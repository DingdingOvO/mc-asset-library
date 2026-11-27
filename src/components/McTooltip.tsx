import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { loadFont, type GlyphFont } from '@/lib/font'
import { measureTooltip, placeTooltip, drawTooltip, type TipLine, type TipSprites } from '@/lib/mcui/tooltip'
import { prepare } from '@/lib/mcui/surface'
import { loadSprite } from '@/lib/sprites'
import { tipStyleOf, type ModernUi } from '@/lib/modern'

/**
 * 原版悬停提示，整块用 canvas 画。
 *
 * @why 以前的实现是 HTML + `border-image` 九宫格 + 系统字体。三个问题叠在一起：
 *      ① `tooltip/background` 本身是半透明的，底下若是文字列表，被悬停的两行字
 *         会透过提示框浮上来，"废弃营地地图"和下面的物品名糊成一团；
 *      ② 系统字体 12.5px 与原版 8px 位图字不是一回事，一眼看得出不是游戏；
 *      ③ `border-image` 的平铺/拉伸行为与 `nine_slice` 的 `stretch_inner`
 *         不同，宽提示的中间那条会变成横纹。
 *      canvas 一次解决：不透明由贴图决定、字形来自 ascii.png、九宫格逐块画。
 *
 * @constraint 必须等字体与两张贴图都到位再画。字体是异步的，缺字形时先画一版
 *      会把整条提示定格成 '?'；贴图缺失则只能退化成实心块。
 */

export interface TipState {
  /** 视口坐标：被悬停元素的左上角 */
  x: number
  y: number
  title: string
  /** 第二行，原版的灰色附加信息（数量、id） */
  note?: string
  /** 第三行，更暗的辅助行 */
  sub?: string
}

/** 每个 GUI 像素占多少 CSS 像素。2 相当于原版 GUI Scale 2 */
const GUI_SCALE = 2

export function McTooltip({
  tip,
  version,
  modern,
}: {
  tip: TipState | null
  version: string
  modern?: ModernUi
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [font, setFont] = useState<GlyphFont | null>(null)
  const [sprites, setSprites] = useState<TipSprites>({ background: null, frame: null })

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
    void Promise.all([loadSprite(version, 'tooltip/background'), loadSprite(version, 'tooltip/frame')]).then(
      ([background, frame]) => {
        if (alive) setSprites({ background, frame })
      },
    )
    return () => {
      alive = false
    }
  }, [version])

  const lines = useMemo<TipLine[]>(() => {
    if (!tip) return []
    // @constraint 第二行必须是 ChatFormatting.GRAY = #AAAAAA 的纯灰。
    //      之前用的 #a8a8b8 带了蓝紫偏色，压在紫边框上整行发紫，
    //      和原版"白色主行 + 灰色副行"的对比完全不是一回事。
    const out: TipLine[] = [{ text: tip.title, color: '#ffffff' }]
    if (tip.note) out.push({ text: tip.note, color: '#aaaaaa' })
    if (tip.sub) out.push({ text: tip.sub, color: '#aaaaaa' })
    return out
  }, [tip])

  const style = useMemo(() => tipStyleOf(modern), [modern])

  const box = useMemo(
    () => (font && lines.length ? measureTooltip(font, lines, style) : null),
    [font, lines, style],
  )

  const place = useMemo(() => {
    if (!box) return null
    return placeTooltip(tip?.x ?? 0, tip?.y ?? 0, box, window.innerWidth, window.innerHeight, GUI_SCALE)
  }, [box, tip])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !font || !box || !place || !lines.length) return
    const surface = prepare(canvas, box.boxWidth, box.boxHeight, GUI_SCALE)
    if (!surface) return
    drawTooltip(surface.ctx, font, lines, box.inset, box.inset, sprites, style)
  }, [font, box, place, lines, sprites, style])

  if (!tip || !box || !place) return null

  return (
    <canvas
      ref={canvasRef}
      className="mc-tip-canvas"
      // @constraint 退距离必须用 measure 出来的 inset，不能写死 12：
      //      带阴影时 box 比原版大一圈，写死会让整块提示往右下偏。
      style={{ left: place.x - box.inset * GUI_SCALE, top: place.y - box.inset * GUI_SCALE }}
      role="tooltip"
      aria-label={lines.map((line) => line.text).join(' ')}
    />
  )
}
