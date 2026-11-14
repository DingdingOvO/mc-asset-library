import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { ParticleThumb, ParticleView } from '@/components/ParticleView'
import { SearchBox } from '@/components/SearchBox'
import { CloseIcon } from '@/components/icons'
import { loadParticles, type ParticleDef } from '@/lib/particles'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { tipAttrs } from '@/lib/tip'

export default function Particles() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取粒子数据…</p>

  return <ParticleBrowser version={version} />
}

function ParticleBrowser({ version }: { version: string }) {
  const particles = useAsync(`particles:${version}`, () => loadParticles(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)

  const all = useMemo(() => particles.data?.items ?? [], [particles.data])
  const query = params.get('q') ?? ''

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return all
    return all.filter((item) => item.id.includes(keyword) || (item.c ?? '').toLowerCase().includes(keyword))
  }, [all, query])

  // 缩略图是 <img>，但 115 张一起解码也不便宜，仍然走虚拟滚动
  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 116,
    minColumnWidth: 96,
  })

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

  const active = selected ? (all.find((item) => item.id === selected) ?? null) : null

  return (
    <>
      <div className="container">
        <div className="page-head">
          <Link to="/" className="text-link">
            ← 返回首页
          </Link>
          <h1>粒子</h1>
          <p>{all.length} 个粒子 · 尺寸与生命周期取自 ParticleResources 注册表与各类源码</p>
        </div>

        <div className="browse-bar">
          <SearchBox primary value={query} onChange={updateQuery} placeholder="搜索粒子…" />
        </div>

        {particles.error && <p className="notice notice--error">加载失败：{particles.error.message}</p>}
        {particles.loading && <p className="empty">正在加载粒子参数…</p>}
        {!particles.loading && filtered.length === 0 && <p className="empty">没有匹配「{query}」的粒子</p>}

        <div className="particle-grid" ref={gridRef} style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              className="particle-cell"
              aria-pressed={selected === item.id}
              {...tipAttrs(item.id, undefined, item.c ?? '未注册到具体类')}
              onClick={() => setSelected(item.id)}
            >
              <ParticleThumb version={version} def={item} size={64} />
              <span className="particle-cell__name">{item.id}</span>
              <span className="particle-cell__meta">
                {item.q.toFixed(2)} 格 · {item.l}t
              </span>
            </button>
          ))}
        </div>
      </div>

      {active && (
        <ParticleModal version={version} def={active} onClose={() => setSelected(null)} />
      )}
    </>
  )
}

/**
 * 颜色由运行时参数决定的粒子：源码里只有一张白贴图，真正的颜色是
 * SpellParticleOption / DustColorTransitionOption 之类传进来的。
 * @why 不染色它们就是一片白，在白底或浅色舞台上等于看不见——
 *      "效果云那些用不了"有一半是这个原因。
 */
const TINTABLE = new Set(['SpellParticle', 'DustParticle', 'DustColorTransitionParticle', 'FallingLeavesParticle'])

/** 游戏里不是一张贴图的粒子，说明清楚，别让人以为渲染错了 */
const NOTE: Record<string, string> = {
  VibrationSignalParticle: '游戏里它画的是从声源到目标的一条振动连线，不是一个四边形，这里只能给出它的贴图',
  FireworkParticles: '烟花爆开的中心闪光，尺寸在两帧内从 0 涨到满，之后立刻消失',
  FallingLeavesParticle: '树叶粒子会按群系染色，并带朝向与翻滚；这里只演示贴图与尺寸',
  SpellParticle: '药水效果漩涡：颜色由药水决定（速度青、力量红、中毒绿……），形状是这张白贴图',
}

/**
 * 粒子详情。
 *
 * @why 不复用 ModelModal：那个弹窗的重心是"立体模型 + 骨骼动作 + 3D 导出"，
 *      粒子没有骨骼也没有可导出的网格，硬塞进去只会让两边都别扭。
 *      粒子真正需要的是「看清这张贴图 + 它在游戏里有多大」。
 */
function ParticleModal({ version, def, onClose }: { version: string; def: ParticleDef; onClose: () => void }) {
  const auto = Math.min(12, Math.max(0.15, 0.34 / Math.max(0.02, def.q)))
  const [zoom, setZoom] = useState(auto)
  /**
   * @why 除了按类判断，还要按贴图判断：ambient_entity_effect / trial_spawner_detection_ominous
   *      这两个 id 在 26.3 的 ParticleResources 里没有注册渲染器，但贴图就是
   *      effect_* 那一套白漩涡，颜色同样是运行时给的，不染色一样看不见。
   */
  const tintable =
    TINTABLE.has(def.c ?? '') || /^(effect|spell)_\d+$/.test(def.f[0]?.[0] ?? '')
  const [tint, setTint] = useState('#b06ce0')

  const seconds = def.l / 20

  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--block"
        role="dialog"
        aria-modal="true"
        aria-label={def.id}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal__close" onClick={onClose} aria-label="关闭">
          <CloseIcon />
        </button>

        <div className="modal__view">
          <div className="particle-stage">
            <ParticleView version={version} def={def} size={300} zoom={zoom} tint={tintable ? tint : undefined} />
          </div>
          <div className="modal__ctl">
            <span className="modal__kind">
              {def.f.length > 1 ? `贴图动画 · ${def.f.length} 帧` : '静态贴图'} · {def.l} tick
            </span>
          </div>
          <span className="modal__hint">
            边长 {def.q.toFixed(2)} 格 · 显示缩放 {zoom.toFixed(1)}×
          </span>
        </div>

        <div className="modal__side">
          <div className="modal__head">
            <div className="detail__name">{def.id}</div>
            <div className="detail__en">{def.c ?? '未在 ParticleResources 中注册'}</div>
          </div>
          <div className="modal__body">
            <div className="kv-list">
              <div className="kv">
                <span className="kv__key">渲染类</span>
                <span className="kv__val">{def.c ?? '—'}</span>
              </div>
              <div className="kv">
                <span className="kv__key">边长 quadSize</span>
                <span className="kv__val">
                  {def.q.toFixed(2)} 格
                  {def.d ? '（基类随机 0.10–0.20）' : ''}
                </span>
              </div>
              <div className="kv">
                <span className="kv__key">生命周期</span>
                <span className="kv__val">
                  {def.l} tick · {seconds.toFixed(2)} 秒
                </span>
              </div>
              <div className="kv">
                <span className="kv__key">重力</span>
                <span className="kv__val">
                  {def.g === 0 ? '无' : `${def.g > 0 ? '下落' : '上浮'} ${Math.abs(def.g).toFixed(3)}`}
                </span>
              </div>
              <div className="kv">
                <span className="kv__key">尺寸变化</span>
                <span className="kv__val">
                  {def.z == null ? '全程不变' : `末帧 ${(def.z * 100).toFixed(0)}%`}
                </span>
              </div>
              <div className="kv">
                <span className="kv__key">贴图</span>
                <span className="kv__val">{def.f.map((frame) => frame[0]).join(', ')}</span>
              </div>
            </div>

            {def.c && NOTE[def.c] && <p className="modal__hint modal__hint--block">{NOTE[def.c]}</p>}

            {tintable && (
              <div className="viewctl">
                <div className="dl__title">
                  颜色
                  <span className="dl__note">游戏里这个颜色由药水/红石信号决定</span>
                </div>
                <label className="viewctl__row viewctl__row--select">
                  <span>色调</span>
                  <input type="color" value={tint} onChange={(event) => setTint(event.target.value)} />
                </label>
              </div>
            )}

            <div className="viewctl">
              <div className="dl__title">
                显示缩放
                <span className="dl__note">粒子本体只有零点几格，放大才看得清贴图</span>
              </div>
              <label className="viewctl__row">
                <span>缩放</span>
                <input
                  type="range"
                  min={0.2}
                  max={16}
                  step={0.2}
                  value={zoom}
                  onChange={(event) => setZoom(Number(event.target.value))}
                />
                <b>{zoom.toFixed(1)}×</b>
              </label>
            </div>

            <div className="sndrel">
              {def.f.map((frame, index) => (
                <div className="sndrel__row" key={`${frame[0]}-${index}`}>
                  <span className="sndrel__play">{index + 1}</span>
                  <span className="sndrel__name">{frame[0]}</span>
                  <span className="sndrel__dir">
                    {frame[1] ? `${frame[1]}×${frame[2]}` : '—'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
