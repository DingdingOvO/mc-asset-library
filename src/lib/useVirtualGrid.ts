import { useEffect, useRef, useState } from 'react'

interface VirtualGridOptions {
  /** 兜底行高：第一帧还没有子元素时用它估算 */
  rowHeight: number
  /** 列宽下限，只在 computedStyle 读不到时用于估算列数 */
  minColumnWidth: number
  /** 过滤条件变化时传一个新值，会把视口拉回网格顶部 */
  resetKey?: unknown
}

/**
 * 只渲染视口附近的网格行。
 *
 * @why 方块页有 1100 多张卡片，每张是一个 canvas 光栅化出来的立方体；
 *      全量挂载会同时创建上千个渲染上下文。虚拟滚动把这批工作压到屏幕内。
 *
 * @constraint 行高必须实测，不能沿用写死的数字。之前用 118/120 估，
 *      而 CSS 里卡片高度会随名字行数、断点、字号变化，估算一漂，滚动条总高
 *      就跟着漂，滚到底部会多出一片空白或者提前截断。
 *
 * @constraint resetKey 变化后要回到网格顶部。搜索把 1146 项缩到 3 项时，
 *      原来的滚动位置在 6000px 处，浏览器虽然会夹紧滚动条，但那一帧里
 *      padTop 还是旧值，用户先看到一片空白再看到结果。
 */
export function useVirtualGrid<T>(items: readonly T[], options: VirtualGridOptions) {
  const { rowHeight, minColumnWidth, resetKey } = options
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState({ start: 0, end: 48, padTop: 0, padBottom: 0 })

  // 过滤条件变了：先把视口拉回网格顶部
  useEffect(() => {
    const node = ref.current
    if (!node || resetKey === undefined) return
    const top = node.getBoundingClientRect().top + window.scrollY
    const anchor = Math.max(0, top - 120)
    if (window.scrollY > anchor) window.scrollTo({ top: anchor })
  }, [resetKey])

  useEffect(() => {
    let frame = 0

    const measure = () => {
      const node = ref.current
      if (!node) return

      const style = getComputedStyle(node)
      const columns = Math.max(
        1,
        style.gridTemplateColumns && style.gridTemplateColumns !== 'none'
          ? style.gridTemplateColumns.trim().split(/\s+/).length
          : Math.floor(node.clientWidth / minColumnWidth),
      )

      // 实测行高：第二行第一个卡片的 offsetTop 减去第一行的，含行间距
      const kids = node.children
      let rowH = rowHeight
      if (kids.length > columns) {
        const first = kids[0] as HTMLElement
        const next = kids[columns] as HTMLElement
        const delta = next.offsetTop - first.offsetTop
        if (delta > 8) rowH = delta
      } else if (kids.length > 0) {
        const first = kids[0] as HTMLElement
        const gap = Number.parseFloat(style.rowGap) || 0
        if (first.offsetHeight > 8) rowH = first.offsetHeight + gap
      }

      const rows = Math.ceil(items.length / columns)
      const rect = node.getBoundingClientRect()
      const scrolled = Math.max(0, -rect.top)
      const startRow = Math.max(0, Math.floor(scrolled / rowH) - 1)
      const endRow = Math.min(rows, startRow + Math.ceil(window.innerHeight / rowH) + 2)

      setState((prev) => {
        const next = {
          start: startRow * columns,
          end: Math.min(items.length, endRow * columns),
          padTop: startRow * rowH,
          padBottom: Math.max(0, (rows - endRow) * rowH),
        }
        if (
          prev.start === next.start &&
          prev.end === next.end &&
          prev.padTop === next.padTop &&
          prev.padBottom === next.padBottom
        ) {
          return prev
        }
        return next
      })
    }

    const schedule = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }

    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const observer = new ResizeObserver(schedule)
    if (ref.current) observer.observe(ref.current)

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
    }
  }, [items.length, rowHeight, minColumnWidth, resetKey])

  return {
    ref,
    visible: items.slice(state.start, state.end),
    padTop: state.padTop,
    padBottom: state.padBottom,
  }
}
