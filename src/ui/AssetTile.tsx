import type { CSSProperties, MouseEventHandler, ReactNode } from 'react'

interface AssetTileProps {
  name: string
  /** 副标题：尺寸、生命周期、路径这类补充信息，固定一行 */
  meta?: ReactNode
  /** 缩略区内容：canvas、img 或占位 */
  children?: ReactNode
  pressed?: boolean
  onClick?: MouseEventHandler<HTMLButtonElement>
  /** 悬停提示，通常来自 tipAttrs(...).title */
  hint?: string
  /** 缩略区用棋盘格背景（透明贴图） */
  checker?: boolean
  style?: CSSProperties
  /** 缩略区内容的额外类名 */
  thumbClassName?: string
}

/**
 * 列表里的一张卡片。
 *
 * @why 以前每个页面一套：.block-cell 无边框、.tex-cell 贴在一起、
 *      .particle-cell 名字两行把行高撑开、.entry-card 又是另一种圆角。
 *      现在只有这一个，尺寸由 CSS 变量控制，名字固定一行，超出省略。
 *
 * @constraint 高度不能由内容决定：虚拟滚动按实测行高推算滚动条总高，
 *      名字换行、meta 缺失都会让某些行高出几个像素，滚到底部就对不上。
 */
export function AssetTile({
  name,
  meta,
  children,
  pressed = false,
  onClick,
  hint,
  checker = false,
  style,
  thumbClassName,
}: AssetTileProps) {
  /**
   * @why 名字与副标题相同时不画副标题。
   *      注册表里的粒子和一部分效果没有中文名，`n` 就是注册 id，于是每张卡上
   *      同一个字符串出现两遍——看起来像渲染重复了，而不是「没有中文名」。
   */
  const redundant = typeof meta === 'string' && meta.trim().toLowerCase() === name.trim().toLowerCase()

  return (
    <button
      type="button"
      className="tile"
      aria-pressed={pressed}
      onClick={onClick}
      title={hint ?? name}
      style={style}
    >
      <span
        className={`tile__thumb${checker ? ' tile__thumb--checker' : ''}${thumbClassName ? ` ${thumbClassName}` : ''}`}
      >
        {children}
      </span>
      <span className="tile__name">{name}</span>
      {meta !== undefined && !redundant && <span className="tile__meta">{meta}</span>}
    </button>
  )
}
