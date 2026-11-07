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
  /** 背景纹理资源路径，例如 textures/gui/container/generic_54.png */
  texture: string
  /** 背景切片。箱子是两段（上盖 + 玩家背包），其余是一整块 */
  draws: ContainerDraw[]
  /** 标题文本，取自 en_us.json 的 container.* 键 */
  titleText: string
  /** 玩家背包标签文本 */
  labelText: string
  title: { x: number; y: number }
  inventoryLabel: { x: number; y: number }
  /** 槽位，下标即 addSlot 顺序 */
  slots: { x: number; y: number }[]
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

export interface ContainerFile {
  source: string
  containers: ContainerDef[]
}

const cache = new Map<string, Promise<ContainerFile>>()

export function loadContainers(version: string): Promise<ContainerFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    const response = await fetchWithRetry(`${BASE}/${version}/containers.json`)
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
