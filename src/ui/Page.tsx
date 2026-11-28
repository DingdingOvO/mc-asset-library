import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

interface PageProps {
  children: ReactNode
  /** 宽版容器：列表页需要更多列 */
  wide?: boolean
  className?: string
}

export function Page({ children, wide, className }: PageProps) {
  return (
    <div className={`page${wide ? ' page--wide' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

interface PageHeaderProps {
  /** 面包屑：从上级页面回退 */
  back?: { to: string; label: string }
  title: string
  /** 标题下方的一行说明，支持任意节点（数量、版本、路径） */
  lead?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ back, title, lead, actions }: PageHeaderProps) {
  return (
    <header className="page-head">
      {back && (
        <nav className="crumbs" aria-label="位置">
          <Link to={back.to}>{back.label}</Link>
          <span className="crumbs__sep">/</span>
          <span aria-current="page">{title}</span>
        </nav>
      )}
      <div className="page-title">
        <h1>{title}</h1>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {lead && <p className="page-lead">{lead}</p>}
    </header>
  )
}

interface SectionProps {
  title: string
  note?: string
  actions?: ReactNode
  children: ReactNode
}

export function Section({ title, note, actions, children }: SectionProps) {
  return (
    <section className="section">
      <div className="section__head">
        <h2 className="section__title">{title}</h2>
        {note && <span className="section__note">{note}</span>}
        {actions && <div className="page-actions">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** 空状态：没有结果、还没选东西 */
export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      {hint && <p className="state__hint">{hint}</p>}
    </div>
  )
}

/** 加载中：带一个明确的转圈，而不是一行灰字 */
export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner" />
      <p className="state__hint">{label}</p>
    </div>
  )
}

/** 错误：贴近出错的位置显示，带上原始信息方便排查 */
export function ErrorState({ title = '加载失败', detail }: { title?: string; detail?: string }) {
  return (
    <div className="state state--inline" role="alert">
      <span>{title}</span>
      {detail && <span className="state__hint">{detail}</span>}
    </div>
  )
}
