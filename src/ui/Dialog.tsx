import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { CloseIcon } from '@/components/icons'
import { useDialogFocus, useScrollLock } from '@/hooks/useDialog'

interface DialogProps {
  open: boolean
  onClose: () => void
  /** 无障碍名称，读屏会念出来 */
  label: string
  children: ReactNode
  /** 追加在 .modal 上的修饰类 */
  className?: string
  style?: CSSProperties
}

/**
 * 全站唯一的弹窗基座。
 *
 * @why 之前 ModelModal / TextureDetail / ParticleModal 各写一份：一份没有 Esc、
 *      一份没有 portal、三份都没有滚动锁和焦点管理，关闭动画也各写一遍。
 *      行为差异全部收在这里，业务组件只负责内容。
 */
export function Dialog({ open, onClose, label, children, className, style }: DialogProps) {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  // 关闭动画：先标记 closing，动画结束后再真正卸载
  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, 170)
    return () => window.clearTimeout(timer)
  }, [open, mounted])

  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const requestClose = useCallback(() => {
    onCloseRef.current()
  }, [])

  useScrollLock(mounted)
  const ref = useDialogFocus(mounted, requestClose)

  if (!mounted) return null

  return createPortal(
    <div
      className={`modal-backdrop${closing ? ' is-closing' : ''}`}
      onMouseDown={(event) => {
        // @why 用 mousedown 而不是 click：在弹窗里拖选文字，鼠标松开时落在
        //      遮罩上会触发 click，整个弹窗被误关。按下位置在遮罩上才算点击外部。
        if (event.target === event.currentTarget) requestClose()
      }}
      role="presentation"
    >
      <div
        ref={ref}
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        style={style}
      >
        <button type="button" className="modal__close" onClick={requestClose} aria-label="关闭">
          <CloseIcon />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  )
}
