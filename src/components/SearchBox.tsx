import { useEffect, useRef } from 'react'
import { SearchIcon } from './icons'

interface SearchBoxProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** 是否为全局快捷键 / 的接收者，同一页面只应有一个 */
  primary?: boolean
  onSubmit?: () => void
  autoFocus?: boolean
}

export function SearchBox({
  value,
  onChange,
  placeholder = '搜索',
  primary = false,
  onSubmit,
  autoFocus = false,
}: SearchBoxProps) {
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
      />
      {primary && <kbd className="search__kbd">/</kbd>}
    </form>
  )
}
