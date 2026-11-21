/**
 * 实体渲染映射：实体 id → 模型类 → 几何 / 贴图。
 *
 * @why 之前靠 id 猜模型名（chicken → adult_chicken），猜不到就退回贴图，
 *      于是僵尸、骷髅、村民全变成了平面图。真实映射在
 *      EntityRenderers.register(EntityTypes.ZOMBIE, ZombieRenderer::new) 里，
 *      由 scripts/extract-renderers.py 反编译挖出来，这里只做查表。
 */
import { MC_BASE } from './mc'
import type { EntityShape } from './shapeRig'
import { fetchWithRetry } from './net'

export interface EntityRenderInfo {
  /** 渲染器类名 */
  r: string
  /** 主模型类名 */
  m: string
  /** 模型层名 */
  l: string
  /** 阴影半径 */
  s: number | null
  /** 硬编码贴图（变体动物是运行时决定的，这里为空） */
  t: string[]
  /** 全部模型变体 */
  v: string[]
  /** 各变体对应的 ModelLayers 键（[0] 是成年体） */
  layers?: string[]
  /**
   * 1 = 渲染器提交模型前把 y 翻了（活体实体），0 = 没翻（末地水晶、投掷物）。
   * 缺省按 1 处理：老数据没有这个字段时，翻转才是绝大多数情况。
   */
  f?: number
  /**
   * 没有骨架时渲染器现拼的几何（方块 / 物品 / billboard）。
   * 有它才能画出 TNT、掉落物、经验球，否则只能给一张物品图标。
   */
  shape?: EntityShape
}

export interface RendererFile {
  entities: Record<string, EntityRenderInfo>
  renderers: Record<string, unknown>
}

const cache = new Map<string, Promise<RendererFile>>()

export function loadRenderers(version: string): Promise<RendererFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    const response = await fetchWithRetry(`${MC_BASE}/${version}/entityrenderers.json?v=3`)
    if (!response.ok) throw new Error(`实体渲染表加载失败：${response.status}`)
    return (await response.json()) as RendererFile
  })()
  cache.set(version, task)
  return task
}

/** PigModel → pig、AdultChickenModel → adult_chicken */
export function modelKeyOf(cls: string): string {
  const base = cls.endsWith('Model') ? cls.slice(0, -5) : cls
  return base.replace(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/g, '_').toLowerCase()
}
