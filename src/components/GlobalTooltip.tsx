import { useEffect, useRef, useState } from 'react'
import { useLibrary } from '@/lib/useLibrary'
import { McTooltip, type TipState } from './McTooltip'

/**
 * 全站悬停提示。
 *
 * @why 各页面原来各自写 `title="金合欢木楼梯"`，那是浏览器原生提示：灰底、
 *      系统字体、1 秒延迟、不能换行、还挡住目标元素。同一个站里出现两种
 *      提示样式，一眼就不像游戏。这里改成事件委托：任何带 `data-tip` 的元素
 *      都用原版 tooltip 渲染，页面侧只需要把 title 换成 data-tip。
 *
 * @constraint 必须挂在**一个**地方（AppShell），不能每个页面各挂一个。
 *      多个实例会在同一像素上叠出两层提示，而且各自记录 hover 目标，
 *      滚动时互相打架。
 */

export interface TipAttrs {
  'data-tip'?: string
  'data-tip-note'?: string
  'data-tip-sub'?: string
}

/** 页面侧把 title 换成这个；返回的对象直接展开到元素上 */
export function tipAttrs(title: string, note?: string, sub?: string): TipAttrs {
  return {
    'data-tip': title,
    ...(note ? { 'data-tip-note': note } : {}),
    ...(sub ? { 'data-tip-sub': sub } : {}),
  }
}

export function GlobalTooltip() {
  const { version } = useLibrary()
  const [tip, setTip] = useState<TipState | null>(null)
  const active = useRef<Element | null>(null)

  useEffect(() => {
    // @constraint 用捕获阶段：很多格子在上层还有一层 pointer-events:none 的
    //      装饰元素，冒泡阶段拿到的 target 是那层壳，closest 找不到 data-tip。
    const over = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      const el = target?.closest?.('[data-tip]') as HTMLElement | null
      if (!el) {
        if (active.current) {
          active.current = null
          setTip(null)
        }
        return
      }
      // @why 同一个元素重复触发 pointerover 时直接返回：子元素之间移动会
      //      每秒触发几十次，每次都 setState 会让提示框跟着闪。
      if (active.current === el) return
      active.current = el
      const box = el.getBoundingClientRect()
      setTip({
        x: box.left,
        y: box.top,
        title: el.dataset.tip ?? '',
        note: el.dataset.tipNote,
        sub: el.dataset.tipSub,
      })
    }

    const hide = () => {
      active.current = null
      setTip(null)
    }

    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  if (!version) return null
  return <McTooltip tip={tip} version={version} />
}
