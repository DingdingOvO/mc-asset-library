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
 *
 * @constraint 颜色写进**顶点色**，不是另开一套材质。正面按世界 y 做竖向渐变、
 *      侧壁按朝向压暗、背面再暗一档——都在写顶点时算完。这样 CPU 预览、GPU
 *      导出、GLB 文件三条路径读到的是同一份颜色，不会出现"预览好看、导出发灰"。
 */
import earcut from 'earcut'
import type { VertexWriter } from '@/render/core/buffer'
import type { Shape2D } from './outline'
import { mixRgb, shadeRgb, type Rgb } from './material'

/** 满亮光照坐标，与 `mesher` 里一致 */
const FULL_LIGHT: [number, number] = [15 * 16, 15 * 16]

export interface ExtrudeStyle {
  /** 背面 z（字贴在 0 上） */
  z0: number
  /** 正面 z */
  z1: number
  /** 贴图在正面的重复尺度（格）。字面按 x/uScale、y/vScale 取样 */
  uScale: number
  vScale: number
  /** y 翻转用的高度：屏幕坐标 y 向下，世界坐标 y 向上 */
  flipY: number
  /** 整体偏移，把字挪到原点附近 */
  offsetX: number
  /** 正面主色（底部） */
  face: Rgb
  /** 正面顶部色，不给就是纯色 */
  top?: Rgb
  /** 侧壁颜色 */
  side: Rgb
  /** 背面颜色 */
  back: Rgb
  /** 竖向渐变的插值高度，通常等于字高 */
  gradient: number
}

/** 有向面积。只用来判断环的绕向，值本身没有意义 */
function signedArea(ring: number[]): number {
  let sum = 0
  const count = ring.length / 2
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count
    sum += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!
  }
  return sum / 2
}

/**
 * 挤出：正面、背面各一层，侧面沿轮廓边长出四边形。
 *
 * @why 背面也要画。立体字允许转到 180°，只看正面的话转过去就是一整片空白，
 *      像模型破了。
 */
export function extrudeShape(writer: VertexWriter, shape: Shape2D, style: ExtrudeStyle): void {
  const { z0, z1, flipY, offsetX, gradient } = style
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

  /** 正面某高度处的颜色：底部 face，顶部 top */
  const faceAt = (y: number): Rgb => {
    if (!style.top) return style.face
    const t = gradient > 0 ? Math.max(0, Math.min(1, y / gradient)) : 0
    return mixRgb(style.face, style.top, t)
  }

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]!
    const b = indices[t + 1]!
    const c = indices[t + 2]!
    // 正面：逐顶点取色，渐变就出来了
    for (const i of [a, b, c]) {
      const color = faceAt(wy(i))
      writer.block(wx(i), wy(i), z1, color[0], color[1], color[2], 255, uu(i), vv(i), FULL_LIGHT[0], FULL_LIGHT[1])
    }
    // 背面（同一个三角形，z 换成 z0，绕向反过来让法线朝外）
    for (const i of [a, c, b]) {
      writer.block(
        wx(i), wy(i), z0,
        style.back[0], style.back[1], style.back[2], 255,
        uu(i), vv(i), FULL_LIGHT[0], FULL_LIGHT[1],
      )
    }
  }

  /**
   * 侧壁。
   * @constraint 侧面必须和正面**共用**同一个顶点位置，不能各自往里缩半格。
   *      缩了会在轮廓线上留一条缝（侧壁和盖子对不上），整圈描边变成虚线。
   * @constraint 法线方向要按环的绕向归一化。轮廓来源有两套（点阵追踪 / 等值线），
   *      两套的绕向相反，直接拿 `dx/len` 当"朝上多少"会让其中一半的字光照
   *      上下颠倒——顶面比底面还暗，看着像凹进去的。
   */
  const walls = (ring: number[]): void => {
    const count = ring.length / 2
    const dir = signedArea(ring) > 0 ? -1 : 1
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
      const ny = (dx / length) * dir
      // 朝上的面接光、朝下的面背光，和原版方块"顶亮底暗"是同一套观感
      const lift = 0.74 + 0.18 * ny
      const sideRgb = shadeRgb(style.side, Math.max(0.52, lift))
      const p0x = px + offsetX
      const p0y = flipY - py
      const q0x = qx + offsetX
      const q0y = flipY - qy
      const u0 = (i / count) * 4
      const u1 = ((i + 1) / count) * 4

      // p(z1) → q(z1) → q(z0) → p(z0)，两个三角形
      writer.block(p0x, p0y, z1, sideRgb[0], sideRgb[1], sideRgb[2], 255, u0, 0, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(q0x, q0y, z1, sideRgb[0], sideRgb[1], sideRgb[2], 255, u1, 0, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(q0x, q0y, z0, sideRgb[0], sideRgb[1], sideRgb[2], 255, u1, 1, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(p0x, p0y, z1, sideRgb[0], sideRgb[1], sideRgb[2], 255, u0, 0, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(q0x, q0y, z0, sideRgb[0], sideRgb[1], sideRgb[2], 255, u1, 1, FULL_LIGHT[0], FULL_LIGHT[1])
      writer.block(p0x, p0y, z0, sideRgb[0], sideRgb[1], sideRgb[2], 255, u0, 1, FULL_LIGHT[0], FULL_LIGHT[1])
    }
  }

  walls(shape.outer)
  for (const hole of shape.holes) walls(hole)
}
