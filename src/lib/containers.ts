import { MC_BASE as BASE, textureSrc } from './mc'
import { fetchWithRetry } from './net'

/**
 * 一个容器的布局，来自 scripts/extract-containers.py 对反编译源码的提取。
 * @why 槽位坐标不是 UI 自己排的：游戏里 addSlot(new Slot(..., x, y)) 决定位置，
 *      面板尺寸与背景切片来自 AbstractContainerScreen 的 super(...) 与 extractBackground。
 *      自己按"看起来差不多"排版，箱子背包第一行就会差 1px，热键栏间距也不对。
 */
export interface ContainerDef {
  id: string
  name: string
  /** 对应的 AbstractContainerMenu 子类 */
  menu: string
  /** 对应的 AbstractContainerScreen 子类 */
  screen: string
  /** 面板逻辑尺寸（GUI 像素），绘制时整体缩放 */
  width: number
  height: number
  /** 背景纹理资源路径，例如 textures/gui/container/generic_54.png；快捷栏为 null */
  texture: string | null
  /** 背景切片。箱子是两段（上盖 + 玩家背包），其余是一整块 */
  draws: ContainerDraw[]
  /** 标题文本，取自 en_us.json 的 container.* 键 */
  titleText: string
  /** 玩家背包标签文本 */
  labelText: string
  /** 同上，取自 zh_cn.json；缺语言文件时为空串 */
  titleTextZh: string
  labelTextZh: string
  title: { x: number; y: number }
  inventoryLabel: { x: number; y: number }
  /**
   * 这个界面实际要画哪几行文字。
   * @why 不是所有屏幕都画标题和"物品栏"：玩家背包只画标题、信标一行都不画、
   *      村民的标题居中带等级。照基类硬画会出现两个"物品栏"，信标的标题还会
   *      压在效果按钮上。
   */
  labelSpec: LabelSpec[]
  tradesText: string
  tradesTextZh: string
  /** 槽位，下标即 addSlot 顺序 */
  slots: { x: number; y: number }[]
  /** 可变状态的可调项，界面据此自动生成控件 */
  controls: ContainerControl[]
  /** 随状态变化的绘制层（火焰、气泡、信标按钮…） */
  layers: ContainerLayer[]
}

/**
 * 动态层：原版 renderBg / extractLabels 里的即时绘制。
 *
 * @why 用结构化字段而不是表达式字符串。`Mth.ceil(v * 24)` 这类式子交给求值器
 *      在 0、负数、浮点边界上几乎必错，而且错了不报错——只是条子短一像素，
 *      肉眼看不出来。每种层只有一种解释，前端一个 switch 就够。
 */
export type ContainerLayer =
  | {
      kind: 'progress'
      sprite: string
      x: number
      y: number
      w: number
      h: number
      axis: 'x' | 'y'
      align?: 'start' | 'end'
      /** value=1 时的像素长度 */
      scale?: number
      /** 在 scale 结果上追加的常量（熔炉火焰的 +1） */
      offset?: number
      /** 长度上限，默认取 w / h */
      max?: number
      /** 离散长度表，按下标取（酿造台气泡） */
      table?: number[]
      value: string
      when?: string
    }
  | {
      kind: 'sprite'
      sprite: string
      /** value 为 false 时改用这张 */
      unset?: string
      x: number
      y: number
      w: number
      h: number
      value?: string
      when?: string
    }
  | {
      kind: 'effect-button'
      x: number
      y: number
      tier: number
      effect: string
      slot: 'primary' | 'secondary'
    }
  | { kind: 'enchant-row'; row: number; x: number; y: number; w: number; h: number }
  | {
      kind: 'text'
      /** 本地化键，提取时已展开成 textEn / textZh */
      text: string
      textEn?: string
      textZh?: string
      cx: number
      y: number
    }
  | {
      kind: 'cost'
      right: number
      y: number
      value: string
      /** 提取时展开的本地化文本，%1$s 是等级消耗的占位 */
      costEn?: string
      costZh?: string
      expensiveEn?: string
      expensiveZh?: string
    }
  | {
      kind: 'select'
      sprite: string
      x: number
      y: number
      w: number
      h: number
      step: number
      value: string
    }

export type ContainerControl =
  | { key: string; type: 'bool'; label: string; default: boolean }
  | { key: string; type: 'range'; label: string; default: number }
  | { key: string; type: 'int'; label: string; default: number; min: number; max: number }
  | { key: string; type: 'effect'; label: string; default: string }

/** 节点的参数值。数字与布尔混用，effect 是效果 id 字符串 */
export type ParamValue = number | boolean | string

export interface LabelSpec {
  src: 'title' | 'label' | 'trades'
  /** left 用 x 作起点，center 用 cx 作中心 */
  align: 'left' | 'center'
  x?: number
  y?: number
  cx?: number
}

export interface ContainerDraw {
  dx: number
  dy: number
  u: number
  v: number
  w: number
  h: number
  texW: number
  texH: number
}

/** 信标效果按钮的显示名，中英各一份 */
export interface EffectName {
  id: string
  en: string
  zh: string
}

export interface ContainerFile {
  source: string
  containers: ContainerDef[]
  effects: EffectName[]
}

const cache = new Map<string, Promise<ContainerFile>>()

export function loadContainers(version: string): Promise<ContainerFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    // @constraint 必须带 ?v=：URL 里没有版本，改完数据用户会一直拿到浏览器缓存的
    //      旧布局（实测分享站点上 hotbar 根本没出现，因为 27KB 的旧 JSON 被钉住了）。
    const response = await fetchWithRetry(`${BASE}/${version}/containers.json?v=${__BUILD_ID__}`)
    if (!response.ok) throw new Error(`容器布局加载失败：${response.status}`)
    return (await response.json()) as ContainerFile
  })()
  cache.set(version, task)
  return task
}

/**
 * 容器背景纹理的 URL。
 * @constraint 派生数据里存的是 assets 相对路径（textures/gui/...），站点按
 *      mc-assets/<version>/ 平铺，所以要去掉开头的 textures/ 再走统一的
 *      textureSrc —— 否则会拼成 .../textures/textures/gui/...。
 */
export function containerTextureSrc(version: string, texture: string): string {
  return textureSrc(version, texture.replace(/^textures\//, '').replace(/\.png$/, ''))
}
