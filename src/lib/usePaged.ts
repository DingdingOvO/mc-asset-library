import { useEffect, useRef, useState } from 'react'

/**
 * 分批渲染 + 滚动追加。
 * @why 3964 张缩略图的 DOM 一次性铺开会让首屏明显卡顿，只保留可视区附近的节点
 */
export function usePaged<T>(items: readonly T[], step = 180) {
  const [count, setCount] = useState(step)
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setCount(step)
  }, [items, step])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || count >= items.length) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setCount((current) => Math.min(current + step, items.length))
        }
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [items.length, count, step])

  return {
    visible: items.slice(0, count),
    sentinelRef,
    total: items.length,
    shown: Math.min(count, items.length),
  }
}
