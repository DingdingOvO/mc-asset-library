#!/usr/bin/env python3
"""
从反编译的 CreativeModeTabs 提取创造栏的真实分类与顺序。

@why 之前的分类是猜的（按 id 正则），颜色变体、工具材料全混在一起。
      游戏里每个标签页的物品注册顺序是写死的，照抄过来才和游戏一致：
      羊毛就是按 白→浅灰→灰→黑→棕→红… 这个顺序排。

输入：反编译后的 CreativeModeTabs.java
输出：creativetabs.json
"""
import json
import re
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/tabs.java'
# 输出进 mc-derived：创造栏顺序来自反编译的 CreativeModeTabs
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'mc-derived', VERSION, 'creativetabs.json')
LANG = sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, 'mc-assets', VERSION, 'lang/zh_cn.json')

# tab 变量名 → 注册表 id
TAB_IDS = {
    'buildingBlocks': 'building_blocks',
    'coloredBlocks': 'colored_blocks',
    'naturalBlocks': 'natural_blocks',
    'functionalBlocks': 'functional_blocks',
    'redstoneBlocks': 'redstone_blocks',
    'toolsAndUtilities': 'tools_and_utilities',
    'combat': 'combat',
    'consumables': 'food_and_drinks',
    'ingredients': 'ingredients',
    'spawnEggs': 'spawn_eggs',
    'opBlocks': 'op_blocks',
}

# 标签页显示顺序（和游戏里一致）
TAB_ORDER = [
    'building_blocks', 'colored_blocks', 'natural_blocks', 'functional_blocks',
    'redstone_blocks', 'tools_and_utilities', 'combat', 'food_and_drinks',
    'ingredients', 'spawn_eggs', 'op_blocks',
]

LABEL_KEYS = {
    'building_blocks': 'itemGroup.buildingBlocks',
    'colored_blocks': 'itemGroup.coloredBlocks',
    'natural_blocks': 'itemGroup.naturalBlocks',
    'functional_blocks': 'itemGroup.functionalBlocks',
    'redstone_blocks': 'itemGroup.redstoneBlocks',
    'tools_and_utilities': 'itemGroup.toolsAndUtilities',
    'combat': 'itemGroup.combat',
    'food_and_drinks': 'itemGroup.foodAndDrinks',
    'ingredients': 'itemGroup.ingredients',
    'spawn_eggs': 'itemGroup.spawnEggs',
    'op_blocks': 'itemGroup.opBlocks',
}

FALLBACK_LABEL = {
    'natural_blocks': '自然方块',
    'functional_blocks': '功能方块',
    'redstone_blocks': '红石方块',
    'tools_and_utilities': '工具与实用物品',
    'food_and_drinks': '食物与饮品',
    'op_blocks': '管理员物品',
}


def camel_to_snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()


def main():
    src = open(SRC, encoding='utf-8', errors='ignore').read()

    # 颜色顺序
    m = re.search(r'gameplayColorOrder = List\.of\(([^)]+)\)', src)
    colors = re.findall(r'DyeColor\.(\w+)', m.group(1)) if m else [
        'WHITE', 'LIGHT_GRAY', 'GRAY', 'BLACK', 'BROWN', 'RED', 'ORANGE', 'YELLOW',
        'LIME', 'GREEN', 'CYAN', 'LIGHT_BLUE', 'BLUE', 'PURPLE', 'MAGENTA', 'PINK',
    ]
    colors = [c.lower() for c in colors]

    # 逐行扫描，遇到标签页声明就切上下文
    tab_start = re.compile(r'Registry\.register\(registry,\s*\w+,\s*CreativeModeTab\.builder.*?\(parameters,\s*(\w+)\)\s*->\s*\{')
    accept = re.compile(r'(\w+)\.accept\(Items\.(\w+)\)')
    colored = re.compile(r'registerColoredItems\((\w+),\s*gameplayColorOrder,\s*Items\.(\w+)\)')

    tabs = {}
    current = None

    for line in src.split('\n'):
        start = tab_start.search(line)
        if start:
            current = start.group(1)
            tabs.setdefault(current, [])
            continue
        if current is None:
            continue

        cm = colored.search(line)
        if cm:
            base = re.sub(r'^DYED_', '', cm.group(2)).lower()
            for color in colors:
                tabs[current].append(f'{color}_{base}')
            continue

        am = accept.search(line)
        if am and am.group(1) == current:
            tabs[current].append(am.group(2).lower())

    lang = {}
    try:
        lang = json.load(open(LANG, encoding='utf-8'))
    except Exception:
        pass

    out = []
    for var, items in tabs.items():
        tab_id = TAB_IDS.get(var)
        if not tab_id:
            continue
        key = LABEL_KEYS.get(tab_id)
        label = (lang.get(key) if key else None) or FALLBACK_LABEL.get(tab_id) or tab_id
        # 去重但保持顺序
        seen = set()
        ordered = []
        for item in items:
            if item in seen:
                continue
            seen.add(item)
            ordered.append(item)
        out.append({'id': tab_id, 'label': label, 'items': ordered})

    out.sort(key=lambda t: TAB_ORDER.index(t['id']) if t['id'] in TAB_ORDER else 99)

    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump({'tabs': out}, fh, ensure_ascii=False, separators=(',', ':'))

    total = sum(len(t['items']) for t in out)
    print(f'标签页 {len(out)} 个，物品 {total} 项')
    for t in out:
        print(f"  {t['id']:22} {t['label']:12} {len(t['items']):5}  {t['items'][:3]}")


if __name__ == '__main__':
    main()
