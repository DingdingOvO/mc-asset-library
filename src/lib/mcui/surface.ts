/**
 * 像素完美的绘制表面。
 *
 * @why 站里所有"原版界面"都是位图放大，最怕两件事：非整数倍缩放（浏览器
 *      用双线性插值补出来的那半像素把 1px 边框糊成 2px 灰线）、以及把
 *      canvas 的逻辑尺寸当成 CSS 尺寸（`width=176` 的 canvas 放到 3 倍容器里，
 *      实际只有 176 个设备像素可用，字形先被拉宽三倍再被压回去）。
 *      这里把"多少设备像素画一个 GUI 像素"一次算清，之后所有绘制指令都用
 *      GUI 坐标，缩放由 ctx 的变换矩阵统一承担。
 *
 * @constraint ratio 必须取整。GUI 1 像素落到 4.5 个设备像素时，相邻两个
 *      像素会各分到 4 和 5 个，格线粗细不匀——正是 Sodium 那类渲染层
 *      最先解决的问题（缩放只允许整数倍）。
 */

export interface Surface {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  /** 一个 GUI 像素占多少设备像素 */
  ratio: number
  /** GUI 像素尺寸 */
  width: number
  height: number
}

/** 设备像素比上限。3 倍以上只会在 4K 屏上白烧内存，视觉无差别 */
export const MAX_DPR = 3

export function deviceRatio(guiScale = 2): number {
  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, MAX_DPR)
  return Math.max(1, Math.round(guiScale * dpr))
}

/**
 * 按 GUI 尺寸准备一块画布。
 *
 * @param guiScale 每个 GUI 像素占多少 CSS 像素。原版界面是 1，这里传 2 是因为
 *        站点的界面密度按 2 倍设计（文字更清楚），传 1 会让 tooltip 只有 8px 高。
 * @constraint 返回前必须重置变换并关掉平滑：setTransform 是累积的，
 *        同一块 canvas 复用时会叠加上一次的矩阵。
 */
export function prepare(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  guiScale = 2,
): Surface | null {
  const ratio = deviceRatio(guiScale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const deviceW = Math.max(1, Math.round(width * ratio))
  const deviceH = Math.max(1, Math.round(height * ratio))
  if (canvas.width !== deviceW) canvas.width = deviceW
  if (canvas.height !== deviceH) canvas.height = deviceH

  const dpr = typeof window === 'undefined' ? 1 : Math.min(window.devicePixelRatio || 1, MAX_DPR)
  canvas.style.width = `${deviceW / dpr}px`
  canvas.style.height = `${deviceH / dpr}px`

  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, width, height)
  return { canvas, ctx, ratio, width, height }
}

/** 把已有 surface 清回透明，保持变换不变 */
export function clear(surface: Surface): void {
  const { ctx, width, height, ratio } = surface
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width * ratio, height * ratio)
  ctx.restore()
}
