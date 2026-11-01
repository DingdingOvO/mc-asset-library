#!/usr/bin/env python3
"""
把音效文件映射到官方字幕（subtitle）中文名。

@why 站点上原来只显示 `say1`、`step3` 这种原始文件名，用户并不知道
      「僵尸在叫什么」。游戏里每个音效事件都有字幕键（subtitles.*），
      语言文件里有官方中文翻译，直接取用就是最准的名字，不需要自己编。

@constraint 一个音频文件会被多个事件引用（dig/stone1 同时属于
      block.stone.break 与 block.stone.place）。按 sounds.json 的书写顺序
      取第一个，也就是「破坏」优先于「放置」——这是玩家最常听到的那个。

用法：
    python3 scripts/extract-sound-names.py
    # 需要 /tmp/mc-sounds-def.json（assets 里的 minecraft/sounds.json）
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '26.3'
# 读素材侧 fetch 生成的裸 sounds.json，写到 mc-derived —— 那份才是入库的增强版
ASSETS = os.path.join(ROOT, 'mc-assets', VERSION)
OUT_DIR = os.path.join(ROOT, 'mc-derived', VERSION)
ASSET_INDEX = os.path.join(ROOT, '.cache', 'assets-34.json')
DEF_CACHE = '/tmp/mc-sounds-def.json'


def fetch_definitions():
    """拿 assets 里的 sounds.json（事件定义），缓存到 /tmp 免得反复下载"""
    if os.path.exists(DEF_CACHE):
        return json.load(open(DEF_CACHE, encoding='utf-8'))
    index = json.load(open(ASSET_INDEX, encoding='utf-8'))['objects']
    entry = index['minecraft/sounds.json']
    digest = entry['hash']
    url = 'https://resources.download.minecraft.net/%s/%s' % (digest[:2], digest)
    print('download', url)
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.loads(response.read().decode('utf-8'))
    json.dump(payload, open(DEF_CACHE, 'w', encoding='utf-8'))
    return payload


def main():
    definitions = fetch_definitions()
    lang = json.load(open(os.path.join(ASSETS, 'lang', 'zh_cn.json'), encoding='utf-8'))

    # 文件路径 → (事件名, 字幕中文)。先到先得
    names = {}
    for event, spec in definitions.items():
        subtitle = spec.get('subtitle')
        text = lang.get(subtitle) if subtitle else None
        if not text:
            continue
        for sound in spec.get('sounds', []):
            if isinstance(sound, str):
                name, kind = sound, None
            else:
                name, kind = sound.get('name'), sound.get('type')
            # 别名事件（type=event）指向另一个事件，名字不是文件
            if kind == 'event' or not name:
                continue
            name = re.sub(r'^minecraft:', '', name)
            name = re.sub(r'\.ogg$', '', name)
            names.setdefault(name, (event, text))

    data = json.load(open(os.path.join(ASSETS, 'sounds.json'), encoding='utf-8'))
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, 'sounds.json')

    hit = 0
    for item in data['items']:
        found = names.get(item['p'])
        if found:
            hit += 1
            item['s'] = found[1]
            item['e'] = found[0]
        else:
            item.pop('s', None)
            item.pop('e', None)

    json.dump(data, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    total = len(data['items'])
    print('%d/%d 个音效有官方字幕（%.0f%%）' % (hit, total, hit * 100 / max(1, total)))


if __name__ == '__main__':
    sys.exit(main())
