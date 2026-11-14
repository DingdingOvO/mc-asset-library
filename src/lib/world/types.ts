/**
 * 世界场景：地形 + 建筑 + 实体 + 界面，放在同一个坐标系里。
 *
 * @why 工作台现在只能摆"界面容器"，而做视频真正要的是"把一个箱子摆进一栋房子里，
 *      房子盖在一片地上"。这三种东西的坐标单位、朝向、尺寸完全不同，
 *      如果继续按页面各存一份，后面永远拼不到一起。
 *      这里按原版的放置语义建模：每个节点有局部坐标、旋转、镜像，
 *      世界坐标 = 节点的 at + 旋转/镜像后的局部坐标。
 *
 * @constraint 旋转换算必须自己做，不能靠 CSS/矩阵在渲染时补：结构是体素，
 *      旋转要落到方块下标上（原版 StructureTemplate.placeInWorld 就是这么做的），
 *      否则 90° 旋转后的建筑会错格。
 */
import type { StructureTemplate, Rotation, Mirror } from './structure'
import type { BlockVolume } from './terrain'

export type { Rotation, Mirror }

export interface NodePlacement {
  /** 世界坐标（格），左下前角 */
  at: [number, number, number]
  rotation?: Rotation
  mirror?: Mirror
}

export interface TerrainNode extends NodePlacement {
  kind: 'terrain'
  id: string
  volume: BlockVolume
}

export interface StructureNode extends NodePlacement {
  kind: 'structure'
  id: string
  /** 结构来源，如 minecraft:village/plains/houses/plains_small_house_1 */
  source: string
  template: StructureTemplate
}

export interface EntityNode extends NodePlacement {
  kind: 'entity'
  id: string
  /** 实体 id，如 minecraft:sheep */
  entity: string
  /** 朝向（度，与原版 yaw 一致：0 = 朝南 +z） */
  yaw?: number
  /** 变体选择，键与 entitylayers.json 的轴一致（size / dye / base / layer:类名） */
  variant?: Record<string, string>
}

export interface ContainerNode extends NodePlacement {
  kind: 'container'
  id: string
  /** 容器定义 id，与 containers.json 一致（chest / furnace / barrel…） */
  container: string
  /** 槽位 → 物品 */
  items?: Record<number, { id: string; count: number }>
  /** 容器参数（熔炉燃烧进度、信标效果），与工作台共用 */
  params?: Record<string, number | string>
}

export type WorldNode = TerrainNode | StructureNode | EntityNode | ContainerNode

export interface WorldScene {
  version: string
  nodes: WorldNode[]
}

export function emptyScene(version: string): WorldScene {
  return { version, nodes: [] }
}

/**
 * 局部坐标绕 Y 轴旋转。
 *
 * @why 用包围盒的 size 参与换算是原版的做法：旋转后体积的三个维度会互换
 *      （90° 时 X↔Z），用固定 size 算出的坐标会越界或错格。
 *      这里约定 rotation 输入的是「旋转前」的尺寸。
 *
 * @constraint 90° 顺时针的映射是 (x,z) → (sizeZ-1-z, x)：先逆转 90°
 *      （x' = -z, z' = x），再把负坐标平移回正区间。写成 (z, sizeX-1-x)
 *      是镜像而不是旋转，做出来的楼会左右反。
 */
export function rotatePos(
  pos: [number, number, number],
  size: [number, number, number],
  rotation: Rotation = 'none',
): [number, number, number] {
  const [x, y, z] = pos
  const [sx, , sz] = size
  switch (rotation) {
    case 'clockwise_90':
      return [sz - 1 - z, y, x]
    case 'clockwise_180':
      return [sx - 1 - x, y, sz - 1 - z]
    case 'counterclockwise_90':
      return [z, y, sx - 1 - x]
    default:
      return [x, y, z]
  }
}

export function mirrorPos(
  pos: [number, number, number],
  size: [number, number, number],
  mirror: Mirror = 'none',
): [number, number, number] {
  const [x, y, z] = pos
  if (mirror === 'left_right') return [size[0] - 1 - x, y, z]
  if (mirror === 'front_back') return [x, y, size[2] - 1 - z]
  return [x, y, z]
}

/** 旋转后的包围盒尺寸（90°/270° 时 X 与 Z 互换） */
export function rotatedSize(
  size: [number, number, number],
  rotation: Rotation = 'none',
): [number, number, number] {
  const [x, y, z] = size
  return rotation === 'clockwise_90' || rotation === 'counterclockwise_90' ? [z, y, x] : [x, y, z]
}

/** 节点在世界里的包围盒（含端点） */
export function nodeBounds(node: WorldNode): { min: [number, number, number]; max: [number, number, number] } {
  let size: [number, number, number]
  if (node.kind === 'terrain') size = node.volume.size
  else if (node.kind === 'structure') size = node.template.size
  else size = [1, 1, 1]
  const rotated = rotatedSize(size, node.rotation)
  return {
    min: [...node.at] as [number, number, number],
    max: [
      node.at[0] + rotated[0] - 1,
      node.at[1] + rotated[1] - 1,
      node.at[2] + rotated[2] - 1,
    ],
  }
}
