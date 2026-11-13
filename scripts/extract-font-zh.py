#!/usr/bin/env python3
"""从 unifont.zip 抽出中文点阵子集，供容器标题渲染。

Minecraft 的 Latin 字形在 textures/font/ascii.png（16x16 格、每格 8x8），
中文不在那里：原版走 font/default.json 的 unihex provider，数据是
font/unifont.zip 里的 unifont_all_no_pua-*.hex。

hex 每行形如 `7BB1:10401040...`（码点 + 32 个十六进制字符），32 个字符
是 16 行 × 每行 4 个 hex（16 位）。UnihexProvider 的规则：
    width   = right - left + 1        （左右各裁掉全透明列）
    advance = width / 2 + 1           （位图按 oversample=2 绘制，即屏幕 8px 高）

@why 整包 7.7MB 不能直接下发：站点是给做视频的人用的，为几十个标题字
      多等 7MB 不值得。这里只抽语言文件里真正出现过的字，产物 2KB 上下。

用法：python3 scripts/extract-font-zh.py [mc-assets 根目录]
"""

import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
ASSETS = os.path.join(ROOT, 'mc-assets', VERSION)
DERIVED = os.path.join(ROOT, 'mc-derived', VERSION)

# 这些前缀的文案会出现在容器界面上，是唯一需要中文字形的地方。
KEY_PREFIXES = ('container.', 'merchant.')


def load_lang(name):
    path = os.path.join(ASSETS, 'lang', name)
    if not os.path.exists(path):
        return {}
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def wanted_text(lang):
    """取出所有会画到界面上的文案。

    @why 除了语言文件里 container./merchant. 开头的键，还要把 containers.json
          里动态层的文案一起收进来：信标的 Primary/Secondary 标题和铁砧的
          "附魔花费"不在那两个前缀下，漏掉就会在面板上渲染成一排问号。
    @constraint 依赖 extract-containers.py 先跑。顺序写在 package.json 的
          fonts 脚本里，这里不再自行推导。
    """
    out = [value for key, value in lang.items() if key.startswith(KEY_PREFIXES)]

    derived = os.path.join(DERIVED, 'containers.json')
    if os.path.exists(derived):
        with open(derived, encoding='utf-8') as handle:
            data = json.load(handle)
        for container in data.get('containers', []):
            # @why name 是容器在列表里的中文名，村民的标题模板被 plain_title
            #      换成它之后，"村民交易"这四个字就从这里进字形表
            for key in ('name', 'titleTextZh', 'labelTextZh'):
                if container.get(key):
                    out.append(container[key])
            for layer in container.get('layers', []):
                for key in ('textZh', 'costZh', 'expensiveZh'):
                    if layer.get(key):
                        out.append(layer[key])
            # @why 状态条的控件标题（"显示经验条""全部缺货"）也画在画布上，
            #      漏掉的话调参数时那一行就是问号。
            for control in container.get('controls', []):
                if control.get('label'):
                    out.append(control['label'])

    # @why 悬停提示要显示物品名，物品名里 689 个汉字都不在 container. 前缀下。
    #      不收的话 hover 任何一件物品，提示框第一行都是"金合欢木????"。
    items_path = os.path.join(ASSETS, 'items.json')
    if os.path.exists(items_path):
        with open(items_path, encoding='utf-8') as handle:
            items = json.load(handle)
        for item in items.get('items', []):
            if item.get('n'):
                out.append(item['n'])
    return out


def read_hex(zip_path):
    """读 hex 文件成 {码点: 32 位十六进制串}。"""
    with zipfile.ZipFile(zip_path) as archive:
        names = [n for n in archive.namelist() if n.endswith('.hex')]
        if not names:
            raise SystemExit(f'{zip_path} 里没有 .hex')
        raw = archive.read(names[0]).decode('utf-8', 'replace')

    table = {}
    for line in raw.splitlines():
        head, _, bits = line.partition(':')
        if len(bits) != 64:
            continue
        try:
            table[int(head, 16)] = bits
        except ValueError:
            continue
    return table


def bounds(bits):
    """左右各裁掉全透明列，返回 (left, right)。

    @how 位图 16 列，每列看 16 行里有没有非零点亮；与 UnihexProvider.Glyph
         的 left/right 含义一致，宽度直接决定 advance。
    """
    rows = [int(bits[i * 4:(i + 1) * 4], 16) for i in range(16)]
    left, right = 0, 15
    while left <= right and all((row >> (15 - left)) & 1 == 0 for row in rows):
        left += 1
    while right >= left and all((row >> (15 - right)) & 1 == 0 for row in rows):
        right -= 1
    return left, right


def main():
    asset_root = sys.argv[1] if len(sys.argv) > 1 else None
    if asset_root:
        global ASSETS
        ASSETS = os.path.join(asset_root, VERSION)

    font_zip = os.path.join(ASSETS, 'font', 'unifont.zip')
    if not os.path.exists(font_zip):
        raise SystemExit(f'找不到 {font_zip}')

    lang = load_lang('zh_cn.json')
    if not lang:
        raise SystemExit('找不到 zh_cn.json，没有中文就没有字形可抽')

    chars = set()
    for text in wanted_text(lang):
        for ch in text:
            # ascii 用 ascii.png，这里只收图集外的字
            if ord(ch) >= 0x100:
                chars.add(ch)

    hexes = read_hex(font_zip)
    glyphs = {}
    missing = []
    for ch in sorted(chars):
        bits = hexes.get(ord(ch))
        if bits is None:
            missing.append(ch)
            continue
        left, right = bounds(bits)
        if right < left:
            # 全空的字形（如不换行空格），直接给个空 advance
            glyphs[ord(ch)] = {'b': bits, 'a': 4}
            continue
        glyphs[ord(ch)] = {'b': bits, 'l': left, 'r': right, 'a': (right - left + 1) // 2 + 1}

    os.makedirs(DERIVED, exist_ok=True)
    out = os.path.join(DERIVED, 'font-zh.json')
    with open(out, 'w', encoding='utf-8') as handle:
        json.dump({'source': 'zh_cn', 'glyphs': glyphs}, handle, ensure_ascii=False,
                  separators=(',', ':'))

    size = os.path.getsize(out)
    print(f'{len(glyphs)} 个字形 → {out} ({size / 1024:.1f} KB)')
    if missing:
        print(f'⚠ unifont 里缺这些字：{"".join(missing)}')


if __name__ == '__main__':
    main()
