import { useEffect, useRef, type ReactNode } from 'react'
import { SearchIcon } from '@/components/icons'

interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** 是否为全局快捷键 / 的接收者，同一页面只应有一个 */
  primary?: boolean
  onSubmit?: () => void
  autoFocus?: boolean
  /** 追加在右侧的控件，例如筛选开关 */
  trailing?: ReactNode
}

/**
 * 搜索框。
 * @constraint 宽度由父级 flex/grid 决定，自身不再写 flex-basis：
 *      之前搜索框和筛选条挤在同一行，chips 的内容宽度把它压成只剩一个图标。
 */
export function SearchField({
  value,
  onChange,
  placeholder = '搜索',
  primary = false,
  onSubmit,
  autoFocus = false,
}: SearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    if (!primary) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      event.preventDefault()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [primary])

  return (
    <form
      className="search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit?.()
      }}
    >
      <span className="search__icon">
        <SearchIcon />
      </span>
      <input
        ref={inputRef}
        className="input"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault()
            onChange('')
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="search__clear"
          aria-label="清空搜索"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2 2l8 8M10 2l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : (
        primary && <kbd className="search__kbd">/</kbd>
      )}
    </form>
  )
}
