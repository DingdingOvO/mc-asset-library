#!/usr/bin/env python3
"""
从反编译源码里提取「实体的渲染图层」与「可变状态（变体贴图）」。

@why 之前每只生物只画一层：SheepRenderer 身上挂了 SheepWoolLayer /
      SheepWoolUndercoatLayer，EndermanRenderer 挂了 EnderEyesLayer，
      HorseRenderer 挂了 HorseMarkingLayer + 鞍具。只画主模型的结果是
      羊没毛、末影人没有眼睛、马没有斑纹——看起来就是"渲染坏了"。
      这些图层在源码里是显式的 addLayer(new XxxLayer(...))，
      图层的几何与贴图也都写在图层类里，全部可抽。

@constraint 只认「几何 + 贴图」型图层。物品/方块装饰（手中物品、雪傀儡的头、
      蘑菇牛的蘑菇）要另一套方块渲染管线，不在这里处理。

输入：CFR 反编译的 net/minecraft/client/renderer/entity{,/layers} 与 model/geom
输出：entitylayers.json
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
REND = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rendsrc/net/minecraft/client/renderer/entity'
GEOM = sys.argv[2] if len(sys.argv) > 2 else '/tmp/rendsrc/net/minecraft/client/model/geom'
# 输出进 mc-derived：图层链来自反编译的 addLayer 调用
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, 'mc-derived', VERSION, 'entitylayers.json')
TEXTURES = sys.argv[4] if len(sys.argv) > 4 else os.path.join(ROOT, 'mc-assets', VERSION, 'textures/entity')

LAYERS_DIR = os.path.join(REND, 'layers')

# DyeColor 的 16 个颜色：源码在 world/item 包里没跟着反编译，
# 这里取游戏内贴图染色用的 diffuse 值（DyeColor#getTextureDiffuseColor）。
DYE_LIST = [
    ('white', '白色', '#f9fffe'), ('orange', '橙色', '#f9801d'),
    ('magenta', '品红色', '#c74ebd'), ('light_blue', '淡蓝色', '#3ab3da'),
    ('yellow', '黄色', '#fed83d'), ('lime', '黄绿色', '#80c71f'),
    ('pink', '粉红色', '#f38baa'), ('gray', '灰色', '#474f52'),
    ('light_gray', '淡灰色', '#9d9d97'), ('cyan', '青色', '#169c9c'),
    ('purple', '紫色', '#8932b8'), ('blue', '蓝色', '#3c44aa'),
    ('brown', '棕色', '#835432'), ('green', '绿色', '#5e7c16'),
    ('red', '红色', '#b02e26'), ('black', '黑色', '#1d1d21'),
]

# 变体名 → 中文。游戏里这些名字从不显示给玩家（只有刷怪蛋/图鉴会提到），
# 所以没有官方译名可抓，按 MC 中文 wiki 的常用叫法逐词翻译。
ZH = {
    'white': '白色', 'orange': '橙色', 'magenta': '品红色', 'light_blue': '淡蓝色',
    'yellow': '黄色', 'lime': '黄绿色', 'pink': '粉红色', 'gray': '灰色',
    'light_gray': '淡灰色', 'cyan': '青色', 'purple': '紫色', 'blue': '蓝色',
    'brown': '棕色', 'green': '绿色', 'red': '红色', 'black': '黑色',
    'creamy': '奶油色', 'chestnut': '栗色', 'darkbrown': '深棕色', 'dark_brown': '深棕色',
    'skeleton': '骷髅', 'zombie': '僵尸', 'mule': '骡', 'donkey': '驴',
    'temperate': '温带', 'cold': '寒带', 'warm': '热带', 'normal': '普通',
    'tabby': '虎斑', 'black': '黑色', 'calico': '三花', 'jellie': '杰利',
    'persian': '波斯', 'ragdoll': '布偶', 'siamese': '暹罗', 'british_shorthair': '英国短毛',
    'all_black': '全黑', 'ocelot': '豹猫',
    'ashen': '灰烬', 'rusty': '锈色', 'woods': '林地', 'spotted': '斑点', 'snowy': '雪原',
    'striped': '条纹', 'black': '黑色',
    'wild': '野生', 'lucy': '白化', 'gold': '金色', 'cyan': '青色',
    'blue': '蓝色', 'green': '绿色', 'grey': '灰色', 'red_blue': '红蓝',
    'yellow_blue': '黄蓝', 'salt': '盐渍', 'toast': '吐司', 'caerbannog': '杀手',
    'white_splotched': '白斑', 'brown': '棕色',
    'purple': '紫色', 'weak': '虚弱', 'worried': '忧郁', 'playful': '顽皮',
    'aggressive': '好斗', 'lazy': '懒惰',
    'tame': '已驯服', 'angry': '愤怒',
    'none': '无', 'white_field': '白斑块', 'whitedots': '白点', 'blackdots': '黑点',
    'whitefield': '白斑块', 'white_dots': '白点', 'black_dots': '黑点',
    'donkey': '驴', 'mule': '骡', 'undead': '亡灵', 'pattern': '花纹',
    'whitedots': '白点', 'blackdots': '黑点', 'whitefield': '白斑块', 'white_field': '白斑块',
}

# 贴图名里出现这些词说明它是"装备/状态"贴图，不是品种皮肤
SKIP_TOKENS = {'armor', 'collar', 'crackiness', 'saddle', 'harness', 'body', 'spit',
               'eyes', 'charging', 'wind', 'undercoat', 'pattern', 'markings', 'decor'}

# 装备型图层：贴图来自 equipment 资源，不属于生物外观
SKIP_LAYERS = {
    'WolfArmorLayer', 'LlamaDecorLayer', 'WingsLayer', 'HumanoidArmorLayer',
    'ParrotOnShoulderLayer', 'CrossedArmsItemLayer', 'PlayerItemInHandLayer',
    'ItemInHandLayer', 'FoxHeldItemLayer', 'PandaHoldsItemLayer', 'WitchItemLayer',
    'CarriedBlockLayer', 'SnowGolemHeadLayer', 'IronGolemFlowerLayer',
    'MushroomCowMushroomLayer', 'BlockDecorationLayer', 'VillagerProfessionLayer',
    'RopesLayer', 'SpinAttackEffectLayer', 'CapeLayer', 'Deadmau5EarsLayer',
    'CustomHeadLayer', 'DolphinCarryingItemLayer', 'BeeStingerLayer',
    'EnergySwirlLayer', 'StuckInBodyLayer', 'IronGolemCrackinessLayer',
    # 只在特定状态下才该出现的图层（充能苦力怕、凋灵护甲、旋风）：
    # 预览里没有这些状态，默认画上去反而变成错的皮
    'CreeperPowerLayer', 'WitherArmorLayer', 'BreezeWindLayer',
}


def snake(name):
    out = re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', '_', name)
    return out.lower()


def read(path):
    try:
        return open(path, encoding='utf-8', errors='replace').read()
    except OSError:
        return ''


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'//[^\n]*', '', text)


def split_args(text):
    args, depth, cur, quote = [], 0, [], None
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in '"\'':
            quote = ch
            cur.append(ch)
            continue
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == ',' and depth == 0:
            args.append(''.join(cur).strip())
            cur = []
            continue
        cur.append(ch)
    if cur:
        args.append(''.join(cur).strip())
    return args


def read_balanced(text, start):
    depth, i, quote = 1, start, None
    while i < len(text) and depth > 0:
        ch = text[i]
        if quote:
            if ch == quote:
                quote = None
        elif ch in '"\'':
            quote = ch
        elif ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        i += 1
    return text[start:i - 1], i


# ------------------------------------------------------------------ 源码索引

_SRC = {}


def build_index():
    for root, _dirs, files in os.walk(REND):
        for name in files:
            if name.endswith('.java'):
                _SRC.setdefault(name[:-5], strip_comments(read(os.path.join(root, name))))


def src_of(cls):
    if not cls:
        return ''
    return _SRC.get(cls, '')


def extends_of(cls, source=None):
    source = source if source is not None else src_of(cls)
    m = re.search(r'class\s+%s(?:<[^>]*>)?\s+extends\s+([\w.]+)' % re.escape(cls), source)
    return m.group(1).rsplit('.', 1)[-1] if m else None


# 全局常量表：某个类的 `static final Identifier FOO = ... "textures/x.png"`
_CONST = {}


def build_consts():
    for cls, source in _SRC.items():
        for m in re.finditer(
                r'static\s+final\s+(?:Identifier|RenderType)\s+(\w+)\s*=\s*[^;]*?"textures/(entity/[\w/]+)\.png"',
                source):
            _CONST.setdefault(m.group(1), m.group(2))


def const_texture(name):
    return _CONST.get(name)


def model_layers():
    src = read(os.path.join(GEOM, 'ModelLayers.java'))
    table = {}
    for m in re.finditer(
            r'public static final ModelLayerLocation (\w+)\s*=\s*ModelLayers\.register\("([^"]+)"(?:,\s*"([^"]+)")?\)',
            src):
        table[m.group(1)] = m.group(2) if not m.group(3) else m.group(2) + ':' + m.group(3)
    return table


# ------------------------------------------------------------------ 注册表

def registrations():
    reg = strip_comments(read(os.path.join(REND, 'EntityRenderers.java')))
    out = {}
    for m in re.finditer(r'EntityRenderers\.register\s*\(\s*EntityTypes\.(\w+)\s*,\s*([^;]+?)\s*\)\s*;', reg):
        entity, expr = snake(m.group(1)), m.group(2).strip()
        ref = re.match(r'(\w+)\s*::\s*new$', expr)
        if ref:
            out[entity] = ref.group(1)
            continue
        lam = re.match(r'\w+\s*->\s*new\s+(\w+)\s*\(', expr)
        if lam:
            out[entity] = lam.group(1)
    return out


# ------------------------------------------------------------------ 图层

def layer_calls(cls, depth=0):
    """沿继承链收集 addLayer(new XxxLayer(...))，父类在前"""
    if not cls or depth > 6:
        return []
    source = src_of(cls)
    out = []
    for m in re.finditer(r'addLayer\s*\(\s*new\s+(\w+)\s*(?:<[^>]*>)?\s*\(', source):
        inner, _ = read_balanced(source, m.end())
        out.append((m.group(1), inner))
    parent = extends_of(cls, source)
    return layer_calls(parent, depth + 1) + out


def adult_texture(cands):
    keep = [c for c in cands if not re.search(r'_baby$|/baby|invisible', c)]
    return keep[0] if keep else None


def texts_in(source):
    return sorted(set(re.findall(r'"textures/(entity/[\w/]+)\.png"', source)))


def layer_model(inner, layers_table, source=''):
    """
    图层用的几何图层。两处都要看：构造参数里（SkeletonClothingLayer(this, set,
    ModelLayers.X, ...)）和类体里（this.model = new XModel(set.bakeLayer(...))）。
    """
    for text in (inner, source):
        keys = []
        for const in re.findall(r'bakeLayer\s*\(\s*ModelLayers\.(\w+)\s*\)', text):
            key = layers_table.get(const)
            if key and key not in keys:
                keys.append(key)
        # 构造参数里的 ModelLayers.X 不带 bakeLayer()
        for const in re.findall(r'ModelLayers\.(\w+)', text):
            key = layers_table.get(const)
            if key and key not in keys:
                keys.append(key)
        adult = [k for k in keys if 'baby' not in k]
        if adult:
            return adult[0]
        if keys:
            return keys[0]
    return None


def describe_layer(cls, inner, layers_table):
    source = src_of(cls)
    if not source:
        return None
    # 装备图层（鞍、马铠、羊驼地毯）走 EquipmentAssets，贴图在 textures/entity/equipment，
    # 是"穿在身上的物品"而不是生物外观，这里统一跳过。
    if 'Equipment' in cls or cls in SKIP_LAYERS:
        return None
    model = layer_model(inner, layers_table, source)

    # 贴图：优先本类字面量，其次常量表（SlimeOuterLayer 用 SlimeRenderer.SLIME_LOCATION）
    cands = texts_in(source)
    if not cands:
        for name in re.findall(r'\b([A-Z][A-Z0-9_]{3,})\b', source):
            hit = const_texture(name)
            if hit and hit not in cands:
                cands.append(hit)
    # 构造参数里也可能直接给贴图（SkeletonClothingLayer(this, set, layer, LOCATION)）
    for name in re.findall(r'\b([A-Z][A-Z0-9_]{3,})\b', inner):
        hit = const_texture(name)
        if hit and hit not in cands:
            cands.append(hit)

    dye = 1 if ('getTextureDiffuseColor' in source or 'getWoolColor' in source
                or 'state.woolColor' in source) else 0
    eyes = 1 if (cls.endswith('EyesLayer') or 'RenderTypes.eyes' in source
                 or 'entityTranslucentEmissive' in source) else 0
    # 需要"已驯服/项圈颜色"才出现的图层：没选颜色就不画，和游戏里一致
    tame = 1 if 'collarColor' in source else 0
    sheared = 1 if 'isSheared' in source else 0

    if not cands and not model:
        return None
    adult = adult_texture(cands)
    # @constraint 没有贴图的图层不画：绳索、手持物品这些用纯色/方块渲染，
    #     塞进贴图管线只会给模型糊上一张错图。
    if not adult:
        return None
    entry = {'c': cls, 'm': model, 't': adult, 'e': eyes}
    if dye:
        entry['d'] = 1
    if tame:
        entry['k'] = 'tame'
    if sheared:
        entry['k'] = 'wool'
    # 同一图层有多种贴图（斑纹、骷髅衣服…）→ 升格成一个可变轴
    adults = [c for c in cands if not re.search(r'_baby$|/baby|invisible', c)]
    if len(adults) > 1:
        entry['v'] = adults
    return entry


def basename(path):
    return path.rsplit('/', 1)[-1]


def dir_siblings(base):
    """某张贴图同目录下的其它 png（相对 textures/，不含扩展名）"""
    if not base:
        return []
    rel = base.split('/', 1)[1] if base.startswith('entity/') else base
    folder = os.path.dirname(os.path.join(TEXTURES, rel))
    if not os.path.isdir(folder):
        return []
    parent = os.path.dirname(rel)
    out = []
    for name in sorted(os.listdir(folder)):
        if name.endswith('.png'):
            out.append('entity/' + (parent + '/' + name[:-4] if parent else name[:-4]))
    return out


# 图层类名 → 中文标签。
#
# @why 直接去掉 Layer 后缀会得到 "SulfurCubeInner"、"TropicalFishPattern" 这种
#      类名，出现在下拉框里就是没做完的样子。这里按结尾词根给一层翻译，
#      认不出的再退回去掉 Layer 的原名。
LAYER_LABEL = (
    ('Marking', '花纹'),
    ('Pattern', '花纹'),
    ('Inner', '内核'),
    ('Collar', '项圈'),
    ('Wool', '羊毛'),
    ('Eyes', '眼睛'),
    ('Emissive', '发光'),
    ('Outer', '外层'),
    ('Undercoat', '底绒'),
    ('Overlay', '覆盖层'),
)


def layer_label(cls):
    for suffix, zh in LAYER_LABEL:
        if suffix in cls:
            return zh
    return cls.replace('Layer', '')


def variant_options(default_tex, extra=(), layer_tex=(), alien=(), entity=''):
    """
    变体候选 = 渲染器自己写的贴图 ∪ 默认贴图同目录下的兄弟文件。

    @constraint 必须按「默认贴图的文件名前缀」过滤：horse 目录里还躺着 donkey /
          mule，cat 目录里有 ocelot 与项圈，spider 目录里有 cave_spider，
          不过滤就会端出一堆别的生物的皮肤。
    @constraint alien 是"同目录下属于别的实体的词"（skeleton / zombie / donkey /
          mule / mooshroom）：马的目录里就有 horse_skeleton.png，
          不排掉的话马的下拉框里会出现骷髅马。
    @constraint 图层自己的贴图（羊毛、项圈、外层、眼睛）必须剔除：
          它们是叠在身上的第二层，不是本体品种。
    """
    if not default_tex:
        return []
    base = basename(default_tex)
    stem = base.split('_')[0]
    pool = set(extra) | set(dir_siblings(default_tex))
    out = []
    for path in sorted(pool):
        name = basename(path)
        parts = name.split('_')
        if path in layer_tex:
            continue
        if any(tok in alien for tok in parts):
            continue
        if re.search(r'(_baby$|^baby_|collar|armor|eyes|undercoat|outer_layer|markings)', name):
            continue
        # 同族判定：单字 id（horse）要 name 就是它或 name_ 开头；
        # 多字 id（skeleton_horse / cave_spider）要求文件名含齐所有词，
        # 否则普通马的色卡会混进骷髅马的下拉框
        id_tokens = [t for t in entity.split('_') if t]
        if len(id_tokens) > 1:
            if not set(id_tokens) <= set(parts):
                continue
        elif name != stem and not name.startswith(stem + '_'):
            continue
        out.append(path)
    out.sort(key=lambda p: (basename(p) != base, p))
    return out


def shared_label(path, group):
    """
    去掉组内共有的词缀再翻译：horse_markings_white → 白色，
    tropical_a_pattern_1 → a·图案·1。
    """
    words = basename(path).split('_')
    common = 0
    if group:
        others = [basename(o).split('_') for o in group]
        while others and all(len(w) > common + 1 and w[common] == words[common] for w in others):
            common += 1
    rest = words[common:]
    if not rest:
        return '默认'
    joined = '_'.join(rest)
    if joined in ZH:
        return ZH[joined]
    return '·'.join(ZH.get(w, w) for w in rest)


def label_of(path, default_tex):
    if not default_tex:
        return basename(path)
    stem = basename(default_tex).split('_')[0]
    words = [w for w in basename(path).split('_') if w != stem]
    if not words:
        return '默认'
    joined = '_'.join(words)
    if joined in ZH:
        return ZH[joined]
    return '·'.join(ZH.get(w, w) for w in words)


def main():
    build_index()
    build_consts()
    layers_table = model_layers()
    regs = registrations()
    # 渲染器表本身也是派生数据，读 mc-derived 而不是素材目录
    renderers = json.load(open(os.path.join(ROOT, 'mc-derived', VERSION, 'entityrenderers.json')))
    table = renderers['entities']

    layers_out = {}
    axes_out = {}

    for entity, cls in sorted(regs.items()):
        calls = layer_calls(cls)
        if not calls:
            continue
        base_tex = (table.get(entity, {}).get('t') or [None])[0]
        entries = []
        seen = set()
        for layer_cls, inner in calls:
            entry = describe_layer(layer_cls, inner, layers_table)
            if not entry:
                continue
            # 图层贴图与本体相同时（史莱姆外壳、监守者本体）画上去等于白干
            if entry['t'] and entry['t'] == base_tex:
                continue
            key = (entry['c'], entry['m'], entry['t'])
            if key in seen:
                continue
            seen.add(key)
            entries.append(entry)
        if entries:
            layers_out[entity] = entries

    # 变体：只对本体的主贴图做
    dir_owner = {}
    for entity, info in table.items():
        tex = info['t'][0] if info['t'] else None
        if tex:
            dir_owner.setdefault(tex.rsplit('/', 1)[0], set()).add(entity)

    for entity, info in sorted(table.items()):
        default = info['t'][0] if info['t'] else None
        if not default:
            continue
        cls = info['r']
        # @constraint 只认渲染器自己写的贴图字面量。renderers.json 里的 textures
        #      会沿继承链合并，骷髅马/僵尸马会拿到整张马的色卡。
        extra = texts_in(src_of(cls))
        alien = set()
        for other in dir_owner.get(default.rsplit('/', 1)[0], set()):
            if other == entity:
                continue
            alien |= {t for t in other.split('_') if t not in entity.split('_')}
        own_layers = {e.get('t') for e in layers_out.get(entity, []) if e.get('t')}
        for entry in layers_out.get(entity, []):
            own_layers |= set(entry.get('v') or [])
        opts = variant_options(default, extra, own_layers, alien, entity)
        if len(opts) < 2:
            continue
        axes = [{
            'k': 'base',
            'zh': '品种',
            'opts': [{'k': o, 'zh': label_of(o, default), 't': o} for o in opts],
        }]
        axes_out[entity] = axes

    # 图层自带的多贴图（马斑纹、骷髅衣服）→ 追加一层轴
    for entity, entries in layers_out.items():
        for entry in entries:
            if not entry.get('v'):
                continue
            opts = entry['v']
            axes_out.setdefault(entity, []).append({
                'k': 'layer:' + entry['c'],
                'zh': layer_label(entry['c']),
                'layer': entry['c'],
                'opts': [{'k': 'none', 'zh': '无', 't': None}] +
                        [{'k': o, 'zh': shared_label(o, opts), 't': o} for o in opts],
            })

    # 染料：图层带 d 的（羊毛、项圈）→ 一个染色轴
    for entity, entries in layers_out.items():
        if any(e.get('d') for e in entries):
            wool = any(e.get('k') == 'wool' or 'Wool' in e['c'] for e in entries)
            axes_out.setdefault(entity, []).append({
                'k': 'dye',
                'zh': '染色',
                'dye': 1,
                'default': 'white' if wool else 'none',
            })

    payload = {
        'dyes': [{'k': k, 'zh': zh, 'rgb': rgb} for k, zh, rgb in DYE_LIST],
        'version': json.load(open(os.path.join(ROOT, 'mc-assets', VERSION, 'version.json'))).get('id', '26.3')
        if os.path.exists(os.path.join(ROOT, 'mc-assets', VERSION, 'version.json')) else '26.3',
        'layers': layers_out,
        'axes': axes_out,
    }
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))
    print('entities with layers:', len(layers_out))
    print('entities with axes  :', len(axes_out))
    for key in ('sheep', 'enderman', 'horse', 'spider', 'cat', 'wolf', 'cow', 'drowned'):
        print(' ', key, json.dumps(layers_out.get(key), ensure_ascii=False)[:300])
        print('   axes', json.dumps(axes_out.get(key), ensure_ascii=False)[:300])


if __name__ == '__main__':
    main()
