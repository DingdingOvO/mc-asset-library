import type { ParamValue } from './containers'

/**
 * 工作区模型：一张画布上摆着若干容器，每个容器的每个格子可以放物品。
 *
 * @why 这是「界面」页的主体，不是贴图列表。游戏里玩家面对的是容器实体——
 *      拉开一个箱子、把物品排进格子、截一张图给资源包当预览。所以数据的
 *      根是「摆在哪、放了什么」，而不是「哪张图好看」。
 */

export interface PlacedItem {
  /** 物品注册表 id，例如 diamond / redstone */
  id: string
  /** 堆叠数量，1 时游戏不画数字 */
  count: number
}

export interface ContainerNode {
  /** 画布内唯一，与容器类型无关：同一张画布可以放三个箱子 */
  uid: string
  /** ContainerDef.id */
  container: string
  /** 画布坐标（GUI 像素，缩放由视图负责） */
  x: number
  y: number
  /** 槽位下标 → 物品。下标就是 addSlot 顺序，提取时已固定 */
  items: Record<number, PlacedItem>
  /**
   * 可变状态：燃烧进度、信标等级、主副效果、快捷栏选中格…
   * @why 容器不只是"格子 + 物品"。熔炉有没有在烧、信标几级点亮了哪排效果，
   *      都直接决定截出来的图对不对。缺省值来自 def.controls。
   */
  params: Record<string, ParamValue>
}

export interface Workspace {
  nodes: ContainerNode[]
}

export type WorkspaceAction =
  | { type: 'add'; container: string; x: number; y: number; uid: string; params: Record<string, ParamValue> }
  | { type: 'move'; uid: string; x: number; y: number }
  | { type: 'remove'; uid: string }
  | { type: 'front'; uid: string }
  | { type: 'clone'; uid: string; nextUid: string }
  | { type: 'put'; uid: string; slot: number; item: PlacedItem }
  | { type: 'param'; uid: string; key: string; value: ParamValue }
  | { type: 'take'; uid: string; slot: number }
  | { type: 'load'; workspace: Workspace }
  | { type: 'clear' }

export const emptyWorkspace = (): Workspace => ({ nodes: [] })

export function workspaceReducer(state: Workspace, action: WorkspaceAction): Workspace {
  switch (action.type) {
    case 'add':
      return {
        nodes: [
          ...state.nodes,
          {
            uid: action.uid,
            container: action.container,
            x: action.x,
            y: action.y,
            items: {},
            params: action.params,
          },
        ],
      }
    case 'move':
      return {
        nodes: state.nodes.map((node) =>
          node.uid === action.uid ? { ...node, x: action.x, y: action.y } : node,
        ),
      }
    case 'remove':
      return { nodes: state.nodes.filter((node) => node.uid !== action.uid) }
    case 'front': {
      // @why 顺序就是绘制顺序：后画的盖住先画的，置顶必须真的把节点挪到数组末尾
      const target = state.nodes.find((node) => node.uid === action.uid)
      if (!target || state.nodes[state.nodes.length - 1]?.uid === action.uid) return state
      return { nodes: [...state.nodes.filter((node) => node.uid !== action.uid), target] }
    }
    case 'clone': {
      const target = state.nodes.find((node) => node.uid === action.uid)
      if (!target) return state
      return {
        nodes: [
          ...state.nodes,
          {
            ...target,
            uid: action.nextUid,
            // 偏移 12 像素，否则复制出来的和原件完全重叠，看着像没反应
            x: target.x + 12,
            y: target.y + 12,
            items: { ...target.items },
            params: { ...target.params },
          },
        ],
      }
    }
    case 'put':
      return {
        nodes: state.nodes.map((node) =>
          node.uid === action.uid
            ? { ...node, items: { ...node.items, [action.slot]: action.item } }
            : node,
        ),
      }
    case 'param':
      return {
        nodes: state.nodes.map((node) =>
          node.uid === action.uid
            ? { ...node, params: { ...node.params, [action.key]: action.value } }
            : node,
        ),
      }
    case 'take':
      return {
        nodes: state.nodes.map((node) => {
          if (node.uid !== action.uid) return node
          const items = { ...node.items }
          delete items[action.slot]
          return { ...node, items }
        }),
      }
    case 'load':
      return action.workspace
    case 'clear':
      return emptyWorkspace()
    default:
      return state
  }
}

const FORMAT = 'mc-asset-library/workspace'
const FORMAT_VERSION = 2

export interface WorkspaceFile {
  format: string
  version: number
  source: string
  nodes: {
    container: string
    x: number
    y: number
    items: Record<string, PlacedItem>
    params?: Record<string, ParamValue>
  }[]
}

export function serialize(workspace: Workspace, source: string): WorkspaceFile {
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    source,
    // @why 不写 uid：导入时重新生成，避免同一份文件导入两次产生主键冲突
    nodes: workspace.nodes.map((node) => ({
      container: node.container,
      x: node.x,
      y: node.y,
      items: Object.fromEntries(
        Object.entries(node.items).map(([slot, item]) => [slot, { id: item.id, count: item.count }]),
      ),
      params: node.params,
    })),
  }
}

export function deserialize(raw: unknown, newUid: () => string): Workspace | null {
  if (!raw || typeof raw !== 'object') return null
  const file = raw as Partial<WorkspaceFile>
  if (file.format !== FORMAT || typeof file.version !== 'number') return null
  if (!Array.isArray(file.nodes)) return null

  const nodes: ContainerNode[] = []
  for (const entry of file.nodes) {
    if (!entry || typeof entry.container !== 'string') continue
    const items: Record<number, PlacedItem> = {}
    for (const [slot, value] of Object.entries(entry.items ?? {})) {
      const index = Number(slot)
      if (!Number.isInteger(index) || index < 0) continue
      if (!value || typeof value.id !== 'string') continue
      const count = Math.max(1, Math.min(99, Math.round(Number(value.count) || 1)))
      items[index] = { id: value.id, count }
    }
    // @constraint 旧文件（version 1）没有 params，这里留空对象；
    //      调用方按 def.controls 的默认值补齐，不要在这一层猜容器结构。
    const params: Record<string, ParamValue> = {}
    for (const [key, value] of Object.entries(entry.params ?? {})) {
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        params[key] = value
      }
    }
    nodes.push({
      uid: newUid(),
      container: entry.container,
      x: Math.round(Number(entry.x) || 0),
      y: Math.round(Number(entry.y) || 0),
      items,
      params,
    })
  }
  return { nodes }
}

/** 找一块空地放新容器：从左上开始，避开已有节点的包围盒 */
export function freeSpot(
  workspace: Workspace,
  size: { width: number; height: number },
  boxes: Record<string, { width: number; height: number }>,
): { x: number; y: number } {
  const taken = workspace.nodes.map((node) => {
    const box = boxes[node.container] ?? { width: size.width, height: size.height }
    return { x0: node.x, y0: node.y, x1: node.x + box.width, y1: node.y + box.height }
  })

  const overlaps = (x: number, y: number) =>
    taken.some((box) => x < box.x1 + 8 && x + size.width + 8 > box.x0 && y < box.y1 + 8 && y + size.height + 8 > box.y0)

  for (let y = 8; y < 4000; y += 12) {
    for (let x = 8; x < 2000; x += 12) {
      if (!overlaps(x, y)) return { x, y }
    }
  }
  return { x: 8, y: 8 }
}
