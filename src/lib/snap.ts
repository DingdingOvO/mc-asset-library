/**
 * 拖拽时的对齐吸附。
 *
 * @why 画布是自由摆放的，但用途是视频制作：两个界面并排放歪 2 像素，导出后
 *      放大到 3 倍就是 6 像素的错位，一帧就能看出来。这里只吸「另一个容器的
 *      左/中/右、上/中/下」，不做整格吸附——整格会把用户有意留的 3 像素间距
 *      改回去，反而更难对齐。
 *
 * @constraint 容差是 GUI 像素，不是屏幕像素。调用方必须传未乘 scale 的坐标，
 *      否则 3 倍缩放下容差会缩成 1.3 像素，手感变成「吸不住」。
 */

export interface SnapRect {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapResult {
  x: number
  y: number
  /** 吸住时该画的竖线位置（GUI 像素），没吸住为 null */
  gx: number | null
  /** 同上，横线 */
  gy: number | null
}

const TOLERANCE = 4

const xEdges = (r: SnapRect) => [r.x, r.x + r.w / 2, r.x + r.w]
const yEdges = (r: SnapRect) => [r.y, r.y + r.h / 2, r.y + r.h]

export function snapMove(moving: SnapRect, others: SnapRect[], tolerance = TOLERANCE): SnapResult {
  let deltaX: { delta: number; line: number } | null = null
  let deltaY: { delta: number; line: number } | null = null
  const mineX = xEdges(moving)
  const mineY = yEdges(moving)

  for (const other of others) {
    for (const line of xEdges(other)) {
      for (const edge of mineX) {
        const delta = line - edge
        if (Math.abs(delta) > tolerance) continue
        if (deltaX === null || Math.abs(delta) < Math.abs(deltaX.delta)) deltaX = { delta, line }
      }
    }
    for (const line of yEdges(other)) {
      for (const edge of mineY) {
        const delta = line - edge
        if (Math.abs(delta) > tolerance) continue
        if (deltaY === null || Math.abs(delta) < Math.abs(deltaY.delta)) deltaY = { delta, line }
      }
    }
  }

  return {
    // @why 吸附后仍然取整：半像素的 left 在 2 倍缩放下会落到 1 个设备像素上，
    //      背景贴图和动态层的采样点就对不齐，边缘出现一条半透明的毛边。
    x: Math.round(moving.x + (deltaX?.delta ?? 0)),
    y: Math.round(moving.y + (deltaY?.delta ?? 0)),
    gx: deltaX === null ? null : Math.round(deltaX.line),
    gy: deltaY === null ? null : Math.round(deltaY.line),
  }
}
