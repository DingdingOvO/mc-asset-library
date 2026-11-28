/**
 * 二维形状 → 挤出的三角网格。
 *
 * @why 用 earcut 而不是自己写耳切：字形轮廓里有大量共线点和细长条（点阵字的
 *      横笔只有一格高），手写耳切在这种输入上极易切出退化三角形，表现为
 *      字面上随机缺一条。earcut 是 Cut 曲线的经典实现，对这些输入已经验证过。
 *
 * @constraint 顶点必须成三角形地写进 `VertexWriter`（`vertexCount` 是 3 的倍数），
 *      `paintVoxelsCpu` 按 `vertexCount / 3` 取三角形，多写或少写一个顶点都会让
 *      最后一个三角形读到别的批次的数据。
 */
import earcut from 'earcut'
import type { VertexWriter } from '@/render/core/buffer'
import type { Shape2D } from './outline'

/** 满亮光照坐标，与 `mesher` 里一致 */
const FULL_LIGHT: [number, number] = [15 * 16, 15 * 16]

export interface ExtrudeStyle {
  /** 背面 z（字贴在 0 上） */
  z0: number
  /** 正面 z */
  z1: number
  /** 正面亮度 0..1；背面与侧面按比例打折 */
  shade: number
  /** 贴图在正面的重复尺度（格）。字面按 x/uScale、y/vScale 取样 */
  uScale: number
  vScale: number
  /** y 翻转用的高度：屏幕坐标 y 向下，世界坐标 y 向上 */
  flipY: number
  /** 整体偏移，把字挪到原点附近 */
  offsetX: number
}

/**
 * 挤出：正面、背面各一层，侧面沿轮廓边长出四边形。
 *
 * @why 背面也要画。立体字允许转到 180°，只看正面的话转过去就是一整片空白，
 *      像模型破了。背面亮度压到 0.6，视觉上是同一个体的背面，不是另一块板。
 */
export function extrudeShape(writer: VertexWriter, shape: Shape2D, style: ExtrudeStyle): void {
  const { z0, z1, shade, flipY, offsetX } = style
  const flat: number[] = [...shape.outer]
  const holeIndices: number[] = []
  for (const hole of shape.holes) {
    holeIndices.push(flat.length / 2)
    for (const value of hole) flat.push(value)
  }

  const indices = earcut(flat, holeIndices.length > 0 ? holeIndices : null, 2)
  const wx = (i: number): number => flat[i * 2]! + offsetX
  const wy = (i: number): number => flipY - flat[i * 2 + 1]!
  const uu = (i: number): number => flat[i * 2]! / style.uScale
  const vv = (i: number): number => flat[i * 2 + 1]! / style.vScale

  const front = Math.round(255 * shade)
  const back = Math.round(255 * shade * 0.45)

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!
    const b = indices[t + 1]!
    const c = indices[t + 2]!
    // 正面
    writer.block(wx(a), wy(a), z1, front, front, front, 255, uu(a), vv(a), FULL_LIGHT[0], FULL_LIGHT[1])
    writer.block(wx(b), wy(b), z1, front, front, front, 255, uu(b), vv(b), FULL_LIGHT[0], FULL_LIGHT[1])
    writer.block(wx(c), wy(c), z1, front, front, front, 255, uu(c), vv(c), FULL_LIGHT[0], FULL_LIGHT[1])
    // 背面（同一个三角形，z 换成 z0）
    writer.block(wx(a), wy(a), z0, back, back, back, 255, uu(a), vv(a), FULL_LIGHT[0], FULL_LIGHT[1])
    writer.block(wx(c), wy(c), z0, back, back, back, 255, uu(c), vv(c), FULL_LIGHT[0], FULL_LIGHT[1])
    writer.block(wx(b), wy(b), z0, back, back, back, 255, uu(b), vv(b), FULL_LIGHT[0], FULL_LIGHT[1])
  }

  /**
   * 侧壁。
   * @constraint 外法线取 `(dy, -dx)`：环是沿"墨在右手边"走的，边向量顺时针转 90°
   *      才指向体外。取反会让光照上下颠倒——顶面比底面还暗，字看起来是凹的。
   * @constraint 侧面必须和正面**共用**同一个顶点位置，不能各自往里缩半格。
   *      缩了会在轮廓线上留一条缝（侧壁和盖子对不上），整圈描边变成虚线。
   */
  const walls = (ring: number[]): void => {
    const count = ring.length / 2
    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count
      const px = ring[i * 2]!
      const py = ring[i * 2 + 1]!
      const qx = ring[j * 2]!
      const qy = ring[j * 2 + 1]!
      const dx = qx - px
      const dy = qy - py
      const length = Math.hypot(dx, dy) || 1
      // 屏幕 y 向下、世界 y 向上，所以世界系法线的 y 要取反
      const ny = dx / length
      // 朝上的面（|ny| 大）给多一点光，和原版方块顶面更亮的观感一致
      const side = Math.round(255 * shade * (0.6 + 0.24 * Math.abs(ny)))
      const p0x = px + offsetX
      const p0y = flipY - py
      const q0x = qx + offsetX
      const q0y = flipY - qy
      const u0 = (i / count) * 4
      const u1 = ((i + 1) / count) * 4

      // p(z1) → q(z1) → q(z0) → p(z0)，两个三角形
      writer.block(p0x, p0y, z1, side, side, side, 255, u0, 0, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(q0x, q0y, z1, side, side, side, 255, u1, 0, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(q0x, q0y, z0, side, side, side, 255, u1, 1, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(p0x, p0y, z1, side, side, side, 255, u0, 0, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(q0x, q0y, z0, side, side, side, 255, u1, 1, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(p0x, p0y, z0, side, side, side, 255, u0, 1, FULL_LIGHT[0], FULL_LIGHT[1])
    }
  }

  walls(shape.outer)
  for (const hole of shape.holes) walls(hole)
}
