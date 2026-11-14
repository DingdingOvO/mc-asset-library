/**
 * 方块几何索引：把方块 id 映射到烘焙好的面数据，并判定「是不是满块不透明」。
 *
 * @why 「满块不透明」这个判定是整个体素网格化的核心。相邻两个不透明方块之间
 *      的那一面玩家永远看不到，不剔除的话一栋 32×32×32 的房子会多出
 *      十几万个纯粹浪费的三角形——在手机上直接把帧率打到个位数。
 *
 * @constraint 判定必须同时满足「几何占满整格」和「贴图全不透明」。
 *      只看几何会把玻璃当成实心块（玻璃的模型也是一个满格立方体），
 *      于是紧贴玻璃的那面墙被剔除，透过玻璃能看到墙是空的。
 *      只看贴图则会把台阶当成满块，台阶旁边的地面被啃掉一块。
 *
 * @constraint 贴图还没下载完时一律判定为不透明。反过来（判定为透明）会让
 *      所有面都生成，网格体积翻三倍，首屏卡顿；而判定为不透明时最坏情况是
 *      少画几个看不见的面，用户完全察觉不到。
 */
import type { BakedFace } from './blockmodels'
import type { BlockModelFile } from './blockmodels'
import { textureSrc } from './mc'
import { peekTexel } from './texel'

/** 六个方向，与面数据的顶点顺序无关，只用来做邻接剔除 */
export type FaceDir = 'negX' | 'posX' | 'negY' | 'posY' | 'negZ' | 'posZ'

export const DIR_NORMAL: Record<FaceDir, [number, number, number]> = {
  negX: [-1, 0, 0],
  posX: [1, 0, 0],
  negY: [0, -1, 0],
  posY: [0, 1, 0],
  negZ: [0, 0, -1],
  posZ: [0, 0, 1],
}

/** 邻接偏移，与 DIR_NORMAL 一一对应 */
export const DIR_OFFSET: Record<FaceDir, [number, number, number]> = {
  negX: [-1, 0, 0],
  posX: [1, 0, 0],
  negY: [0, -1, 0],
  posY: [0, 1, 0],
  negZ: [0, 0, -1],
  posZ: [0, 0, 1],
}

export interface BlockFaceRef {
  face: BakedFace
  /** 若是贴合格边界的面，给出朝向；台阶侧面、栅栏横杆这类内部面为 null */
  dir: FaceDir | null
}

/**
 * 判断一个面是否完全贴在某个格边界上。
 *
 * @constraint 只看「4 个顶点在某一轴上取值全相同且等于 0 或 16」，
 *      不看顶点顺序算出来的法线。烘焙数据的顶点绕序不统一，
 *      靠叉积算法线会把一部分面的朝向判反，结果是本该剔除的面留下来、
 *      该留的被剔除，建筑内部露出黑洞。
 */
function boundaryDir(face: BakedFace): FaceDir | null {
  for (let axis = 0; axis < 3; axis += 1) {
    let allZero = true
    let allMax = true
    for (let i = 0; i < 4; i += 1) {
      const value = face[i * 3 + axis] ?? 0
      if (value !== 0) allZero = false
      if (value !== 16) allMax = false
    }
    if (allZero || allMax) {
      const positive = allMax
      if (axis === 0) return positive ? 'posX' : 'negX'
      if (axis === 1) return positive ? 'posY' : 'negY'
      return positive ? 'posZ' : 'negZ'
    }
  }
  return null
}

export class BlockGeometry {
  private readonly opaqueCache = new Map<string, boolean>()
  private readonly facesCache = new Map<string, BlockFaceRef[]>()

  constructor(
    private readonly models: BlockModelFile,
    private readonly version: string,
  ) {}

  /** 取方块的面，附带每面是否贴边界 */
  facesOf(id: string): BlockFaceRef[] {
    const hit = this.facesCache.get(id)
    if (hit) return hit
    const raw = this.models.blocks[id] ?? this.models.blocks[stripNamespace(id)]
    if (!raw) {
      this.facesCache.set(id, [])
      return []
    }
    const refs = raw.map((face) => ({ face, dir: boundaryDir(face) }))
    this.facesCache.set(id, refs)
    return refs
  }

  /**
   * 是不是「满格 + 全不透明」。
   *
   * @constraint 结果必须缓存。一个 32³ 的建筑有 3 万格，每格要问 6 次邻居，
   *      不缓存就是 20 万次贴图扫描，每次都要遍历上千个像素。
   */
  isOpaque(id: string): boolean {
    const hit = this.opaqueCache.get(id)
    if (hit !== undefined) return hit
    const value = this.computeOpaque(id)
    this.opaqueCache.set(id, value)
    return value
  }

  private computeOpaque(id: string): boolean {
    if (id.endsWith(':air') || id === 'air') return false
    const refs = this.facesOf(id)
    if (refs.length !== 6) return false

    const seen = new Set<FaceDir>()
    for (const ref of refs) {
      if (!ref.dir || seen.has(ref.dir)) return false
      seen.add(ref.dir)
    }
    if (seen.size !== 6) return false

    for (const ref of refs) {
      const texIndex = ref.face[20] ?? -1
      const texture = this.models.textures[texIndex]
      if (!texture) return false
      if (!this.textureIsOpaque(texture)) return false
    }
    return true
  }

  private readonly textureOpaque = new Map<string, boolean>()

  private textureIsOpaque(texture: string): boolean {
    const hit = this.textureOpaque.get(texture)
    if (hit !== undefined) return hit
    const source = peekTexel(textureSrc(this.version, texture))
    // 没加载完时按不透明处理，理由见类注释
    if (!source) {
      this.textureOpaque.set(texture, true)
      return true
    }
    const { data } = source
    let opaque = true
    for (let i = 3; i < data.length; i += 4) {
      if (data[i]! < 250) {
        opaque = false
        break
      }
    }
    this.textureOpaque.set(texture, opaque)
    return opaque
  }

  /** 贴图池索引 → 纹理 id */
  textureOf(index: number): string | null {
    return this.models.textures[index] ?? null
  }

  /** 某张贴图是否带透明度，决定要不要进 cutout 批 */
  isCutout(texture: string): boolean {
    return !this.textureIsOpaque(texture)
  }
}

/** 数据里的方块 id 有的带命名空间有的不带，两种都试 */
function stripNamespace(id: string): string {
  const index = id.indexOf(':')
  return index >= 0 ? id.slice(index + 1) : id
}
