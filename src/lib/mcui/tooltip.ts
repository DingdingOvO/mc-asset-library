import { drawText, textWidth, type GlyphFont } from '../font'
import type { TipBorder } from '../modern'
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

/**
 * 提示框的现代外观参数。
 *
 * @why 屏幕（`McTooltip`，DOM 里一块 canvas）和导出（`exportLayers`，分层
 *      canvas）是两条渲染路径，但必须共用同一份参数：用户在画布上调完圆角，
 *      导出来的图还是直角，那这个开关等于假的。
 * @constraint 全部以 **GUI 像素**为单位，与 MOUSE_OFFSET / PADDING / MARGIN
 *      同一坐标系。写成 CSS 像素的话，2 倍界面下圆角只有一半大。
 */
export interface TipStyle {
  radius: number
  shadowRadius: number
  shadowAlpha: number
  border: TipBorder
  titleRule: boolean
  centerTitle: boolean
  opacity: number
}

/** 原版长相：直角、无阴影、九宫格边框、全不透明 */
export const VANILLA_TIP: TipStyle = {
  radius: 0,
  shadowRadius: 0,
  shadowAlpha: 0,
  border: 'vanilla',
  titleRule: false,
  centerTitle: false,
  opacity: 1,
}

/**
 * 分隔线额外占的高度。
 * @why 不能只占原本的 LINE_GAP：那样线是「挤」在两行之间的，标题和正文
 *      看起来仍然是一坨。MUI 的 title separator 是给标题加下边距，
 *      这里给 4（1px 线 + 3px 呼吸），标题才真正独立出来。
 */
const RULE_EXTRA = 4

export interface TipSize {
  /** 文字区宽高 */
  width: number
  height: number
  /** 含 padding、margin 与阴影外扩的背景宽高 */
  boxWidth: number
  boxHeight: number
  /**
   * 内容左上角到 box 左上角的距离 = PADDING + MARGIN + 阴影外扩。
   * @why 阴影会溢出到框外，box 必须比原版大一圈才装得下；调用方定位
   *      画布时得往左上退这么多，写死 12 会让带阴影的框整体偏右下。
   */
  inset: number
}

export function measureTooltip(font: GlyphFont, lines: TipLine[], style: TipStyle = VANILLA_TIP): TipSize {
  let width = 0
  for (const line of lines) width = Math.max(width, textWidth(font, line.text))
  const count = Math.max(1, lines.length)
  const rule = style.titleRule && count > 1 ? RULE_EXTRA : 0
  const height = count * LINE_HEIGHT + (count - 1) * LINE_GAP + rule
  const pad = Math.max(0, style.shadowRadius)
  return {
    width,
    height,
    boxWidth: width + PADDING * 2 + MARGIN * 2 + pad * 2,
    boxHeight: height + PADDING * 2 + MARGIN * 2 + pad * 2,
    inset: PADDING + MARGIN + pad,
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
 *
 * @constraint 阴影、底板、边框、文字四层的顺序不能换：阴影必须在底板之下，
 *      边框必须在底板之上（底板的斜纹会盖掉内描边），文字必须在最后（否则
 *      边框压在字上）。原版只有底板 + 边框两层，加了圆角阴影之后层数变了。
 */
export function drawTooltip(
  ctx: CanvasRenderingContext2D,
  font: GlyphFont,
  lines: TipLine[],
  x: number,
  y: number,
  sprites: TipSprites,
  style: TipStyle = VANILLA_TIP,
): void {
  const size = measureTooltip(font, lines, style)
  const bx = x - size.inset
  const by = y - size.inset
  const pad = Math.max(0, style.shadowRadius)
  const coreW = size.boxWidth - pad * 2
  const coreH = size.boxHeight - pad * 2
  const radius = Math.min(style.radius, coreW / 2, coreH / 2)

  if (pad > 0) paintShadow(ctx, bx + pad, by + pad, coreW, coreH, radius, pad, style.shadowAlpha)

  ctx.save()
  ctx.globalAlpha = Math.min(1, Math.max(0, style.opacity))

  if (style.border === 'round') {
    /**
     * @constraint 圆角模式**不能**只靠 clip 裁九宫格。原版 `tooltip/background`
     *      这张图的四边各有 9px 透明内缩（边框由 `tooltip/frame` 单独提供），
     *      所以贴出来的底板本来就是一个比 box 小一圈的直角矩形。裁圆角只会
     *      裁到那块透明边，底板依旧方正——现象是「圆角参数、clip 路径、
     *      drawImage 坐标全对，画出来却是直角」。
     *      结论：圆角必须**自绘**一块圆角矩形填色，颜色从贴图采样，
     *      这样既拿到圆角形状，又不丢原版色调。
     */
    ctx.beginPath()
    ctx.roundRect(bx + pad, by + pad, coreW, coreH, radius)
    ctx.fillStyle = coreFillColor(sprites.background)
    ctx.fill()
    ctx.restore()

    // 边框单独一层，不参与 opacity：底板半透时边框应当仍然是实的，
    // 否则 70% 不透明度下边框淡到看不见，圆角就白做了。
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(bx + pad + 0.5, by + pad + 0.5, coreW - 1, coreH - 1, Math.max(0, radius - 0.5))
    ctx.strokeStyle = frameStrokeColor(sprites.frame)
    ctx.lineWidth = 1
    // @why 采样到的边框色本身只有三成不透明度（原版是 9px 宽的柔和边，
    //      靠宽度堆出存在感）。压成 1px 之后会淡到看不见，描两遍补回来。
    ctx.stroke()
    ctx.stroke()
    ctx.restore()
  } else {
    if (radius > 0) {
      // @why 原版边框 + 圆角是一个合法组合（MUI 的「普通边框带阴影」）。
      //      这里只裁底板，不裁边框，让直角边框露在圆角外面——这正是
      //      那个组合的样子，不需要额外画一圈。
      ctx.beginPath()
      ctx.roundRect(bx + pad, by + pad, coreW, coreH, radius)
      ctx.clip()
    }
    if (sprites.background) {
      drawNineSlice(ctx, sprites.background, bx + pad, by + pad, coreW, coreH, TOOLTIP_BACKGROUND)
    } else {
      // 兜底：贴图没到时先给一块实心底，总比文字浮在画面上强
      ctx.fillStyle = 'rgba(16, 0, 16, 0.94)'
      ctx.fillRect(bx + pad, by + pad, coreW, coreH)
    }
    ctx.restore()

    if (sprites.frame) drawNineSlice(ctx, sprites.frame, bx + pad, by + pad, coreW, coreH, TOOLTIP_FRAME)
  }

  let cursor = y
  lines.forEach((line, index) => {
    const dx = style.centerTitle && index === 0 ? x + Math.round((size.width - textWidth(font, line.text)) / 2) : x
    // @constraint 原版 tooltip 文字一律带投影（`text(..., -1, true)`），
    //      纯白字压在深紫底上会显得比游戏里细一圈。
    drawText(ctx, font, line.text, dx, cursor, line.color ?? '#ffffff', true)
    if (index === 0 && style.titleRule && lines.length > 1) {
      // 分隔线钉在字底下方 1px，第二行从「行高 + 行距 + 分隔线」之后开始，
      // 与 measureTooltip 里多加的 RULE_EXTRA 严格对上。
      ctx.fillStyle = 'rgba(255, 255, 255, 0.16)'
      ctx.fillRect(x, y + LINE_HEIGHT + 2, size.width, 1)
      cursor = y + LINE_HEIGHT + LINE_GAP + RULE_EXTRA
    } else {
      cursor += LINE_HEIGHT + LINE_GAP
    }
  })
}

/**
 * 从 `tooltip/background` 中心取底板色。
 *
 * @why 圆角模式要自绘底板，但颜色不能写死：原版这张图换过配色（1.20 与
 *      26.3 的底色不是一个值），写死的常量在换版本后就成了「自己发明的一种紫」。
 * @constraint 取正中一格：四边 9px 是透明内缩，取边上会拿到全透明。
 */
const fillCache = new WeakMap<HTMLImageElement, string>()

function coreFillColor(image: HTMLImageElement | null): string {
  if (!image || !image.naturalWidth) return 'rgba(16, 0, 16, 0.94)'
  const hit = fillCache.get(image)
  if (hit) return hit
  let color = 'rgba(16, 0, 16, 0.94)'
  try {
    const probe = document.createElement('canvas')
    probe.width = image.naturalWidth
    probe.height = image.naturalHeight
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.drawImage(image, 0, 0)
      const { data } = ctx.getImageData(probe.width >> 1, probe.height >> 1, 1, 1)
      const [r, g, b, a] = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0]
      if (a > 8) color = `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
    }
  } catch {
    // 跨域贴图会污染 canvas，读像素抛 SecurityError。退回原版兜底色
  }
  fillCache.set(image, color)
  return color
}

/**
 * 从 `tooltip/frame` 贴图上取边框颜色。
 *
 * @why 边框色不能写死。原版这张图随版本换过配色（1.20 与 26.3 的紫不是一个紫），
 *      写死的常量在换版本之后就成了「自己发明的一种紫」。
 * @constraint 结果按 image 缓存：每帧重建一块 canvas 取 1 个像素，
 *      十几个锁定提示同时画会把主线程拖住。
 */
const strokeCache = new WeakMap<HTMLImageElement, string>()

function frameStrokeColor(image: HTMLImageElement | null): string {
  if (!image || !image.naturalWidth) return 'rgba(255, 255, 255, 0.16)'
  const hit = strokeCache.get(image)
  if (hit) return hit
  let color = 'rgba(255, 255, 255, 0.16)'
  try {
    const probe = document.createElement('canvas')
    probe.width = image.naturalWidth
    probe.height = image.naturalHeight
    const ctx = probe.getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.drawImage(image, 0, 0)
      /**
       * @constraint 不能直接取 (w/2, 0)。原版 frame 的四周有 9px 透明内缩，
       *      第 0 行整行透明，取到的是 0 —— 边框就退化成灰白线。
       *      沿中轴那一列往下扫，取第一个真正有色的像素。
       */
      const col = ctx.getImageData(Math.floor(probe.width / 2), 0, 1, probe.height).data
      for (let i = 0; i < col.length; i += 4) {
        const a = col[i + 3] ?? 0
        if (a > 8) {
          color = `rgba(${col[i] ?? 0}, ${col[i + 1] ?? 0}, ${col[i + 2] ?? 0}, ${(a / 255).toFixed(3)})`
          break
        }
      }
    }
  } catch {
    // 跨域贴图会污染 canvas，读像素抛 SecurityError。退回中性描边
  }
  strokeCache.set(image, color)
  return color
}

/**
 * 多层同心矩形叠出的柔和阴影。
 *
 * @why 不能用 `ctx.shadowBlur`：它按**设备像素**算，而导出路径的 ctx 上已经
 *      挂了 `scale(4)`，同一份 shadowBlur 在 1× 和 4× 下会得到两种浓度；
 *      也不能用 `ctx.filter = blur()`，那需要额外的离屏层，`McTooltip` 的
 *      单 canvas 里加不了。同心层是纯几何，跟着变换矩阵一起缩放，两条路径
 *      拿到的阴影完全一致。
 */
function paintShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  spread: number,
  alpha: number,
): void {
  if (spread <= 0 || alpha <= 0) return
  const steps = 7
  ctx.save()
  for (let i = steps; i >= 1; i -= 1) {
    const t = i / steps
    const grow = spread * t
    ctx.beginPath()
    ctx.roundRect(x - grow, y - grow, w + grow * 2, h + grow * 2, radius + grow)
    /**
     * @constraint 挖洞必须用**直角**矩形，不能用带 radius 的。
     *      用圆角矩形挖的时候，底板四角的圆弧缺口正好落在「环」里，
     *      七层环叠出约 0.28 的黑色，把缺口糊成了深色实心角——
     *      表现就是「圆角明明设了、看起来却是直角」，而且 clip 参数、
     *      drawImage 坐标全对，查不出问题。直角挖洞让缺口彻底不被填充。
     */
    ctx.rect(x, y, w, h)
    ctx.fillStyle = `rgba(0, 0, 0, ${((alpha / steps) * (1 - 0.45 * t)).toFixed(4)})`
    ctx.fill('evenodd')
  }
  ctx.restore()
}
