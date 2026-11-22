import { useCallback, useEffect, useRef, useState } from 'react'
import { MAP_GUI, MAP_PALETTE } from './mcui/screens'

/**
 * 地图笔刷层。
 *
 * @why 原版地图就是一张 128×128 的像素图，每一格是 `MapColor` 的一个下标——
 *      地形、建筑、标记全都画在这张图上。之前这里只有"底图 + 标记"，等于把
 *      地图最有用的那部分（画面）整个抽掉了，用户只能截个空图。这里补上真正的
 *      笔刷：一格一像素，改了立刻出现在预览上。
 *
 * @constraint 颜色必须查预计算的 RGB 表，不能在像素循环里解析 CSS 字符串。
 *      16384 个像素每次拖动都跑一遍 `parseInt(hex.slice())` 是纯浪费，
 *      实测拖动时帧率会掉到个位数。
 */

export type MapTool = 'brush' | 'eraser' | 'fill' | 'picker'

const W = MAP_GUI.width
const H = MAP_GUI.height
const SIZE = W * H

/** 色板下标（1 起）→ RGB，下标 0 留空（透明） */
const PALETTE_RGB = (() => {
  const table = new Uint8Array((MAP_PALETTE.length * 4 + 1) * 3)
  MAP_PALETTE.forEach((group, groupIndex) => {
    group.forEach((hex, level) => {
      const index = groupIndex * 4 + level + 1
      table[index * 3] = parseInt(hex.slice(1, 3), 16)
      table[index * 3 + 1] = parseInt(hex.slice(3, 5), 16)
      table[index * 3 + 2] = parseInt(hex.slice(5, 7), 16)
    })
  })
  return table
})()

/** 撤销栈上限。一份快照 16KB，40 步 640KB，比整页的贴图缓存还小 */
const HISTORY_MAX = 40

export interface MapPaintApi {
  /** 已经光栅化的 128×128 画布，直接交给 `drawMap` */
  raster: HTMLCanvasElement | null
  /** 每次落笔 +1，用来触发重绘 */
  version: number
  /** 把画布上的 CSS 坐标换算成地图格子，落在画外返回 null */
  locate: (rect: DOMRect, clientX: number, clientY: number) => { x: number; y: number } | null
  /** 开始一笔：入撤销栈，然后落第一个点 */
  begin: (x: number, y: number, tool: MapTool, color: number) => number | null
  /** 继续这一笔：与上一点之间补直线，避免快速拖动留下断点 */
  move: (x: number, y: number) => void
  end: () => void
  undo: () => void
  clear: () => void
  canUndo: boolean
  /** 吸管顺手读到的色号；没有颜色返回 0 */
  sample: (x: number, y: number) => number
}

export function useMapPaint(): MapPaintApi {
  const paint = useRef<Uint8Array>(new Uint8Array(SIZE))
  const raster = useRef<HTMLCanvasElement | null>(null)
  const pixels = useRef<ImageData | null>(null)
  const dirty = useRef(false)
  const frame = useRef(0)

  const history = useRef<Uint8Array[]>([])
  const stroke = useRef<{ tool: MapTool; color: number; last: { x: number; y: number } | null } | null>(null)

  const [version, setVersion] = useState(0)
  const [canUndo, setCanUndo] = useState(false)

  /**
   * @constraint 离屏画布必须在**首次渲染期间**就位，不能等 useEffect：
   *      ScreenStudio 用 useLayoutEffect 画预览，比 useEffect 早一帧跑，
   *      那时 raster 还是 null，预览就永远缺一层笔刷，直到用户画第一笔才补上。
   *      渲染期做惰性初始化是 React 官方认可的写法（纯内存对象，无外部副作用）。
   */
  if (raster.current === null && typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (ctx) {
      pixels.current = ctx.createImageData(W, H)
      raster.current = canvas
    }
  }

  const flush = useCallback(() => {
    const canvas = raster.current
    const image = pixels.current
    if (!canvas || !image) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const data = image.data
    const source = paint.current
    for (let i = 0; i < SIZE; i += 1) {
      const value = source[i]!
      const at = i * 4
      if (value === 0) {
        data[at + 3] = 0
        continue
      }
      const rgb = value * 3
      data[at] = PALETTE_RGB[rgb]!
      data[at + 1] = PALETTE_RGB[rgb + 1]!
      data[at + 2] = PALETTE_RGB[rgb + 2]!
      data[at + 3] = 255
    }
    ctx.putImageData(image, 0, 0)

    /**
     * @why 用 rAF 合并提交，而不是每落一个像素就 setState：pointermove 在
     *      高刷屏上一秒能来 240 次，每次都触发 React 重渲染 + 整块预览重绘，
     *      画笔会明显拖在手指后面。一帧一次刚好。
     */
    dirty.current = false
    setVersion((value) => value + 1)
  }, [])

  const schedule = useCallback(() => {
    if (dirty.current) return
    dirty.current = true
    frame.current = requestAnimationFrame(flush)
  }, [flush])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const snapshot = useCallback(() => {
    history.current.push(new Uint8Array(paint.current))
    if (history.current.length > HISTORY_MAX) history.current.shift()
    setCanUndo(true)
  }, [])

  const setPixel = useCallback(
    (x: number, y: number, color: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false
      const at = y * W + x
      if (paint.current[at] === color) return false
      paint.current[at] = color
      return true
    },
    [],
  )

  /** 四邻接填充。用显式栈而不是递归：128×128 的整片同色会把调用栈打爆 */
  const flood = useCallback((x: number, y: number, color: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return
    const start = y * W + x
    const from = paint.current[start]!
    if (from === color) return
    const stack: number[] = [start]
    while (stack.length) {
      const at = stack.pop()!
      if (paint.current[at] !== from) continue
      paint.current[at] = color
      const px = at % W
      const py = (at - px) / W
      if (px > 0) stack.push(at - 1)
      if (px < W - 1) stack.push(at + 1)
      if (py > 0) stack.push(at - W)
      if (py < H - 1) stack.push(at + W)
    }
  }, [])

  /** Bresenham：两次 pointermove 之间可能跨十几格，只点端点会留下一串空点 */
  const line = useCallback(
    (x0: number, y0: number, x1: number, y1: number, color: number) => {
      let x = x0
      let y = y0
      const dx = Math.abs(x1 - x0)
      const dy = Math.abs(y1 - y0)
      const sx = x0 < x1 ? 1 : -1
      const sy = y0 < y1 ? 1 : -1
      let err = dx - dy
      for (let guard = 0; guard < 512; guard += 1) {
        setPixel(x, y, color)
        if (x === x1 && y === y1) break
        const e2 = err * 2
        if (e2 > -dy) {
          err -= dy
          x += sx
        }
        if (e2 < dx) {
          err += dx
          y += sy
        }
      }
    },
    [setPixel],
  )

  const locate = useCallback((rect: DOMRect, clientX: number, clientY: number) => {
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = Math.floor(((clientX - rect.left) / rect.width) * W)
    const y = Math.floor(((clientY - rect.top) / rect.height) * H)
    if (x < 0 || y < 0 || x >= W || y >= H) return null
    return { x, y }
  }, [])

  const begin = useCallback(
    (x: number, y: number, tool: MapTool, color: number): number | null => {
      if (tool === 'picker') return paint.current[y * W + x] ?? 0
      snapshot()
      if (tool === 'fill') {
        flood(x, y, color)
        schedule()
        return null
      }
      stroke.current = { tool, color, last: { x, y } }
      setPixel(x, y, color)
      schedule()
      return null
    },
    [flood, schedule, setPixel, snapshot],
  )

  const move = useCallback(
    (x: number, y: number) => {
      const active = stroke.current
      if (!active) return
      const last = active.last ?? { x, y }
      line(last.x, last.y, x, y, active.color)
      active.last = { x, y }
      schedule()
    },
    [line, schedule],
  )

  const end = useCallback(() => {
    stroke.current = null
  }, [])

  const undo = useCallback(() => {
    const previous = history.current.pop()
    if (!previous) return
    paint.current = previous
    setCanUndo(history.current.length > 0)
    schedule()
  }, [schedule])

  const clear = useCallback(() => {
    snapshot()
    paint.current = new Uint8Array(SIZE)
    schedule()
  }, [schedule, snapshot])

  const sample = useCallback((x: number, y: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 0
    return paint.current[y * W + x] ?? 0
  }, [])

  return {
    raster: raster.current,
    version,
    locate,
    begin,
    move,
    end,
    undo,
    clear,
    canUndo,
    sample,
  }
}
