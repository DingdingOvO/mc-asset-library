#!/usr/bin/env python3
"""
从图层源码里补出「这一层什么条件下才画」。

@why 图层不是无条件绘制的。SheepWoolUndercoatLayer 的 submit() 里有
      `!state.isBaby && woolColor != WHITE` —— 白绵羊根本不该有底绒层。
      只按「有这个图层 + 有这张贴图」就去画，结果是白绵羊身上糊了一层成年尺寸的
      白色绒点（底层几何是成年体），幼年羊更是整只被白点包住，看起来就是渲染坏了。
      这些条件全部写在源码里，抽出来存进数据，运行时只做查表。

@constraint 独立脚本，不塞进 extract-layers.py：后者要整套反编译源码才能跑完整，
      而这里只做「读 51 个图层类 + 合并标记」，重跑的成本和风险都低一个量级。

输入：<rendsrc>/net/minecraft/client/renderer/entity/layers、entitylayers.json
输出：原地更新 entitylayers.json（给图层加 b / y 标记）
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = sys.argv[1] if len(sys.argv) > 1 else '26.3'
SRC = sys.argv[2] if len(sys.argv) > 2 else '/tmp/rendsrc/net/minecraft/client/renderer/entity/layers'
LAYERS = os.path.join(ROOT, 'mc-derived', VERSION, 'entitylayers.json')


def submit_body(source):
    """只取 submit(...) 的方法体：构造器里的 modelSet 引用不能当门控条件"""
    m = re.search(r'\bvoid\s+submit\s*\(', source)
    if not m:
        return source
    depth = 0
    start = source.index('{', m.end())
    for i in range(start, len(source)):
        if source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
            if depth == 0:
                return source[start:i + 1]
    return source[start:]


def gates_of(source):
    body = submit_body(source)
    out = {}
    """
    @constraint 同一个条件在两种反编译产物里写法相反：
          vineflower 是 `if (!state.isBaby && ...) { 画 }`，
          CFR 是 `if (... || state.isBaby) return;`。
          所以不能按 `!isBaby` 字面匹配，只能看「方法体里出现了 isBaby，
          但又没有 isBaby ? babyModel : adultModel 这种二选一」——
          出现却不用来选择模型，就说明它是排除条件。
    """
    if 'isBaby' in body and not re.search(r'isBaby\s*\?', body):
        out['b'] = 0
    # 只有非白染料才画（染色过的羊才有底绒）
    if 'DyeColor.WHITE' in body:
        out['y'] = 1
    return out


def main():
    file = json.load(open(LAYERS))
    changed = 0
    missing = set()
    for entity, entries in file.get('layers', {}).items():
        for entry in entries:
            cls = entry.get('c')
            if not cls:
                continue
            path = os.path.join(SRC, cls + '.java')
            if not os.path.exists(path):
                missing.add(cls)
                continue
            flags = gates_of(open(path, encoding='utf-8').read())
            if not flags:
                continue
            before = dict(entry)
            entry.update(flags)
            if entry != before:
                changed += 1
    with open(LAYERS, 'w', encoding='utf-8') as fh:
        json.dump(file, fh, ensure_ascii=False, separators=(',', ':'))
    print('layers annotated:', changed)
    print('class not found  :', sorted(missing)[:10], len(missing))
    for key in ('sheep', 'cat', 'wolf', 'horse'):
        print(' ', key, json.dumps(file['layers'].get(key), ensure_ascii=False)[:400])


if __name__ == '__main__':
    main()
