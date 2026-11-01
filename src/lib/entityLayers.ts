/**
 * 实体图层与可变状态。
 *
 * @why 游戏里一只生物从来不是「一个模型 + 一张贴图」：SheepRenderer 挂着
 *      羊毛外层与底绒，EndermanRenderer 挂着发光眼睛，HorseRenderer 挂着斑纹，
 *      CatRenderer 挂着项圈。只画主模型的结果是羊秃、末影人没眼睛、马没花纹。
 *      这些图层在源码里是 addLayer(new XxxLayer(...))，几何与贴图都写在图层类里，
 *      由 scripts/extract-layers.py 抽成 entitylayers.json。
 *
 * @why 品种/颜色这类"状态"也一起抽出来了：horse 的 7 种毛色 × 5 种斑纹、
 *      cat 的 11 个品种、shulker 的 16 种染色、羊的 16 种羊毛色……
 *      它们本质上是「换一张贴图」或「给图层乘一个颜色」，
 *      不需要为每只生物写一套界面。
 */
import { fetchWithRetry } from './net'
import { buildRig, type EntityLayer, type Rig } from './entityRig'
import type { EntityModel } from './entityMesh'

export interface LayerDef {
  /** 图层类名 */
  c: string
  /** ModelLayers 键（如 sheep:wool）；空表示复用本体几何 */
  m: string | null
  /** 成年体贴图 */
  t: string
  /** 发光层：满亮渲染 */
  e?: 0 | 1
  /** 吃染料色 */
  d?: 1
  /** wool = 羊毛类（默认白色），tame = 只有驯服后才出现（项圈） */
  k?: 'wool' | 'tame'
  /** 该图层可换的多张贴图（斑纹、骷髅衣服） */
  v?: string[]
}

export interface AxisOption {
  k: string
  zh: string
  t?: string | null
}

export interface Axis {
  /** base = 本体贴图；dye = 染料；layer:类名 = 某个图层的贴图 */
  k: string
  zh: string
  layer?: string
  dye?: 1
  default?: string
  opts?: AxisOption[]
}

export interface DyeColor {
  k: string
  zh: string
  rgb: string
}

export interface LayerFile {
  version: string
  dyes: DyeColor[]
  layers: Record<string, LayerDef[]>
  axes: Record<string, Axis[]>
}

const cache = new Map<string, Promise<LayerFile>>()

export function loadLayers(version: string): Promise<LayerFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    const response = await fetchWithRetry(`/mc/${version}/entitylayers.json?v=1`)
    if (!response.ok) throw new Error(`图层数据加载失败：${response.status}`)
    return (await response.json()) as LayerFile
  })()
  cache.set(version, task)
  return task
}

/** 组装好的几何按模型键缓存：同一只生物的图层被反复切换时不用重建骨骼 */
const rigCache = new Map<string, Rig | null>()

function rigOf(
  key: string | null,
  pool: Record<string, EntityModel>,
  byLayer: Record<string, string>,
): Rig | null {
  if (!key) return null
  const modelKey = byLayer[key] ?? key
  if (rigCache.has(modelKey)) return rigCache.get(modelKey) ?? null
  const model = pool[modelKey]
  const rig = model ? buildRig(model) : null
  rigCache.set(modelKey, rig)
  return rig
}

/** 某个实体的默认选择：品种取默认贴图，项圈取无，羊毛取白色 */
export function defaultChoice(file: LayerFile | null, entity: string, baseTexture: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const axis of file?.axes[entity] ?? []) {
    if (axis.k === 'base') out[axis.k] = baseTexture
    else if (axis.dye) out[axis.k] = axis.default ?? 'none'
    else out[axis.k] = 'none'
  }
  return out
}

/** 标签：品种轴里"默认"那一项要能认出来是本体皮肤 */
export function axisLabel(axis: Axis): string {
  return axis.zh
}

function dyeTint(file: LayerFile, key: string): [number, number, number] | undefined {
  if (!key || key === 'none') return undefined
  const hit = file.dyes.find((dye) => dye.k === key)
  if (!hit) return undefined
  const hex = hit.rgb.replace('#', '')
  return [
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  ]
}

/**
 * 按当前选择组装图层。
 *
 * @constraint 项圈图层只有选了颜色才画：游戏里没驯服的猫/狼根本没有项圈，
 *      默认画上去等于给野生生物套了个红领子。
 */
export function composeLayers(
  entity: string,
  file: LayerFile | null,
  choice: Record<string, string>,
  pool: Record<string, EntityModel>,
  byLayer: Record<string, string>,
): EntityLayer[] {
  const defs = file?.layers[entity]
  if (!defs || defs.length === 0) return []
  const axes = file?.axes[entity] ?? []
  const dyeAxis = axes.find((axis) => axis.dye)
  const tint = dyeAxis ? dyeTint(file!, choice[dyeAxis.k] ?? '') : undefined

  const out: EntityLayer[] = []
  for (const def of defs) {
    const axis = axes.find((item) => item.layer === def.c)
    let texture = def.t
    if (axis) {
      const picked = choice[axis.k] ?? 'none'
      const opt = axis.opts?.find((item) => item.k === picked)
      if (!opt?.t) continue
      texture = opt.t
    }
    if (def.k === 'tame' && !tint) continue
    out.push({
      rig: rigOf(def.m, pool, byLayer),
      texture,
      cls: def.c,
      tint: def.d ? (tint ?? (def.k === 'wool' ? [1, 1, 1] : undefined)) : undefined,
      unlit: def.e === 1,
    })
  }
  return out
}
