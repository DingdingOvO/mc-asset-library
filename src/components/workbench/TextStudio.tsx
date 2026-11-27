import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { buildVoxelBatches, type VoxelBatch } from '@/render/world/mesher'
import { paintVoxelsCpu } from '@/render/world/cpuPaint'
import { createVolume, setBlock } from '@/lib/world/terrain'
import { loadGeometry } from '@/lib/world/geometry'
import { exportStructureSolid, exportStructureStill, type StructureSubject } from '@/lib/export/structure'
import { saveBlob } from '@/lib/export/types'
import { currentDpr, watchDpr } from '@/lib/dpr'

/**
 * 立体字：把点阵字挤成体素，能转、能导。
 *
 * @why 视频封面、服务器宣传图上的「Minecraft 风格立体字」一直是手工在 PS 里
 *      一层层偏移描边做出来的。这里换个做法：文字先光栅成 16 像素点阵，
 *      每个亮像素长成一个方块，再用结构那套体素管线渲染——
 *      得到的不是贴图假立体，是真正有厚度、有六个面的方块。
 *
 * @constraint 光栅必须用 `Unifont UI` 的 16px 字号。这份字体的 unitsPerEm
 *      正好是 16，一个字体单位 = 一个像素，点阵落在整数网格上；换成任何
 *      系统字体，第一件事就是亚像素抗锯齿，二值化之后笔画会随机缺一格。
 *
 * @constraint 体素尺寸必须封顶。一句话 24 个字 × 16 列 = 384 格宽，逐面建
 *      网格是几万个三角形，CPU 预览会卡在个位数帧率。这里按最长边 160 格
 *      截断并提示，够做标题，不够做小字。
 */

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

/** 最长边（格）。超过就整体降采样，字会糊但仍能看 */
const MAX_EDGE = 160
/** 预览画布上限（物理像素） */
const PREVIEW_MAX = 720

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

/** 掩码 → 体素体积。y 轴翻转：画布往下，体素往上 */
function toVolume(mask: GlyphMask, depth: number) {
  const volume = createVolume([mask.width, mask.height, depth])
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (!mask.data[y * mask.width + x]) continue
      for (let z = 0; z < depth; z += 1) {
        setBlock(volume, x, mask.height - 1 - y, z, BLOCKS[0]!.id)
      }
    }
  }
  return volume
}

export function TextStudio({ version }: { version: string }) {
  const [text, setText] = useState('MC 素材库\n3D 文字')
  const [block, setBlock] = useState(BLOCKS[0]!.id)
  const [depth, setDepth] = useState(2)
  const [rotX, setRotX] = useState(18)
  const [rotY, setRotY] = useState(-28)
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

  /** 预览尺寸跟随容器与 DPR */
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = () => {
      const dpr = currentDpr(2)
      const box = Math.min(stage.clientWidth, stage.clientHeight)
      setSize(Math.max(220, Math.min(PREVIEW_MAX, Math.floor(box * dpr))))
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
      const fitted: GlyphMask =
        scale === 1
          ? mask
          : {
              width: Math.max(1, Math.floor(mask.width * scale)),
              height: Math.max(1, Math.floor(mask.height * scale)),
              data: (() => {
                const data = new Uint8Array(
                  Math.max(1, Math.floor(mask.width * scale)) * Math.max(1, Math.floor(mask.height * scale)),
                )
                const w = Math.max(1, Math.floor(mask.width * scale))
                for (let y = 0; y < Math.max(1, Math.floor(mask.height * scale)); y += 1) {
                  for (let x = 0; x < w; x += 1) {
                    const sx = Math.min(mask.width - 1, Math.floor(x / scale))
                    const sy = Math.min(mask.height - 1, Math.floor(y / scale))
                    data[y * w + x] = mask.data[sy * mask.width + sx] ? 1 : 0
                  }
                }
                return data
              })(),
            }

      const volume = toVolume(fitted, depth)
      const { geometry } = await loadGeometry(version, [block])
      if (!alive) return
      const batches = buildVoxelBatches(volume, geometry)
      if (!batches.length) {
        setPrepared(null)
        setNote('这个方块没有可用的几何，换一个材质试试')
        return
      }
      setNote(scale < 1 ? `文字超出 ${MAX_EDGE} 格，已整体缩到 ${Math.round(scale * 100)}%` : null)
      setPrepared({
        batches,
        mask: fitted,
        span: Math.max(fitted.width, fitted.height, 1) * 1.15,
        pivot: [fitted.width / 2, fitted.height / 2, depth / 2],
      })
    })()
    return () => {
      alive = false
    }
  }, [text, block, depth, version])

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

      <div className="studio__stage" ref={stageRef}>
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
          style={{ cursor: 'grab' }}
        />
        <p className="studio__status">拖动旋转 · 滚轮缩放</p>
      </div>
    </div>
  )
}
