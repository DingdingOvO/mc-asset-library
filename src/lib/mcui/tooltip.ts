import { drawText, textWidth, type GlyphFont } from '../font'
import { drawNineSlice, TOOLTIP_BACKGROUND, TOOLTIP_FRAME } from './nineSlice'

/**
 * 原版悬停提示：几何、配色、行距全部照 `TooltipRenderUtil` 与
 * `DefaultTooltipPositioner` 抄，不自创。
 *
 * 反编译得到的常量（`client-26.3.jar`）：
 *   MOUSE_OFFSET = 12, PADDING = 3, MARGIN = 9
 *   x0 = x - 3 - 9, y0 = y - 3 - 9, paddedWidth = w + 3 + 3 + 18
 *   ClientTextTooltip.getHeight = 10
 *   位置 = (mouseX + 12, mouseY - 12)，右溢出 → max(x - 24 - width, 4)
 *   下溢出 → screenHeight - (height + 3)
 *
 * @constraint 背景与边框画在**同一个矩形**上（原版两个 blitSprite 参数一致），
 *      不是嵌套。写成「边框里再套一层底色」会让内圈多出一圈亮边。
 */

export const MOUSE_OFFSET = 12
const PADDING = 3
const MARGIN = 9
/** 单行高，来自 ClientTextTooltip.getHeight */
export const LINE_HEIGHT = 10
/** 行间额外间距，原版 renderTooltipInternal 的 `+ 2` */
const LINE_GAP = 2

export interface TipLine {
  text: string
  color?: string
}

export interface TipSize {
  /** 文字区宽高 */
  width: number
  height: number
  /** 含 padding 与 margin 的背景宽高 */
  boxWidth: number
  boxHeight: number
}

export function measureTooltip(font: GlyphFont, lines: TipLine[]): TipSize {
  let width = 0
  for (const line of lines) width = Math.max(width, textWidth(font, line.text))
  const count = Math.max(1, lines.length)
  const height = count * LINE_HEIGHT + (count - 1) * LINE_GAP
  return {
    width,
    height,
    boxWidth: width + PADDING * 2 + MARGIN * 2,
    boxHeight: height + PADDING * 2 + MARGIN * 2,
  }
}

/**
 * 按原版规则算内容左上角。
 *
 * @constraint 返回的是**内容**坐标（背景要再往外扩 12），不是背景坐标。
 *      混用会让提示框整体偏移一圈 padding，贴边时提前翻转。
 */
export function placeTooltip(
  pointerX: number,
  pointerY: number,
  size: TipSize,
  screenW: number,
  screenH: number,
): { x: number; y: number } {
  let x = pointerX + MOUSE_OFFSET
  let y = pointerY - MOUSE_OFFSET
  if (x + size.boxWidth > screenW) x = Math.max(x - 24 - size.boxWidth, 4)
  const paddedHeight = size.boxHeight + 3
  if (y + paddedHeight > screenH) y = screenH - paddedHeight
  return { x: Math.round(x), y: Math.round(y) }
}

export interface TipSprites {
  background: HTMLImageElement | null
  frame: HTMLImageElement | null
}

/**
 * 把提示画进 ctx。坐标（x, y）是内容左上角，与 placeTooltip 的返回值配套。
 */
export function drawTooltip(
  ctx: CanvasRenderingContext2D,
  font: GlyphFont,
  lines: TipLine[],
  x: number,
  y: number,
  sprites: TipSprites,
): void {
  const size = measureTooltip(font, lines)
  const bx = x - PADDING - MARGIN
  const by = y - PADDING - MARGIN

  if (sprites.background) {
    drawNineSlice(ctx, sprites.background, bx, by, size.boxWidth, size.boxHeight, TOOLTIP_BACKGROUND)
  } else {
    // 兜底：贴图没到时先给一块实心底，总比文字浮在画面上强
    ctx.fillStyle = 'rgba(16, 0, 16, 0.94)'
    ctx.fillRect(bx, by, size.boxWidth, size.boxHeight)
  }
  if (sprites.frame) {
    drawNineSlice(ctx, sprites.frame, bx, by, size.boxWidth, size.boxHeight, TOOLTIP_FRAME)
  }

  let cursor = y
  for (const line of lines) {
    // @constraint 原版 tooltip 文字一律带投影（`text(..., -1, true)`），
    //      纯白字压在深紫底上会显得比游戏里细一圈。
    drawText(ctx, font, line.text, x, cursor, line.color ?? '#ffffff', true)
    cursor += LINE_HEIGHT + LINE_GAP
  }
}
