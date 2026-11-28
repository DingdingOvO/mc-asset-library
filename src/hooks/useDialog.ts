import { useEffect, useRef } from 'react'

/**
 * 弹窗打开时锁住背景滚动。
 *
 * @why 之前只有遮罩没有锁：鼠标滚轮划过遮罩，后面的整页跟着滚，关掉弹窗后
 *      用户已经不知道自己看的是列表的哪一段了。用 overflow: hidden 会把
 *      滚动条宽度抽掉，页面横向抖一下，所以补上 padding。
 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const { body, documentElement } = document
    const scrollbar = window.innerWidth - documentElement.clientWidth
    const prevOverflow = body.style.overflow
    const prevPadding = body.style.paddingRight

    body.style.overflow = 'hidden'
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`

    return () => {
      body.style.overflow = prevOverflow
      body.style.paddingRight = prevPadding
    }
  }, [active])
}

/**
 * 把焦点圈在弹窗里，Esc 关闭，关闭后把焦点还给打开它的元素。
 *
 * @constraint 焦点环必须能在弹窗内部循环：只做「打开时 focus 第一个控件」
 *      的话，用户按几下 Tab 就跑到顶栏后面的链接上，视觉上焦点消失了。
 */
export function useDialogFocus(active: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    restoreRef.current = document.activeElement as HTMLElement | null

    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

    // 延后一帧：弹窗有入场动画，此时子元素未必都已挂载
    const timer = window.setTimeout(() => {
      const first = node.querySelector<HTMLElement>(selector)
      ;(first ?? node).focus({ preventScroll: true })
    }, 0)

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const items = [...node.querySelectorAll<HTMLElement>(selector)].filter(
        (element) => element.offsetParent !== null,
      )
      if (items.length === 0) return

      const first = items[0]
      const last = items[items.length - 1]
      if (!first || !last) return
      const current = document.activeElement

      if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown, true)
      restoreRef.current?.focus?.({ preventScroll: true })
    }
  }, [active, onClose])

  return ref
}
