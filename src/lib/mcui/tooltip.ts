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
 * 按原版规则算内容左上角，返回 **CSS 像素**坐标。
 *
 * @constraint 屏幕尺寸、鼠标位置是 CSS 像素，而 MOUSE_OFFSET / padding 都是
 *      GUI 像素——原版整个 `renderTooltipInternal` 跑在 GUI 坐标系里，屏幕尺寸
 *      是先除以 guiScale 的。两边直接加会在 2 倍界面下把判定阈值放大一倍：
 *      提示框已经压到窗口边缘了，`x + width > screenWidth` 还是 false，
 *      于是永远不翻转，右边最后二十来个像素被切掉。
 */
export function placeTooltip(
  pointerX: number,
  pointerY: number,
  size: TipSize,
  screenW: number,
  screenH: number,
  guiScale = 1,
): { x: number; y: number } {
  const scale = guiScale > 0 ? guiScale : 1
  const sw = screenW / scale
  const sh = screenH / scale
  let x = pointerX / scale + MOUSE_OFFSET
  let y = pointerY / scale - MOUSE_OFFSET
  if (x + size.boxWidth > sw) x = Math.max(x - 24 - size.boxWidth, 4)
  const paddedHeight = size.boxHeight + 3
  if (y + paddedHeight > sh) y = sh - paddedHeight
  return { x: Math.round(x * scale), y: Math.round(y * scale) }
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
