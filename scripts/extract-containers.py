#!/usr/bin/env python3
"""
从反编译的 Minecraft 源码里提取 GUI 容器布局：槽位坐标、面板尺寸、背景绘制切片。

@why 游戏里每个容器的格子位置不是配置，是 AbstractContainerMenu 子类里一串
      addSlot(new Slot(..., x, y))；面板尺寸与背景切片写在 AbstractContainerScreen
      子类的 super(...) 与 extractBackground。要做出和游戏一致的可编辑容器，这些
      数字只能从源码取，按印象写会错（26.3 的箱子背包第一行是 y=85，不是记忆里的 84）。

@constraint 槽位坐标用声明式表格表达，不写 Java 求值器。源码里的布局要么是字面量，
      要么是 for 循环（上界来自 this.width / this.containerRows），要么藏在父类的
      addStandardInventorySlots。通用求值器要处理跨类调用、字段推导、builder 链，
      任何一种漏判都会静默算错——宁可把表达式抄进表里，再用 check_constants()
      核对每个数字确实出现在对应 .java 里。

@constraint 槽位序号 = 声明顺序（游戏里就是 addSlot 的下标）。物品按这个序号落位。

输入：CFR 反编译后的源码根目录
输出：mc-derived/<version>/containers.json
用法：python3 scripts/extract-containers.py [SRC_ROOT] [OUT] [VERSION]
"""
import ast
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/guisrc'
VERSION = sys.argv[3] if len(sys.argv) > 3 else '26.3'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'mc-derived', VERSION, 'containers.json')


# ------------------------------------------------------------------ 布局原语

def grid(left, top, cols, rows):
    """矩形网格，列内步长 18。对应源码里 for y / for x 的 addSlot。"""
    return [{'x': left + x * 18, 'y': top + y * 18} for y in range(rows) for x in range(cols)]


def row(left, top, count):
    return grid(left, top, count, 1)


def cell(x, y):
    return [{'x': x, 'y': y}]


def std(left, top):
    """AbstractContainerMenu.addStandardInventorySlots：3×9 背包 + 间隔 58 的热键栏。"""
    return grid(left, top, 9, 3) + grid(left, top + 58, 9, 1)


# ------------------------------------------------------------------ 容器表

# @why 每条的坐标都直接对应源码表达式，注释里标了出处。改版本时先读源码再改表，
#      跑 check_constants() 能抓出手抄错。
CONTAINERS = [
    # --- 箱子系：ChestMenu#addChestGrid(8,18) + inventoryTop = 18+rows*18+13
    # @why 只列 1/2/3 行与 6 行：ChestMenu 的构造器接受任意 rows，但游戏里
    #      单箱只生成 1~3 行、大箱子固定 6 行。4/5 行是引擎允许、游戏不存在的
    #      尺寸，摆进工作区会让人以为原版有这种界面。
    ('chest_1', '箱子（1 行）', 'ChestMenu', 'ContainerScreen', {'containerRows': 1},
     lambda r: grid(8, 18, 9, 1) + std(8, 18 + 1 * 18 + 13)),
    ('chest_2', '箱子（2 行）', 'ChestMenu', 'ContainerScreen', {'containerRows': 2},
     lambda r: grid(8, 18, 9, 2) + std(8, 18 + 2 * 18 + 13)),
    ('chest_3', '箱子（3 行）', 'ChestMenu', 'ContainerScreen', {'containerRows': 3},
     lambda r: grid(8, 18, 9, 3) + std(8, 18 + 3 * 18 + 13)),
    ('chest_6', '箱子（6 行）', 'ChestMenu', 'ContainerScreen', {'containerRows': 6},
     lambda r: grid(8, 18, 9, 6) + std(8, 18 + 6 * 18 + 13)),

    # --- ShulkerBoxMenu：for y<3/for x<9 于 (8,18)，std(8,84)
    ('shulker_box', '潜影盒', 'ShulkerBoxMenu', 'ShulkerBoxScreen', {},
     lambda r: grid(8, 18, 9, 3) + std(8, 84)),

    # --- HopperMenu：for x<5 于 (44,20)，std(8,51)
    ('hopper', '漏斗', 'HopperMenu', 'HopperScreen', {},
     lambda r: row(44, 20, 5) + std(8, 51)),

    # --- DispenserMenu#add3x3GridSlots(62,17)，std(8,84)
    ('dispenser', '发射器 / 投掷器', 'DispenserMenu', 'DispenserScreen', {},
     lambda r: grid(62, 17, 3, 3) + std(8, 84)),

    # --- CrafterMenu#addSlots：3×3 于 (26,17)，结果格 (134,35)，std(8,84)
    ('crafter', '合成器', 'CrafterMenu', 'CrafterScreen', {},
     lambda r: grid(26, 17, 3, 3) + cell(134, 35) + std(8, 84)),

    # --- CraftingMenu：addResultSlot(124,35) + addCraftingGridSlots(30,17) 3×3 + std(8,84)
    ('crafting', '工作台', 'CraftingMenu', 'CraftingScreen', {},
     lambda r: cell(124, 35) + grid(30, 17, 3, 3) + std(8, 84)),

    # --- InventoryMenu：结果 (154,28) + 2×2 于 (98,18) + 护甲 4 格 (8, 8+i*18)
    #     + std(8,84) + 副手 (77,62)
    ('inventory', '玩家背包', 'InventoryMenu', 'InventoryScreen', {},
     lambda r: cell(154, 28) + grid(98, 18, 2, 2) + grid(8, 8, 1, 4) + std(8, 84) + cell(77, 62)),

    # --- AbstractFurnaceMenu：输入(56,17) 燃料(56,53) 产物(116,35) + std(8,84)
    ('furnace', '熔炉', 'FurnaceMenu', 'FurnaceScreen', {},
     lambda r: cell(56, 17) + cell(56, 53) + cell(116, 35) + std(8, 84)),
    ('smoker', '烟熏炉', 'SmokerMenu', 'SmokerScreen', {},
     lambda r: cell(56, 17) + cell(56, 53) + cell(116, 35) + std(8, 84)),
    ('blast_furnace', '高炉', 'BlastFurnaceMenu', 'BlastFurnaceScreen', {},
     lambda r: cell(56, 17) + cell(56, 53) + cell(116, 35) + std(8, 84)),

    # --- AnvilMenu：ItemCombinerMenuSlotDefinition.withSlot(0,27,47)(1,76,47)
    #     .withResultSlot(2,134,47)；ItemCombinerMenu 的 std(8,84)
    ('anvil', '铁砧', 'AnvilMenu', 'AnvilScreen', {},
     lambda r: cell(27, 47) + cell(76, 47) + cell(134, 47) + std(8, 84)),

    # --- SmithingMenu：(8,48)(26,48)(44,48) 结果 (98,48)
    ('smithing', '锻造台', 'SmithingMenu', 'SmithingScreen', {},
     lambda r: cell(8, 48) + cell(26, 48) + cell(44, 48) + cell(98, 48) + std(8, 84)),

    # --- EnchantmentMenu：物品(15,47) 青金石(35,47) + std(8,84)
    ('enchanting', '附魔台', 'EnchantmentMenu', 'EnchantmentScreen', {},
     lambda r: cell(15, 47) + cell(35, 47) + std(8, 84)),

    # --- BrewingStandMenu：瓶(56,51)(79,58)(102,51) 材料(79,17) 燃料(17,17) + std(8,84)
    ('brewing', '酿造台', 'BrewingStandMenu', 'BrewingStandScreen', {},
     lambda r: cell(56, 51) + cell(79, 58) + cell(102, 51) + cell(79, 17) + cell(17, 17) + std(8, 84)),

    # --- GrindstoneMenu：(49,19)(49,40) 结果(129,34) + std(8,84)
    ('grindstone', '砂轮', 'GrindstoneMenu', 'GrindstoneScreen', {},
     lambda r: cell(49, 19) + cell(49, 40) + cell(129, 34) + std(8, 84)),

    # --- LoomMenu：旗帜(13,26) 染料(33,26) 图案(23,45) 结果(143,57) + std(8,84)
    ('loom', '织布机', 'LoomMenu', 'LoomScreen', {},
     lambda r: cell(13, 26) + cell(33, 26) + cell(23, 45) + cell(143, 57) + std(8, 84)),

    # --- CartographyTableMenu：(15,15)(15,52) 结果(145,39) + std(8,84)
    ('cartography', '制图台', 'CartographyTableMenu', 'CartographyTableScreen', {},
     lambda r: cell(15, 15) + cell(15, 52) + cell(145, 39) + std(8, 84)),

    # --- StonecutterMenu：输入(20,33) 结果(143,33) + std(8,84)
    ('stonecutter', '切石机', 'StonecutterMenu', 'StonecutterScreen', {},
     lambda r: cell(20, 33) + cell(143, 33) + std(8, 84)),

    # --- MerchantMenu：(136,37)(162,37) 结果(220,37) + std(108,84)
    ('villager', '村民交易', 'MerchantMenu', 'MerchantScreen', {},
     lambda r: cell(136, 37) + cell(162, 37) + cell(220, 37) + std(108, 84)),

    # --- BeaconMenu：paymentSlot (136,110) + std(36,137)
    ('beacon', '信标', 'BeaconMenu', 'BeaconScreen', {},
     lambda r: cell(136, 110) + std(36, 137)),
]


# 容器标题的本地化键。游戏里标题由打开界面的一方传入 Component.translatable(...)，
# 所以只能按容器类型登记；文本本身从 en_us.json 取，绝不手抄。
TITLE_KEYS = {
    'chest_1': 'container.chest',
    'chest_2': 'container.chest',
    'chest_3': 'container.chest',
    'chest_6': 'container.chestDouble',
    'shulker_box': 'container.shulkerBox',
    'hopper': 'container.hopper',
    'dispenser': 'container.dispenser',
    'crafter': 'container.crafter',
    'crafting': 'container.crafting',
    'inventory': 'container.crafting',
    'furnace': 'container.furnace',
    'smoker': 'container.smoker',
    'blast_furnace': 'container.blast_furnace',
    'anvil': 'container.repair',
    'smithing': 'container.upgrade',
    'enchanting': 'container.enchant',
    'brewing': 'container.brewing',
    'grindstone': 'container.grindstone_title',
    'loom': 'container.loom',
    'cartography': 'container.cartography_table',
    'stonecutter': 'container.stonecutter',
    'villager': 'merchant.title',
    'beacon': 'container.beacon',
}


def load_lang(code='en_us'):
    """读语言文件。缺了就把标题留空，不编造。

    @why 标题要出中英两份：中文是默认显示，英文必须留着——做视频的人经常要
          还原官方截图，英文原版标题不能丢。
    """
    path = os.path.join(ROOT, 'mc-assets', VERSION, 'lang', f'{code}.json')
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


# ------------------------------------------------------------------ 源码工具

def strip_comments(text):
    """去掉注释但保留字符串字面量 —— 纹理路径里有 // 的概率虽低，误删会连带吃掉代码。"""
    out = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            j = i + 1
            while j < n:
                if text[j] == '\\':
                    j += 2
                    continue
                if text[j] == '"':
                    break
                j += 1
            out.append(text[i:j + 1])
            i = j + 1
        elif ch == '/' and i + 1 < n and text[i + 1] == '/':
            while i < n and text[i] != '\n':
                i += 1
        elif ch == '/' and i + 1 < n and text[i + 1] == '*':
            i += 2
            while i + 1 < n and not (text[i] == '*' and text[i + 1] == '/'):
                i += 1
            i += 2
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


_CLASS_FILES = None


def class_index():
    global _CLASS_FILES
    if _CLASS_FILES is not None:
        return _CLASS_FILES
    table = {}
    # @why 纹理常量常定义在父类（INVENTORY_LOCATION 就在 AbstractContainerScreen），
    #      只扫 inventory 两个目录会漏，所以整棵源码树建一次索引。
    for root, _dirs, files in os.walk(SRC):
        for name in files:
            if name.endswith('.java'):
                table.setdefault(name[:-5], os.path.join(root, name))
    _CLASS_FILES = table
    return table


def read_class(name):
    path = class_index().get(name)
    if not path:
        return None
    with open(path, encoding='utf-8') as handle:
        return strip_comments(handle.read())


def superclass(name):
    """父类名。

    @constraint 必须先跳过类名后的泛型参数再找 extends ——
      `class AbstractRecipeBookScreen<T extends RecipeBookMenu> extends AbstractContainerScreen<T>`
      里泛型边界上就有一个 extends，用 `[^{]*?extends` 会抓成 RecipeBookMenu，
      父类链断在那里，纹理常量（定义在最顶上的 AbstractContainerScreen）就找不到了。
    """
    source = read_class(name)
    if not source:
        return None
    match = re.search(r'\bclass\s+' + re.escape(name) + r'\b', source)
    if not match:
        return None
    i = match.end()
    depth = 0
    while i < len(source):
        ch = source[i]
        if ch == '<':
            depth += 1
        elif ch == '>':
            depth -= 1
        elif ch == '{':
            return None
        elif depth == 0 and source.startswith('extends', i):
            rest = re.match(r'\s+([\w.]+)', source[i + 7:])
            return rest.group(1).split('.')[-1] if rest else None
        i += 1
    return None


def ancestry(name, depth=6):
    """类 → 父类链。纹理与标签常在父类里，解析必须向上找。"""
    chain, cur = [], name
    while cur and cur not in chain and len(chain) < depth:
        chain.append(cur)
        cur = superclass(cur)
    return chain


def find_body(source, signature):
    """取某个方法/构造器的花括号体。signature 传类名即取构造器。"""
    for match in re.finditer(r'\b' + re.escape(signature) + r'\s*\(', source):
        prefix = source[max(0, match.start() - 8):match.start()].rstrip()
        if prefix.endswith('.') or prefix.endswith('new'):
            continue
        open_pos = source.find('{', match.end())
        if open_pos < 0:
            continue
        if ';' in source[match.end():open_pos]:
            continue
        depth = 0
        i = open_pos
        while i < len(source):
            if source[i] == '{':
                depth += 1
            elif source[i] == '}':
                depth -= 1
                if depth == 0:
                    yield source[open_pos + 1:i]
                    break
            i += 1


def split_args(text):
    args, buf, depth = [], [], 0
    for ch in text:
        if ch in '([{':
            depth += 1
        elif ch in ')]}':
            depth -= 1
        if ch == ',' and depth == 0:
            args.append(''.join(buf).strip())
            buf = []
            continue
        buf.append(ch)
    tail = ''.join(buf).strip()
    if tail:
        args.append(tail)
    return args


def call_args(body, open_paren):
    depth = 0
    i = open_paren
    while i < len(body):
        if body[i] == '(':
            depth += 1
        elif body[i] == ')':
            depth -= 1
            if depth == 0:
                return split_args(body[open_paren + 1:i])
        i += 1
    return []


_EXPR_NODES = None


def evaluate(expr, env):
    """整数算术求值，只认数字、已绑定名字与 +-*/。失败返回 None，绝不猜。

    @constraint 用 AST 节点白名单而不是字符白名单 —— 字符白名单第一版把以数字开头的
      '8' 整条挡掉了，坐标常量全部求值失败，最终表现为「一个容器都解析不出来」。
    """
    global _EXPR_NODES
    if _EXPR_NODES is None:
        _EXPR_NODES = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant, ast.Name,
                       ast.Load, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv,
                       ast.USub, ast.UAdd, ast.Mod)
    expr = expr.strip()
    expr = re.sub(r'\bthis\.', '', expr)
    expr = re.sub(r'^\(\s*(?:int|double|float)\s*\)\s*', '', expr)
    # Java 的 0.0f / 18L 这类字面量后缀，Python 不认
    expr = re.sub(r'(\d)[fFdDlL]\b', r'\1', expr)
    try:
        tree = ast.parse(expr, mode='eval')
    except SyntaxError:
        return None
    for node in ast.walk(tree):
        if not isinstance(node, _EXPR_NODES):
            return None
        if isinstance(node, ast.Constant) and not isinstance(node.value, (int, float)):
            return None
    try:
        value = eval(compile(tree, '<expr>', 'eval'), {'__builtins__': {}}, dict(env))  # noqa: S307
    except Exception:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if value != int(value):
            return None
        value = int(value)
    return value


# ------------------------------------------------------------------ 屏幕解析

IDENT_RE = re.compile(r'Identifier\.withDefaultNamespace\("([^"]+)"\)')


def resolve_identifier(var, chain):
    """把 blit 的纹理实参（常量名 / this.field）解析成资源路径。"""
    var = re.sub(r'^this\.', '', var.strip())
    if not re.fullmatch(r'\w+', var):
        return None
    for cls in chain:
        source = read_class(cls)
        if not source:
            continue
        match = re.search(r'\b' + re.escape(var) + r'\s*=\s*' + IDENT_RE.pattern, source)
        if match:
            return match.group(1)
    return None



def parse_screen(name, env):
    """面板尺寸、容器纹理、背景切片、标签位置。"""
    source = read_class(name)
    if source is None:
        return None

    width, height = 176, 166
    for body in find_body(source, name.split('.')[-1]):
        sup = re.search(r'super\s*\(([^;]*?)\)\s*;', body)
        if not sup:
            continue
        args = split_args(sup.group(1))
        if len(args) >= 5:
            w = evaluate(args[3], env)
            h = evaluate(args[4], env)
            if w is not None:
                width = w
            if h is not None:
                height = h
        if 'getRowCount()' in sup.group(1):
            rows = int(env.get('containerRows', 3))
            height = 114 + rows * 18
        break

    # 背景纹理与切片：沿父类链找 extractBackground / renderBg 里的 blit。
    # @why 熔炉系、铁砧系自己没写绘制，底板与切片都在 AbstractFurnaceScreen /
    #      ItemCombinerScreen 里；箱子则是同一张图切两段（上盖 + 玩家背包）。
    chain = ancestry(name)
    texture = None
    draws = []
    scope_base = dict(env, xo=0, yo=0, leftPos=0, topPos=0, width=0, height=0,
                      imageWidth=width, imageHeight=height)
    for cls in chain:
        cls_src = read_class(cls)
        if not cls_src:
            continue
        bodies = []
        for method in ('extractBackground', 'renderBg'):
            bodies.extend(find_body(cls_src, method))
        if not bodies:
            continue
        for body in bodies:
            for match in re.finditer(r'graphics\.blit\s*\(', body):
                args = call_args(body, match.end() - 1)
                if len(args) < 10:
                    continue
                # blit(pipeline, texture, x, y, u, v, w, h, texW, texH)
                nums = [evaluate(a, scope_base) for a in args[2:10]]
                if any(v is None for v in nums):
                    continue
                if texture is None:
                    texture = resolve_identifier(args[1], chain)
                draws.append({
                    'dx': nums[0], 'dy': nums[1], 'u': nums[2], 'v': nums[3],
                    'w': nums[4], 'h': nums[5], 'texW': nums[6], 'texH': nums[7],
                })
        if draws:
            break

    if not texture:
        for cls in chain:
            cls_src = read_class(cls)
            if not cls_src:
                continue
            found = [c for c in IDENT_RE.findall(cls_src) if 'textures/gui/container/' in c]
            if found:
                texture = found[0]
                break

    labels = {}
    for key, default in (('titleLabelX', 8), ('titleLabelY', 6),
                         ('inventoryLabelX', 8), ('inventoryLabelY', None)):
        value = default
        for match in re.finditer(r'this\.' + key + r'\s*=\s*([^;]+);', source):
            got = evaluate(match.group(1), env)
            if got is not None:
                value = got
                break
        labels[key] = value
    if labels['inventoryLabelY'] is None:
        labels['inventoryLabelY'] = height - 94

    return {'width': width, 'height': height, 'texture': texture, 'draws': draws, 'labels': labels}


# ------------------------------------------------------------------ 核验

def check_bounds(slots, width, height):
    """槽位必须落在面板内 —— 坐标抄错一位最典型的症状就是格子跑到边框外。

    @why 不用「数字必须出现在源码里」来核验：像 26 这种值是 left + x*18 算出来的，
          源码里只有 left 与 18，拿算出来的数去源码里搜必然误报。
    """
    return [(i, s['x'], s['y']) for i, s in enumerate(slots)
            if s['x'] < 0 or s['y'] < 0 or s['x'] + 16 > width or s['y'] + 16 > height]


# ------------------------------------------------------------------ 主流程

def main():
    containers = []
    problems = []
    lang = load_lang()
    lang_zh = load_lang('zh_cn')
    for cid, title, menu, screen, env, layout in CONTAINERS:
        menu_src = read_class(menu)
        screen_src = read_class(screen)
        if menu_src is None or screen_src is None:
            problems.append(f'{cid}: 缺少 {menu} 或 {screen}')
            continue

        slots = layout(env)
        info = parse_screen(screen, env)
        if not info or not info['texture']:
            problems.append(f'{cid}: {screen} 未解析出容器纹理')
            continue
        if not info['draws']:
            problems.append(f'{cid}: {screen} 未解析出背景切片')
            continue

        # 同一格不许出现两次 —— addSlot 顺序错位会直接表现为物品错位
        seen = set()
        for slot in slots:
            key = (slot['x'], slot['y'])
            if key in seen:
                problems.append(f'{cid}: 槽位 {key} 重复')
            seen.add(key)

        outside = check_bounds(slots, info['width'], info['height'])
        for index, x, y in outside:
            problems.append(f'{cid}: 槽位 {index} ({x},{y}) 越出面板 {info["width"]}x{info["height"]}')

        containers.append({
            'id': cid,
            'name': title,
            'menu': menu,
            'screen': screen,
            'width': info['width'],
            'height': info['height'],
            'texture': info['texture'],
            'draws': info['draws'],
            'titleText': lang.get(TITLE_KEYS.get(cid, ''), ''),
            'labelText': lang.get('container.inventory', ''),
            'titleTextZh': lang_zh.get(TITLE_KEYS.get(cid, ''), ''),
            'labelTextZh': lang_zh.get('container.inventory', ''),
            'title': {'x': info['labels']['titleLabelX'], 'y': info['labels']['titleLabelY']},
            'inventoryLabel': {'x': info['labels']['inventoryLabelX'],
                               'y': info['labels']['inventoryLabelY']},
            'slots': slots,
        })

    payload = {'source': VERSION, 'containers': containers}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(',', ':'))

    print(f'{len(containers)} 个容器 → {out_size(OUT)}')
    for item in containers:
        print(f"  {item['id']:<14} {item['width']:>3}x{item['height']:<4} "
              f"槽位 {len(item['slots']):<3} 切片 {len(item['draws'])}  "
              f"{item['texture'].split('/')[-1]}")
    if problems:
        print('\n问题：')
        for line in problems:
            print('  ' + line)


def out_size(path):
    return f'{os.path.getsize(path) / 1024:.1f} KB'


if __name__ == '__main__':
    main()
