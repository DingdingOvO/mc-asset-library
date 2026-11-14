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
import { MC_BASE } from './mc'
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
  /**
   * 0 = 只画成年体。
   * @why 值不是"有没有幼年变体"，而是源码 submit() 里的排除条件：
   *      SheepWoolUndercoatLayer 直接 `if (state.isBaby) return`。
   *      不知道这条就会给幼年羊叠一层成年尺寸的白绒，整只被白点包住。
   */
  b?: 0
  /**
   * 1 = 只有染色过的才画（白羊毛没有底绒）。
   * 源码条件：state.woolColor == DyeColor.WHITE 时 return。
   */
  y?: 1
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

/**
 * 幼年体（体型变体）。
 *
 * @why 原版里幼年不是「把成年模型缩小」：BabySheepModel 是一具独立烘焙的骨架，
 *      贴图也是独立文件（sheep_baby.png、sheep_wool_baby.png）。数据由
 *      scripts/extract-sizes.py 从 entitymodels.json 与贴图目录配出来，
 *      这里只负责按当前选择查表。
 */
export interface SizeDef {
  /** 幼年几何的 bake 键（sheep_baby） */
  m: string | null
  /** 幼年体的动画类名（BabySheepModel）；没有就只能是静态姿势 */
  c?: string
  /** 默认幼年本体贴图 */
  t?: string
  /** 成年贴图 → 幼年贴图。品种轴与体型轴同时生效时靠它换算 */
  tex?: Record<string, string>
  /** 图层类名 → 幼年图层（羊毛层是另一套几何与贴图） */
  layers?: Record<string, { t?: string | null; m?: string | null }>
}

export interface LayerFile {
  version: string
  dyes: DyeColor[]
  layers: Record<string, LayerDef[]>
  axes: Record<string, Axis[]>
  /** 有幼年形态的实体。缺省表示该实体没有幼年变体 */
  sizes?: Record<string, SizeDef>
}

const cache = new Map<string, Promise<LayerFile>>()

export function loadLayers(version: string): Promise<LayerFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    const response = await fetchWithRetry(`${MC_BASE}/${version}/entitylayers.json?v=3`)
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
    // @why 非染料轴也可能有默认值：村民的生态型是整张身体贴图，默认必须画
    //      平原那一张，留空等于给村民套一件没有颜色的灰袍（不传 default 的
    //      图层轴仍然是"无"，比如马的花纹）
    if (axis.k === 'base') out[axis.k] = baseTexture
    else out[axis.k] = axis.default ?? 'none'
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
  const baby = choice.size === 'baby' ? file?.sizes?.[entity] : undefined
  const dyed = dyeAxis ? (choice[dyeAxis.k] ?? '') : ''

  const out: EntityLayer[] = []
  for (const def of defs) {
    // 源码里的绘制条件，逐条照抄：跳过就真的不画
    if (baby && def.b === 0) continue
    if (def.y === 1 && (!dyed || dyed === 'none' || dyed === 'white')) continue

    const axis = axes.find((item) => item.layer === def.c)
    let texture = def.t
    if (axis) {
      const picked = choice[axis.k] ?? 'none'
      const opt = axis.opts?.find((item) => item.k === picked)
      if (!opt?.t) continue
      texture = opt.t
    }
    if (def.k === 'tame' && !tint) continue

    /**
     * @constraint 幼年换算必须放在品种轴之后：两个轴是叠加的，
     *      猫选了「三花」再切幼年，要的是 cat_calico_baby 而不是默认那张。
     *      图层几何也要换（羊毛层在幼年体上是 sheep_baby:wool），
     *      只换贴图会让羊毛按成年尺寸糊在幼年羊身上。
     */
    let rigKey = def.m
    if (baby) {
      const over = baby.layers?.[def.c]
      if (over?.m) rigKey = over.m
      texture = baby.tex?.[texture] ?? over?.t ?? texture
    }

    out.push({
      rig: rigOf(rigKey, pool, byLayer),
      texture,
      cls: def.c,
      tint: def.d ? (tint ?? (def.k === 'wool' ? [1, 1, 1] : undefined)) : undefined,
      unlit: def.e === 1,
    })
  }
  return out
}

/** 该实体有没有幼年形态，以及幼年的几何/类名 */
export function sizeOf(file: LayerFile | null, entity: string): SizeDef | null {
  return file?.sizes?.[entity] ?? null
}

/** 当前选择是否是幼年体 */
export function isBaby(choice: Record<string, string>): boolean {
  return choice.size === 'baby'
}

