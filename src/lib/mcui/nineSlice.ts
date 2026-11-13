/**
 * 九宫格贴图绘制，对应原版的 `nine_slice` sprite 缩放。
 *
 * @why 原版 26.3 的界面框不再有专用的「四角 + 四边」拼接代码：`gui.json` 与
 *      每张图的 `.mcmeta` 声明 `{"type":"nine_slice","border":N}`，`blitSprite`
 *      按声明自己拼。所以这里也读同一套参数，参数从 `.mcmeta` 抄过来写死：
 *      tooltip/background 是 border 9（中心平铺），tooltip/frame 是 border 10
 *      且 `stretch_inner: true`（中心拉伸）。
 *
 * @constraint 平铺（tile）与拉伸（stretch）不能混用。原版 `NineSlice`
 *      在没有 stretch_inner 时用 REPEAT 采样，边缘那块按余数裁；改成 stretch
 *      会让斜纹背景在宽框上被拉成横条，一眼看出不是游戏里的样子。
 */

export interface NineSliceSpec {
  /** 源图四周不参与缩放的宽度（像素） */
  border: number
  /** 中心是拉伸还是平铺。原版只有 frame 开了 stretch */
  stretchInner?: boolean
}

export const TOOLTIP_BACKGROUND: NineSliceSpec = { border: 9 }
export const TOOLTIP_FRAME: NineSliceSpec = { border: 10, stretchInner: true }

/**
 * 把 image 按九宫格画进 (x, y, w, h)，坐标为 GUI 像素。
 *
 * @constraint 目标小于两倍 border 时必须先缩 border，否则左右两边会反向重叠，
 *        边框出现一条贯穿的裂缝。原版 `NineSlice` 也是这么钳的。
 */
export function drawNineSlice(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  spec: NineSliceSpec,
): void {
  const sw = image.naturalWidth
  const sh = image.naturalHeight
  const b = Math.max(0, Math.min(spec.border, Math.floor(w / 2), Math.floor(h / 2), Math.floor(sw / 2), Math.floor(sh / 2)))
  if (b <= 0) {
    ctx.drawImage(image, 0, 0, sw, sh, x, y, w, h)
    return
  }

  const dx = Math.round(x)
  const dy = Math.round(y)
  const dw = Math.round(w)
  const dh = Math.round(h)
  const innerW = dw - b * 2
  const innerH = dh - b * 2

  // 四角：1:1，绝不缩放
  ctx.drawImage(image, 0, 0, b, b, dx, dy, b, b)
  ctx.drawImage(image, sw - b, 0, b, b, dx + dw - b, dy, b, b)
  ctx.drawImage(image, 0, sh - b, b, b, dx, dy + dh - b, b, b)
  ctx.drawImage(image, sw - b, sh - b, b, b, dx + dw - b, dy + dh - b, b, b)

  // 上下边：横向按 border 宽平铺
  tileStrip(ctx, image, b, 0, sw - b * 2, b, dx + b, dy, innerW, b, true)
  tileStrip(ctx, image, b, sh - b, sw - b * 2, b, dx + b, dy + dh - b, innerW, b, true)
  // 左右边：纵向平铺
  tileStrip(ctx, image, 0, b, b, sh - b * 2, dx, dy + b, b, innerH, false)
  tileStrip(ctx, image, sw - b, b, b, sh - b * 2, dx + dw - b, dy + b, b, innerH, false)

  // 中心
  if (innerW > 0 && innerH > 0) {
    if (spec.stretchInner) {
      ctx.drawImage(image, b, b, sw - b * 2, sh - b * 2, dx + b, dy + b, innerW, innerH)
    } else {
      tileRect(ctx, image, b, b, sw - b * 2, sh - b * 2, dx + b, dy + b, innerW, innerH)
    }
  }
}

/** 平铺一条边：沿一个方向重复一段源图，末块按余数裁剪 */
function tileStrip(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
  horizontal: boolean,
): void {
  const step = horizontal ? sw : sh
  const span = horizontal ? dw : dh
  if (step <= 0 || span <= 0) return
  let done = 0
  while (done < span) {
    const piece = Math.min(step, span - done)
    // @constraint 末块要从源图对应位置截，不能把整块压扁：压扁之后那道
    //      接缝在浅色底上会显示成一块深色竖条。
    if (horizontal) {
      ctx.drawImage(image, sx, sy, piece, sh, dx + done, dy, piece, dh)
    } else {
      ctx.drawImage(image, sx, sy, sw, piece, dx, dy + done, dw, piece)
    }
    done += piece
  }
}

/** 中心区域两个方向都平铺 */
function tileRect(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number,
): void {
  let oy = 0
  while (oy < dh) {
    const ph = Math.min(sh, dh - oy)
    let ox = 0
    while (ox < dw) {
      const pw = Math.min(sw, dw - ox)
      ctx.drawImage(image, sx, sy, pw, ph, dx + ox, dy + oy, pw, ph)
      ox += pw
    }
    oy += ph
  }
}
