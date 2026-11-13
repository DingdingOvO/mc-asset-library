import { useEffect, useMemo, useState } from 'react'
import { ensureIcon, ICON_PIXELS, iconKey, iconUrl } from '@/lib/itemIcon'
import type { Item } from '@/lib/items'

/**
 * 物品选择区：原版创造模式物品栏那种纯图标网格。
 *
 * @why 之前这里是一列文字 chips，只显示物品中文名。问题是这个站的物品命名
 *      高度相似——"金合欢木楼梯 / 金合欢木台阶 / 金合欢木压力板"三行挨在一起，
 *      满屏汉字没有任何视觉锚点，找一件东西要逐行读。游戏里从来不这么做：
 *      物品栏是 18×18 的格子，认图比认字快一个数量级。
 *
 * @constraint 图标按 64px 光栅化、32 CSS px 显示。差值正好是 2 倍，在 2x 屏上
 *      1 个位图像素 = 1 个设备像素；写 32px 会在高分屏上被浏览器再插值一次，
 *      16×16 的贴图直接糊成色块。
 */

/** 光栅化尺寸：与槽位共用同一份缓存键 */
const ICON_PX = ICON_PIXELS
/** 画面上占多少 CSS 像素 */
const SHOW_PX = 32

export interface ItemPaletteProps {
  version: string
  items: Item[]
  heldId: string | null
  onPick: (item: Item) => void
  onDragStart: (event: React.PointerEvent, itemId: string) => void
  onHover: (item: Item | null, at: { x: number; y: number } | null) => void
  /** 搜索后仍被截断时为 true，用来提示缩小范围 */
  truncated: number
}

function ItemTile({
  version,
  item,
  active,
  onPick,
  onDragStart,
  onHover,
}: {
  version: string
  item: Item
  active: boolean
  onPick: (item: Item) => void
  onDragStart: (event: React.PointerEvent, itemId: string) => void
  onHover: (item: Item | null, at: { x: number; y: number } | null) => void
}) {
  const key = iconKey(version, item.id, ICON_PX)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (iconUrl(key)) return
    let alive = true
    void ensureIcon(version, item.id, item.i, ICON_PX).then(() => {
      if (alive) setTick((value) => value + 1)
    })
    return () => {
      alive = false
    }
  }, [key, version, item.id, item.i])

  const url = iconUrl(key)

  return (
    <button
      type="button"
      className={`item-tile${active ? ' item-tile--on' : ''}`}
      aria-label={item.n || item.id}
      onPointerDown={(event) => onDragStart(event, item.id)}
      onClick={() => onPick(item)}
      onPointerEnter={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        onHover(item, { x: box.left, y: box.top })
      }}
      onPointerLeave={() => onHover(null, null)}
    >
      {url ? (
        <img className="item-tile__icon" src={url} alt="" draggable={false} width={SHOW_PX} height={SHOW_PX} />
      ) : (
        <span className="item-tile__wait" aria-hidden="true" />
      )}
    </button>
  )
}

export function ItemPalette({ version, items, heldId, onPick, onDragStart, onHover, truncated }: ItemPaletteProps) {
  // @why 截断提示只在这一屏用得到，做成常量避免父组件每次渲染都传新字符串
  const hint = useMemo(() => (truncated > 0 ? `还有 ${truncated} 件，缩小搜索范围` : null), [truncated])

  return (
    <div className="item-grid">
      {items.map((item) => (
        <ItemTile
          key={item.id}
          version={version}
          item={item}
          active={heldId === item.id}
          onPick={onPick}
          onDragStart={onDragStart}
          onHover={onHover}
        />
      ))}
      {hint && <p className="workbench__hint workbench__hint--wide">{hint}</p>}
    </div>
  )
}
