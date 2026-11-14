/**
 * 结构仓库：索引 + 按需加载。
 *
 * @why 1511 个结构不能一次全读：单个 village 房子是 1~10KB，全量解压进内存要
 *      几十兆，而用户一次只看一栋。索引（路径/类别/字节数）先给列表用，
 *      .nbt 点开才取。
 *
 * @constraint 缓存的是 Promise 而不是结果：连点两次同一栋房子时，第二次
 *      必须复用第一次的请求，否则两个 fetch 同时跑、各自解析一遍。
 */
import { MC_BASE } from '../mc'
import { fetchWithRetry } from '../net'
import { readNbt } from './nbt'
import { parseStructure, type StructureTemplate } from './structure'

export interface StructureFile {
  /** 相对 structures 根的路径，不含 .nbt */
  path: string
  name: string
  group: string
  bytes: number
}

export interface StructureIndex {
  version: string
  count: number
  groups: Record<string, number>
  files: StructureFile[]
}

const indexCache = new Map<string, Promise<StructureIndex>>()

export function loadStructureIndex(version: string): Promise<StructureIndex> {
  const hit = indexCache.get(version)
  if (hit) return hit
  const task = (async () => {
    const response = await fetchWithRetry(`${MC_BASE}/${version}/structures.json`)
    if (!response.ok) throw new Error(`结构索引加载失败：${response.status}`)
    return (await response.json()) as StructureIndex
  })()
  indexCache.set(version, task)
  return task
}

const templateCache = new Map<string, Promise<StructureTemplate | null>>()

export function loadStructure(version: string, path: string): Promise<StructureTemplate | null> {
  const key = `${version}:${path}`
  const hit = templateCache.get(key)
  if (hit) return hit
  const task = (async () => {
    const response = await fetchWithRetry(`${MC_BASE}/${version}/structures/${path}.nbt`)
    if (!response.ok) return null
    const bytes = new Uint8Array(await response.arrayBuffer())
    /**
     * @constraint 解析失败不能抛出：原版结构里有极少几个用了本版本没有的
     *      方块状态，或者玩家自己存过损坏文件。抛异常会让整个列表页崩掉，
     *      返回 null 只让那一栋显示"读不出"。
     */
    try {
      return parseStructure(await readNbt(bytes))
    } catch {
      return null
    }
  })()
  templateCache.set(key, task)
  return task
}

/** 结构的中文分类名。原版没有中文分类，这里的叫法跟游戏内结构名一致 */
export const STRUCTURE_GROUP_ZH: Record<string, string> = {
  village: '村庄',
  bastion: '堡垒遗迹',
  ancient_city: '远古城市',
  trial_chambers: '试炼密室',
  woodland_mansion: '林地府邸',
  end_city: '末地城',
  shipwreck: '沉船',
  ruined_portal: '废弃传送门',
  underwater_ruin: '海底废墟',
  pillager_outpost: '掠夺者前哨',
  igloo: '雪屋',
  fossil: '化石',
  nether_fossils: '下界化石',
  desert_well: '沙漠水井',
  abandoned_camp: '废弃营地',
  trail_ruins: '古迹废墟',
  spring: '水源',
  misc: '其它',
}
