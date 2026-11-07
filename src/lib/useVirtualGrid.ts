import { useEffect, useRef, useState } from 'react'

interface VirtualGridOptions {
  rowHeight: number
  minColumnWidth: number
}

interface VirtualGridState {
  start: number
  end: number
  padTop: number
  padBottom: number
}

/**
 * 只渲染视口附近的网格行。
 * @why 每个立方体要十几个 3D 变换的 div，一百多个卡片就是一千多个合成层，
 *      浏览器直接掉帧；这里按滚动位置算可见行，屏外只留空白高度。
 */
export function useVirtualGrid<T>(items: readonly T[], options: VirtualGridOptions) {
  const { rowHeight, minColumnWidth } = options
  const ref = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<VirtualGridState>({
    start: 0,
    end: 48,
    padTop: 0,
    padBottom: 0,
  })

  useEffect(() => {
    let frame = 0

    const measure = () => {
      const node = ref.current
      if (!node) return

      /**
       * @constraint 列数必须从计算样式读，不能按 minColumnWidth 自己除：
       *      CSS 在手机断点换了更窄的列宽（104 → 84），两边算法不一致的话
       *      虚拟滚动会以为只有 3 列、实际排了 4 列，视口底部留半屏空白。
       */
      const style = getComputedStyle(node).gridTemplateColumns
      const columns =
        style && style !== 'none'
          ? style.trim().split(/\s+/).length
          : Math.max(1, Math.floor(node.clientWidth / minColumnWidth))
      const rows = Math.ceil(items.length / columns)
      const rect = node.getBoundingClientRect()

      // 已经滚过网格顶部的距离，负数说明网格还没进视口
      const scrolled = Math.max(0, -rect.top)
      const startRow = Math.max(0, Math.floor(scrolled / rowHeight) - 1)
      const endRow = Math.min(rows, startRow + Math.ceil(window.innerHeight / rowHeight) + 2)

      setState({
        start: startRow * columns,
        end: Math.min(items.length, endRow * columns),
        padTop: startRow * rowHeight,
        padBottom: Math.max(0, (rows - endRow) * rowHeight),
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
    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [items.length, rowHeight, minColumnWidth])

  return {
    ref,
    visible: items.slice(state.start, state.end),
    padTop: state.padTop,
    padBottom: state.padBottom,
  }
}
