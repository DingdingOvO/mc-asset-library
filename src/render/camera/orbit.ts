/**
 * 轨道相机。
 *
 * @why 不用 free camera + 四元数：这个站点的 3D 展示全是"绕一个东西转"，
 *      没有漫游需求。球坐标（yaw / pitch / distance）直接对应鼠标行为，
 *      姿态不会累积漂移，永远能一键回到默认视角。
 *
 * @constraint pitch 必须夹在 ±89.9°。到正 90° 时视线与 up 向量平行，
 *      `lookAt` 的叉积退化成零向量，视图矩阵变成全 0，画面直接黑屏。
 *      这类"拖到底就黑"的 bug 极难让人联想到相机奇异点。
 */
import { lookAt, multiply, ortho, perspective, type Mat4 } from '../core/matrix'
import type { Vec3 } from '../core/types'

export interface CameraPose {
  /** 注视点（世界坐标，单位格） */
  target: Vec3
  /** 相机到注视点的距离 */
  distance: number
  /** 水平角（度），0 时相机在 +Z 方向 */
  yaw: number
  /** 俯仰角（度），正值抬高相机 */
  pitch: number
}

export interface CameraProjection {
  kind: 'ortho' | 'perspective'
  /** 正交：视野高度（世界单位）；透视不用 */
  span: number
  /** 透视：垂直视角（度） */
  fov: number
  near: number
  far: number
}

export const DEFAULT_POSE: CameraPose = { target: [0, 0, 0], distance: 8, yaw: 45, pitch: 30 }
export const DEFAULT_ORTHO: CameraProjection = { kind: 'ortho', span: 2, fov: 70, near: -1000, far: 1000 }
export const DEFAULT_PERSPECTIVE: CameraProjection = { kind: 'perspective', span: 2, fov: 70, near: 0.05, far: 2000 }

const DEG = Math.PI / 180

/** 球坐标 → 相机位置 */
export function eyeOf(pose: CameraPose): Vec3 {
  const pitch = Math.max(-89.9, Math.min(89.9, pose.pitch)) * DEG
  const yaw = pose.yaw * DEG
  const cosPitch = Math.cos(pitch)
  return [
    pose.target[0] + pose.distance * cosPitch * Math.sin(yaw),
    pose.target[1] + pose.distance * Math.sin(pitch),
    pose.target[2] + pose.distance * cosPitch * Math.cos(yaw),
  ]
}

export function viewMatrix(pose: CameraPose): Mat4 {
  return lookAt(eyeOf(pose), pose.target, [0, 1, 0])
}

export function projectionMatrix(projection: CameraProjection, aspect: number): Mat4 {
  if (projection.kind === 'perspective') {
    return perspective(projection.fov * DEG, aspect, projection.near, projection.far)
  }
  // 正交用 span 定义的是"高度"，宽度按宽高比展开。
  // 这样竖屏下模型不会被横向裁掉，和原版 GUI 的自适应一致。
  const halfH = projection.span / 2
  const halfW = halfH * aspect
  return ortho(-halfW, halfW, -halfH, halfH, projection.near, projection.far)
}

/** 相机 + 投影的组合，缓存矩阵避免每帧重算 */
export class Camera {
  pose: CameraPose
  projection: CameraProjection
  private cachedView: Mat4 | null = null
  private cachedProj: Mat4 | null = null
  private cachedAspect = 0

  constructor(pose: CameraPose = DEFAULT_POSE, projection: CameraProjection = DEFAULT_ORTHO) {
    this.pose = { ...pose }
    this.projection = { ...projection }
  }

  setPose(pose: Partial<CameraPose>): void {
    Object.assign(this.pose, pose)
    this.cachedView = null
  }

  setProjection(projection: Partial<CameraProjection>): void {
    Object.assign(this.projection, projection)
    this.cachedProj = null
  }

  view(): Mat4 {
    if (!this.cachedView) this.cachedView = viewMatrix(this.pose)
    return this.cachedView
  }

  proj(aspect: number): Mat4 {
    if (!this.cachedProj || this.cachedAspect !== aspect) {
      this.cachedProj = projectionMatrix(this.projection, aspect)
      this.cachedAspect = aspect
    }
    return this.cachedProj
  }
}

/**
 * 把包围盒换算成相机参数，让物体正好铺满画面。
 *
 * @why 固定用 `span` 而不是距离：正交投影下模型大小只由 span 决定，
 *      距离再远也不会变小，所以"拉远"这个操作在正交下是无效的。
 *      之前把两者混在一起，缩放滑块在正交模式下拖了没反应。
 *
 * @constraint 要取宽高的较大者再留 12% 余量。严格按包围盒会贴边，
 *      旋转时模型的角会顶出画面。
 */
export function frameBox(min: Vec3, max: Vec3): { target: Vec3; span: number } {
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const width = max[0] - min[0]
  const height = max[1] - min[1]
  const depth = max[2] - min[2]
  // 斜着看时包围盒的投影宽度约是 sqrt(w²+d²)，按这个算才不会在转视角时被裁
  const projected = Math.hypot(width, depth)
  return { target, span: Math.max(projected, height, 0.001) * 1.12 }
}

/** 屏幕坐标 → 世界射线，用于拾取方块 */
export function screenRay(
  pose: CameraPose,
  projection: CameraProjection,
  aspect: number,
  ndcX: number,
  ndcY: number,
): { origin: Vec3; direction: Vec3 } {
  const eye = eyeOf(pose)
  const forward: Vec3 = [pose.target[0] - eye[0], pose.target[1] - eye[1], pose.target[2] - eye[2]]
  const fLen = Math.hypot(forward[0], forward[1], forward[2]) || 1
  const f: Vec3 = [forward[0] / fLen, forward[1] / fLen, forward[2] / fLen]

  const rightLen = Math.hypot(f[2], f[0]) || 1
  const right: Vec3 = [f[2] / rightLen, 0, -f[0] / rightLen]
  const up: Vec3 = [
    right[1] * f[2] - right[2] * f[1],
    right[2] * f[0] - right[0] * f[2],
    right[0] * f[1] - right[1] * f[0],
  ]

  const scale =
    projection.kind === 'ortho'
      ? projection.span / 2
      : Math.tan(projection.fov * DEG * 0.5) * pose.distance

  const ox = right[0]! * ndcX * scale * aspect + up[0]! * ndcY * scale
  const oy = right[1]! * ndcX * scale * aspect + up[1]! * ndcY * scale
  const oz = right[2]! * ndcX * scale * aspect + up[2]! * ndcY * scale

  return {
    origin: projection.kind === 'ortho' ? [eye[0] + ox, eye[1] + oy, eye[2] + oz] : eye,
    direction: f,
  }
}

export { multiply }
