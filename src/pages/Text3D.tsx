/**
 * 立体字：点阵字形 → 轮廓 → 挤出，能转、能导。
 *
 * @why 单独一页而不是「界面」下的一个页签。它是「造一张图」的工具，
 *      和告示牌/书页/地图那种「预览一个 GUI 控件」不是同一件事：那三页的输出
 *      是游戏里真实存在的界面，这一页的输出是模型文件和 PNG。挂在界面页签里
 *      会让分类失去意义。
 *
 * @why 形态照 [Cube 3D Text](https://github.com/EaseCation/cube-3d-text)（EaseCation，
 *      MIT，React + Three.js）的做法：**取字形轮廓 → 三角化 → 挤出 → 沿轮廓外扩
 *      一圈薄壳当描边**。不是"一个像素长一个方块"。逐方块堆出来的字，相邻方块
 *      之间留缝、描边围着每个方块长，「日」中间那道缝会被吃掉一半，放大后就是
 *      一排积木。这里是整块实心 + 沿轮廓均匀的一圈边，和参考项目同一个拓扑。
 *      差别只在字形来源：那边用系统字体轮廓，本站用原版点阵字，所以字是像素风的。
 *
 * @constraint 光栅必须用 `Unifont UI` 的 16px 字号。这份字体的 unitsPerEm
 *      正好是 16，一个字体单位 = 一个像素，点阵落在整数网格上；换成任何
 *      系统字体，第一件事就是亚像素抗锯齿，二值化之后笔画会随机缺一格。
 *
 * @constraint 体素尺寸必须封顶。一句话 24 个字 × 16 列 = 384 格宽，轮廓点数
 *      翻几倍，CPU 逐三角形填充会卡在个位数帧率。这里按最长边 160 格截断并提示。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { paintVoxelsCpu } from '@/render/world/cpuPaint'
import { exportStructureSolid, exportStructureStill, type StructureSubject } from '@/lib/export/structure'
import { saveBlob } from '@/lib/export/types'
import { buildTextGeometry, type Text3DGeometry } from '@/lib/text3d/build'
import { currentDpr, watchDpr } from '@/lib/dpr'
import { useLibrary } from '@/lib/useLibrary'

/** 可选方块。都是 16×16 的整格方块，字体最常用的几种「实心色」 */
const BLOCKS: { id: string; zh: string }[] = [
  { id: 'block/white_concrete', zh: '白混凝土' },
  { id: 'block/stone', zh: '石头' },
  { id: 'block/deepslate', zh: '深板岩' },
  { id: 'block/quartz_block_side', zh: '石英' },
  { id: 'block/gold_block', zh: '金块' },
  { id: 'block/diamond_block', zh: '钻石块' },
  { id: 'block/emerald_block', zh: '绿宝石块' },
  { id: 'block/sea_lantern', zh: '海晶灯' },
  { id: 'block/oak_planks', zh: '橡木木板' },
  { id: 'block/redstone_block', zh: '红石块' },
]

/**
 * 描边方块。
 * @why 固定黑色而不是让用户选：参考项目的描边是沿轮廓的一圈纯色壳，
 *      颜色只影响观感、不影响结构。给一排色板只会让面板变长，
 *      真正想换色的场景可以直接导模型回 Blender 改材质。
 */
const OUTLINE_TEXTURE = 'block/black_concrete'

/** 最长边（格）。超过就整体降采样，字会糊但仍能看 */
const MAX_EDGE = 280
/**
 * 预览画布上限（物理像素）。
 *
 * @constraint 别再往上加：CPU 逐三角形填充是 O(像素)，1024² 已经是
 *      百毫秒级，拖动旋转时会明显拖手。
 */
const PREVIEW_MAX = 1024

/**
 * 可选字体。
 *
 * @why 默认给系统无衬线体而不是点阵字。参考项目（Cube 3D Text）的字形是
 *      矢量轮廓，所以字是平滑的；点阵字即使挤出成三维，边缘仍是一圈 90° 台阶，
 *      放大看像积木。用系统的无衬线体在 32px 以上光栅化，再把暗部二值化，
 *      台阶只有 1 格宽，挤出后就是参考项目那种"整体一块"的字。
 *      点阵字作为另一个选项保留——做 8 位风、复古风的标题时它更对味。
 */
const FONTS: { id: string; zh: string; css: string; weight: string }[] = [
  {
    id: 'sans',
    zh: '无衬线（系统）',
    css: '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", Arial, sans-serif',
    weight: '700',
  },
  {
    id: 'serif',
    zh: '衬线（系统）',
    css: '"Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif',
    weight: '700',
  },
  { id: 'pixel', zh: 'MC 点阵', css: '"Unifont UI", monospace', weight: '400' },
]

/** 可选字号（像素）。点阵字体取 16 的整数倍才不会有灰边 */
const SIZES = [24, 32, 40, 56, 72]

interface GlyphMask {
  width: number
  height: number
  /** 1 = 有墨 */
  data: Uint8Array
}

/**
 * 文字 → 点阵掩码。
 *
 * @constraint 二值化阈值取 128。大字号下抗锯齿的灰边有 1~2 像素宽，
 *      按 `alpha > 0` 取会把整圈灰边也算成墨，字胖一圈、笔画粘连；
 *      阈值定在中间，边缘落在半像素上，字形和字体原本的轮廓最接近。
 */
async function rasterize(text: string, size: number, font: string, weight: string): Promise<GlyphMask | null> {
  const lines = text.replace(/\r/g, '').split('\n').slice(0, 8)
  if (!lines.some((line) => line.trim())) return null

  if (typeof document !== 'undefined' && document.fonts) {
    await document.fonts.ready
  }

  const lineHeight = Math.round(size * 1.12)
  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.font = `${weight} ${size}px ${font}`
  const width = Math.max(1, Math.ceil(Math.max(...lines.map((line) => probe.measureText(line).width)))) + 4
  const height = lines.length * lineHeight + 4

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.font = `${weight} ${size}px ${font}`
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  lines.forEach((line, index) => ctx.fillText(line, 2, 2 + index * lineHeight))

  const image = ctx.getImageData(0, 0, width, height).data
  const data = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = image[index * 4 + 3]! > 128 ? 1 : 0
  }
  return { width, height, data }
}

/** 超长文本整体降采样 */
function fit(mask: GlyphMask, edge: number): GlyphMask {
  const scale = Math.max(mask.width, mask.height) > edge ? edge / Math.max(mask.width, mask.height) : 1
  if (scale === 1) return mask
  const w = Math.max(1, Math.floor(mask.width * scale))
  const h = Math.max(1, Math.floor(mask.height * scale))
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const sx = Math.min(mask.width - 1, Math.floor(x / scale))
      const sy = Math.min(mask.height - 1, Math.floor(y / scale))
      data[y * w + x] = mask.data[sy * mask.width + sx] ? 1 : 0
    }
  }
  return { width: w, height: h, data }
}

export default function Text3D() {
  const { version, loading } = useLibrary()
  if (loading || !version) return <p className="empty">正在加载方块贴图…</p>
  return <Text3DBody version={version} />
}

function Text3DBody({ version }: { version: string }) {
  const [text, setText] = useState('MC 素材库\n立体字')
  const [block, setBlock] = useState(BLOCKS[0]!.id)
  /**
   * @why 厚度和描边用**字号的比例**，不是固定的格数。参考项目（Cube 3D Text）
   *      里这两个参数也是相对 size 的：同一套数值在标题和大字上看起来一样厚。
   *      按格数写死的话，换成 56px 字号，4 格厚度就从"厚板"变成"一张纸"。
   */
  const [depthRatio, setDepthRatio] = useState(0.4)
  const [outlineRatio, setOutlineRatio] = useState(0.03)
  const [boldRatio, setBoldRatio] = useState(0.02)
  const [fontId, setFontId] = useState(FONTS[0]!.id)
  const [fontSize, setFontSize] = useState(40)
  const [rotX, setRotX] = useState(32)
  const [rotY, setRotY] = useState(-32)
  const [zoom, setZoom] = useState(1)
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
   *      的 width 属性（1024），于是一个 1024×530 的非方形盒子把舞台撑破，
   *      位图按 object-fit 缩在中间，上下多出来的部分被 overflow 裁掉 ——
   *      表现就是"字的下半截没了"。
   */
  const [side, setSide] = useState(320)

  /** 预览尺寸跟随容器与 DPR */
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
      const raw = await rasterize(text, fontSize, face.css, face.weight)
      if (!alive) return
      if (!raw) {
        setGeometry(null)
        return
      }
      const mask = fit(raw, MAX_EDGE)
      const built = buildTextGeometry(mask, {
        depth: Math.max(0.75, fontSize * depthRatio),
        outline: fontSize * outlineRatio,
        bold: fontSize * boldRatio,
        texture: block,
        outlineTexture: OUTLINE_TEXTURE,
      })
      if (!alive) return
      if (built.batches.length === 0) {
        setGeometry(null)
        setNote('这段文字没有可挤出的轮廓，换一句话试试')
        return
      }
      setNote(
        Math.max(raw.width, raw.height) > MAX_EDGE
          ? `文字超出 ${MAX_EDGE} 格，已整体缩到 ${Math.round((MAX_EDGE / Math.max(raw.width, raw.height)) * 100)}%`
          : null,
      )
      setGeometry(built)
    })()
    return () => {
      alive = false
    }
  }, [text, block, depthRatio, outlineRatio, boldRatio, fontId, fontSize])

  /** CPU 画家算法绘制。字量小，不需要 WebGL 上下文 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !geometry) return
    canvas.width = size
    canvas.height = size
    void paintVoxelsCpu(
      canvas,
      geometry.batches,
      {
        size,
        rotX,
        rotY,
        zoom,
        span: geometry.span,
        pivot: geometry.pivot,
      },
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

  const stats = geometry ? geometry.batches.reduce((sum, batch) => sum + batch.vertexCount, 0) / 3 : 0

  return (
    <div className="page text3d">
      <header className="page-head">
        <p className="page-head__crumb">MC 素材库 / 立体字</p>
        <h1 className="page-head__title">立体字</h1>
        <p className="page-head__note">
          字形轮廓挤出成整块立体字，沿轮廓一圈薄描边。可导出 GLB / OBJ / STL 或透明底 PNG。
        </p>
      </header>

      <div className="studio">
        <aside className="studio__panel">
          <h2 className="workbench__section">文字</h2>
          <textarea
            className="studio__textarea"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="两行标题，回车换行"
          />
          <p className="workbench__hint">
            按所选字号光栅化，一个亮像素等于一格。字号越大轮廓越细，字越像"一整块"；
            点阵字体请选 16 的整数倍。
          </p>

          <label className="studio__field">
            字体
            <select className="studio__select" value={fontId} onChange={(event) => setFontId(event.target.value)}>
              {FONTS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.zh}
                </option>
              ))}
            </select>
          </label>

          <label className="studio__field">
            字号
            <select
              className="studio__select"
              value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))}
            >
              {SIZES.map((item) => (
                <option key={item} value={item}>
                  {item} px
                </option>
              ))}
            </select>
          </label>

          <h2 className="workbench__section">材质</h2>
          <select className="studio__select" value={block} onChange={(event) => setBlock(event.target.value)}>
            {BLOCKS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.zh}
              </option>
            ))}
          </select>

          <label className="studio__field">
            厚度 {Math.round(depthRatio * 100)}% 字号
            <input
              type="range"
              min={0.05}
              max={0.5}
              step={0.01}
              value={depthRatio}
              onChange={(event) => setDepthRatio(Number(event.target.value))}
            />
          </label>
          <label className="studio__field">
            字重 +{Math.round(boldRatio * 100)}% 字号
            <input
              type="range"
              min={0}
              max={0.08}
              step={0.005}
              value={boldRatio}
              onChange={(event) => setBoldRatio(Number(event.target.value))}
            />
          </label>
          <label className="studio__field">
            描边 {outlineRatio === 0 ? '关' : `${Math.round(outlineRatio * 100)}% 字号`}
            <input
              type="range"
              min={0}
              max={0.08}
              step={0.005}
              value={outlineRatio}
              onChange={(event) => setOutlineRatio(Number(event.target.value))}
            />
          </label>

          <h2 className="workbench__section">视角</h2>
          <label className="studio__field">
            俯仰 {Math.round(rotX)}°
            <input
              type="range"
              min={-80}
              max={80}
              value={Math.round(rotX)}
              onChange={(event) => setRotX(Number(event.target.value))}
            />
          </label>
          <label className="studio__field">
            水平 {Math.round(rotY)}°
            <input
              type="range"
              min={-180}
              max={180}
              value={Math.round(rotY)}
              onChange={(event) => setRotY(Number(event.target.value))}
            />
          </label>
          <label className="studio__field">
            缩放 {zoom.toFixed(1)}×
            <input
              type="range"
              min={0.5}
              max={2.5}
              step={0.1}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>

          <h2 className="workbench__section">导出</h2>
          <div className="studio__row studio__row--wrap">
            {(['glb', 'obj', 'stl', 'png'] as const).map((kind) => (
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
          {stats > 0 && <p className="workbench__hint">{Math.round(stats).toLocaleString()} 个三角面</p>}
          {note && <p className="workbench__hint studio__note">{note}</p>}
        </aside>

        <div className="studio__stage text3d__stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="studio__canvas studio__canvas--draw"
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
          <p className="studio__status">拖动旋转 · 滚轮缩放</p>
        </div>
      </div>
    </div>
  )
}
