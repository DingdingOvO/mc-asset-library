import { useEffect } from 'react'
import { cssCursor } from './cursors'

/**
 * 装上像素风鼠标指针。
 *
 * @constraint 主题与指针是反的：浅色主题用 dark 那套（黑箭头），深色主题用
 *      light 那套（白箭头）。用反了会在同色背景上完全看不见。
 * @why 用 MutationObserver 跟随 data-theme 而不是只在挂载时算一次：主题开关
 *      是同一个页面里切的，不重挂载根组件。
 */
export function useCursors(): void {
  useEffect(() => {
    const apply = () => {
      const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
      const root = document.documentElement.style
      root.setProperty('--cur-arrow', cssCursor(theme, 'arrow', 'default'))
      root.setProperty('--cur-hand', cssCursor(theme, 'hand', 'pointer'))
      root.setProperty('--cur-grab', cssCursor(theme, 'grab', 'grab'))
      root.setProperty('--cur-grabbing', cssCursor(theme, 'grab', 'grabbing'))
      root.setProperty('--cur-text', cssCursor(theme, 'text', 'text'))
      root.setProperty('--cur-cross', cssCursor(theme, 'crosshair', 'crosshair'))
      root.setProperty('--cur-nodrop', cssCursor(theme, 'nodrop', 'not-allowed'))
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
}
