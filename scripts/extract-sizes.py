#!/usr/bin/env python3
"""
从派生数据里补出「体型（成年 / 幼年）」轴。

@why extract-layers.py 只处理 addLayer 出来的图层与贴图色卡，幼年体不在这条链上：
      原版里 BabySheepModel 是独立的 ModelLayers 注册项（sheep_baby），
      贴图也是独立的文件（sheep_baby.png）。于是数据里模型和贴图都有，
      界面上却没有开关——羊只能显示成年体，看起来像"变体没做出来"。
      这里只做一件事：把 entitymodels.json 里现成的 *_baby 键、
      以及 textures/entity 下现成的 *_baby.png 配成一条 axis，不猜任何名字。

@constraint 独立成脚本而不是塞进 extract-layers.py：后者要 /tmp/rendsrc 的
      反编译源码才能跑，而体型信息全部来自已经产出好的 mc-derived JSON 与
      素材目录。混在一起会导致每次补体型都得把整套反编译重跑一遍。

输入：mc-derived/<version>/{entityrenderers,entitymodels}.json、entitylayers.json、textures/entity
输出：原地更新 entitylayers.json（新增 sizes，并在 axes 里加 size 轴）
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = sys.argv[1] if len(sys.argv) > 1 else '26.3'
DERIVED = os.path.join(ROOT, 'mc-derived', VERSION)
TEXTURES = os.path.join(ROOT, 'mc-assets', VERSION, 'textures')
LAYERS = os.path.join(DERIVED, 'entitylayers.json')

SIZE_AXIS = {
    'k': 'size',
    'zh': '体型',
    'default': 'adult',
    'opts': [
        {'k': 'adult', 'zh': '成年'},
        {'k': 'baby', 'zh': '幼年'},
    ],
}


def texture_index():
    """textures 下所有 png 的相对路径（不带扩展名），用于判断某张贴图是否存在"""
    out = set()
    for base, _dirs, files in os.walk(TEXTURES):
        for name in files:
            if not name.endswith('.png'):
                continue
            full = os.path.join(base, name)
            out.add(os.path.relpath(full, TEXTURES)[:-4].replace(os.sep, '/'))
    return out


def baby_model_keys(pool, base):
    """
    幼年几何的键名。

    @constraint 只认 `<base>_baby` 这一种拼法。原版 ModelLayers 的命名全部如此
          （sheep_baby / cow_baby / villager_baby），猜 `<base>_child` 之类
          只会引入不存在的键，最后渲染成空。
    """
    head = base + '_baby'
    return head if head in pool else None


def layer_baby_key(model_key):
    """sheep:wool → sheep_baby:wool；pig → pig_baby"""
    if not model_key:
        return None
    if ':' in model_key:
        head, tail = model_key.split(':', 1)
        return head + '_baby:' + tail
    return model_key + '_baby'


def snake(name):
    """BabySheepModel → baby_sheep_model（与 entitymodels.json byClass 的键一致）"""
    s = name[:-5] if name.endswith('Model') else name
    return re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', '_', s).lower()


def pascal(name):
    return ''.join(part.capitalize() for part in name.split('_') if part)


def baby_class(info, model_key, anim_classes):
    """
    幼年几何对应的动画类名。

    @why 动作脚本按模型类名索引（BabySheepModel），几何按 ModelLayers 键索引
          （sheep_baby）。两个名字都得有：只给几何，幼年体站着不动。
    @constraint 不能只靠 entitymodels.json 的 byClass 反查：那张表是
          类名 → 几何键，同一种几何可能有多个类（baby_cow_model 指向
          cold_cow_baby），反查会丢。改为按「Baby 前缀 + 实体名」直接拼，
          再拿 entityanims.json 里现存的类名验一遍——验不过就不写，
          宁可没动作，也不要编一个不存在的类名让动画静默失效。
    """
    core = snake(info.get('m') or '')
    if core.startswith('adult_'):
        core = core[len('adult_'):]
    if not core:
        return None
    # 渲染器自己列的变体类最准（鸡是 AdultChickenModel → BabyChickenModel）
    for cand in info.get('v') or []:
        if cand.startswith('Baby') and snake(cand).endswith(core) and cand in anim_classes:
            return cand
    # 动物（牛）的 v 全是同一个类，只能按前缀拼
    cand = 'Baby' + pascal(core) + 'Model'
    if cand in anim_classes:
        return cand
    return None


def main():
    renderers = json.load(open(os.path.join(DERIVED, 'entityrenderers.json')))['entities']
    models = json.load(open(os.path.join(DERIVED, 'entitymodels.json')))
    pool = models['models']
    # @constraint 图层用 ModelLayers 键（sheep:wool），本体用 bake 键（sheep_baby）：
    #      两套命名都存在，只看 models 会把 sheep_baby:wool 判成不存在，
    #      幼年羊的羊毛层就退回成年几何，羊毛会长到模型外面。
    known = set(pool) | set(models.get('byLayer') or {})
    try:
        anim_classes = set(json.load(open(os.path.join(DERIVED, 'entityanims.json')))['classes'])
    except (OSError, KeyError):
        anim_classes = set()
    file = json.load(open(LAYERS))
    tex = texture_index()

    layers_out = file.get('layers', {})
    axes_out = file.get('axes', {})
    sizes_out = {}

    for entity, info in sorted(renderers.items()):
        texts = info.get('t') or []
        if not texts:
            continue
        base_layer = info.get('l')
        if not base_layer:
            continue
        model_key = baby_model_keys(known, base_layer)
        base_tex = texts[0]
        # 幼年贴图：原版是独立文件；没有的话（僵尸幼年与成年同皮）沿用本体
        baby_tex = base_tex + '_baby' if base_tex + '_baby' in tex else base_tex
        if not model_key and baby_tex == base_tex:
            continue

        entry = {'m': model_key}
        cls = baby_class(info, model_key, anim_classes) if model_key else None
        if cls:
            entry['c'] = cls
        if baby_tex != base_tex:
            entry['t'] = baby_tex

        # 贴图映射：成年贴图 → 幼年贴图。
        # @constraint 不能只记一张：品种轴（猫 11 种、马 7 种）换的是本体贴图，
        #      幼年 + 品种是两个轴同时生效，界面拿到的当前贴图未必是默认那张。
        #      把每个已知选项的幼年对应关系都列出来，运行时只做一次查表。
        swaps = {}
        known_tex = {base_tex}
        for axis in axes_out.get(entity, []):
            for opt in axis.get('opts') or []:
                if opt.get('t'):
                    known_tex.add(opt['t'])
        for layer in layers_out.get(entity, []):
            if layer.get('t'):
                known_tex.add(layer['t'])
            for extra in layer.get('v') or []:
                known_tex.add(extra)
        for one in sorted(known_tex):
            if one + '_baby' in tex:
                swaps[one] = one + '_baby'
        if swaps:
            entry['tex'] = swaps

        # 图层也要跟着换：羊毛、项圈、马铠在幼年体上是另一套几何 + 另一张贴图
        overrides = {}
        for layer in layers_out.get(entity, []):
            cls = layer.get('c')
            if not cls:
                continue
            lay_tex = layer.get('t')
            lay_model = layer.get('m')
            next_tex = lay_tex + '_baby' if lay_tex and lay_tex + '_baby' in tex else lay_tex
            next_model = layer_baby_key(lay_model)
            if next_model and next_model not in known:
                next_model = lay_model
            if next_tex == lay_tex and next_model == lay_model:
                continue
            overrides[cls] = {'t': next_tex, 'm': next_model}
        if overrides:
            entry['layers'] = overrides
        sizes_out[entity] = entry

        axes = axes_out.setdefault(entity, [])
        if not any(axis.get('k') == 'size' for axis in axes):
            # @why 插到最前面：体型决定后面所有轴的基准（幼年体是另一具骨架），
            #      排在品种/染色后面会让人先选了毛色再发现整只换了大小。
            axes.insert(0, dict(SIZE_AXIS))
            axes_out[entity] = axes

    file['sizes'] = sizes_out
    file['axes'] = axes_out
    with open(LAYERS, 'w', encoding='utf-8') as fh:
        json.dump(file, fh, ensure_ascii=False, separators=(',', ':'))

    print('entities with size :', len(sizes_out))
    for key in ('sheep', 'cow', 'zombie', 'villager', 'pig', 'cat'):
        print(' ', key, json.dumps(sizes_out.get(key), ensure_ascii=False))


if __name__ == '__main__':
    main()
