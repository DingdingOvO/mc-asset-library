import { useEffect, useMemo, useRef, useState } from 'react'
import { containerTextureSrc, type ContainerDef } from '@/lib/containers'
import { loadFont, renderLine, type GlyphFont } from '@/lib/font'
import { ensureIcon, iconKey, iconUrl } from '@/lib/itemIcon'
import type { PlacedItem } from '@/lib/workspace'

interface ContainerPanelProps {
  def: ContainerDef
  version: string
  /** GUI 像素 → CSS 像素。整数倍才不糊，默认 3 */
  scale?: number
  items: Record<number, PlacedItem>
  /** 手上拿着的物品，非空时槽位高亮可放 */
  held?: PlacedItem | null
  /** 物品 id → 贴图路径，平面图标用 */
  textureOf: (itemId: string) => string | undefined
  onSlotClick?: (slot: number) => void
  onSlotContext?: (slot: number) => void
  interactive?: boolean
  selected?: boolean
  /** 标题语言。中文走 unifont 点阵，没有对应字形时自动退回英文 */
  lang?: 'zh' | 'en'
  className?: string
}

/**
 * 一个容器面板：背景按源码的 blit 切片拼出来，槽位按 addSlot 的坐标绝对定位。
 *
 * @constraint 内部坐标一律用 GUI 像素，缩放靠外层 transform。逐格算 scale 会
 *      在 2x/3x 下累积舍入误差，九十个格子的间距就不均匀了。
 */
function CountBadge({ version, count }: { version: string; count: number }) {
  const [font, setFont] = useState<GlyphFont | null>(null)
  useEffect(() => {
    let alive = true
    void loadFont(version).then((loaded) => {
      if (alive) setFont(loaded)
    })
    return () => {
      alive = false
    }
  }, [version])

  const url = useMemo(
    () => (font ? (renderLine(font, String(count), '#ffffff')?.toDataURL() ?? null) : null),
    [font, count],
  )
  if (!url) return null
  return <img className="mc-slot__count" src={url} alt="" draggable={false} />
}

export function ContainerPanel({
  def,
  version,
  scale = 3,
  items,
  held = null,
  textureOf,
  onSlotClick,
  onSlotContext,
  interactive = true,
  selected = false,
  lang = 'zh',
  className,
}: ContainerPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [painted, setPainted] = useState(false)
  const [font, setFont] = useState<GlyphFont | null>(null)
  const src = containerTextureSrc(version, def.texture)

  useEffect(() => {
    let alive = true
    void loadFont(version).then((loaded) => {
      if (alive) setFont(loaded)
    })
    return () => {
      alive = false
    }
  }, [version])

  useEffect(() => {
    let alive = true
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (!alive) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      for (const draw of def.draws) {
        // 与 GuiGraphics.blit 同参：从纹理 (u,v) 取 w×h，落到 (dx,dy)
        ctx.drawImage(image, draw.u, draw.v, draw.w, draw.h, draw.dx, draw.dy, draw.w, draw.h)
      }
      setPainted(true)
    }
    image.src = src
    return () => {
      alive = false
    }
  }, [src, def])

  const slotStyle = useMemo(
    () => def.slots.map((slot) => ({ left: slot.x, top: slot.y })),
    [def],
  )

  // @why 标题用位图字体渲成 data URL 而不是 HTML 文字：面板整体要按 3 倍缩放，
  //      系统字体在 8px 下渲染再放大会糊边，和背景的像素风格也对不上。
  // @constraint 中文缺失时退回英文，而不是显示一排问号：zh_cn.json 里
  //      个别键可能是空的，宁可显示原文也不要交出乱码。
  const titleText = lang === 'zh' ? def.titleTextZh || def.titleText : def.titleText
  const labelText = lang === 'zh' ? def.labelTextZh || def.labelText : def.labelText

  const titleUrl = useMemo(() => {
    if (!font) return null
    return renderLine(font, titleText, '#404040')?.toDataURL() ?? null
  }, [font, titleText])

  const labelUrl = useMemo(() => {
    if (!font) return null
    return renderLine(font, labelText, '#404040')?.toDataURL() ?? null
  }, [font, labelText])

  return (
    <div
      className={`mc-panel${selected ? ' mc-panel--selected' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: def.width * scale, height: def.height * scale }}
    >
      <div
        className="mc-panel__inner"
        style={{ width: def.width, height: def.height, transform: `scale(${scale})` }}
      >
        <canvas
          ref={canvasRef}
          className="mc-panel__bg"
          width={def.width}
          height={def.height}
          aria-hidden="true"
        />
        {!painted && <div className="mc-panel__pending" style={{ width: def.width, height: def.height }} />}
        {titleUrl && (
          <img
            className="mc-panel__text"
            src={titleUrl}
            alt=""
            style={{ left: def.title.x, top: def.title.y }}
            draggable={false}
          />
        )}
        {labelUrl && (
          <img
            className="mc-panel__text"
            src={labelUrl}
            alt=""
            style={{ left: def.inventoryLabel.x, top: def.inventoryLabel.y }}
            draggable={false}
          />
        )}
        <div className="mc-panel__slots">
          {slotStyle.map((style, index) => {
            const item = items[index]
            return (
              <button
                key={index}
                type="button"
                className={`mc-slot${item ? ' mc-slot--filled' : ''}${held ? ' mc-slot--armed' : ''}`}
                style={style}
                title={item ? `${item.id} × ${item.count}` : `槽位 ${index}`}
                tabIndex={interactive ? 0 : -1}
                disabled={!interactive}
                onClick={() => onSlotClick?.(index)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onSlotContext?.(index)
                }}
              >
                {item && (
                  <SlotItem
                    version={version}
                    item={item}
                    texture={textureOf(item.id)}
                  />
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/**
 * 槽位里的物品：图标 + 堆叠数字。
 * @why 图标是异步光栅化出来的（方块要跑一遍光栅器），所以要先查缓存、
 *      没有就排队渲染，回来后再触发一次重渲染。数量为 1 时不画数字，与游戏一致。
 */
function SlotItem({
  version,
  item,
  texture,
}: {
  version: string
  item: PlacedItem
  texture?: string
}) {
  const size = 64
  const key = iconKey(version, item.id, size)
  const [, setTick] = useState(0)

  useEffect(() => {
    if (iconUrl(key)) return
    let alive = true
    void ensureIcon(version, item.id, texture ?? `item/${item.id}`, size).then(() => {
      if (alive) setTick((value) => value + 1)
    })
    return () => {
      alive = false
    }
  }, [key, version, item.id, texture, size])

  const url = iconUrl(key)

  return (
    <>
      {url ? (
        <img className="mc-slot__icon" src={url} alt="" draggable={false} />
      ) : (
        <span className="mc-slot__icon mc-slot__icon--wait" aria-hidden="true" />
      )}
      {item.count > 1 && <CountBadge version={version} count={item.count} />}
    </>
  )
}
