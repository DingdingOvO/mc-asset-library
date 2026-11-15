#!/usr/bin/env python3
"""
从原版 client jar 的 `CreativeModeTabs` 还原创造栏分组与物品顺序。

@why 分类表必须来自原版本身。上一版是拿正则去啃反编译出来的 Java 源码，
      26.3 把创造栏拆成一堆 `lambda$bootstrap$N` 之后源码形态大变（同一个
      tab 的 displayItems 有时是 `accept()`、有时是 `accept(List)`），正则
      只能抓到一部分，剩下的 205 个物品（铜系列、收纳袋、马具、地图变体）
      全掉进「未分类」。改成读 javap 的字节码：注册顺序在
      `getstatic Items.XXX` 的**出现顺序**里，那是编译器留下的、和游戏里
      一模一样的顺序，不受源码排版影响。

@constraint 颜色变体不能按命名规则猜。彩色方块页的每一项是一个
      `ColorCollection`（16 色），字段名是模板名（WOOL、WOOL_STAIRS），
      真实 id 靠 `BlockItemIds` 里 `createSimpleColored("<base>")` 的参数
      决定。所以要把两边的字节码都读出来，用 base 展开成 16 个 id。
      颜色顺序同样从字节码里那串 16 元素 DyeColor 数组读，不写死。

用法：
  python3 scripts/extract-tabs.py [client.jar|class目录] [输出json] [lang.json]
默认：/tmp/client-26.3.jar → mc-derived/26.3/creativetabs.json
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
SRC = sys.argv[1] if len(sys.argv) > 1 else f'/tmp/client-{VERSION}.jar'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'mc-derived', VERSION, 'creativetabs.json')
LANG = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, 'mc-assets', VERSION, 'lang/zh_cn.json')
# 用来校验展开出来的 id 是否真实存在；缺失时不过滤，只降级为"不检查"
ITEM_TABLE = os.path.join(ROOT, 'mc-assets', VERSION, 'items.json')

TABS_CLASS = 'net/minecraft/world/item/CreativeModeTabs'
# 颜色集合分散在两个 id 类里：方块类自带的那批在 BlockItemIds，
# 纯物品类（靠垫、收纳袋）的 base 在 ItemIds。两处都要读，否则整组掉。
ID_CLASSES = [
    'net/minecraft/references/BlockItemIds',
    'net/minecraft/references/ItemIds',
]

# 搜索页不是分类，内容随输入变化
SKIP_TABS = {'SEARCH'}

# 铜系列的八个变体。名字规律来自 BlockItemIds 里
# `WeatheringCopperCollection` 的四个氧化档 + 对应的四个蜡封档，
# 拿不到时按 items 表里的实际 id 过滤（不存在的自然被丢掉）。
COPPER_VARIANTS = [
    '{b}', 'exposed_{b}', 'weathered_{b}', 'oxidized_{b}',
    'waxed_{b}', 'waxed_exposed_{b}', 'waxed_weathered_{b}', 'waxed_oxidized_{b}',
]


def javap_text(class_file, cwd):
    sub = subprocess.run(['javap', '-v', '-p', class_file], cwd=cwd,
                         capture_output=True, text=True)
    if sub.returncode != 0:
        raise SystemExit(f'javap 失败：{class_file}\n{sub.stderr[:400]}')
    return sub.stdout


def split_methods(text):
    """把 javap 输出按方法切开：方法名 → 指令行列表"""
    out, cur, buf = {}, None, []
    sig = re.compile(r'^  (?:public|private|protected|static|final|abstract)[^;]*?([A-Za-z0-9_$<>]+)\([^;]*;$')
    for line in text.splitlines():
        # @constraint 静态初始化块在 javap 里写作 `static {};`，不带方法名；
        #      漏掉它就读不到颜色集合的 base 名（createSimpleColored 的参数）。
        if line.strip() == 'static {};':
            if cur:
                out[cur] = buf
            cur, buf = '<clinit>', []
            continue
        m = sig.match(line)
        if m:
            if cur:
                out[cur] = buf
            cur, buf = m.group(1), []
            continue
        if cur is not None:
            buf.append(line)
    if cur:
        out[cur] = buf
    return out


def parse_bootstrap_table(text):
    """InvokeDynamic 序号 → lambda 方法名"""
    table, inside = {}, False
    for line in text.splitlines():
        if line.startswith('BootstrapMethods:'):
            inside = True
            continue
        if not inside:
            continue
        m = re.match(r'^  (\d+): #\d+ REF_invokeStatic java/lang/invoke/LambdaMetafactory', line)
        if m:
            table[int(m.group(1))] = None
            continue
        m = re.search(r'CreativeModeTabs\.(lambda\$[A-Za-z0-9_$]+):', line)
        if m and table:
            last = max(table)
            if table[last] is None:
                table[last] = m.group(1)
    return {k: v for k, v in table.items() if v}


def parse_dye_order(boot):
    """bootstrap 里那串 16 元素 DyeColor 数组 → 颜色顺序"""
    order = []
    for line in boot:
        m = re.search(r'// Field net/minecraft/world/item/DyeColor\.([A-Z_]+):', line)
        if m:
            order.append(m.group(1).lower())
    if len(order) < 16:
        raise SystemExit(f'DyeColor 顺序解析异常：拿到 {len(order)} 个')
    return order[:16]


def parse_tab_bindings(boot, table):
    """bootstrap 指令顺序 → [(tab key, lambda 名, 语言键)]

    @why 语言键要从字节码里的 `ldc "itemGroup.xxx"` 读，不能拿 tab 名拼：
          26.3 的键是 `itemGroup.natural` / `itemGroup.foodAndDrink` 这种，
          与字段名 BUILDING_BLOCKS / FOOD_AND_DRINKS 不是一套拼法。
    """
    pairs, cur, label = [], None, None
    for line in boot:
        m = re.search(r'// Field ([A-Z_]+):Lnet/minecraft/resources/ResourceKey;', line)
        if m:
            cur, label = m.group(1), None
            continue
        m = re.search(r'// String (itemGroup\.[A-Za-z0-9_]+)$', line)
        if m:
            label = m.group(1)
            continue
        m = re.search(r'InvokeDynamic #(\d+):accept:', line)
        if m and cur:
            pairs.append((cur, table.get(int(m.group(1))), label))
            cur, label = None, None
    return [(k, v, l) for k, v, l in pairs if k not in SKIP_TABS]


def parse_tab_items(body, methods):
    """tab 的 lambda 体 → 有序 token

    ('item', 'OAK_PLANKS')     单个物品
    ('colors', 'WOOL')         16 色集合
    ('copper', 'COPPER_BLOCK')  8 个氧化/蜡封变体

    @constraint 颜色集合不能等 `registerColoredItems` 才提交：26.3 里同一个
          集合有两种用法（`registerColoredItems(output, order, c)` 与
          `c.forEach(output::accept)`），只认前者会漏掉染料、收纳袋、马具
          这三整组。集合出现在 tab 的 lambda 里就是为了产出物品，直接记。
    """
    tokens = []
    for line in body:
        m = re.search(r'// Field net/minecraft/world/item/Items\.([A-Z0-9_]+):Lnet/minecraft/world/item/Item;', line)
        if m:
            tokens.append(('item', m.group(1)))
            continue
        m = re.search(r'// Field net/minecraft/world/item/Items\.([A-Z0-9_]+):Lnet/minecraft/world/level/block/ColorCollection;', line)
        if m:
            tokens.append(('colors', m.group(1)))
            continue
        m = re.search(r'// Field net/minecraft/world/item/Items\.([A-Z0-9_]+):Lnet/minecraft/world/level/block/WeatheringCopperCollection;', line)
        if m:
            tokens.append(('copper', m.group(1)))
            continue
        # 铜系列在辅助方法里，调用点内联，两处调用各得一份
        if 'Method copperBlockFamilies:' in line:
            for inner in methods.get('copperBlockFamilies', []):
                m = re.search(r'// Field net/minecraft/world/item/Items\.([A-Z0-9_]+):Lnet/minecraft/world/level/block/WeatheringCopperCollection;', inner)
                if m:
                    tokens.append(('copper', m.group(1)))
    return tokens


def parse_id_names(id_methods):
    """id 类的静态初始化 → ({字段名: 真实 id 基名}, {字段名: 颜色集合 base})

    @why 字段名不等于 id。`Items.DRY_SHORT_GRASS` 的真实 id 是
          `short_dry_grass`（26.3 把词序换了），照字段名小写会得到
          `dry_short_grass` 这种不存在的 id，物品就永远归不了类。
          真实名字只在 `BlockItemId.create("...")` 的参数里，必须读出来。
    """
    names, colors, last = {}, {}, None
    body = id_methods.get('<clinit>') or id_methods.get('static') or []
    for line in body:
        m = re.search(r'// String ([a-z0-9_]+)$', line)
        if m:
            last = m.group(1)
            continue
        if 'Method createSimpleColored:' in line:
            pending_color = last
            continue
        # @constraint 字段注释可能带全限定类名前缀（跨类引用时 javap 会写全
        #      `net/minecraft/references/BlockItemIds.DRY_SHORT_GRASS:`），
        #      只匹配裸字段名会漏掉整整一类。
        m = re.search(r'// Field (?:[\w/$]+\.)?([A-Z0-9_]+):Lnet/minecraft/world/level/block/ColorCollection;', line)
        if m and last:
            colors[m.group(1)] = last
            continue
        m = re.search(r'// Field (?:[\w/$]+\.)?([A-Z0-9_]+):Lnet/minecraft/references/(?:Block)?ItemId;', line)
        if m and last:
            names[m.group(1)] = last
    return names, colors


def main():
    if not os.path.exists(SRC):
        raise SystemExit(f'找不到原版 jar：{SRC}')

    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(SRC) as z:
            for cls in [TABS_CLASS, *ID_CLASSES]:
                z.extract(f'{cls}.class', tmp)
        tabs_text = javap_text(f'{TABS_CLASS}.class', tmp)
        id_texts = [javap_text(f'{c}.class', tmp) for c in ID_CLASSES]

    tabs_methods = split_methods(tabs_text)
    table = parse_bootstrap_table(tabs_text)
    boot = tabs_methods['bootstrap']
    dye = parse_dye_order(boot)
    pairs = parse_tab_bindings(boot, table)
    bases, names = {}, {}
    for text in id_texts:
        n, c = parse_id_names(split_methods(text))
        for field, name in n.items():
            names.setdefault(field, name)
        for field, base in c.items():
            bases.setdefault(field, base)

    lang_path = LANG
    lang = json.load(open(lang_path, encoding='utf-8')) if os.path.exists(lang_path) else {}
    known, by_words = set(), {}
    if os.path.exists(ITEM_TABLE):
        known = {i['id'] for i in json.load(open(ITEM_TABLE, encoding='utf-8')).get('items', [])}
        for item_id in known:
            by_words.setdefault(''.join(sorted(item_id.split('_'))), []).append(item_id)

    def resolve(cand):
        """把候选 id 落到真实 id 上，落不上返回 None

        @why 26.3 的 id 引用层与注册表有词序不一致的条目：`BlockItemIds`
              写的是 `dry_short_grass`，注册表里却是 `short_dry_grass`。
              按词集合比对可以救回来，但只在**唯一命中**时采用——`oak_planks`
              与 `planks_oak` 这种双向都能拼出来的情况必须放弃，否则会把
              物品塞进错误的分类。
        """
        if not known or cand in known:
            return cand
        hits = by_words.get(''.join(sorted(cand.split('_'))), [])
        return hits[0] if len(hits) == 1 else None

    tabs, unmapped = [], []
    for key, lam, label_key in pairs:
        tokens = parse_tab_items(tabs_methods.get(lam or '', []), tabs_methods)
        ids = []
        for kind, name in tokens:
            if kind == 'item':
                got = resolve(names.get(name, name.lower()))
                if got:
                    ids.append(got)
            elif kind == 'copper':
                base = name.lower()
                # @constraint 铜块是唯一一个氧化后改名的家族：物品本身叫
                #      `copper_block`，氧化档却是 `exposed_copper` 而不是
                #      `exposed_copper_block`。先按规则试，落不上就砍掉 `_block`。
                stem = base[:-6] if base.endswith('_block') else None
                for v in COPPER_VARIANTS:
                    got = resolve(v.format(b=base))
                    if not got and stem:
                        got = resolve(v.format(b=stem))
                    if got:
                        ids.append(got)
            else:
                base = bases.get(name)
                if not base:
                    unmapped.append(name)
                    continue
                for c in dye:
                    got = resolve(f'{c}_{base}')
                    if got:
                        ids.append(got)
        if not ids:
            continue
        tab_id = key.lower()
        label = (lang.get(label_key) if label_key else None) or lang.get(f'itemGroup.{tab_id}') or tab_id
        tabs.append({'id': tab_id, 'label': label, 'items': ids})

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'tabs': tabs, '_source': f'{os.path.basename(SRC)}:{TABS_CLASS}'},
                  f, ensure_ascii=False, separators=(',', ':'))

    total = sum(len(t['items']) for t in tabs)
    print(f'写入 {OUT}')
    for t in tabs:
        print(f"  {t['id']:<20}{len(t['items']):>5}  {t['label']}")
    print(f'  合计 {total} 条（颜色已展开）')
    if unmapped:
        print(f'  未找到 base 的颜色集合：{sorted(set(unmapped))}')


if __name__ == '__main__':
    main()
