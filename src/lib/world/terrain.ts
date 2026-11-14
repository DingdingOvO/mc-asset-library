/**
 * 体素地形：一块连续的方块体积。
 *
 * @why 场景里除了"一栋楼"还需要"一片地"：超平坦、分层地表、噪声地形。
 *      这三种在原版里都是"区块里的一堆 blockstate"，没有文件格式，
 *      所以这里只做一件事——提供一个能读能写的体积，让生成器往里填。
 *
 * @constraint 用稠密 Uint16Array + 调色板，和区块 section 一样：
 *      96×64×96 的房子是 590k 格，Uint16 只要 1.2MB；用 Map<string,state>
 *      是它的二十倍以上，而且每帧遍历会卡死。
 */
import { indexIn, parseStateKey, rasterize, type BlockState, type StructureTemplate } from './structure'

export interface BlockVolume {
  size: [number, number, number]
  /** [0] 恒为 air */
  palette: BlockState[]
  data: Uint16Array
}

export const AIR: BlockState = { name: 'minecraft:air' }

export function createVolume(size: [number, number, number]): BlockVolume {
  const [x, y, z] = size
  return { size, palette: [AIR], data: new Uint16Array(Math.max(0, x * y * z)) }
}

/** 取调色板下标，没有就追加。返回 0 表示空气 */
export function paletteIndex(volume: BlockVolume, state: BlockState): number {
  if (state.name === AIR.name) return 0
  const key = state.name + JSON.stringify(state.props ?? null)
  for (let i = 1; i < volume.palette.length; i += 1) {
    const entry = volume.palette[i]!
    if (entry.name + JSON.stringify(entry.props ?? null) === key) return i
  }
  volume.palette.push(state)
  return volume.palette.length - 1
}

export function setBlock(volume: BlockVolume, x: number, y: number, z: number, state: BlockState | string): void {
  const { size } = volume
  if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) return
  const parsed = typeof state === 'string' ? parseStateKey(state) : state
  volume.data[indexIn(size, x, y, z)] = paletteIndex(volume, parsed)
}

export function getBlock(volume: BlockVolume, x: number, y: number, z: number): BlockState {
  const { size } = volume
  if (x < 0 || y < 0 || z < 0 || x >= size[0] || y >= size[1] || z >= size[2]) return AIR
  const index = volume.data[indexIn(size, x, y, z)] ?? 0
  return volume.palette[index] ?? AIR
}

/**
 * 超平坦地形的分层定义。
 * @why 从上到下而不是从下到上：写地形时人想的是"最上面一层草"，不是"最下面一层基岩"。
 *      最后一层可以无限向下延伸，用 Infinity 表示。
 */
export interface TerrainLayer {
  state: BlockState | string
  /** 厚度（格）。Infinity 表示这一层一直填到体积底部 */
  height: number
}

/** 超平坦：按层定义从上往下填 */
export function flatVolume(size: [number, number, number], layers: TerrainLayer[]): BlockVolume {
  const volume = createVolume(size)
  let y = size[1] - 1
  for (const layer of layers) {
    const thickness = layer.height === Infinity ? y + 1 : Math.round(layer.height)
    for (let i = 0; i < thickness && y >= 0; i += 1) {
      for (let z = 0; z < size[2]; z += 1) {
        for (let x = 0; x < size[0]; x += 1) setBlock(volume, x, y, z, layer.state)
      }
      y -= 1
    }
    if (y < 0) break
  }
  return volume
}

/** 结构 → 体积。用于把一栋楼当作地形的一部分放进来 */
export function volumeFromStructure(template: StructureTemplate): BlockVolume {
  return rasterize(template)
}

/** 统计：一共多少非空气格、用了多少种方块 */
export function volumeStats(volume: BlockVolume): { blocks: number; kinds: number; size: [number, number, number] } {
  let blocks = 0
  const seen = new Set<number>()
  for (const value of volume.data) {
    if (value === 0) continue
    blocks += 1
    seen.add(value)
  }
  return { blocks, kinds: seen.size, size: volume.size }
}
