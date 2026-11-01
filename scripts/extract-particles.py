#!/usr/bin/env python3
"""
从反编译源码抽取粒子参数，生成 particledata.json。

@why particles/*.json 只有贴图名，没有一个字说明这个粒子多大、活多久、会不会缩。
      这些全在 Java 里（ParticleResources 的注册表 + 各 *Particle 的构造函数），
      不翻源码就只能瞎猜——而"粒子看起来像不像游戏里的"几乎全靠尺寸与生命周期。

@constraint 不逐类内联 getQuadSize 的公式：粒子有八十多个类，公式五花八门
      （有的按 age 缩小、有的先放大再缩、有的按随机量抖）。这里只抽出
      「末帧相对首帧的缩放系数」，足以复现"火焰越烧越小"这类最显眼的特征，
      同时保证数据表不会随版本微调而大改。

用法：
    unzip -q /workspace/.cache/client-26.3.jar "net/minecraft/client/particle/*" -d /tmp/pcls
    java -jar /tmp/cfr.jar /tmp/pcls/net/minecraft/client/particle/*.class --outputdir /tmp/particlesrc
    python3 scripts/extract-particles.py
"""
import json
import os
import re
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
ASSETS = os.path.join(ROOT, 'mc-assets', VERSION)
DERIVED = os.path.join(ROOT, 'mc-derived', VERSION)
SRC = '/tmp/particlesrc/net/minecraft/client/particle'

NUM = r'(-?\d+(?:\.\d+)?)([fFdD])?'


def strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'//[^\n]*', '', text)


def png_size(path):
    """只读 IHDR，不依赖 PIL"""
    try:
        with open(path, 'rb') as handle:
            head = handle.read(24)
        if len(head) < 24 or head[:8] != b'\x89PNG\r\n\x1a\n':
            return None
        return struct.unpack('>II', head[16:24])
    except OSError:
        return None


def registrations():
    """
    ParticleTypes.X → Provider 类名。

    @why 粒子的 id（flame、crit）与类名（FlameParticle、CritParticle）看着像，
          但并不总对得上：campfire_cosy_smoke 用的是 CampfireSmokeParticle.CosyProvider，
          dust 是 DustParticle，而 explosion 是 ExplodeParticle。只有注册表说了算。
    """
    path = os.path.join(SRC, 'ParticleResources.java')
    text = strip_comments(open(path, encoding='utf-8', errors='replace').read())
    out = {}
    for match in re.finditer(
        r'register\(\s*(?:\(ParticleType\))?\s*ParticleTypes\.(\w+)\s*,\s*([\w.]+)::new', text
    ):
        out[match.group(1)] = match.group(2)
    for match in re.finditer(
        r'register\(\s*(?:\(ParticleType\))?\s*ParticleTypes\.(\w+)\s*,\s*new\s+([\w.]+)\(', text
    ):
        out.setdefault(match.group(1), match.group(2))
    return out


def class_body(name):
    """取某个类的类体（同名内部类会混在一起，正则抽数值时够用）"""
    path = os.path.join(SRC, name + '.java')
    if not os.path.exists(path):
        return None
    text = strip_comments(open(path, encoding='utf-8', errors='replace').read())
    # 顶层类名可能带泛型
    hit = re.search(r'class\s+%s\b[^{]*\{' % re.escape(name), text)
    if not hit:
        return text
    return text[hit.end():]


def first_assign(body, field):
    """`this.quadSize = 0.1f` 这类赋值，取第一个能解析的常量"""
    for match in re.finditer(r'this\.%s\s*=\s*%s' % (field, NUM), body):
        return float(match.group(1))
    return None


def end_scale(body):
    """
    末帧相对首帧的缩放：从 getQuadSize 里抽。

    @why 火焰是 quadSize * (1 - s²·0.5)（越烧越小），爆炸是 (1 - s) 之类。
          直接抄公式要内联大量 Java 表达式；只取 s=1 时的系数就够还原"缩小"这个观感。
    """
    hit = re.search(r'getQuadSize\s*\([^)]*\)\s*\{', body)
    if not hit:
        return None
    tail = body[hit.end():hit.end() + 400]
    # 只看 return 那一行
    line = re.search(r'return\s+([^;]+);', tail)
    if not line:
        return None
    expr = line.group(1)
    # 固定放大：return this.quadSize * 2.0f
    fixed = re.fullmatch(r'\s*(?:this\.)?quadSize\s*\*\s*' + NUM + r'\s*', expr)
    if fixed:
        return float(fixed.group(1))
    # 随 age 变化：取表达式里 s（归一化年龄）为 1 时的系数
    if 's' in expr and 'quadSize' in expr:
        coeffs = re.findall(r'[+-]\s*s\s*\*\s*s\s*\*\s*' + NUM, expr) or re.findall(
            r'[+-]\s*s\s*\*\s*' + NUM, expr
        )
        if coeffs:
            value = 1.0
            for raw in re.findall(r'([+-])\s*s(?:\s*\*\s*s)?\s*\*\s*' + NUM, expr):
                value += (-1 if raw[0] == '-' else 1) * float(raw[1])
            return round(max(0.0, value), 3)
    return None


def main():
    if not os.path.isdir(SRC):
        print('找不到粒子源码，先反编译到 %s' % SRC)
        return 1

    reg = registrations()
    files = sorted(
        name[:-5]
        for name in os.listdir(SRC)
        if name.endswith('.java') and name not in ('ParticleResources', 'ParticleEngine')
    )

    cache = {}
    items = []
    roots = os.path.join(ASSETS, 'particles')
    for filename in sorted(os.listdir(roots)):
        if not filename.endswith('.json'):
            continue
        pid = filename[:-5]
        spec = json.load(open(os.path.join(roots, filename), encoding='utf-8'))
        textures = [re.sub(r'^minecraft:', '', name) for name in spec.get('textures', [])]

        provider = reg.get(pid.upper())
        owner = provider.split('.')[0] if provider else None
        body = class_body(owner) if owner else None
        base = body is None
        if body is None:
            # 注册表没命中就从 id 反推一个类名（flame → FlameParticle）
            guess = ''.join(part.capitalize() for part in pid.split('_')) + 'Particle'
            if guess in files:
                owner, body = guess, class_body(guess)

        size = lifetime = gravity = None
        fade = None
        if body:
            size = first_assign(body, 'quadSize')
            lifetime = first_assign(body, 'lifetime')
            gravity = first_assign(body, 'gravity')
            fade = end_scale(body)

        frames = []
        for name in textures:
            size_px = png_size(os.path.join(ASSETS, 'textures', 'particle', name + '.png'))
            frames.append([name, size_px[0] if size_px else None, size_px[1] if size_px else None])

        items.append(
            {
                'id': pid,
                'c': owner,
                'q': size if size is not None else 0.15,
                'l': int(lifetime) if lifetime else 20,
                'g': gravity if gravity is not None else 0.0,
                'z': fade,
                'f': frames,
                'd': 1 if base else 0,
            }
        )

    out = {
        'version': VERSION,
        'items': items,
    }
    os.makedirs(DERIVED, exist_ok=True)
    path = os.path.join(DERIVED, 'particledata.json')
    json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    known = sum(1 for item in items if item['c'])
    print('粒子 %d 个，命中源码类 %d 个，有尺寸常量 %d 个'
          % (len(items), known, sum(1 for item in items if item['q'] != 0.15)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
