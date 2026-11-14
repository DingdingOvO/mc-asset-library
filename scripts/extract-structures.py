#!/usr/bin/env python3
"""
把原版建筑结构（.nbt）从客户端 jar 抽出来，并生成索引。

@why 结构是这个站最值钱的现成资源：1511 个原版 .nbt 全在 data/minecraft/structure 下，
      全部加起来只有 4MB。抽出来之后「生成整栋建筑」就不需要任何第三方模型，
      读的就是游戏自己用的文件格式（见 src/lib/world/nbt.ts）。

@constraint 只抽 .nbt，不抽 jigsaw / template_pool 的 JSON：那些是生成规则
      （村庄怎么拼、要塞有几间），不是几何；先有几何再谈拼装。
@constraint 输出进 mc-assets（gitignore），索引进 mc-derived（入库）：
      4MB 二进制可以由这个脚本随时重建，索引是前端要用的清单，必须跟着仓库走。
@constraint 部署链上不跑这个脚本。CI 里 .nbt 由 scripts/fetch-assets.mjs 从 jar
      直接剥到 mc-assets/<version>/structures/（同一批文件、同一套路径），
      索引则由 mc-derived 随仓库分发。本脚本只在需要重建索引时本地跑一次。
      两边路径必须保持一致，改一边就得改另一边。

输入：.cache/client-26.3.jar
输出：mc-assets/<version>/structures/**/*.nbt、mc-derived/<version>/structures.json
"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = sys.argv[1] if len(sys.argv) > 1 else '26.3'
JAR = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, '.cache', f'client-{VERSION}.jar')
OUT_DIR = os.path.join(ROOT, 'mc-assets', VERSION, 'structures')
INDEX = os.path.join(ROOT, 'mc-derived', VERSION, 'structures.json')

PREFIX = 'data/minecraft/structure/'


def main():
    if not os.path.exists(JAR):
        raise SystemExit(f'缺少客户端 jar：{JAR}')

    entries = []
    total = 0
    with zipfile.ZipFile(JAR) as jar:
        for info in jar.infolist():
            name = info.filename
            if not name.startswith(PREFIX) or not name.endswith('.nbt'):
                continue
            rel = name[len(PREFIX):]
            target = os.path.join(OUT_DIR, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with jar.open(info) as src, open(target, 'wb') as dst:
                data = src.read()
                dst.write(data)
            total += len(data)
            parts = rel[:-4].split('/')
            entries.append({
                'path': rel[:-4],
                'name': parts[-1],
                # 顶层目录就是结构类别：village / ancient_city / bastion / …
                'group': parts[0] if len(parts) > 1 else 'misc',
                'bytes': len(data),
            })

    entries.sort(key=lambda item: item['path'])
    groups = {}
    for entry in entries:
        groups[entry['group']] = groups.get(entry['group'], 0) + 1

    payload = {
        'version': VERSION,
        # 长度由前端展示（"7×7×7"），需要读文件才知道，这里只给字节数与类别
        'count': len(entries),
        'groups': groups,
        'files': entries,
    }
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    with open(INDEX, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(',', ':'))

    print('结构数:', len(entries))
    print('总体积: %.2f MB' % (total / 1048576))
    print('类别  :', json.dumps(groups, ensure_ascii=False))
    print('索引  :', INDEX)


if __name__ == '__main__':
    main()
