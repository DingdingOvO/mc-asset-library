/**
 * 模型网格化：把 `Face3D` 列表转成 GPU 顶点。
 *
 * @why 用 BLOCK 顶点格式而不是 ENTITY：方块和"烘焙型"实体（箱子、床、船）
 *      的亮度在游戏里是烘焙阶段算好的常量，走 terrain 着色器。
 *      真正需要逐顶点方向光的是骨骼实体，那条路在 `pass/entity.ts`。
 *
 * @constraint 必须按纹理分组。一个 draw call 只能绑一张纹理，
 *      几百个面混在一个缓冲里提交，只有最后一张贴图生效——
 *      表现是"整个模型糊成同一张图的碎片"。
 */
import { VertexWriter, BLOCK_LAYOUT } from '../core/buffer'
import { cardinalShade, CARDINAL_LIGHTING } from '../lighting/directions'
import type { Vec3 } from '../core/types'

/** 与 `src/lib/scene.ts` 的 Face3D 结构一致，但不直接依赖它 */
export interface ModelFace {
  /** 4 个顶点 xyz，共 12 个数，y 向上 */
  pts: number[]
  /** 4 个顶点 uv，共 8 个数，0..1 */
  uv: number[]
  /** 纹理路径（相对 textures/，不含 .png） */
  tex: string
  /** 群系/染料染色 */
  tint?: [number, number, number]
  /** 是否参与六面方向光照 */
  shade: boolean
  /** 叠加层深度偏置（格） */
  bias?: number
  /** 满亮（眼睛、发光层） */
  unlit?: boolean
  /** 半透明，需要排序并单独成批 */
  translucent?: boolean
}

export interface ModelBatch {
  texture: string
  data: Uint8Array
  vertexCount: number
  translucent: boolean
  /** 有叠加层偏置，需要 polygon offset */
  biased: boolean
  /** 满亮层。方块路径恒为 false，留字段是为了和实体批对齐 */
  emissive: boolean
  /** 贴图带透明像素，需要 cutout 程序（体素路径用） */
  cutout?: boolean
}

/** 光照坐标：展示场景恒为满亮（方块光 15、天空光 15） */
const FULL_LIGHT: [number, number] = [15 * 16, 15 * 16]

/**
 * 四边形 → 两个三角形的顶点顺序。
 *
 * @constraint 必须保持外法线朝向下的逆时针缠绕。写反的话会被背面剔除
 *      直接丢掉，模型看起来是"空心的"——从外面能看穿到内侧。
 *      原版的面顶点顺序是固定的（0,1,2,3 逆时针），这里照着拆。
 */
const QUAD_TRIANGLES = [0, 1, 2, 0, 2, 3] as const

/** 从四边形的三个角算外法线 */
export function faceNormal(pts: number[]): Vec3 {
  const ax = pts[3]! - pts[0]!
  const ay = pts[4]! - pts[1]!
  const az = pts[5]! - pts[2]!
  const bx = pts[6]! - pts[0]!
  const by = pts[7]! - pts[1]!
  const bz = pts[8]! - pts[2]!
  let nx = ay * bz - az * by
  let ny = az * bx - ax * bz
  let nz = ax * by - ay * bx
  const len = Math.hypot(nx, ny, nz)
  if (len < 1e-9) return [0, 1, 0]
  nx /= len
  ny /= len
  nz /= len
  return [nx, ny, nz]
}

/**
 * 把一批面按纹理分组并网格化。
 *
 * @constraint 顶点色必须用 `CardinalLighting.DEFAULT`（1.0 / 0.8 / 0.6 / 0.5）。
 *      这是原版 `CardinalLighting` 的权威值，用它才能让台阶、墙、地面的
 *      层次和游戏里一致。之前用的是"提亮过一档"的自造表，
 *      整体偏灰，建筑看起来像塑料模型。
 */
export function buildModelBatches(faces: ModelFace[], lightTable = CARDINAL_LIGHTING): ModelBatch[] {
  const groups = new Map<string, ModelFace[]>()
  for (const face of faces) {
    const key = `${face.tex}|${face.translucent ? 1 : 0}`
    const bucket = groups.get(key)
    if (bucket) bucket.push(face)
    else groups.set(key, [face])
  }

  const out: ModelBatch[] = []
  for (const [key, bucket] of groups) {
    const [texture = '', flag] = key.split('|')
    const writer = new VertexWriter(BLOCK_LAYOUT, bucket.length * 6)
    let biased = false

    for (const face of bucket) {
      const normal = faceNormal(face.pts)
      // 满亮层跳过方向光照；不参与光照的面（草、粒子）也不压暗
      const shadeValue = face.unlit ? 1 : face.shade ? cardinalShade(normal, lightTable) : 1
      const tint = face.tint
      const r = Math.min(255, Math.round(255 * shadeValue * (tint ? tint[0] : 1)))
      const g = Math.min(255, Math.round(255 * shadeValue * (tint ? tint[1] : 1)))
      const b = Math.min(255, Math.round(255 * shadeValue * (tint ? tint[2] : 1)))
      if (face.bias) biased = true

      for (const corner of QUAD_TRIANGLES) {
        writer.block(
          face.pts[corner * 3]!,
          face.pts[corner * 3 + 1]!,
          face.pts[corner * 3 + 2]!,
          r,
          g,
          b,
          255,
          face.uv[corner * 2]!,
          face.uv[corner * 2 + 1]!,
          FULL_LIGHT[0],
          FULL_LIGHT[1],
        )
      }
    }

    out.push({
      texture,
      data: writer.data(),
      vertexCount: writer.count,
      translucent: flag === '1',
      biased,
      emissive: false,
    })
  }

  return out
}
