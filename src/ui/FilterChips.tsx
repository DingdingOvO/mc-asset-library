import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'

export interface ChipItem {
  id: string
  label: string
  count?: number
}

interface FilterChipsProps {
  items: ChipItem[]
  active: string
  /** 生成链接地址；传 href 时用链接（可分享、可前进后退） */
  href?: (id: string) => string
  onChange?: (id: string) => void
  /** 是否插入「全部」项 */
  allLabel?: string
  allCount?: number
  ariaLabel?: string
  trailing?: ReactNode
}

/**
 * 分类筛选条。
 *
 * @why 六个页面各写一遍 chips 渲染，其中两页忘了给 aria-pressed，一页把
 *      "全部" 的计数写成了含隐藏项的总数。这里统一，计数由调用方按实际列表给。
 */
export function FilterChips({
  items,
  active,
  href,
  onChange,
  allLabel = '全部',
  allCount,
  ariaLabel = '分类',
  trailing,
}: FilterChipsProps) {
  const render = (id: string, label: string, count: number | undefined) => {
    const pressed = active === id
    const content = (
      <>
        {label}
        {count !== undefined && <span className="chip__count">{count}</span>}
      </>
    )

    if (href) {
      return (
        <Link key={id} className="chip" to={href(id)} aria-pressed={pressed}>
          {content}
        </Link>
      )
    }
    return (
      <button
        key={id}
        type="button"
        className="chip"
        aria-pressed={pressed}
        onClick={() => onChange?.(id)}
      >
        {content}
      </button>
    )
  }

  return (
    <div className="chips" role="group" aria-label={ariaLabel}>
      {render('all', allLabel, allCount)}
      {items.map((item) => render(item.id, item.label, item.count))}
      {trailing}
    </div>
  )
}
