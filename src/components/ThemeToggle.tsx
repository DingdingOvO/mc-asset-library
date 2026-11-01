import { useCallback, useState } from 'react'
import { MoonIcon, SunIcon } from './icons'
import { resetOutlineColor } from '@/lib/scene'

type Theme = 'light' | 'dark'

const STORAGE_KEY = 'theme'

function readTheme(): Theme {
  // @why 内联脚本已在首帧写入 data-theme，这里直接读回，保证按钮图标与实际一致
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme)

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === 'dark' ? 'light' : 'dark'
      document.documentElement.dataset.theme = next
      // @why 描边色取自主题前景色并做了缓存，不失效的话切主题后仍是旧色
      resetOutlineColor()
      try {
        localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // 隐私模式下写入失败可忽略，主题仍在当前会话生效
      }
      return next
    })
  }, [])

  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon"
      onClick={toggle}
      title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
      aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  )
}
