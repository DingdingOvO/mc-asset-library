import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { PauseIcon, PlayIcon } from '@/components/icons'
import {
  EmptyState,
  ErrorState,
  FilterChips,
  LoadingState,
  Page,
  PageHeader,
  SearchField,
  Toolbar,
} from '@/ui'
import { useQueryParam } from '@/hooks/useQueryParam'
import { formatBytes, loadSounds, soundSrc } from '@/lib/mc'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import './sounds.css'

const GROUP_LABELS: Record<string, string> = {
  ambient: '环境',
  block: '方块',
  mob: '生物',
  item: '物品',
  entity: '实体',
  music: '音乐',
  step: '脚步',
  random: '随机',
  dig: '破坏',
  liquid: '液体',
  note: '音符盒',
  records: '唱片',
  enchant: '附魔',
  ui: '界面',
  event: '事件',
  fireworks: '烟花',
  damage: '伤害',
  minecart: '矿车',
  portal: '传送门',
  fire: '火焰',
  tile: '旧版方块',
  misc: '杂项',
}

export default function Sounds() {
  const { version, current, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取音效索引…" /></Page>

  /**
   * @constraint 音频有没有随包分发，由版本清单说了算，别在前端猜。
   *      `--no-sounds` 提取的素材里一条 .ogg 都没有，清单照样有 4961 行，
   *      每行都挂个播放按钮，点下去只会 404——先知道这件事，就不用让用户
   *      逐行点一遍才发现全是坏的。
   */
  const canPlay = current?.registrySummary?.find((entry) => entry.id === 'sounds')?.audio === 1

  return <SoundBrowser version={version} canPlay={canPlay} />
}

function SoundBrowser({ version, canPlay }: { version: string; canPlay: boolean }) {
  const { group = 'all' } = useParams()
  const { data, loading, error } = useAsync(`sounds:${version}`, () => loadSounds(version))
  const { value: query, setValue: setQuery, withQuery } = useQueryParam()

  const [playing, setPlaying] = useState<string | null>(null)
  /**
   * @constraint 部署版为了压体积可能不带 .ogg，点播放会 404。原来只是把按钮
   *      弹回未播放状态，用户看到的是「点了没反应」。这里把失败原因说出来，
   *      并且只提示一次。
   */
  const [audioMissing, setAudioMissing] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const items = useMemo(
    // @why 自然排序，避免 cave10 排在 cave2 前面
    () => [...(data?.items ?? [])].sort((a, b) => a.p.localeCompare(b.p, undefined, { numeric: true })),
    [data],
  )

  const groups = useMemo(() => {
    const counter = new Map<string, number>()
    for (const item of items) counter.set(item.g, (counter.get(item.g) ?? 0) + 1)
    return [...counter.entries()]
      .map(([id, count]) => ({ id, count, label: GROUP_LABELS[id] ?? id }))
      .sort((a, b) => b.count - a.count)
  }, [items])

  const filtered = useMemo(() => {
    const scoped = group === 'all' ? items : items.filter((item) => item.g === group)
    const keyword = query.trim().toLowerCase()
    if (!keyword) return scoped
    /**
     * @constraint 三个字段都要搜：中文名是给人看的（"方块：被破坏"），
     *      路径是给人抄进资源包的（block/stone/break1），事件 id（block.stone.break）
     *      是写 sounds.json 时要填的。少搜哪个都会有"明明有却搜不到"。
     */
    return scoped.filter(
      (item) =>
        item.p.toLowerCase().includes(keyword) ||
        (item.s?.toLowerCase().includes(keyword) ?? false) ||
        (item.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [items, group, query])

  const { ref: listRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 56,
    minColumnWidth: 2000,
    resetKey: `${group}|${query}`,
  })

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  const toggle = (id: string) => {
    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio

    if (playing === id) {
      audio.pause()
      setPlaying(null)
      return
    }

    audio.src = soundSrc(version, id)
    audio.onended = () => setPlaying(null)
    void audio
      .play()
      .then(() => setPlaying(id))
      .catch((reason: unknown) => {
        setPlaying(null)
        /**
         * @constraint NotAllowedError 是浏览器的自动播放策略（页面还没拿到
         *      用户手势），不是文件缺失。把它也当成「部署版没带音频」会冤枉
         *      一个功能完好的站点。
         */
        if (reason instanceof DOMException && reason.name === 'NotAllowedError') return
        setAudioMissing(true)
      })
  }

  const activeLabel = group === 'all' ? '全部音效' : (GROUP_LABELS[group] ?? group)

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title={activeLabel}
        lead={
          <>
            <span className="num">{filtered.length}</span> 个音效
            {group !== 'all' && <span className="muted"> · 全站 {items.length} 个</span>}
          </>
        }
      />

      <Toolbar
        meta={`${filtered.length} 条`}
        filters={
          <FilterChips
            allLabel="全部"
            allCount={items.length}
            active={group}
            href={(id) => withQuery(id === 'all' ? '/sounds' : `/sounds/${id}`)}
            items={groups.map((item) => ({ id: item.id, label: item.label, count: item.count }))}
            ariaLabel="音效分类"
          />
        }
      >
        <SearchField
          primary
          value={query}
          onChange={setQuery}
          placeholder={`在 ${activeLabel} 中搜索…`}
        />
      </Toolbar>

      {error && <ErrorState title="索引加载失败" detail={error.message} />}
      {!canPlay && !loading && (
        <p className="notice">
          这份素材没带音频文件（提取时用了 <span className="mono">--no-sounds</span>），只能看清单与中文名。
          要试听请跑 <span className="mono">pnpm run setup</span> 完整下载一次。
        </p>
      )}
      {canPlay && audioMissing && (
        <p className="notice">
          这个音效没能播放出来。音频文件是随包发布的，常见原因是浏览器不支持 Ogg
          Vorbis（Safari 旧版），或刚才那次请求被网络中断了——重试一次通常就好。
        </p>
      )}
      {loading && <LoadingState label="正在加载音效…" />}
      {!loading && filtered.length === 0 && (
        <EmptyState
          title={`没有匹配「${query}」的音效`}
          hint="可以搜中文名、路径或事件 id，例如 破坏、block.stone。"
        />
      )}

      <div
        ref={listRef}
        className="sound-list"
        style={{ paddingTop: padTop || undefined, paddingBottom: padBottom || undefined }}
      >
        {visible.map((sound) => (
          <button
            key={sound.p}
            type="button"
            className="sound-row"
            aria-pressed={playing === sound.p}
            disabled={!canPlay}
            aria-label={canPlay ? undefined : '本地素材未包含音频，无法试听'}
            title={sound.e ? `${sound.s ?? sound.p}\n事件 ${sound.e}` : sound.p}
            onClick={() => toggle(sound.p)}
          >
            <span className="sound-row__play">
              {playing === sound.p ? <PauseIcon /> : <PlayIcon />}
            </span>
            <span className="sound-row__text">
              {/*
                @why 主标题放官方字幕中文名：音效路径是给机器看的，人翻列表时想知道的是
                "这是什么声音"。路径降为副标题，照样能看能复制。
              */}
              <span className="sound-row__name">{sound.s ?? sound.p}</span>
              <span className="sound-row__path">{sound.p}</span>
            </span>
            <span className="badge sound-row__group">{GROUP_LABELS[sound.g] ?? sound.g}</span>
            <span className="sound-row__size">{formatBytes(sound.k)}</span>
          </button>
        ))}
      </div>
    </Page>
  )
}
