/**
 * 光照方向常量（等价 `com.mojang.blaze3d.platform.Lighting`）。
 *
 * @why 这四组方向不是随便定的，它们决定了模型每个面的明暗比例。
 *      之前的实现只有一组硬写的世界光方向，物品栏里的实体也吃同一套，
 *      于是"放在容器里的生物"和"世界里站着的生物"明暗完全不同——
 *      原版专门为 UI 内实体准备了 `INVENTORY` 一组，Z 分量朝 +1，
 *      相当于从观察者背后打光，看起来是正面受光。
 *
 * @constraint 归一化必须在导入时做一次，不能每个 draw call 都算。
 *      这几组方向被用来算逐顶点光照，每帧几十万次点积，
 *      多一次 sqrt 就多几毫秒。
 */
import { multiply, rotateX, rotateY, identity, fromScale } from '../core/matrix'
import type { Vec3 } from '../core/types'

type Mat4 = Float32Array

/** 与 JOML `Vector3f.normalize()` 一致 */
function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2])
  return len === 0 ? [0, 0, 0] : [v[0] / len, v[1] / len, v[2] / len]
}

/** JOML `Matrix4f.rotateZ` */
function rotateZ(radians: number): Mat4 {
  const m = identity()
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  m[0] = c
  m[1] = s
  m[4] = -s
  m[5] = c
  return m
}

/** JOML `Matrix4f.rotateYXZ(y, x, z)` = rotateY(y) × rotateX(x) × rotateZ(z) */
function rotateYXZ(y: number, x: number, z: number): Mat4 {
  return multiply(rotateY(y), multiply(rotateX(x), rotateZ(z)))
}

/**
 * JOML `Matrix4f.transformDirection(v)`。
 *
 * @constraint 是 `Mᵀ·v` 而不是 `M·v`。JOML 的 m00/m10/m20 分别取
 *      `m[0]/m[4]/m[8]`（列主序的同一行），展开后正好等价于转置相乘。
 *      写成 `M·v` 会让物品栏里的模型光从右下来，和原版镜像相反。
 */
function transformDirection(m: Mat4, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[4]! * v[1] + m[8]! * v[2],
    m[1]! * v[0] + m[5]! * v[1] + m[9]! * v[2],
    m[2]! * v[0] + m[6]! * v[1] + m[10]! * v[2],
  ]
}

/** 世界（主世界）光照方向 */
const DIFFUSE_LIGHT_0 = normalize([0.2, 1.0, -0.7])
const DIFFUSE_LIGHT_1 = normalize([-0.2, 1.0, 0.7])

/** 下界：第二束光从下方来，避免地狱里的实体全黑 */
const NETHER_DIFFUSE_LIGHT_0 = normalize([0.2, 1.0, -0.7])
const NETHER_DIFFUSE_LIGHT_1 = normalize([-0.2, -1.0, 0.7])

/** UI 内实体：从观察者方向打光 */
const INVENTORY_DIFFUSE_LIGHT_0 = normalize([0.2, -1.0, 1.0])
const INVENTORY_DIFFUSE_LIGHT_1 = normalize([-0.2, -1.0, 0.0])

/** 平面物品（物品栏里的图标） */
const ITEMS_FLAT_LIGHTS = (() => {
  const pose = multiply(rotateY(-Math.PI / 8), rotateX((Math.PI * 3) / 4))
  return {
    light0: transformDirection(pose, DIFFUSE_LIGHT_0),
    light1: transformDirection(pose, DIFFUSE_LIGHT_1),
  }
})()

/** 立体物品（手持、掉落物） */
const ITEMS_3D_LIGHTS = (() => {
  const pose = multiply(
    fromScale(1, -1, 1),
    multiply(rotateYXZ(1.0821041, 3.2375858, 0), rotateYXZ(-Math.PI / 8, (Math.PI * 3) / 4, 0)),
  )
  return {
    light0: transformDirection(pose, DIFFUSE_LIGHT_0),
    light1: transformDirection(pose, DIFFUSE_LIGHT_1),
  }
})()

/** 光照方案，与 `Lighting.Entry` 一一对应 */
export interface LightPair {
  light0: Vec3
  light1: Vec3
}

export const LIGHTING: Record<'level' | 'nether' | 'inventory' | 'items_flat' | 'items_3d', LightPair> = {
  level: { light0: DIFFUSE_LIGHT_0, light1: DIFFUSE_LIGHT_1 },
  nether: { light0: NETHER_DIFFUSE_LIGHT_0, light1: NETHER_DIFFUSE_LIGHT_1 },
  inventory: { light0: INVENTORY_DIFFUSE_LIGHT_0, light1: INVENTORY_DIFFUSE_LIGHT_1 },
  items_flat: ITEMS_FLAT_LIGHTS,
  items_3d: ITEMS_3D_LIGHTS,
}

/**
 * 六面亮度表（等价 `CardinalLighting.DEFAULT`）。
 *
 * @constraint 数值是 1.0 / 0.8 / 0.6 / **0.5**，不是我之前那套
 *      1 / 0.88 / 0.76 / 0.66。后者是"整体提亮过一档"的产物，
 *      看起来更亮但对比度被抹平了，石砖台阶和地面的层次消失，
 *      整块建筑像一块灰色的塑料。这是"颜色对不上"最直接的来源。
 */
export const CARDINAL_LIGHTING = {
  down: 0.5,
  up: 1.0,
  north: 0.8,
  south: 0.8,
  west: 0.6,
  east: 0.6,
} as const

/** 下界：底面抬到 0.9，因为地狱没有天空光，底面按 0.5 会是一团黑 */
export const CARDINAL_LIGHTING_NETHER = {
  down: 0.9,
  up: 0.9,
  north: 0.8,
  south: 0.8,
  west: 0.6,
  east: 0.6,
} as const

/**
 * 按法线取六面亮度。
 *
 * @constraint 用主分量判定而不是点积。点积让斜面亮度连续渐变，
 *      整块建筑发灰发"软"；原版每个朝向是固定档位，转 45° 会跳变，
 *      那种硬朗的层次才是方块的观感。
 */
export function cardinalShade(n: Vec3, table = CARDINAL_LIGHTING): number {
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  if (ay >= ax && ay >= az) return n[1] > 0 ? table.up : table.down
  if (ax >= az) return n[0] > 0 ? table.east : table.west
  return n[2] > 0 ? table.south : table.north
}

export type LightingKey = keyof typeof LIGHTING
