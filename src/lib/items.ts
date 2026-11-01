import { fetchWithRetry } from './net'

const BASE = '/mc'

export interface ItemGroup {
  id: string
  label: string
  count: number
}

export interface Item {
  /** 物品注册表 id，例如 diamond_sword */
  id: string
  n: string
  e: string | null
  /** 图标所用纹理 */
  i: string
  /** 模型类型：model / select / special / composite / condition / range_dispatch */
  t: string
  g: string
  /** 1 表示同时是可放置方块 */
  b: 0 | 1
}

export interface ItemFile {
  version: string
  groups: ItemGroup[]
  items: Item[]
}

const cache = new Map<string, Promise<ItemFile>>()

export function loadItems(version: string): Promise<ItemFile> {
  const hit = cache.get(version)
  if (hit) return hit

  const task = (async () => {
    const response = await fetchWithRetry(`${BASE}/${version}/items.json`)
    if (!response.ok) throw new Error(`物品注册表加载失败：${response.status}`)
    return (await response.json()) as ItemFile
  })()

  cache.set(version, task)
  return task
}

/** 特殊模型类型没有独立贴图可看，界面上需要给出说明 */
export const MODEL_TYPE_LABELS: Record<string, string> = {
  model: '普通模型',
  select: '条件模型',
  special: '特殊渲染',
  composite: '组合模型',
  condition: '条件模型',
  range_dispatch: '数值模型',
}
