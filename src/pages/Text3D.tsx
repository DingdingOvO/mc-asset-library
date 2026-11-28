/**
 * 立体字：把点阵字挤成体素方块，能转、能导。
 *
 * @why 单独一页而不是「界面」下的一个页签。它是「造一张图」的工具，
 *      和告示牌/书页/地图那种「预览一个 GUI 控件」不是同一件事：那三页的输出
 *      是游戏里真实存在的界面，这一页的输出是模型文件和 PNG。挂在界面页签里
 *      会让分类失去意义。
 *
 * @why 形态参考 [Cube 3D Text](https://github.com/EaseCation/cube-3d-text)
 *      （EaseCation，MIT）：MC 风格的立体字不是「一块厚板」，而是
 *      「一层方块 + 一圈深色描边」—— 描边才是让字从背景里跳出来的东西。
 *      这里用体素层面外扩 1 格实现同一件事，不引入 three.js。
 *
 * @constraint 光栅必须用 `Unifont UI` 的 16px 字号。这份字体的 unitsPerEm
 *      正好是 16，一个字体单位 = 一个像素，点阵落在整数网格上；换成任何
 *      系统字体，第一件事就是亚像素抗锯齿，二值化之后笔画会随机缺一格。
 *
 * @constraint 体素尺寸必须封顶。一句话 24 个字 × 16 列 = 384 格宽，逐面建
 *      网格是几万个三角形，CPU 预览会卡在个位数帧率。这里按最长边 160 格
 *      截断并提示，够做标题，不够做小字。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildVoxelBatches, type VoxelBatch } from '@/render/world/mesher'
import { paintVoxelsCpu } from '@/render/world/cpuPaint'
import { createVolume, setBlock } from '@/lib/world/terrain'
import { loadGeometry } from '@/lib/world/geometry'
import { exportStructureSolid, exportStructureStill, type StructureSubject } from '@/lib/export/structure'
import { saveBlob } from '@/lib/export/types'
import { currentDpr, watchDpr } from '@/lib/dpr'
import { useLibrary } from '@/lib/useLibrary'

/** 可选方块。都是 16×16 的整格方块，字体最常用的几种「实心色」 */
const BLOCKS: { id: string; zh: string }[] = [
  { id: 'minecraft:white_concrete', zh: '白混凝土' },
  { id: 'minecraft:quartz_block', zh: '石英' },
  { id: 'minecraft:gold_block', zh: '金块' },
  { id: 'minecraft:diamond_block', zh: '钻石块' },
  { id: 'minecraft:emerald_block', zh: '绿宝石块' },
  { id: 'minecraft:sea_lantern', zh: '海晶灯' },
  { id: 'minecraft:oak_planks', zh: '橡木木板' },
  { id: 'minecraft:redstone_block', zh: '红石块' },
]

/**
 * 描边方块。
 * @why 固定黑色而不是让用户选：Cube 3D Text 的描边是「反向法线膨胀」出来的
 *      纯色壳，颜色只影响观感、不影响结构。给一排色板只会让面板变长，
 *      真正想换色的场景可以直接导模型回 Blender 改材质。
 */
const OUTLINE_BLOCK = 'minecraft:black_concrete'

/** 最长边（格）。超过就整体降采样，字会糊但仍能看 */
const MAX_EDGE = 160
/**
 * 预览画布上限（物理像素）。
 *
 * @why 不能停在 720。一个方块字每格只有 8~10 个像素，顶面（朝上的那个面）
 *      在屏幕上正好 1 像素高，会被读成"笔画边缘的白色小齿"。提到 1024 之后
 *      每格约 12 像素，顶面有 2~3 像素，厚度才真正读得出来。
 * @constraint 别再往上加：CPU 逐三角形填充是 O(像素)，1024² 已经是
 *      百毫秒级，拖动旋转时会明显拖手。
 */
const PREVIEW_MAX = 1024

interface GlyphMask {
  width: number
  height: number
  /** 1 = 有墨 */
  data: Uint8Array
}

/**
 * 文字 → 点阵掩码。
 *
 * @constraint 二值化阈值取 128：点了 16px 字号的点阵字在浏览器里仍会带一点
 *      抗锯齿灰边，按 alpha>0 取会把整圈灰边也算成方块，字胖一圈、笔画粘连。
 */
async function rasterize(text: string): Promise<GlyphMask | null> {
  const lines = text.replace(/\r/g, '').split('\n').slice(0, 8)
  if (!lines.some((line) => line.trim())) return null

  if (typeof document !== 'undefined' && document.fonts) {
    await document.fonts.ready
  }

  const probe = document.createElement('canvas').getContext('2d')
  if (!probe) return null
  probe.font = '16px "Unifont UI"'
  const width = Math.max(1, Math.ceil(Math.max(...lines.map((line) => probe.measureText(line).width)))) + 2
  const height = lines.length * 16 + 2

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.font = '16px "Unifont UI"'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  lines.forEach((line, index) => ctx.fillText(line, 1, 1 + index * 16))

  const image = ctx.getImageData(0, 0, width, height).data
  const data = new Uint8Array(width * height)
  for (let index = 0; index < data.length; index += 1) {
    data[index] = image[index * 4 + 3]! > 128 ? 1 : 0
  }
  return { width, height, data }
}

/**
 * 掩码 → 体素体积。y 轴翻转：画布往下，体素往上。
 *
 * @why 描边在**同一张掩码上**外扩，而不是把字放大一圈：放大一圈会让笔画之间
 *      的空隙被填平（「日」中间那道缝直接消失），外扩只影响轮廓外沿。
 * @constraint 描边体素与主体同厚。薄一层的话侧看会露馅，字像贴着个黑纸板。
 */
function toVolume(mask: GlyphMask, depth: number, block: string, outline: string | null) {
  const pad = outline ? 1 : 0
  const width = mask.width + pad * 2
  const height = mask.height + pad * 2
  const volume = createVolume([width, height, depth])

  const ink = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false
    return mask.data[y * mask.width + x] === 1
  }

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!ink(x, y)) continue
      for (let z = 0; z < depth; z += 1) {
        setBlock(volume, x + pad, height - 1 - (y + pad), z, block)
      }
    }
  }

  if (outline) {
    for (let y = -1; y <= mask.height; y += 1) {
      for (let x = -1; x <= mask.width; x += 1) {
        if (ink(x, y)) continue
        let touch = false
        for (let dy = -1; dy <= 1 && !touch; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (ink(x + dx, y + dy)) {
              touch = true
              break
            }
          }
        }
        if (!touch) continue
        for (let z = 0; z < depth; z += 1) {
          setBlock(volume, x + pad, height - 1 - (y + pad), z, outline)
        }
      }
    }
  }

  return volume
}

export default function Text3D() {
  const { version, loading } = useLibrary()
  if (loading || !version) return <p className="empty">正在加载方块几何…</p>
  return <Text3DBody version={version} />
}

function Text3DBody({ version }: { version: string }) {
  const [text, setText] = useState('MC 素材库\n立体字')
  const [block, setBlock] = useState(BLOCKS[0]!.id)
  const [outline, setOutline] = useState(true)
  const [depth, setDepth] = useState(3)
  const [rotX, setRotX] = useState(22)
  const [rotY, setRotY] = useState(-32)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [prepared, setPrepared] = useState<{
    batches: VoxelBatch[]
    mask: GlyphMask
    span: number
    pivot: [number, number, number]
  } | null>(null)
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
   * 文字/材质/厚度变化 → 重建体素。
   * @constraint 必须整体重建而不是增量：改一个字符会让整行宽度变化，
   *      增量更新会把旧字形的方块留在左边。
   */
  useEffect(() => {
    let alive = true
    void (async () => {
      const mask = await rasterize(text)
      if (!alive) return
      if (!mask) {
        setPrepared(null)
        return
      }
      /**
       * @constraint 超长文本整体降采样，不能只截断：截断会把半句话留下，
       *      用户以为自己打错字了。
       */
      const edge = Math.max(mask.width, mask.height)
      const scale = edge > MAX_EDGE ? MAX_EDGE / edge : 1
      const fitted: GlyphMask = (() => {
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
      })()

      const volume = toVolume(fitted, depth, block, outline ? OUTLINE_BLOCK : null)
      const ids = outline ? [block, OUTLINE_BLOCK] : [block]
      const { geometry } = await loadGeometry(version, ids)
      if (!alive) return
      const batches = buildVoxelBatches(volume, geometry)
      if (!batches.length) {
        setPrepared(null)
        setNote('这个方块没有可用的几何，换一个材质试试')
        return
      }
      setNote(scale < 1 ? `文字超出 ${MAX_EDGE} 格，已整体缩到 ${Math.round(scale * 100)}%` : null)
      const pad = outline ? 1 : 0
      setPrepared({
        batches,
        mask: fitted,
        span: Math.max(fitted.width, fitted.height, 1) * 1.16,
        pivot: [fitted.width / 2 + pad, fitted.height / 2 + pad, depth / 2],
      })
    })()
    return () => {
      alive = false
    }
  }, [text, block, depth, outline, version])

  /** CPU 画家算法绘制。字是小体量，不需要 WebGL 上下文 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !prepared) return
    canvas.width = size
    canvas.height = size
    void paintVoxelsCpu(
      canvas,
      prepared.batches,
      {
        size,
        rotX,
        rotY,
        zoom,
        span: prepared.span,
        pivot: prepared.pivot,
      },
      version,
    )
  }, [prepared, size, rotX, rotY, zoom, version])

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
    if (!prepared) return null
    return {
      kind: 'structure',
      id: 'text3d',
      version,
      batches: prepared.batches,
      rotX,
      rotY,
      zoom,
      span: prepared.span,
      pivot: prepared.pivot,
      size: 1024,
      backdrop: null,
    }
  }, [prepared, version, rotX, rotY, zoom])

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

  const stats = prepared ? prepared.batches.reduce((sum, batch) => sum + batch.vertexCount, 0) / 3 : 0

  return (
    <div className="page text3d">
      <header className="page-head">
        <p className="page-head__crumb">MC 素材库 / 立体字</p>
        <h1 className="page-head__title">立体字</h1>
        <p className="page-head__note">
          点阵字 → 方块 → 立体字，带一圈深色描边。可导出 GLB / OBJ / STL 或透明底 PNG。
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
            用 16px 点阵光栅化，一个亮像素长一个方块。中文一行 12 字以内最清楚。
          </p>

          <h2 className="workbench__section">材质</h2>
          <select className="studio__select" value={block} onChange={(event) => setBlock(event.target.value)}>
            {BLOCKS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.zh}
              </option>
            ))}
          </select>

          <label className="studio__check">
            <input type="checkbox" checked={outline} onChange={(event) => setOutline(event.target.checked)} />
            深色描边（轮廓外扩 1 格）
          </label>

          <label className="studio__field">
            厚度 {depth} 格
            <input
              type="range"
              min={1}
              max={6}
              value={depth}
              onChange={(event) => setDepth(Number(event.target.value))}
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
