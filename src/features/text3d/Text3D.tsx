/**
 * 立体字：字形场 → 亚像素轮廓 → 挤出，能转、能导。
 *
 * @why 单独一页而不是「界面」下的一个页签。它是「造一张图」的工具，
 *      和告示牌/书页/地图那种「预览一个 GUI 控件」不是同一件事：那三页的输出
 *      是游戏里真实存在的界面，这一页的输出是模型文件和 PNG。挂在界面页签里
 *      会让分类失去意义。
 *
 * @why 形态照 [Cube 3D Text](https://github.com/EaseCation/cube-3d-text)（EaseCation，
 *      MIT，React + Three.js）：取字形轮廓 → 三角化 → 挤出 → 沿轮廓外扩一圈
 *      薄壳当描边。差别只在实现：那边用 Three.js 的 ExtrudeGeometry + clipper，
 *      这边用自研的 marching squares + 距离场，好处是中文/任意系统字体都能用，
 *      导出也还是原来那套 GLB/OBJ/STL。视觉上要还原的是它的三件事——
 *      平滑轮廓、竖向渐变、等宽描边。
 *
 * @constraint 光栅必须走 `SUPERSAMPLE` 倍超采样。1 倍时一个像素就是一格，
 *      斜笔画的台阶宽一整个像素，挤出后是一圈方齿；4 倍之后等值线插值把台阶
 *      抹成 0.25 格的斜边，肉眼已经看不出栅格。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { paintVoxelsCpu } from '@/render/world/cpuPaint'
import { exportStructureSolid, exportStructureStill, type StructureSubject } from '@/lib/export/structure'
import { saveBlob } from '@/lib/export/types'
import { buildTextGeometry, type Text3DGeometry } from '@/lib/text3d/build'
import { SUPERSAMPLE, fieldFromPixels, padField, trimField, type Field } from '@/lib/text3d/field'
import { MATERIALS, type MaterialPreset } from '@/lib/text3d/material'
import { currentDpr, watchDpr } from '@/lib/dpr'
import { useLibrary } from '@/lib/useLibrary'
import { LoadingState, PageHeader } from '@/ui'
import './text3d.css'

/**
 * 可选字体。
 *
 * @why 默认系统无衬线体：中文标题在 56px 以上光栅化后轮廓干净，超采样取等值线
 *      能把边缘抹平。点阵字作为另一个选项保留——做 8 位风、复古风的标题时
 *      它更对味，而且它本来就是原版游戏里的字。
 */
const FONTS: { id: string; zh: string; css: string; weight: string }[] = [
  {
    id: 'sans',
    zh: '无衬线（系统）',
    css: '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", Arial, sans-serif',
    weight: '900',
  },
  {
    id: 'serif',
    zh: '衬线（系统）',
    css: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif',
    weight: '900',
  },
  { id: 'pixel', zh: 'MC 点阵', css: '"Unifont UI", monospace', weight: '400' },
]

/** 可选字号（像素）。点阵字体取 16 的整数倍才不会有灰边 */
const SIZES = [32, 40, 56, 72, 96]

/** 最长边（格）。超过就整体降采样，字会糊但仍能看 */
const MAX_EDGE = 260

/**
 * 预览画布上限（物理像素）。
 *
 * @constraint 别再往上加：CPU 逐三角形填充是 O(像素)，1024² 已经是
 *      百毫秒级，拖动旋转时会明显拖手。
 */
const PREVIEW_MAX = 1024

/** 视角预设，三个就够，剩下的交给拖拽 */
const ANGLES: { id: string; zh: string; rotX: number; rotY: number }[] = [
  { id: 'front', zh: '正面', rotX: 0, rotY: 0 },
  { id: 'iso', zh: '三分之四', rotX: -9, rotY: -24 },
  { id: 'top', zh: '俯视', rotX: -46, rotY: -18 },
]

/**
 * 文字 → 覆盖率场。
 *
 * @constraint 字号必须乘以 SUPERSAMPLE 再交给 fillText，否则"4 倍超采样"只是
 *      把 1 像素的字放大 4 倍，锯齿一样宽，白算一遍距离场。
 */
async function rasterizeField(text: string, size: number, font: string, weight: string): Promise<Field | null> {
  const lines = text.replace(/\r/g, '').split('\n').slice(0, 6)
  if (!lines.some((line) => line.trim())) return null

  if (typeof document !== 'undefined' && document.fonts) {
    await document.fonts.ready
  }

  const ss = SUPERSAMPLE
  const px = Math.round(size * ss)
  const lineHeight = Math.round(size * 1.14) * ss
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.font = `${weight} ${px}px ${font}`
  const widest = Math.max(...lines.map((line) => probe.measureText(line).width))
  const width = Math.max(8, Math.ceil(widest) + 8 * ss)
  const height = lines.length * lineHeight + 8 * ss

  // @constraint 画布尺寸封顶，避免一句话把内存吃爆（Chrome 单边上限 32767）
  const limit = MAX_EDGE * ss * 2
  const scale = Math.min(1, limit / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(8, Math.floor(width * scale))
  canvas.height = Math.max(8, Math.floor(height * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.scale(scale, scale)
  ctx.font = `${weight} ${px}px ${font}`
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  lines.forEach((line, index) => ctx.fillText(line, 4 * ss, 4 * ss + index * lineHeight))

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return fieldFromPixels(image.data, canvas.width, canvas.height)
}

/** 场整体降采样到最长边不超过 edge（格） */
function fitField(field: Field, edge: number): Field {
  const widthInCells = field.width / SUPERSAMPLE
  const heightInCells = field.height / SUPERSAMPLE
  const longest = Math.max(widthInCells, heightInCells)
  if (longest <= edge) return field
  const scale = edge / longest
  const w = Math.max(8, Math.floor(field.width * scale))
  const h = Math.max(8, Math.floor(field.height * scale))
  const alpha = new Float32Array(w * h)
  for (let y = 0; y < h; y += 1) {
    const sy = Math.min(field.height - 1, Math.floor(y / scale))
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(field.width - 1, Math.floor(x / scale))
      alpha[y * w + x] = field.alpha[sy * field.width + sx]!
    }
  }
  return { width: w, height: h, alpha }
}

export default function Text3D() {
  const { version, loading } = useLibrary()
  if (loading || !version) return <LoadingState label="正在准备字体与方块贴图…" />
  return <Text3DBody version={version} />
}

function Text3DBody({ version }: { version: string }) {
  const [text, setText] = useState('方块世界\n立体字')
  const [materialId, setMaterialId] = useState(MATERIALS[0]!.id)
  /**
   * @why 厚度和描边用**字号的比例**，不是固定的格数。参考实现里这两个参数也是
   *      相对 size 的：同一套数值在标题和大字上看起来一样厚。按格数写死的话，
   *      换成 72px 字号，4 格厚度就从"厚板"变成"一张纸"。
   */
  const [depthRatio, setDepthRatio] = useState(0.46)
  const [outlineRatio, setOutlineRatio] = useState(0.05)
  const [fontId, setFontId] = useState(FONTS[0]!.id)
  const [fontSize, setFontSize] = useState(56)
  const [rotX, setRotX] = useState(-9)
  const [rotY, setRotY] = useState(-24)
  const [zoom, setZoom] = useState(1.12)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [geometry, setGeometry] = useState<Text3DGeometry | null>(null)
  const [size, setSize] = useState(PREVIEW_MAX)
  /**
   * 画布的 CSS 边长。
   *
   * @constraint 必须显式给，不能靠 `max-width/max-height: 100%`。
   *      百分比的 `max-height` 只夹住盒子的上限，`width: auto` 仍然取 canvas
   *      的 width 属性（1024），于是一个非方形盒子把舞台撑破，位图按 object-fit
   *      缩在中间，上下多出来的部分被裁掉——表现就是"字的下半截没了"。
   */
  const [side, setSide] = useState(320)

  const material: MaterialPreset = MATERIALS.find((item) => item.id === materialId) ?? MATERIALS[0]!

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const dpr = currentDpr(2)
      const box = Math.max(220, Math.min(stage.clientWidth, stage.clientHeight))
      setSide(box)
      setSize(Math.min(PREVIEW_MAX, Math.floor(box * dpr)))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    const stop = watchDpr(measure)
    return () => {
      observer.disconnect()
      stop()
    }
  }, [])

  /**
   * 文字/材质/厚度/描边变化 → 重建几何。
   * @constraint 必须整体重建：改一个字符会让整行宽度变化，增量更新会把旧字形
   *      的轮廓留在左边。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      const face = FONTS.find((item) => item.id === fontId) ?? FONTS[0]!
      const raw = await rasterizeField(text, fontSize, face.css, face.weight)
      if (!alive) return
      if (!raw) {
        setGeometry(null)
        return
      }
      const fitted = fitField(raw, MAX_EDGE)
      const depth = Math.max(0.75, fontSize * depthRatio)
      const outline = fontSize * outlineRatio
      /**
       * @constraint 场要先往外扩一圈，宽度等于描边半径。距离变换是在场边界
       *      内算的，贴边的笔画会被当成"到边界就结束"，描边缺一条边。
       */
      const trimmed = trimField(fitted)
      const padded = padField(trimmed, Math.ceil(outline * SUPERSAMPLE) + 2)
      const built = buildTextGeometry(padded, { depth, outline, material })
      if (!alive) return
      if (built.batches.length === 0) {
        setGeometry(null)
        setNote('这段文字没有可挤出的轮廓，换一句话试试？')
        return
      }
      setNote(null)
      setGeometry(built)
    })()
    return () => {
      alive = false
    }
  }, [text, material, depthRatio, outlineRatio, fontId, fontSize])

  /** CPU 画家算法绘制。字量小，不需要 WebGL 上下文 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !geometry) return
    canvas.width = size
    canvas.height = size
    void paintVoxelsCpu(
      canvas,
      geometry.batches,
      { size, rotX, rotY, zoom, span: geometry.span, pivot: geometry.pivot },
      version,
    )
  }, [geometry, size, rotX, rotY, zoom, version])

  /** 拖动旋转：与结构页同一套手感（水平全 360，垂直夹在 ±80） */
  const beginDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const from = { x: event.clientX, y: event.clientY }
    const start = { rotX, rotY }
    event.currentTarget.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - from.x
      const dy = moveEvent.clientY - from.y
      setRotY(start.rotY + dx * 0.6)
      setRotX(Math.max(-80, Math.min(80, start.rotX - dy * 0.6)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const subject = useMemo<StructureSubject | null>(() => {
    if (!geometry) return null
    return {
      kind: 'structure',
      id: 'text3d',
      version,
      batches: geometry.batches,
      rotX,
      rotY,
      zoom,
      span: geometry.span,
      pivot: geometry.pivot,
      size: 1024,
      backdrop: null,
      // 纯色材质的贴图是内联的 1×1 底图，GPU 管线按路径取不到，走 CPU 更稳
      forceCpu: true,
    }
  }, [geometry, version, rotX, rotY, zoom])

  const run = useCallback(
    async (kind: 'glb' | 'obj' | 'stl' | 'png') => {
      if (!subject) return
      setBusy(kind)
      setNote(null)
      try {
        const blob = kind === 'png' ? await exportStructureStill(subject) : await exportStructureSolid(subject, kind)
        if (!blob) {
          setNote('没有可导出的几何')
          return
        }
        saveBlob(blob, kind === 'png' ? 'text3d.png' : `text3d.${kind}`)
      } catch (error) {
        setNote(`导出失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setBusy(null)
      }
    },
    [subject],
  )

  const triangles = geometry ? geometry.batches.reduce((sum, batch) => sum + batch.vertexCount, 0) / 3 : 0

  return (
    <div className="studio-page">
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title="立体字"
        lead="给标题一点厚度。挑个材质、拧个角度，导成透明底 PNG 或 GLB / OBJ / STL 拿去用。"
      />

      <div className="studio text3d">
        <aside className="studio-panel">
          <h2 className="studio-group">
            文字 <span className="studio-group__note">回车换行，最多 6 行</span>
          </h2>
          <textarea
            className="textarea studio-textarea"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="想写点什么？"
          />

          <div className="studio-row">
            <label className="studio-field studio-field--inline">
              字体
              <select className="select" value={fontId} onChange={(event) => setFontId(event.target.value)}>
                {FONTS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.zh}
                  </option>
                ))}
              </select>
            </label>
            <label className="studio-field studio-field--inline">
              字号
              <select className="select" value={fontSize} onChange={(event) => setFontSize(Number(event.target.value))}>
                {SIZES.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <h2 className="studio-group">
            材质 <span className="studio-group__note">{material.hint}</span>
          </h2>
          <div className="swatches">
            {MATERIALS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="swatch"
                aria-pressed={item.id === materialId}
                onClick={() => setMaterialId(item.id)}
                title={item.label}
              >
                <span
                  className="swatch__chip"
                  style={{
                    background: item.top
                      ? `linear-gradient(160deg, ${item.top}, ${item.face} 55%, ${item.side})`
                      : `linear-gradient(160deg, ${item.face}, ${item.side})`,
                    borderColor: item.outline,
                  }}
                />
                <span className="swatch__name">{item.label}</span>
              </button>
            ))}
          </div>

          <h2 className="studio-group">造型</h2>
          <label className="studio-field">
            <span className="studio-field__head">
              <span>厚度</span>
              <b>{Math.round(depthRatio * 100)}% 字号</b>
            </span>
            <input
              className="slider"
              type="range"
              min={0.05}
              max={0.5}
              step={0.01}
              value={depthRatio}
              onChange={(event) => setDepthRatio(Number(event.target.value))}
            />
          </label>
          <label className="studio-field">
            <span className="studio-field__head">
              <span>描边</span>
              <b>{outlineRatio === 0 ? '关' : `${Math.round(outlineRatio * 100)}% 字号`}</b>
            </span>
            <input
              className="slider"
              type="range"
              min={0}
              max={0.09}
              step={0.0025}
              value={outlineRatio}
              onChange={(event) => setOutlineRatio(Number(event.target.value))}
            />
          </label>

          <h2 className="studio-group">视角</h2>
          <div className="segmented">
            {ANGLES.map((item) => (
              <button
                key={item.id}
                type="button"
                className="segmented__item"
                aria-pressed={rotX === item.rotX && rotY === item.rotY}
                onClick={() => {
                  setRotX(item.rotX)
                  setRotY(item.rotY)
                }}
              >
                {item.zh}
              </button>
            ))}
          </div>
          <label className="studio-field">
            <span className="studio-field__head">
              <span>俯仰</span>
              <b>{Math.round(rotX)}°</b>
            </span>
            <input
              className="slider"
              type="range"
              min={-80}
              max={80}
              value={Math.round(rotX)}
              onChange={(event) => setRotX(Number(event.target.value))}
            />
          </label>
          <label className="studio-field">
            <span className="studio-field__head">
              <span>水平</span>
              <b>{Math.round(rotY)}°</b>
            </span>
            <input
              className="slider"
              type="range"
              min={-180}
              max={180}
              value={Math.round(rotY)}
              onChange={(event) => setRotY(Number(event.target.value))}
            />
          </label>
          <label className="studio-field">
            <span className="studio-field__head">
              <span>缩放</span>
              <b>{zoom.toFixed(1)}×</b>
            </span>
            <input
              className="slider"
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>

          <h2 className="studio-group">拿走</h2>
          <div className="studio-actions">
            <button type="button" className="btn btn--primary" disabled={!subject || !!busy} onClick={() => void run('png')}>
              {busy === 'png' ? '导出中…' : 'PNG 透明底'}
            </button>
            {(['glb', 'obj', 'stl'] as const).map((kind) => (
              <button
                key={kind}
                type="button"
                className="btn btn--ghost"
                disabled={!subject || !!busy}
                onClick={() => void run(kind)}
              >
                {busy === kind ? '…' : kind.toUpperCase()}
              </button>
            ))}
          </div>
          <p className="studio-hint">
            {triangles > 0 ? `${Math.round(triangles).toLocaleString()} 个三角面 · ` : ''}
            PNG 是透明底，叠在背景墙上正好（去「背景墙」看看）。
          </p>
          {note && <p className="studio-hint studio-hint--warn">{note}</p>}
        </aside>

        <div className="studio-stage studio-stage--dark text3d-stage" ref={stageRef}>
          <span
            className="text3d-glow"
            style={{ transform: `translateX(${rotY * -0.4}px) rotate(${rotY * 0.02}deg)` }}
            aria-hidden
          />
          <canvas
            ref={canvasRef}
            className="studio-canvas"
            onPointerDown={beginDrag}
            /**
             * @constraint 不调 preventDefault：React 在 root 上挂的 wheel 是
             *      passive 监听，调了只会得到一条控制台警告，页面照滚。
             *      外层舞台本来就 overflow: hidden，滚轮不会带动页面。
             */
            onWheel={(event) =>
              setZoom((value) => Math.max(0.5, Math.min(2.5, value * (event.deltaY > 0 ? 0.92 : 1.08))))
            }
            style={{ cursor: 'grab', width: side, height: side }}
          />
          <p className="studio-status">拖动转一转 · 滚轮缩放</p>
        </div>
      </div>
    </div>
  )
}
