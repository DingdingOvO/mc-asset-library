/**
 * 场景解析：把「一堆带摆放参数的节点」压成「一具体素 + 一张实体清单」。
 *
 * @why 渲染层不该认识 StructureNode / TerrainNode 的差别：它只要一具体素、
 *      一张调色板、以及"哪些坐标上有实体和容器"。所有摆放语义（旋转、镜像、
 *      平移、互相覆盖）都在这一层算完，渲染层拿到的是已经拼好的世界。
 *
 * @constraint 后放的节点覆盖先放的，和原版 placeInWorld 一致：
 *      先铺地形再盖房子，房子里的空气块会把地形挖掉（结构文件里空气是显式存的）。
 */
import { stateKey, type BlockState, type StructureTemplate } from './structure'
import { createVolume, getBlock, setBlock } from './terrain'
import {
  mirrorPos,
  nodeBounds,
  rotatePos,
  type NodePlacement,
  type WorldNode,
  type WorldScene,
} from './types'

export interface ResolvedEntity {
  entity: string
  /** 世界坐标（格，方块中心为 x+0.5） */
  at: [number, number, number]
  yaw: number
  variant?: Record<string, string>
  sourceId: string
}

export interface ResolvedContainer {
  container: string
  at: [number, number, number]
  items?: Record<number, { id: string; count: number }>
  params?: Record<string, number | string>
  sourceId: string
}

export interface ResolvedWorld {
  size: [number, number, number]
  /** [0] 恒为 air */
  palette: BlockState[]
  data: Uint16Array
  origin: [number, number, number]
  entities: ResolvedEntity[]
  containers: ResolvedContainer[]
  /** 非空气方块数，用于界面上显示"这栋楼多大" */
  blocks: number
}

/** 摆放变换：先镜像再旋转，最后平移到世界坐标 */
function place(
  pos: [number, number, number],
  size: [number, number, number],
  node: NodePlacement,
): [number, number, number] {
  const mirrored = mirrorPos(pos, size, node.mirror)
  const rotated = rotatePos(mirrored, size, node.rotation)
  return [rotated[0] + node.at[0], rotated[1] + node.at[1], rotated[2] + node.at[2]]
}

function gridOf(nodes: WorldNode[]): { min: [number, number, number]; size: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const node of nodes) {
    const box = nodeBounds(node)
    for (let axis = 0; axis < 3; axis += 1) {
      if (box.min[axis]! < min[axis]!) min[axis] = box.min[axis]!
      if (box.max[axis]! > max[axis]!) max[axis] = box.max[axis]!
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], size: [0, 0, 0] }
  return {
    min,
    size: [max[0] - min[0] + 1, max[1] - min[1] + 1, max[2] - min[2] + 1],
  }
}

/**
 * 复制一个结构进世界体素。
 * @constraint 结构的 palette 是局部的，必须逐条搬到世界的 palette 里：
 *      直接沿用下标会让两栋楼的石头互相串成木头。
 */
function stampStructure(
  target: ReturnType<typeof createVolume>,
  node: Extract<WorldNode, { kind: 'structure' }>,
  origin: [number, number, number],
): void {
  const template: StructureTemplate = node.template
  const size = template.size
  const local: [number, number, number] = [
    Math.max(1, size[0]),
    Math.max(1, size[1]),
    Math.max(1, size[2]),
  ]
  for (const block of template.blocks) {
    const state = template.palette[block.state] ?? { name: 'minecraft:air' }
    const [x, y, z] = place(block.pos, local, { ...node, at: [0, 0, 0] })
    setBlock(target, x + node.at[0] - origin[0], y + node.at[1] - origin[1], z + node.at[2] - origin[2], state)
  }
}

function stampTerrain(
  target: ReturnType<typeof createVolume>,
  node: Extract<WorldNode, { kind: 'terrain' }>,
  origin: [number, number, number],
): void {
  const { volume } = node
  for (let y = 0; y < volume.size[1]; y += 1) {
    for (let z = 0; z < volume.size[2]; z += 1) {
      for (let x = 0; x < volume.size[0]; x += 1) {
        const state = getBlock(volume, x, y, z)
        if (state.name === 'minecraft:air') continue
        const [px, py, pz] = place([x, y, z], volume.size, { ...node, at: [0, 0, 0] })
        setBlock(target, px + node.at[0] - origin[0], py + node.at[1] - origin[1], pz + node.at[2] - origin[2], state)
      }
    }
  }
}

/**
 * 解析整个场景。
 * @why 一次铺平而不是树形结构：渲染、导出、统计都只需要"某个坐标是什么方块"，
 *      树形结构每问一次就要递归一遍，热路径上不划算。
 */
export function resolveScene(scene: WorldScene): ResolvedWorld {
  const { min, size } = gridOf(scene.nodes)
  const volume = createVolume(size)
  // palette 预置空气；之后按出现顺序追加
  const palette: BlockState[] = [volume.palette[0]!]
  volume.palette = palette

  for (const node of scene.nodes) {
    if (node.kind === 'structure') stampStructure(volume, node, min)
    else if (node.kind === 'terrain') stampTerrain(volume, node, min)
  }

  const entities: ResolvedEntity[] = []
  const containers: ResolvedContainer[] = []
  for (const node of scene.nodes) {
    if (node.kind === 'entity') {
      entities.push({
        entity: node.entity,
        at: [
          node.at[0] - min[0] + 0.5,
          node.at[1] - min[1],
          node.at[2] - min[2] + 0.5,
        ],
        yaw: node.yaw ?? 0,
        variant: node.variant,
        sourceId: node.id,
      })
    } else if (node.kind === 'container') {
      containers.push({
        container: node.container,
        at: [node.at[0] - min[0], node.at[1] - min[1], node.at[2] - min[2]],
        items: node.items,
        params: node.params,
        sourceId: node.id,
      })
    }
  }

  let blocks = 0
  for (const value of volume.data) if (value !== 0) blocks += 1

  return { size, palette, data: volume.data, origin: min, entities, containers, blocks }
}

/** 世界体素里的某个方块，坐标是世界坐标 */
export function blockAtWorld(world: ResolvedWorld, x: number, y: number, z: number): BlockState {
  const lx = x - world.origin[0]
  const ly = y - world.origin[1]
  const lz = z - world.origin[2]
  if (lx < 0 || ly < 0 || lz < 0 || lx >= world.size[0] || ly >= world.size[1] || lz >= world.size[2]) {
    return { name: 'minecraft:air' }
  }
  const index = (ly * world.size[2] + lz) * world.size[0] + lx
  return world.palette[world.data[index] ?? 0] ?? { name: 'minecraft:air' }
}

/** 场景用了哪些方块（去重后按名字排序），给"这栋楼用了什么材料"用 */
export function worldPalette(world: ResolvedWorld): { key: string; count: number }[] {
  const counts = new Map<number, number>()
  for (const value of world.data) {
    if (value === 0) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([index, count]) => ({ key: stateKey(world.palette[index] ?? { name: 'minecraft:air' }), count }))
    .sort((a, b) => b.count - a.count)
}
