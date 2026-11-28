import type { ReactNode } from 'react'

interface ToolbarProps {
  children: ReactNode
  /** 第二行：分类筛选 */
  filters?: ReactNode
  /** 右侧附加信息，例如「1146 个方块」 */
  meta?: ReactNode
}

/**
 * 列表页统一的粘性工具栏。
 *
 * @constraint 搜索框在独立一行，宽度只由这一行决定。之前和 14 个分类 chip
 *      挤在同一 flex 行里，chip 的内容宽度把搜索框压到 30px，线上表现为
 *      「搜索框变成一个图标按钮」。
 */
export function Toolbar({ children, filters, meta }: ToolbarProps) {
  return (
    <div className="toolbar">
      <div className="toolbar__row">
        {children}
        {meta !== undefined && <span className="toolbar__meta">{meta}</span>}
      </div>
      {filters && <div className="toolbar__row">{filters}</div>}
    </div>
  )
}
