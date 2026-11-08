import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { containerTextureSrc, type ContainerDef, type ParamValue } from '@/lib/containers'
import { loadFont, renderLine, type GlyphFont } from '@/lib/font'
import { ensureIcon, iconKey, iconUrl } from '@/lib/itemIcon'
import { layerSprites, paintLabels, paintLayers } from '@/lib/layerRender'
import { preloadSprites, spriteOf } from '@/lib/sprites'
import type { PlacedItem } from '@/lib/workspace'

interface ContainerPanelProps {
  def: ContainerDef
  version: string
  /** GUI 像素 → CSS 像素。整数倍才不糊，默认 3 */
  scale?: number
  items: Record<number, PlacedItem>
  /** 可变状态：熔炉进度、信标等级… */
  params?: Record<string, ParamValue>
  /** 手上拿着的物品，非空时槽位高亮可放 */
  held?: PlacedItem | null
  /** 物品 id → 贴图路径，平面图标用 */
  textureOf: (itemId: string) => string | undefined
  /** 物品 id → 显示名，供悬停提示 */
  nameOf?: (itemId: string) => string
  onSlotClick?: (slot: number) => void
  onSlotContext?: (slot: number) => void
  /** 悬停格子时上报，交给画布统一渲染 tooltip */
  onSlotHover?: (slot: number | null, at: { x: number; y: number } | null) => void
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
 * @constraint 背景与动态层画在同一块 canvas 上。分两块会导致火焰和槽位高亮
 *      之间插一层 DOM，缩放时边缘对不齐一像素——导出图里能看出来。
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
  params = {},
  held = null,
  textureOf,
  nameOf,
  onSlotClick,
  onSlotContext,
  onSlotHover,
  interactive = true,
  selected = false,
  lang = 'zh',
  className,
}: ContainerPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const bgRef = useRef<HTMLImageElement | null>(null)
  const [bgState, setBgState] = useState<'idle' | 'loading' | 'done' | 'none'>('idle')
  const [font, setFont] = useState<GlyphFont | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    void loadFont(version).then((loaded) => {
      if (alive) setFont(loaded)
    })
    return () => {
      alive = false
    }
  }, [version])

  // 背景纹理：箱子、熔炉这些是一整张图的几段；快捷栏没有背景图，全部由层画出来
  useEffect(() => {
    if (!def.texture) {
      bgRef.current = null
      setBgState('none')
      return
    }
    let alive = true
    setBgState('loading')
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (!alive) return
      bgRef.current = image
      setBgState('done')
    }
    image.onerror = () => {
      if (alive) setBgState('none')
    }
    image.src = containerTextureSrc(version, def.texture)
    return () => {
      alive = false
    }
  }, [version, def])

  // 动态层的 sprite 必须先攒齐：它们是同步绘制的，缺一张就该层整块消失，
  // 要等下一次参数变化才补回来，看起来像"火焰偶尔不见了"。
  useEffect(() => {
    const need = layerSprites(def)
    if (!need.length) return
    let alive = true
    void preloadSprites(version, need).then(() => {
      if (alive) setTick((value) => value + 1)
    })
    return () => {
      alive = false
    }
  }, [version, def])

  const paint = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const bg = bgRef.current
    if (bg) {
      for (const draw of def.draws) {
        // 与 GuiGraphics.blit 同参：从纹理 (u,v) 取 w×h，落到 (dx,dy)
        ctx.drawImage(bg, draw.u, draw.v, draw.w, draw.h, draw.dx, draw.dy, draw.w, draw.h)
      }
    }
    paintLabels(ctx, def, font, lang)
    paintLayers(ctx, def, {
      font,
      lang,
      params,
      getSprite: (name) => spriteOf(version, name),
    })
  }, [def, font, lang, params, version])

  useEffect(() => {
    if (bgState !== 'done' && bgState !== 'none') return
    paint()
  }, [bgState, paint, tick])

  const ready = bgState === 'done' || bgState === 'none'

  const slotStyle = useMemo(
    () => def.slots.map((slot) => ({ left: slot.x, top: slot.y })),
    [def],
  )

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
        {!ready && <div className="mc-panel__pending" style={{ width: def.width, height: def.height }} />}
        <div className="mc-panel__slots">
          {slotStyle.map((style, index) => {
            const item = items[index]
            return (
              <button
                key={index}
                type="button"
                className={`mc-slot${item ? ' mc-slot--filled' : ''}${held ? ' mc-slot--armed' : ''}`}
                style={style}
                tabIndex={interactive ? 0 : -1}
                disabled={!interactive}
                /* @why 拖放要在 window 的 pointerup 里用 elementFromPoint 反查落点，
                   React 的合成事件拿不到跨组件目标，只能靠 DOM 属性传身份。 */
                data-slot={index}
                aria-label={item ? `${nameOf?.(item.id) ?? item.id} × ${item.count}` : `槽位 ${index + 1}`}
                onClick={() => onSlotClick?.(index)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  onSlotContext?.(index)
                }}
                onPointerEnter={(event) => {
                  if (!item) return
                  const box = event.currentTarget.getBoundingClientRect()
                  onSlotHover?.(index, { x: box.left, y: box.top })
                }}
                onPointerLeave={() => onSlotHover?.(null, null)}
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
