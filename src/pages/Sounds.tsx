import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { PauseIcon, PlayIcon } from '@/components/icons'
import { SearchBox } from '@/components/SearchBox'
import { formatBytes, loadSounds, soundSrc } from '@/lib/mc'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { usePaged } from '@/lib/usePaged'

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
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取音效索引…</p>

  return <SoundBrowser version={version} />
}

function SoundBrowser({ version }: { version: string }) {
  const { group = 'all' } = useParams()
  const { data, loading, error } = useAsync(`sounds:${version}`, () => loadSounds(version))
  const [params, setParams] = useSearchParams()

  const [playing, setPlaying] = useState<string | null>(null)
  /**
   * @constraint Pages 部署版为了压体积带了 `--no-sounds`，.ogg 全部缺席，
   *      点播放会 404。原来的 catch 只是把按钮弹回未播放状态，用户看到的是
   *      "点了没反应"，会以为网站坏了。这里把失败原因显式说出来，并且只提示
   *      一次（一个 404 就足以说明整站音频都没带）。
   */
  const [audioMissing, setAudioMissing] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const query = params.get('q') ?? ''
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

  const { visible, sentinelRef, total, shown } = usePaged(filtered, 200)

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
      .catch((error: unknown) => {
        setPlaying(null)
        /**
         * @constraint NotAllowedError 是浏览器的自动播放策略（页面还没拿到
         *      用户手势），不是文件缺失。把它也当成「部署版没带音频」会冤枉
         *      一个功能完好的站点——自动化测试里就复现过这种假阳性。
         */
        if (error instanceof DOMException && error.name === 'NotAllowedError') return
        setAudioMissing(true)
      })
  }

  const activeLabel = group === 'all' ? '全部音效' : (GROUP_LABELS[group] ?? group)

  const updateQuery = (value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set('q', value)
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }

  const withQuery = (path: string) => {
    const suffix = params.toString()
    return suffix ? `${path}?${suffix}` : path
  }

  return (
    <div className="container">
      <div className="page-head">
        <Link to="/" className="text-link">
          ← 返回首页
        </Link>
        <h1>{activeLabel}</h1>
        <p>
          {total} 个音效
          {shown < total && ` · 已显示 ${shown}`}
        </p>
      </div>

      <div className="browse-bar">
        <div className="chips">
          <Link className="chip" to={withQuery('/sounds')} aria-pressed={group === 'all'}>
            全部
            <span className="chip__count">{items.length}</span>
          </Link>
          {groups.map((item) => (
            <Link
              key={item.id}
              className="chip"
              to={withQuery(`/sounds/${item.id}`)}
              aria-pressed={group === item.id}
            >
              {item.label}
              <span className="chip__count">{item.count}</span>
            </Link>
          ))}
        </div>
        <SearchBox
          primary
          value={query}
          onChange={updateQuery}
          placeholder={`在 ${activeLabel} 中搜索…`}
        />
      </div>

      {error && <p className="notice notice--error">索引加载失败：{error.message}</p>}
      {audioMissing && (
        <p className="notice">
          这个音效没能播放出来。音频文件是随包发布的，常见原因是浏览器不支持 Ogg
          Vorbis（Safari 旧版），或刚才那次请求被网络中断了——重试一次通常就好。
        </p>
      )}
      {loading && <p className="empty">正在加载音效…</p>}
      {!loading && filtered.length === 0 && <p className="empty">没有匹配「{query}」的音效</p>}

      <div className="sound-list">
        {visible.map((sound) => (
          <button
            key={sound.p}
            type="button"
            className="sound-row"
            aria-pressed={playing === sound.p}
            title={sound.e ? `${sound.s ?? sound.p}\n事件 ${sound.e}` : sound.p}
            onClick={() => toggle(sound.p)}
          >
            <span className="sound-row__play">
              {playing === sound.p ? <PauseIcon /> : <PlayIcon />}
            </span>
            <span className="sound-row__text">
              {/*
                @why 主标题放官方字幕中文名：音效路径（block/stone/break1）是给机器看的，
                人翻列表时想知道的是"这是什么声音"。路径降为副标题，照样能看能复制。
              */}
              <span className="sound-row__name">{sound.s ?? sound.p}</span>
              <span className="sound-row__path">{sound.p}</span>
            </span>
            <span className="sound-row__group">{GROUP_LABELS[sound.g] ?? sound.g}</span>
            <span className="sound-row__size">{formatBytes(sound.k)}</span>
          </button>
        ))}
      </div>

      <div ref={sentinelRef} className="sentinel" />
    </div>
  )
}
