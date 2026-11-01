import { fetchWithRetry } from './net'

const BASE = '/mc'

export interface RegistryEntry {
  id: string
  n: string
  e: string | null
  /** 图标纹理，没有图标的注册表（附魔、伤害类型等）不带此字段 */
  i?: string
  /** 仅物品有：模型类型 */
  t?: string
}

/**
 * registry：游戏启动时登记在 Registry 里的内容清单（方块、物品、附魔、生物群系…）
 * asset：资源包里的一类文件（模型 JSON、着色器、字体、图集），它们没有注册表
 *
 * @why 之前这两类混在一个叫「注册表」的列表里，模型文件和附魔并排出现——
 *      模型不是注册表，是磁盘上的文件，读的人第一眼就会懵。
 */
export type DataKind = 'registry' | 'asset'

export interface Registry {
  id: string
  label: string
  kind: DataKind
  /** 数据来源，界面上标注清楚免得用户以为是官方 API */
  source: string
  route: string
  dataDir?: string
  /** assets 下的目录（模型、着色器），条目 id 是带扩展名的相对路径 */
  assetDir?: string
  count: number
  entries: RegistryEntry[]
}

export interface RegistryFile {
  version: string
  registries: Registry[]
}

const cache = new Map<string, Promise<RegistryFile>>()

export function loadRegistries(version: string): Promise<RegistryFile> {
  const hit = cache.get(version)
  if (hit) return hit

  const task = (async () => {
    const response = await fetchWithRetry(`${BASE}/${version}/registries.json`)
    if (!response.ok) throw new Error(`注册表加载失败：${response.status}`)
    return (await response.json()) as RegistryFile
  })()

  cache.set(version, task)
  return task
}

export async function loadRegistryEntryJson(
  version: string,
  dataDir: string,
  id: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${BASE}/${version}/data/minecraft/${dataDir}/${id}.json`)
    if (!response.ok) return null
    return JSON.stringify(await response.json(), null, 2)
  } catch {
    return null
  }
}

/** assets 下的文件（模型、着色器）多为纯文本，直接按文本读 */
export async function loadAssetText(
  version: string,
  assetDir: string,
  id: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${BASE}/${version}/${assetDir}/${id}`)
    if (!response.ok) return null
    const text = await response.text()
    if (id.endsWith('.json')) {
      try {
        return JSON.stringify(JSON.parse(text), null, 2)
      } catch {
        return text
      }
    }
    return text
  } catch {
    return null
  }
}
