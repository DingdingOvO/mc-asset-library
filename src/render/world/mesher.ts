/**
 * 体素网格化：`BlockVolume` → GPU 顶点。
 *
 * @why 和 `pass/model.ts` 分开，因为输入根本不同：那边是一组已经摆好的面，
 *      这边是「几万格方块 + 邻接关系」。混在一起就得在同一个函数里
 *      既处理模型面又处理体素剔除，两边都写不干净。
 *
 * @constraint 剔除只在「邻居是满格不透明方块」时发生。相邻两个玻璃、
 *      两片树叶之间的面必须保留——玩家透过它们能看见对方。
 */
import { VertexWriter, BLOCK_LAYOUT } from '../core/buffer'
import { cardinalShade, CARDINAL_LIGHTING } from '../lighting/directions'
import type { BlockVolume } from '@/lib/world/terrain'
import { DIR_NORMAL, type BlockGeometry, type FaceDir } from '@/lib/blockGeometry'

export interface VoxelBatch {
  texture: string
  data: Uint8Array
  vertexCount: number
  /** 贴图带透明像素，需要 cutout 程序 */
  cutout: boolean
}

/** 满亮光照坐标：方块光 15、天空光 15 */
const FULL_LIGHT: [number, number] = [15 * 16, 15 * 16]

/**
 * 植物染色（草地、树叶、藤蔓）。
 *
 * @why 原版按群系取色，一个存档里有十几种绿。这个站点没有群系概念，
 *      取平原的默认值即可——它和游戏里出生点最常见的那种绿是同一个。
 */
const FOLIAGE_TINT: [number, number, number] = [0.549, 0.749, 0.353]

export interface VoxelOptions {
  /** 遍历范围，默认整块体积。调小可以在拖动时只重建脏区域 */
  min?: [number, number, number]
  max?: [number, number, number]
  /** 额外的整体染色，用于区分不同地形层 */
  tint?: [number, number, number]
}

/** 顶点顺序：四边形拆两个三角形，与模型路径保持一致 */
const QUAD_TRIANGLES = [0, 1, 2, 0, 2, 3] as const

/**
 * 把整块体素变成按纹理分组的三角形批。
 *
 * @constraint 顶点坐标单位是「格」。世界的尺度直接用格，不像模型那样按
 *      16 单位一格归一化——建筑动辄 100 格宽，除以 16 之后相机参数
 *      要跟着换算，多一层换算就多一处能写错的地方。
 */
export function buildVoxelBatches(volume: BlockVolume, geometry: BlockGeometry, options: VoxelOptions = {}): VoxelBatch[] {
  const [sx, sy, sz] = volume.size
  const min = options.min ?? [0, 0, 0]
  const max = options.max ?? [sx, sy, sz]
  const groups = new Map<string, VertexWriter>()

  const at = (x: number, y: number, z: number): string | null => {
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return null
    const index = (y * sz + z) * sx + x
    const paletteIndex = volume.data[index] ?? 0
    if (paletteIndex === 0) return null
    return volume.palette[paletteIndex]?.name ?? null
  }

  for (let y = min[1]; y < Math.min(max[1], sy); y += 1) {
    for (let z = min[2]; z < Math.min(max[2], sz); z += 1) {
      for (let x = min[0]; x < Math.min(max[0], sx); x += 1) {
        const id = at(x, y, z)
        if (!id) continue
        const refs = geometry.facesOf(id)
        if (refs.length === 0) continue

        for (const ref of refs) {
          // 贴边界的面才做邻接剔除；台阶侧面、栅栏横杆这类内部面一律保留
          if (ref.dir) {
            const [dx, dy, dz] = DIR_NORMAL[ref.dir]
            const neighbor = at(x + dx, y + dy, z + dz)
            if (neighbor && geometry.isOpaque(neighbor)) continue
          }

          const texture = geometry.textureOf(ref.face[20] ?? -1)
          if (!texture) continue

          let writer = groups.get(texture)
          if (!writer) {
            writer = new VertexWriter(BLOCK_LAYOUT, 4096)
            groups.set(texture, writer)
          }

          const shaded = ref.face[22] !== 0
          const shade = shaded ? cardinalShade(ref.dir ? DIR_NORMAL[ref.dir] : [0, 1, 0], CARDINAL_LIGHTING) : 1
          const tinted = (ref.face[21] ?? -1) >= 0
          const tint = options.tint ?? (tinted ? FOLIAGE_TINT : null)
          const r = Math.min(255, Math.round(255 * shade * (tint ? tint[0] : 1)))
          const g = Math.min(255, Math.round(255 * shade * (tint ? tint[1] : 1)))
          const b = Math.min(255, Math.round(255 * shade * (tint ? tint[2] : 1)))

          for (const corner of QUAD_TRIANGLES) {
            writer.block(
              x + (ref.face[corner * 3] ?? 0) / 16,
              y + (ref.face[corner * 3 + 1] ?? 0) / 16,
              z + (ref.face[corner * 3 + 2] ?? 0) / 16,
              r,
              g,
              b,
              255,
              ref.face[12 + corner * 2] ?? 0,
              ref.face[13 + corner * 2] ?? 0,
              FULL_LIGHT[0],
              FULL_LIGHT[1],
            )
          }
        }
      }
    }
  }

  const out: VoxelBatch[] = []
  for (const [texture, writer] of groups) {
    out.push({
      texture,
      data: writer.data(),
      vertexCount: writer.count,
      cutout: geometry.isCutout(texture),
    })
  }
  return out
}

/** 体积里非空气方块的数量，用于估算网格规模 */
export function countBlocks(volume: BlockVolume): number {
  let count = 0
  for (let i = 0; i < volume.data.length; i += 1) {
    if (volume.data[i] !== 0) count += 1
  }
  return count
}

/** 六面方向的可读名字，调试用 */
export const FACE_NAMES: FaceDir[] = ['negX', 'posX', 'negY', 'posY', 'negZ', 'posZ']
