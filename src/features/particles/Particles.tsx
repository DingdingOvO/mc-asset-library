import { useMemo, useState } from 'react'
import { ParticleThumb, ParticleView } from '@/components/ParticleView'
import {
  AssetGrid,
  AssetTile,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  PageHeader,
  SearchField,
  Toolbar,
} from '@/ui'
import { useQueryParam } from '@/hooks/useQueryParam'
import { loadParticles, type ParticleDef } from '@/lib/particles'
import { tipAttrs } from '@/lib/tip'
import { useAsync } from '@/lib/useAsync'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { useLibrary } from '@/lib/useLibrary'
import './particles.css'

export default function Particles() {
  const { version, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取粒子数据…" /></Page>

  return <ParticleBrowser version={version} />
}

function ParticleBrowser({ version }: { version: string }) {
  const particles = useAsync(`particles:${version}`, () => loadParticles(version))
  const { value: query, setValue: setQuery } = useQueryParam()
  const [selected, setSelected] = useState<string | null>(null)

  const all = useMemo(() => particles.data?.items ?? [], [particles.data])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return all
    return all.filter(
      (item) => item.id.includes(keyword) || (item.c ?? '').toLowerCase().includes(keyword),
    )
  }, [all, query])

  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 170,
    minColumnWidth: 132,
    resetKey: query,
  })

  const active = selected ? (all.find((item) => item.id === selected) ?? null) : null

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title="粒子"
        lead={
          <>
            <span className="num">{all.length}</span> 种粒子，尺寸和寿命都按源码来的 · 深色底上看得最清
          </>
        }
      />

      <Toolbar meta={particles.loading ? '加载参数…' : `${filtered.length} / ${all.length}`}>
        <SearchField primary value={query} onChange={setQuery} placeholder="搜索粒子…" />
      </Toolbar>

      {particles.error && <ErrorState title="加载失败" detail={particles.error.message} />}
      {particles.loading && <LoadingState label="正在加载粒子参数…" />}
      {!particles.loading && filtered.length === 0 && (
        <EmptyState title={`没找到「${query}」这个粒子`} hint="粒子名就是注册 id，试试 flame、smoke、crit。" />
      )}

      <AssetGrid gridRef={gridRef} padTop={padTop} padBottom={padBottom} minWidth={132} label="粒子列表">
        {visible.map((item) => (
          <AssetTile
            key={item.id}
            name={item.id}
            meta={`${item.q.toFixed(2)} 格 · ${item.l}t`}
            pressed={selected === item.id}
            hint={tipAttrs(item.id, undefined, item.c ?? '未注册到具体类').title}
            onClick={() => setSelected(item.id)}
          >
            <ParticleThumb version={version} def={item} size={88} />
          </AssetTile>
        ))}
      </AssetGrid>

      {active && <ParticleDialog version={version} def={active} onClose={() => setSelected(null)} />}
    </Page>
  )
}

/**
 * 颜色由运行时参数决定的粒子：源码里只有一张白贴图，真正的颜色是
 * SpellParticleOption / DustColorTransitionOption 之类传进来的。
 * @why 不染色它们就是一片白，在白底或浅色舞台上等于看不见。
 */
const TINTABLE = new Set([
  'SpellParticle',
  'DustParticle',
  'DustColorTransitionParticle',
  'FallingLeavesParticle',
])

/** 游戏里不是一张贴图的粒子，说明清楚，别让人以为渲染错了 */
const NOTE: Record<string, string> = {
  VibrationSignalParticle:
    '游戏里它画的是从声源到目标的一条振动连线，不是一个四边形，这里只能给出它的贴图',
  FireworkParticles: '烟花爆开的中心闪光，尺寸在两帧内从 0 涨到满，之后立刻消失',
  FallingLeavesParticle: '树叶粒子会按群系染色，并带朝向与翻滚；这里只演示贴图与尺寸',
  SpellParticle: '药水效果漩涡：颜色由药水决定（速度青、力量红、中毒绿……），形状是这张白贴图',
}

/**
 * 粒子详情。
 *
 * @why 复用 Dialog 基座而不是 ModelModal：那个弹窗的重心是骨骼动作与 3D 导出，
 *      粒子没有骨骼也没有可导出的网格。粒子真正需要的是「看清贴图 + 游戏里多大」。
 */
function ParticleDialog({
  version,
  def,
  onClose,
}: {
  version: string
  def: ParticleDef
  onClose: () => void
}) {
  const auto = Math.min(12, Math.max(0.15, 0.34 / Math.max(0.02, def.q)))
  const [zoom, setZoom] = useState(auto)
  /**
   * @why 除了按类判断，还要按贴图判断：ambient_entity_effect / trial_spawner_detection_ominous
   *      这两个 id 在 26.3 的 ParticleResources 里没有注册渲染器，但贴图就是
   *      effect_* 那一套白漩涡，颜色同样是运行时给的。
   */
  const tintable = TINTABLE.has(def.c ?? '') || /^(effect|spell)_\d+$/.test(def.f[0]?.[0] ?? '')
  const [tint, setTint] = useState('#b06ce0')

  const seconds = def.l / 20

  return (
    <Dialog open onClose={onClose} label={def.id} className="modal--narrow">
      <div className="modal__view">
        <div className="modal__stage particle-stage">
          <ParticleView
            version={version}
            def={def}
            size={320}
            zoom={zoom}
            tint={tintable ? tint : undefined}
          />
        </div>
        <div className="modal__footer">
          <span className="badge">
            {def.f.length > 1 ? `贴图动画 · ${def.f.length} 帧` : '静态贴图'} · {def.l} tick
          </span>
          <span className="modal__hint">
            边长 {def.q.toFixed(2)} 格 · 显示缩放 {zoom.toFixed(1)}×
          </span>
        </div>
      </div>

      <div className="modal__side">
        <div className="modal__head">
          <div className="modal__title">{def.id}</div>
          <div className="modal__subtitle">{def.c ?? '未在 ParticleResources 中注册'}</div>
        </div>
        <div className="modal__body">
          <div className="kv-list">
            <div className="kv">
              <span className="kv__key">渲染类</span>
              <span className="kv__val">{def.c ?? '—'}</span>
            </div>
            <div className="kv">
              <span className="kv__key">边长</span>
              <span className="kv__val">
                {def.q.toFixed(2)} 格{def.d ? '（基类随机 0.10–0.20）' : ''}
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

          {def.c && NOTE[def.c] && <p className="notice">{NOTE[def.c]}</p>}

          {tintable && (
            <div className="section">
              <div className="section__head">
                <span className="section__title">颜色</span>
                <span className="section__note">游戏里由药水或红石信号决定</span>
              </div>
              <div className="controls">
                <label className="control-row control-row--select">
                  <span>色调</span>
                  <input type="color" value={tint} onChange={(event) => setTint(event.target.value)} />
                </label>
              </div>
            </div>
          )}

          <div className="section">
            <div className="section__head">
              <span className="section__title">显示缩放</span>
              <span className="section__note">粒子本体只有零点几格，放大才看得清</span>
            </div>
            <div className="controls">
              <label className="control-row">
                <span>缩放</span>
                <input
                  className="slider"
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
          </div>

          <div className="section">
            <div className="section__head">
              <span className="section__title">帧序列</span>
              <span className="section__note">{def.f.length} 帧</span>
            </div>
            <div className="frames">
              {def.f.map((frame, index) => (
                <div className="frames__row" key={`${frame[0]}-${index}`}>
                  <span className="frames__index">{index + 1}</span>
                  <span className="frames__name">{frame[0]}</span>
                  <span className="frames__size">{frame[1] ? `${frame[1]}×${frame[2]}` : '—'}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
