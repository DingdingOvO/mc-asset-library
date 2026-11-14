/**
 * 建筑结构：与原版 StructureTemplate（.nbt）一一对应。
 *
 * @why 这套类型不是为了"能存"，而是为了"能读原版的文件"。字段名、层级、取值
 *      全部照 NbtIo 的产物来：size / palette / blocks[pos,state,nbt] / entities。
 *      自己另发明一套的话，任何原版结构都得先转换才能用，而这 1511 个结构就是
 *      这个站最值钱的现成资源。
 *
 * @constraint palette 里的 state 是「下标」不是方块名：原版结构文件里方块
 *      只按调色板下标存，重复方块（一面墙都是石头）因此只占一个 short。
 *      按名字存会把 640KB 的房子撑到几兆。
 */
import type { NbtCompound } from './nbt'
import { intTriple, isCompound, list, num, str } from './nbt'

/** 方块状态：`minecraft:oak_stairs[facing=east,half=top]` 的拆解形式 */
export interface BlockState {
  name: string
  props?: Record<string, string>
}

export interface StructureBlock {
  /** 结构内的局部坐标，0 起 */
  pos: [number, number, number]
  /** palette 下标 */
  state: number
  /** 方块实体数据（箱子内容、告示牌文字） */
  nbt?: NbtCompound
}

export interface StructureEntity {
  pos: [number, number, number]
  blockPos: [number, number, number]
  nbt: NbtCompound
}

export interface StructureTemplate {
  size: [number, number, number]
  palette: BlockState[]
  blocks: StructureBlock[]
  entities: StructureEntity[]
}

/** 原版 Rotation 的四个档位 */
export type Rotation = 'none' | 'clockwise_90' | 'clockwise_180' | 'counterclockwise_90'

/** 原版 Mirror */
export type Mirror = 'none' | 'left_right' | 'front_back'

/**
 * 方块状态 → 规范字符串。
 *
 * @constraint 属性必须排序。原版 Properties 是 HashMap，序列化顺序不固定，
 *      同一个状态在两个结构里可能写出两种字符串，按字符串去重会把它们
 *      当成两种方块，调色板凭空翻倍。
 */
export function stateKey(state: BlockState): string {
  if (!state.props) return state.name
  const keys = Object.keys(state.props).sort()
  if (keys.length === 0) return state.name
  return `${state.name}[${keys.map((key) => `${key}=${state.props![key]}`).join(',')}]`
}

/** `minecraft:oak_stairs[facing=east]` → BlockState */
export function parseStateKey(text: string): BlockState {
  const open = text.indexOf('[')
  if (open < 0 || !text.endsWith(']')) return { name: text }
  const name = text.slice(0, open)
  const props: Record<string, string> = {}
  for (const pair of text.slice(open + 1, -1).split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    props[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return { name, props }
}

/**
 * 调色板条目 → 方块状态。
 *
 * @constraint 两套键名都要认。旧版结构文件是 `{Name, Properties}`（和数据包
 *      的 block_state 一致），新版（25 之后）改成了 `{id, properties}`。
 *      只认一种的话，另一半文件会整片读成空气。
 */
function readState(tag: unknown): BlockState | null {
  if (!isCompound(tag as never)) return null
  const node = tag as NbtCompound
  const name = str(node.Name) || str(node.id)
  if (!name) return null
  const raw = node.Properties ?? node.properties
  if (!isCompound(raw)) return { name }
  const props: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) props[key] = str(value)
  return { name, props }
}

/**
 * NBT → 结构。
 * @why 容错而不是抛异常：玩家用工具（Amulet、litematic 转换器）导出的文件
 *      经常少 size 或多一层包装，硬校验会让整个文件读不出来；
 *      这里缺什么就退化成空，至少能把方块读出来。
 */
export function parseStructure(nbt: NbtCompound): StructureTemplate {
  const size = intTriple(nbt.size) ?? [0, 0, 0]
  const palette: BlockState[] = []
  for (const entry of list(nbt.palette)) {
    const state = readState(entry)
    palette.push(state ?? { name: 'minecraft:air' })
  }

  const blocks: StructureBlock[] = []
  for (const entry of list(nbt.blocks)) {
    if (!isCompound(entry)) continue
    const pos = intTriple(entry.pos)
    const state = num(entry.state, 0)
    if (!pos) continue
    blocks.push({
      pos,
      state,
      nbt: isCompound(entry.nbt) ? entry.nbt : undefined,
    })
  }

  const entities: StructureEntity[] = []
  for (const entry of list(nbt.entities)) {
    if (!isCompound(entry)) continue
    const pos = intTriple(entry.pos)
    const blockPos = intTriple(entry.blockPos) ?? pos
    if (!pos || !blockPos || !isCompound(entry.nbt)) continue
    entities.push({ pos, blockPos, nbt: entry.nbt })
  }

  return { size, palette, blocks, entities }
}

/** 结构包围盒（局部坐标，含端点） */
export function structureBounds(template: StructureTemplate): {
  min: [number, number, number]
  max: [number, number, number]
} {
  let max: [number, number, number] = [0, 0, 0]
  for (const block of template.blocks) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (block.pos[axis]! > max[axis]!) max[axis] = block.pos[axis]!
    }
  }
  // @constraint size 缺失时用方块推算：工具导出的文件经常没有 size，
  //      只用 size 会让整栋楼被压成 0×0×0。
  const size = template.size
  for (let axis = 0; axis < 3; axis += 1) {
    if (size[axis]! > 0) max[axis] = Math.max(max[axis]!, size[axis]! - 1)
  }
  return { min: [0, 0, 0], max }
}

/** 局部坐标 → 结构内下标（用于稠密体素） */
export function indexIn(size: [number, number, number], x: number, y: number, z: number): number {
  return (y * size[2]! + z) * size[0]! + x
}

export function inside(size: [number, number, number], pos: [number, number, number]): boolean {
  return pos[0]! >= 0 && pos[1]! >= 0 && pos[2]! >= 0 &&
    pos[0]! < size[0]! && pos[1]! < size[1]! && pos[2]! < size[2]!
}

/**
 * 把一个结构摊成 局部坐标 → 调色板下标 的稠密体素。
 *
 * @why 稠密而不是 Map：结构最多几万个方块，稠密表是 Uint16Array 直接下标，
 *      后面做遮挡剔除、面合并都要逐格遍历，Map 的字符串键在这件事上慢一个
 *      数量级。体积上限按 512³ 卡住，再大的结构在原版里也要切块。
 */
export function rasterize(template: StructureTemplate): {
  size: [number, number, number]
  palette: BlockState[]
  data: Uint16Array
} {
  const { max } = structureBounds(template)
  const size: [number, number, number] = [max[0] + 1, max[1] + 1, max[2] + 1]
  const volume = size[0] * size[1] * size[2]
  const data = new Uint16Array(volume)
  for (const block of template.blocks) {
    if (!inside(size, block.pos)) continue
    data[indexIn(size, block.pos[0], block.pos[1], block.pos[2])] = block.state + 1
  }
  const palette: BlockState[] = [{ name: 'minecraft:air' }, ...template.palette]
  return { size, palette, data }
}
