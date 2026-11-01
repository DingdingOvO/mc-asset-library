import { useEffect, useMemo, useRef, useState } from 'react'
import { PauseIcon, PlayIcon } from './icons'
import { loadSounds, soundSrc } from '@/lib/mc'
import { relatedSounds } from '@/lib/soundLinks'
import { useAsync } from '@/lib/useAsync'

interface SoundLinksProps {
  version: string
  kind: 'block' | 'item' | 'entity'
  id: string
  /** 折叠时先显示几条 */
  limit?: number
}

/**
 * 详情页里的「关联音效」。
 *
 * @why 素材站的下一个动作通常是"我要把这只猪放进我的游戏"，接着要的就是它的叫声。
 *      音效索引 260KB，只在打开详情弹窗时才拉，列表页不受影响。
 *
 * @constraint 展开必须在原地：之前这里是个跳去 /sounds 的链接，用户点「查看全部」
 *      会直接离开详情页，回来还得重新找刚才那个方块。全部条目就在这里滚。
 */
export function SoundLinks({ version, kind, id, limit = 6 }: SoundLinksProps) {
  const { data, loading } = useAsync(`sounds:${version}`, () => loadSounds(version))
  const [playing, setPlaying] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  const list = useMemo(() => (data ? relatedSounds(data.items, kind, id) : []), [data, kind, id])
  const shown = expanded ? list : list.slice(0, limit)

  useEffect(() => {
    return () => {
      audioRef.current?.pause()
    }
  }, [])

  // 换对象就停掉上一只的叫声，否则点开下一只时上一只还在叫
  useEffect(() => {
    audioRef.current?.pause()
    setPlaying(null)
    setExpanded(false)
  }, [id])

  const toggle = (path: string) => {
    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio
    if (playing === path) {
      audio.pause()
      setPlaying(null)
      return
    }
    audio.src = soundSrc(version, path)
    audio.onended = () => setPlaying(null)
    void audio
      .play()
      .then(() => setPlaying(path))
      .catch(() => setPlaying(null))
  }

  if (loading) return <p className="dl__note">正在查找关联音效…</p>
  if (list.length === 0) return <p className="dl__note">这个版本里没有与之对应的音效文件</p>

  return (
    <>
      <div className={`sndrel${expanded ? ' sndrel--tall' : ''}`}>
        {shown.map((sound) => (
          <button
            key={sound.path}
            type="button"
            className="sndrel__row"
            aria-pressed={playing === sound.path}
            onClick={() => toggle(sound.path)}
            title={sound.event ? `${sound.path}\n${sound.event}` : sound.path}
          >
            <span className="sndrel__play">{playing === sound.path ? <PauseIcon /> : <PlayIcon />}</span>
            <span className="sndrel__name">{sound.zh ?? sound.name}</span>
            <span className="sndrel__dir">
              {sound.zh && sound.name !== sound.zh ? `${sound.name} · ` : ''}
              {sound.label}
            </span>
          </button>
        ))}
      </div>
      {list.length > limit && (
        <button type="button" className="text-link text-link--btn" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起' : `展开全部 ${list.length} 个音效`}
        </button>
      )}
    </>
  )
}
