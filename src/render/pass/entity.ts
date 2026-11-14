/**
 * 实体网格化：把骨骼算出来的面转成 ENTITY 顶点。
 *
 * @why 实体的光照和方块完全不同，不能共用一条路：
 *      方块的方向亮度是六个固定档位（1.0 / 0.8 / 0.6 / 0.5），在烘焙阶段
 *      就乘进顶点色；实体则是两束方向光按面法线做点积（`minecraft_mix_light`），
 *      在顶点着色器里算。把两者混在一起，要么方块失去硬朗的层次，
 *      要么实体变成一块块平面色。
 *
 * @constraint 顶点色必须是白色（除染色外）。实体的颜色来自贴图，
 *      `Color` 承载的是「染料染色」「受伤闪红」这类调制；
 *      如果把亮度也乘进顶点色，着色器里再乘一次方向光就等于平方，模型会发黑。
 */
import { VertexWriter, ENTITY_LAYOUT } from '../core/buffer'
import type { Vec3 } from '../core/types'
import { faceNormal, type ModelFace } from './model'

export interface EntityBatch {
  texture: string
  data: Uint8Array
  vertexCount: number
  translucent: boolean
  /** 满亮层（眼睛、发光贴图），不吃光照图 */
  emissive: boolean
}

const QUAD_TRIANGLES = [0, 1, 2, 0, 2, 3] as const
/** 满亮光照坐标：方块光 15、天空光 15 */
const FULL_LIGHT: [number, number] = [15 * 16, 15 * 16]
/** 没有 overlay 时用 (0,0)，原版也是这个约定 */
const NO_OVERLAY: [number, number] = [0, 0]

/**
 * 按「纹理 + 半透明 + 满亮」三要素分组。
 *
 * @constraint 满亮必须单独成批。实体着色器的 EMISSIVE 是编译期变体，
 *      同一个程序里没法对部分像素关掉光照图乘法；混在一起要么眼睛发暗，
 *      要么整个身体过曝。
 */
export function buildEntityBatches(faces: ModelFace[]): EntityBatch[] {
  const groups = new Map<string, ModelFace[]>()
  for (const face of faces) {
    const key = `${face.tex}|${face.translucent ? 1 : 0}|${face.unlit ? 1 : 0}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(face)
    else groups.set(key, [face])
  }

  const out: EntityBatch[] = []
  for (const [key, bucket] of groups) {
    const [texture = '', translucentFlag = '0', emissiveFlag = '0'] = key.split('|')
    const writer = new VertexWriter(ENTITY_LAYOUT, bucket.length * 6)

    for (const face of bucket) {
      const normal = faceNormal(face.pts)
      const tint = face.tint
      const r = Math.min(255, Math.round(255 * (tint ? tint[0] : 1)))
      const g = Math.min(255, Math.round(255 * (tint ? tint[1] : 1)))
      const b = Math.min(255, Math.round(255 * (tint ? tint[2] : 1)))

      for (const corner of QUAD_TRIANGLES) {
        writer.entity(
          face.pts[corner * 3]!,
          face.pts[corner * 3 + 1]!,
          face.pts[corner * 3 + 2]!,
          r,
          g,
          b,
          255,
          face.uv[corner * 2]!,
          face.uv[corner * 2 + 1]!,
          NO_OVERLAY[0],
          NO_OVERLAY[1],
          FULL_LIGHT[0],
          FULL_LIGHT[1],
          normal[0],
          normal[1],
          normal[2],
        )
      }
    }

    out.push({
      texture,
      data: writer.data(),
      vertexCount: writer.count,
      translucent: translucentFlag === '1',
      emissive: emissiveFlag === '1',
    })
  }

  return out
}

/** 实体面算包围盒，用于取景 */
export function entityBounds(faces: ModelFace[]): { min: Vec3; max: Vec3 } | null {
  if (faces.length === 0) return null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const face of faces) {
    for (let i = 0; i < 4; i += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = face.pts[i * 3 + axis] ?? 0
        if (value < min[axis]!) min[axis] = value
        if (value > max[axis]!) max[axis] = value
      }
    }
  }
  return { min, max }
}
