import type { CSSProperties, ReactNode, RefObject } from 'react'

interface AssetGridProps {
  /** useVirtualGrid 返回的网格 ref */
  gridRef?: RefObject<HTMLDivElement | null>
  /** 视口外上方占位高度 */
  padTop?: number
  /** 视口外下方占位高度 */
  padBottom?: number
  /** 列宽下限 */
  minWidth?: number
  label?: string
  children: ReactNode
}

/**
 * 统一网格容器。
 *
 * @why 六个列表页各自实现滚动策略：两页用 usePaged 每次追加 180 个，
 *      三页用 useVirtualGrid，剩下的一页直接全量渲染。行为不一致，视觉也不一致
 *      （区块卡片有的带边框、有的贴在一起、有的名字两行把行高撑开）。
 *      现在网格只有这一个，卡片只有 .tile 一种。
 *
 * @constraint 虚拟化由页面调用 useVirtualGrid 驱动，不在组件内部做：
 *      方块页与物品页需要把「当前视口内的 id」传给分片加载器，
 *      组件内部藏一份 visible 就得多开一个回传通道。
 */
export function AssetGrid({
  gridRef,
  padTop = 0,
  padBottom = 0,
  minWidth = 132,
  label,
  children,
}: AssetGridProps) {
  return (
    <div
      ref={gridRef}
      className="asset-grid"
      style={
        {
          '--tile-min-base': `${minWidth}px`,
          paddingTop: padTop || undefined,
          paddingBottom: padBottom || undefined,
        } as CSSProperties
      }
      aria-label={label}
    >
      {children}
    </div>
  )
}
