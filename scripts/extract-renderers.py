#!/usr/bin/env python3
"""
从反编译的渲染器源码里提取「实体 → 模型类 / 图层 / 阴影 / 贴图」。

@why 实体页之前靠 id 猜模型（chicken → adult_chicken 之类），猜不准就掉回贴图。
      真实映射写在 EntityRenderers.register(EntityTypes.PIG, PigRenderer::new) 里，
      PigRenderer 又用 new PigModel(context.bakeLayer(ModelLayers.PIG)) 指定几何。
      把这条链路原样挖出来，实体就不需要任何启发式。

@constraint 注册有两种写法，必须都认：
      register(EntityTypes.PIG, PigRenderer::new)
      register(EntityTypes.OAK_BOAT, ctx -> new BoatRenderer(ctx, ModelLayers.OAK_BOAT))
      只认第一种会丢掉全部船、矿车、羊驼、猪灵——第二批 60 多个实体就是这么没的。
      第二种还顺便把图层名写死在参数里（同一个 BoatRenderer 被 11 种木头复用）。

@constraint 渲染器继承链要跟着走：BoggedRenderer 不 new 模型，几何来自
      AbstractSkeletonRenderer；只查本类会让这些变体没有模型。

输入：CFR 反编译后的 net/minecraft/client/renderer/entity 与 client/model/geom
输出：entityrenderers.json
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
REND = sys.argv[1] if len(sys.argv) > 1 else '/tmp/rendsrc/net/minecraft/client/renderer/entity'
GEOM = sys.argv[2] if len(sys.argv) > 2 else '/tmp/rendsrc/net/minecraft/client/model/geom'
# 输出进 mc-derived：注册表来自反编译的 EntityRenderers
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, 'mc-derived', VERSION, 'entityrenderers.json')
TEXTURES = sys.argv[4] if len(sys.argv) > 4 else os.path.join(ROOT, 'mc-assets', VERSION, 'textures/entity')


def snake(name):
    # ZOMBIFIED_PIGLIN → zombified_piglin，ArmorStand → armor_stand
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
    depth = 1
    i = start
    quote = None
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


def load_layers():
    """
    ModelLayers.PIG = register("pig")            → { 'PIG': 'pig' }
    ModelLayers.CAMEL_SADDLE = register("camel", "saddle") → { 'CAMEL_SADDLE': 'camel:saddle' }
    ModelLayers.OAK_BOAT = register("boat/oak")  → { 'OAK_BOAT': 'boat/oak' }

    @why 规范化成「路径 + 子层」两种写法，模型表就能按同一个键索引：
         船的图层路径自带斜杠（boat/oak），鞍具是"主层 + saddle"，
         混着用会让 20 多个图层查不到几何。
    """
    src = read(os.path.join(GEOM, 'ModelLayers.java'))
    table = {}
    for m in re.finditer(
            r'public static final ModelLayerLocation (\w+)\s*=\s*ModelLayers\.register\("([^"]+)"(?:,\s*"([^"]+)")?\)',
            src):
        key = m.group(2) if not m.group(3) else m.group(2) + ':' + m.group(3)
        table[m.group(1)] = key
    return table


# ---------------------------------------------------------------- 渲染器类索引

_RENDERER_SRC = None


def renderer_src(cls):
    """类名 → 源码（渲染器分散在子包里，先建一张全量索引）"""
    global _RENDERER_SRC
    if _RENDERER_SRC is None:
        _RENDERER_SRC = {}
        for root, _dirs, files in os.walk(REND):
            for name in files:
                if name.endswith('.java'):
                    _RENDERER_SRC.setdefault(name[:-5], os.path.join(root, name))
    path = _RENDERER_SRC.get(cls)
    return strip_comments(read(path)) if path else ''


def _skip_generics(text, i):
    """从 text[i] == '<' 起跳过配平的尖括号（泛型可以嵌套）"""
    depth = 0
    while i < len(text):
        if text[i] == '<':
            depth += 1
        elif text[i] == '>':
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return i


def renderer_extends(cls):
    src = renderer_src(cls)
    head = re.search(r'class\s+%s\b' % re.escape(cls), src)
    if not head:
        return None
    # @constraint 必须先配平跳过泛型再找 extends：泛型上界里也有 extends
    #      （AbstractZombieRenderer<T extends Zombie, …>），直接正则会认成 "父类 = Zombie"，
    #      继承链断在这里，翻转标记和几何继承一起丢。
    i = head.end()
    if i < len(src) and src[i] == '<':
        i = _skip_generics(src, i)
    m = re.search(r'\bextends\s+([\w.]+)', src[i:i + 400])
    return m.group(1).rsplit('.', 1)[-1] if m else None


# ---------------------------------------------------------------- 注册表

def registrations():
    """
    实体 id → (渲染器类, [参数表达式])。

    参数表达式保留原文，后面既能取 ModelLayers.X，也能在里面 new 一个模型。
    """
    reg = strip_comments(read(os.path.join(REND, 'EntityRenderers.java')))
    out = {}
    for m in re.finditer(r'EntityRenderers\.register\s*\(\s*EntityTypes\.(\w+)\s*,\s*([^;]+?)\s*\)\s*;', reg):
        entity, expr = snake(m.group(1)), m.group(2).strip()
        ref = re.match(r'(\w+)\s*::\s*new$', expr)
        if ref:
            out[entity] = (ref.group(1), [])
            continue
        lam = re.match(r'\w+\s*->\s*new\s+(\w+)\s*\(', expr)
        if lam:
            start = lam.end()
            depth, i = 1, start
            while i < len(expr) and depth:
                if expr[i] == '(':
                    depth += 1
                elif expr[i] == ')':
                    depth -= 1
                i += 1
            out[entity] = (lam.group(1), split_args(expr[start:i - 1]))
    return out


# ---------------------------------------------------------------- 单类解析

MODEL_NEW_RE = re.compile(
    r'new\s+(\w*Model)\s*(?:<[^>]*>)?\s*\(\s*\w+\s*\.\s*bakeLayer\s*\(\s*([\w.]+)\s*\)')


def models_of(cls, layers):
    """类里 new 出来的模型：[(模型类, 图层名)]，按出现顺序"""
    src = renderer_src(cls)
    found = []
    for m in MODEL_NEW_RE.finditer(src):
        model_cls, arg = m.group(1), m.group(2)
        const = arg.rsplit('.', 1)[-1]
        layer = layers.get(const) or snake(model_cls[:-5] if model_cls.endswith('Model') else model_cls)
        found.append({'cls': model_cls, 'layer': layer})
    return found


def shadow_of(cls):
    src = renderer_src(cls)
    m = re.search(r'this\.shadowRadius\s*=\s*([\d.]+)', src)
    if m:
        return float(m.group(1))
    # super(context, new XxxModel(...), 0.7f) —— 取 super 调用里最后一个浮点数
    m = re.search(r'super\s*\(', src)
    if m:
        inner, _ = read_balanced(src, m.end())
        nums = re.findall(r'(?<![\w.])(\d+(?:\.\d+)?)f?(?=\s*[,)])', inner)
        if nums:
            return float(nums[-1])
    return None


def textures_of(cls):
    src = renderer_src(cls)
    return sorted(set(re.findall(r'"textures/(entity/[\w/]+)\.png"', src)))


def flips_y(cls, depth=0):
    """
    渲染器在提交模型前是否把 y 轴翻过来。

    @why ModelPart 的 y 向上，屏幕空间 y 向下，原版各渲染器各翻各的：
          LivingEntityRenderer 一律 `scale(-1,-1,1)`，EndCrystalRenderer 不翻。
          前端统一按"翻转"处理的话，末地水晶就是倒的——底座浮在水晶上方，
          而生物都正好正确。这个标记就是那条分界线。
    """
    if not cls or depth > 6:
        return False
    src = renderer_src(cls)
    if re.search(r'poseStack\.scale\(\s*-1\.0[fF]?,\s*-1\.0[fF]?,\s*1\.0[fF]?\s*\)', src):
        return True
    return flips_y(renderer_extends(cls), depth + 1)


def resolve(cls, layers, override_layers=None, depth=0):
    """
    渲染器类 → 完整描述。几何没有就地 new 的，往父类找。

    @why override_layers 来自注册表达式（ctx -> new BoatRenderer(ctx, ModelLayers.OAK_BOAT)）：
          同一个 BoatRenderer 服务 11 种木头，图层只能从注册处拿到。
    """
    if not cls or depth > 6:
        return None
    models = models_of(cls, layers)
    info = {
        'models': models,
        'shadow': shadow_of(cls),
        'textures': textures_of(cls),
    }
    if not info['models']:
        sub = resolve(renderer_extends(cls), layers, None, depth + 1)
        if sub:
            info['models'] = [dict(m) for m in sub['models']]
            info['textures'] = info['textures'] or sub['textures']
            info['shadow'] = info['shadow'] if info['shadow'] is not None else sub['shadow']
    if override_layers and info['models']:
        info['models'][0]['layer'] = override_layers[0]
        for extra, layer in zip(info['models'][1:], override_layers[1:]):
            extra['layer'] = layer
    return info


def layers_in(exprs, layers):
    """注册参数里的 ModelLayers.X，按出现顺序"""
    out = []
    for expr in exprs:
        for const in re.findall(r'ModelLayers\.(\w+)', expr):
            if const in layers and layers[const] not in out:
                out.append(layers[const])
    return out


# ---------------------------------------------------------------- 贴图猜测

def texture_index():
    """textures/entity 下全部 png → [(相对路径, token 集合)]"""
    rows = []
    if not os.path.isdir(TEXTURES):
        return rows
    base = os.path.dirname(TEXTURES)
    for root, _dirs, files in os.walk(TEXTURES):
        for name in files:
            if not name.endswith('.png'):
                continue
            rel = os.path.relpath(os.path.join(root, name), base).replace(os.sep, '/')[:-4]
            tail = rel.split('/', 1)[1] if '/' in rel else rel
            rows.append((rel, set(t for t in re.split(r'[/_]', tail) if t)))
    return rows


def best_texture(entity, layer, index):
    """
    实体 id / 图层名 → 贴图路径。船是 entity/boat/oak，运输船是 entity/chest_boat/oak。

    @why 渲染器源码里贴图是拼出来的（"textures/entity/" + p + ".png"），正则抓不到，
          只能按名字对：两边 token 集合越接近越可信。
    @constraint 候选同等可信时取最短名：熊猫有 panda / aggressive_panda / lazy_panda…
          十个变体，按字母序取第一个会得到"愤怒的小熊猫"当默认皮肤。
    """
    want = set(t for t in re.split(r'[_\s]', entity) if t)
    if layer:
        want |= set(t for t in re.split(r'[/_]', layer) if t)
    best, best_key = None, None
    for rel, tokens in index:
        if not tokens:
            continue
        inter = len(want & tokens)
        if not inter:
            continue
        score = inter / len(want | tokens)
        if score < 0.5:
            continue
        key = (-round(score, 6),) + variant_penalty(tokens) + (len(tokens), rel)
        if best_key is None or key < best_key:
            best, best_key = rel, key
    return best


# 变体皮肤里"像默认皮肤"的名字与"明显是特例"的名字
PREFER = {'temperate', 'brown', 'normal', 'default', 'red'}
ODD = {'baby', 'cold', 'warm', 'aggressive', 'angry', 'sad', 'lazy', 'worried', 'playful',
       'toast', 'salt', 'caerbannog', 'splotched', 'markings', 'blackdots', 'whitedots',
       'swirls', 'tuxedo', 'gray', 'black', 'white', 'gold', 'chestnut', 'creamy',
       'darkbrown', 'skeleton', 'zombie', 'archer', 'jellie', 'calico', 'persian', 'ragdoll',
       'siamese', 'red', 'blue', 'green', 'cyan', 'light_blue', 'purple', 'pink'}


def variant_penalty(tokens):
    """
    变体排序：先认同名程度，再让"温和/棕色"这类默认皮肤优先，最后才比特例名。

    @why 26.3 的牛按气候拆成 temperate / cold / warm，默认是 temperate；
          只按字母序取第一张会拿到 cow_cold，整只牛换了个肤色。
    """
    penalty = len([t for t in tokens if t in ODD])
    bonus = 0 if (tokens & PREFER) else 1
    return (bonus, penalty)


def pick_texture(textures, entity, layer, index):
    """
    渲染器里写死的贴图可能是一整张变体表（熊猫十种、马七种、猫十一种），
    按"最贴近实体名"的顺序挑一张，而不是按字母序。
    """
    if not textures:
        return best_texture(entity, layer, index)
    if len(textures) == 1:
        return textures[0]
    want = set(t for t in re.split(r'[_/]', entity) if t)
    best, best_key = None, None
    for rel in textures:
        tokens = set(t for t in re.split(r'[_/]', rel.split('/', 1)[1]) if t)
        inter = len(want & tokens)
        score = inter / len(want | tokens) if want | tokens else 0.0
        key = (-round(score, 6),) + variant_penalty(tokens) + (len(tokens), rel)
        if best_key is None or key < best_key:
            best, best_key = rel, key
    return best


def args_models(args, layers):
    """
    注册表达式里现搭的模型：
        ctx -> new SquidRenderer(ctx, new SquidModel(ctx.bakeLayer(ModelLayers.SQUID)))

    @why 乌贼、发光乌贼的模型不在渲染器类里，是注册时 new 好再传进去的。
          漏掉这一步，两种乌贼会整只是空白卡片。
    """
    out = []
    for expr in args:
        for m in MODEL_NEW_RE.finditer(expr):
            model_cls, arg = m.group(1), m.group(2)
            const = arg.rsplit('.', 1)[-1]
            layer = layers.get(const) or snake(model_cls[:-5] if model_cls.endswith('Model') else model_cls)
            out.append({'cls': model_cls, 'layer': layer})
    return out


# 没有 ModelPart 树的实体：几何在渲染器里现拼，这里记下它拼的是什么。
#
# @why ThrownItemRenderer / ItemEntityRenderer 画的是物品模型，TntRenderer 画的是
#      TNT 方块，ExperienceOrbRenderer 画的是 `quad 0.3×0.3` 的 billboard。
#      不记下来，这些实体在站上只有一张物品图标，看着像整类功能坏了。
# @constraint 少部分实体（闪电、标记、文本/方块展示）真的没有固定几何，
#      它们的形状由实体数据决定，留空比瞎猜一个方块好。
SHAPES = {
    'item': {'k': 'item', 'id': 'diamond'},
    'egg': {'k': 'item', 'id': 'egg'},
    'ender_pearl': {'k': 'item', 'id': 'ender_pearl'},
    'experience_bottle': {'k': 'item', 'id': 'experience_bottle'},
    'snowball': {'k': 'item', 'id': 'snowball'},
    'eye_of_ender': {'k': 'item', 'id': 'ender_eye'},
    'firework_rocket': {'k': 'item', 'id': 'firework_rocket'},
    # 药水贴图是灰度遮罩，颜色来自 PotionContents；给一个标准的水蓝色
    'potion': {'k': 'item', 'id': 'potion', 'tint': [0.35, 0.42, 0.9]},
    'splash_potion': {'k': 'item', 'id': 'splash_potion', 'tint': [0.35, 0.42, 0.9]},
    'lingering_potion': {'k': 'item', 'id': 'lingering_potion', 'tint': [0.35, 0.42, 0.9]},
    'item_frame': {'k': 'item', 'id': 'item_frame'},
    'glow_item_frame': {'k': 'item', 'id': 'glow_item_frame'},
    'painting': {'k': 'item', 'id': 'painting'},
    'ominous_item_spawner': {'k': 'block', 'id': 'trial_spawner'},
    'tnt': {'k': 'block', 'id': 'tnt'},
    'falling_block': {'k': 'block', 'id': 'sand'},
    # 经验球贴图是 4×4 图集，只取左上那一格；原版按 Icon 索引选格，展示取首格
    # 图集里第 3 行第 2 格是标准那颗"红芯经验球"，首格是未点亮的灰球
    'experience_orb': {'k': 'sprite', 'id': 'entity/experience/experience_orb',
                       'uv': [0.25, 0.5, 0.5, 0.75], 's': 0.5},
    'fishing_bobber': {'k': 'sprite', 'id': 'entity/fishing/fishing_hook', 's': 0.5},
    # DragonFireballRenderer 里 poseStack.scale(2, 2, 2)
    'dragon_fireball': {'k': 'sprite', 'id': 'entity/enderdragon/dragon_fireball', 's': 2},
}


def main():
    layers = load_layers()
    regs = registrations()
    index = texture_index()

    entities = {}
    renderers = {}
    for entity, (renderer, args) in regs.items():
        override = layers_in(args, layers)
        info = resolve(renderer, layers, override)
        if info is None:
            continue
        renderers.setdefault(renderer, info)
        if not info['models']:
            from_args = args_models(args, layers)
            if from_args:
                info['models'] = from_args
        if not info['models']:
            # 没有骨架：记下渲染器现拼的是什么，前端据此凑几何
            shape = SHAPES.get(entity)
            if shape:
                entities[entity] = {
                    'r': renderer,
                    'm': '',
                    'l': '',
                    's': info['shadow'],
                    't': info['textures'][:1],
                    'v': [],
                    'layers': [],
                    'f': 1 if flips_y(renderer) else 0,
                    'shape': shape,
                }
            continue
        primary = info['models'][0]
        tex = pick_texture(info['textures'], entity, primary['layer'], index)
        entities[entity] = {
            'r': renderer,
            'm': primary['cls'],
            'l': primary['layer'],
            's': info['shadow'],
            't': [tex] if tex else [],
            'v': [m['cls'] for m in info['models']],
            'layers': [m['layer'] for m in info['models']],
            # 1 = 渲染器自己把 y 翻过来（生物），0 = 没翻（末地水晶这类）
            'f': 1 if flips_y(renderer) else 0,
        }

    data = {'entities': entities, 'renderers': renderers}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(data, fh, separators=(',', ':'))

    print('实体 %d 个，渲染器 %d 个 → %s' % (len(entities), len(renderers), OUT))
    no_model = sorted(set(regs) - set(entities))
    print('无几何 %d 个：%s' % (len(no_model), ', '.join(no_model)))


if __name__ == '__main__':
    main()
