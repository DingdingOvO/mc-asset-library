/**
 * 背景墙：拿方块纹理拼一张壁纸，按比例和密度调，导出 PNG。
 *
 * @why 单独一页。它的产物是"图"，用途是当直播/视频/PPT 的背景，和查素材
 *      不是同一件事；挂在「界面」页签下会被当成 GUI 预览，找不到。
 *
 * @constraint 预览和导出必须走**同一个**渲染函数，只是尺寸不同。分开写两份
 *      的下场是预览好看、导出的格子数和预览对不上——这个仓库里已经有过一次
 *      同样的教训（tooltip 导出被裁掉一块）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { LoadingState, Page, PageHeader, Switch } from '@/ui'
import {
  RATIOS,
  SIZES,
  WALL_PRESETS,
  WALL_TEXTURES,
  renderWall,
  sizeOf,
  type WallOptions,
} from '@/lib/wall'
import { textureSrc } from '@/lib/mc'
import { useLibrary } from '@/lib/useLibrary'
import './wall.css'

/** 预览宽度上限。再宽就只是白烧 CPU，导出的还是全尺寸 */
const PREVIEW_WIDTH = 1280

export default function Wall() {
  const { version, loading } = useLibrary()
  if (loading || !version) {
    return (
      <Page wide>
        <LoadingState label="正在准备方块纹理…" />
      </Page>
    )
  }
  return <WallBody version={version} />
}

function WallBody({ version }: { version: string }) {
  const preset = WALL_PRESETS[0]!
  const [ratioId, setRatioId] = useState(RATIOS[0]!.id)
  const [longEdge, setLongEdge] = useState(SIZES[1]!)
  const [cell, setCell] = useState(48)
  const [picked, setPicked] = useState<string[]>(preset.textures)
  const [rotate, setRotate] = useState(true)
  const [mirror, setMirror] = useState(true)
  const [jitter, setJitter] = useState(0.14)
  const [vignette, setVignette] = useState(0.32)
  const [gap, setGap] = useState(2)
  const [bond, setBond] = useState(true)
  const [tint, setTint] = useState<string | null>(preset.tint ?? null)
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 1e9))
  const [stat, setStat] = useState({ cols: 0, rows: 0 })
  const [busy, setBusy] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ratio = RATIOS.find((item) => item.id === ratioId) ?? RATIOS[0]!
  const { width, height } = sizeOf(longEdge, ratio)

  const optionsOf = useCallback(
    (scale: number): WallOptions => ({
      width: Math.max(16, Math.round(width * scale)),
      height: Math.max(16, Math.round(height * scale)),
      cell: Math.max(2, Math.round(cell * scale)),
      textures: picked,
      rotate,
      mirror,
      jitter,
      tint,
      vignette,
      gap,
      bond,
      seed,
    }),
    [width, height, cell, picked, rotate, mirror, jitter, tint, vignette, gap, bond, seed],
  )

  /**
   * 预览重绘。
   * @constraint 必须 debounce：拖密度滑块时每一帧都会触发，1080p 一次要铺
   *      八千多块，不防抖会明显卡手。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const scale = Math.min(1, PREVIEW_WIDTH / width)
    const timer = window.setTimeout(() => {
      void renderWall(canvas, optionsOf(scale), (id) => textureSrc(version, id)).then((result) => {
        setStat({ cols: result.cols, rows: result.rows })
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [optionsOf, width, version])

  const exportPng = useCallback(async () => {
    setBusy(true)
    try {
      const canvas = document.createElement('canvas')
      await renderWall(canvas, optionsOf(1), (id) => textureSrc(version, id))
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `wall-${width}x${height}.png`
      link.click()
      URL.revokeObjectURL(url)
    } finally {
      setBusy(false)
    }
  }, [optionsOf, version, width, height])

  const toggleTexture = (id: string): void => {
    setPicked((list) => {
      if (list.includes(id)) {
        // @constraint 至少留一种，全不选等于一面空白墙
        return list.length === 1 ? list : list.filter((item) => item !== id)
      }
      return [...list, id]
    })
  }

  const applyPreset = (id: string): void => {
    const next = WALL_PRESETS.find((item) => item.id === id)
    if (!next) return
    setPicked(next.textures)
    setTint(next.tint ?? null)
  }

  const toggleTint = (checked: boolean): void => setTint(checked ? '#5b7cff' : null)

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title="背景墙"
        lead="用方块纹理铺一面墙，调好比例和密度直接导图。做直播间背景、视频封面或者 PPT 底图都行。"
        actions={
          <button type="button" className="btn btn--primary" onClick={() => void exportPng()} disabled={busy}>
            {busy ? '导出中…' : '导出 PNG'}
          </button>
        }
      />

      <div className="wall">
        <aside className="wall__panel">
          <h2 className="studio-group">
            画幅 <span className="studio-group__note">按长边算，短边自动跟随</span>
          </h2>
          <div className="ratio-grid">
            {RATIOS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="ratio"
                aria-pressed={item.id === ratioId}
                onClick={() => setRatioId(item.id)}
              >
                <span
                  className="ratio__box"
                  style={{ aspectRatio: `${item.w} / ${item.h}` }}
                  aria-hidden="true"
                />
                {item.label}
              </button>
            ))}
          </div>

          <label className="studio-field">
            <span className="studio-field__head">
              <span>长边</span>
              <b>{width} × {height}</b>
            </span>
            <select className="select" value={longEdge} onChange={(event) => setLongEdge(Number(event.target.value))}>
              {SIZES.map((item) => (
                <option key={item} value={item}>
                  {item} px
                </option>
              ))}
            </select>
          </label>

          <label className="studio-field">
            <span className="studio-field__head">
              <span>密度</span>
              <b>
                {cell} px / 格 · 约 {stat.cols} × {stat.rows} 块
              </b>
            </span>
            <input
              className="slider"
              type="range"
              min={4}
              max={48}
              step={2}
              value={cell}
              onChange={(event) => setCell(Number(event.target.value))}
            />
          </label>

          <h2 className="studio-group">
            风格 <span className="studio-group__note">先挑个预设，再改细节</span>
          </h2>
          <div className="preset-list">
            {WALL_PRESETS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="preset"
                onClick={() => applyPreset(item.id)}
                title={item.hint}
              >
                {item.zh}
              </button>
            ))}
          </div>

          <h2 className="studio-group">
            纹理 <span className="studio-group__note">至少留一种</span>
          </h2>
          <div className="chips chips--tight">
            {WALL_TEXTURES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="chip"
                aria-pressed={picked.includes(item.id)}
                onClick={() => toggleTexture(item.id)}
              >
                {item.zh}
              </button>
            ))}
          </div>

          <h2 className="studio-group">质感</h2>
          <div className="wall__switches">
            <Switch checked={rotate} onChange={(event) => setRotate(event.target.checked)}>
              随机旋转
            </Switch>
            <Switch checked={mirror} onChange={(event) => setMirror(event.target.checked)}>
              随机镜像
            </Switch>
            <Switch checked={tint !== null} onChange={(event) => toggleTint(event.target.checked)}>
              统一色调
            </Switch>
            <Switch checked={bond} onChange={(event) => setBond(event.target.checked)}>
              错缝砌筑
            </Switch>
          </div>

          <label className="studio-field">
            <span className="studio-field__head">
              <span>砖缝</span>
              <b>{gap === 0 ? '无缝' : `${gap} px`}</b>
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={4}
              step={1}
              value={gap}
              onChange={(event) => setGap(Number(event.target.value))}
            />
          </label>

          {tint !== null && (
            <label className="studio-field">
              <span className="studio-field__head">
                <span>色调</span>
                <b>{tint}</b>
              </span>
              <input
                className="wall__color"
                type="color"
                value={tint}
                onChange={(event) => setTint(event.target.value)}
              />
            </label>
          )}

          <label className="studio-field">
            <span className="studio-field__head">
              <span>明暗抖动</span>
              <b>{Math.round((jitter / 0.22) * 100)}%</b>
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={0.22}
              step={0.01}
              value={jitter}
              onChange={(event) => setJitter(Number(event.target.value))}
            />
          </label>

          <label className="studio-field">
            <span className="studio-field__head">
              <span>暗角</span>
              <b>{Math.round(vignette * 100)}%</b>
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={0.9}
              step={0.02}
              value={vignette}
              onChange={(event) => setVignette(Number(event.target.value))}
            />
          </label>

          <div className="studio-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setSeed(Math.floor(Math.random() * 1e9))}
            >
              换一片墙 ↻
            </button>
          </div>
          <p className="studio-hint">
            同一套参数下「换一片墙」只是换随机种子，尺寸和密度不变，方便对比。
          </p>
        </aside>

        <div className="wall__stage">
          <canvas ref={canvasRef} className="wall__canvas" />
          <p className="wall__meta">
            {width} × {height} · {cell} px / 格 · {stat.cols} × {stat.rows} = {stat.cols * stat.rows} 块
          </p>
        </div>
      </div>
    </Page>
  )
}
