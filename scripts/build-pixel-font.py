#!/usr/bin/env python3
"""把 unifont 点阵转成网页可用的 woff2，让站点的字和游戏界面里的字是同一套。

@why 容器工作台里的字是 `unifont.zip` 的 16×16 点阵（见 extract-font-zh.py），
      站点的标题、导航、卡片名却是系统无衬线：Linux 上落到 DejaVu + Noto CJK，
      Windows 上是 Segoe UI + 微软雅黑。同一个页面两套字形，游戏素材站看起来
      像个普通后台。这里把点阵包成真字体，全站一套字。

@constraint 只收 GB2312 能编码的 6763 个汉字，不是整个 CJK 区。整区 2 万字
      的 woff2 是 1.1MB，首屏白屏时间翻倍；GB2312 覆盖现代汉语通用字，
      超出的生僻字由 font-family 的下一项兜底，不影响阅读。

@constraint unitsPerEm 必须是 16。点阵每格正好一个 em 单位，字号取 16 的整数倍
      时一个位图像素落在一个设备像素上；取 13/14px 会让每个方块跨在
      1.3 个像素上，边缘糊成灰边——那正是"字体烂"的观感来源。

用法：python3 scripts/build-pixel-font.py [mc-assets 根目录]
"""

import os
import sys
import zipfile

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
ASSETS = os.path.join(ROOT, 'mc-assets', VERSION)
OUT = os.path.join(ROOT, 'public', 'fonts', 'unifont-ui.woff2')

# unifont 的 16 行里，基线在第 14 行下沿：上面 14 行是 ascent，下面 2 行是 descent
ASCENT = 14
DESCENT = 2


def gb2312_chars():
    """GB2312 的全部字符（含一级 3755 字、二级 3008 字与符号区）。"""
    chars = set()
    for hi in range(0xA1, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.add(bytes([hi, lo]).decode('gb2312'))
            except UnicodeDecodeError:
                continue
    return chars


def wanted_codepoints():
    """要打进字体里的码点。"""
    cps = set(range(0x20, 0x7F))  # ASCII 可见字符
    cps |= set(range(0xA0, 0x100))  # Latin-1（° ± × 之类）
    cps |= set(range(0x3000, 0x3040))  # 中文标点
    cps |= set(range(0xFF01, 0xFF5F))  # 全角 ASCII
    cps |= {0x2013, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2022, 0x2030}
    cps |= {0x2190, 0x2191, 0x2192, 0x2193, 0x25B2, 0x25B4, 0x25BC, 0x25BE}
    cps |= {0x2713, 0x2717, 0x25CF, 0x25CB, 0x25A0, 0x25A1, 0x2605, 0x2606}
    for char in gb2312_chars():
        cps.add(ord(char))
    return cps


def read_hex(zip_path):
    """读 hex 文件成 {码点: 32 位十六进制串}。"""
    with zipfile.ZipFile(zip_path) as archive:
        names = [name for name in archive.namelist() if name.endswith('.hex')]
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


def span(bits):
    """左右裁掉全透明列，返回 (left, right)；与 UnihexProvider 的规则一致。"""
    rows = [int(bits[i * 4:(i + 1) * 4], 16) for i in range(16)]
    left, right = 0, 15
    while left <= right and all((row >> (15 - left)) & 1 == 0 for row in rows):
        left += 1
    while right >= left and all((row >> (15 - right)) & 1 == 0 for row in rows):
        right -= 1
    return left, right


def draw(pen, bits, left, right):
    """
    把点阵画成轮廓。

    @how 逐行合并水平连续的亮点画成一个宽矩形。汉字横画多，合并之后每个字
         大约 40 个矩形，不合并是 150+ 个小方块——轮廓点数差三倍，woff2 体积
         和首次排版耗时都跟着涨。
    """
    rows = [int(bits[i * 4:(i + 1) * 4], 16) for i in range(16)]
    for index, row in enumerate(rows):
        y_bottom = ASCENT - 1 - index
        y_top = y_bottom + 1
        x = left
        while x <= right:
            if (row >> (15 - x)) & 1 == 0:
                x += 1
                continue
            start = x
            while x <= right and (row >> (15 - x)) & 1:
                x += 1
            pen.moveTo((start, y_bottom))
            pen.lineTo((x, y_bottom))
            pen.lineTo((x, y_top))
            pen.lineTo((start, y_top))
            pen.closePath()


def main():
    args = [item for item in sys.argv[1:] if not item.startswith('--')]
    if args:
        global ASSETS
        ASSETS = os.path.join(args[0], VERSION)

    font_zip = os.path.join(ASSETS, 'font', 'unifont.zip')
    if not os.path.exists(font_zip):
        raise SystemExit(f'找不到 {font_zip}')

    table = read_hex(font_zip)
    cps = sorted(cp for cp in wanted_codepoints() if cp in table)
    print(f'点阵 {len(table)} 个字形，选中 {len(cps)} 个')

    names = []
    glyphs = {}
    metrics = {}
    cmap = {}

    # .notdef 画一个空心方框，缺字时看得出来是缺字而不是空白
    notdef = TTGlyphPen(None)
    notdef.moveTo((1, 0))
    notdef.lineTo((15, 0))
    notdef.lineTo((15, 14))
    notdef.lineTo((1, 14))
    notdef.closePath()
    glyphs['.notdef'] = notdef.glyph()
    metrics['.notdef'] = (16, 1)
    names.append('.notdef')

    for cp in cps:
        if cp < 0x80:
            name = f'uni{cp:04X}'
        else:
            name = f'uni{cp:04X}'
        bits = table[cp]
        left, right = span(bits)
        pen = TTGlyphPen(None)
        if right >= left:
            draw(pen, bits, left, right)
        wide = (right - left + 1) > 8
        advance = 16 if wide else 8
        # @why 拉丁半角字形的左侧留白按 span 左边界走，否则 'i' 和 'm'
        #      会挤在一起——点阵本身带留白，但 advance 只有 8，得让它居中
        offset = max(0, (advance - (right - left + 1)) // 2)
        glyphs[name] = pen.glyph()
        if offset:
            glyphs[name].coordinates.translate((offset - left, 0))
        elif left:
            glyphs[name].coordinates.translate((-left, 0))
        metrics[name] = (advance, 0)
        cmap[cp] = name
        names.append(name)

    fb = FontBuilder(16, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ASCENT, descent=-DESCENT)
    fb.setupNameTable(
        {
            'familyName': 'Unifont UI',
            'styleName': 'Regular',
            'uniqueFontIdentifier': 'UnifontUI-Regular',
            'fullName': 'Unifont UI Regular',
            'psName': 'UnifontUI-Regular',
            'version': 'Version 1.0',
            'licenseDescription': 'GNU Unifont, SIL Open Font License 1.1',
        }
    )
    fb.setupOS2(sTypoAscender=ASCENT, sTypoDescender=-DESCENT, usWinAscent=ASCENT, usWinDescent=DESCENT)
    fb.setupPost()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    fb.font.flavor = 'woff2'
    fb.save(OUT)
    size = os.path.getsize(OUT)
    print(f'{OUT}  {size / 1024:.0f} KB  {len(names)} 字形')


if __name__ == '__main__':
    main()
