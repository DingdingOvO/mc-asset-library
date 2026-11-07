import type { DisplayTransform } from './scene'
import { MC_BASE as BASE } from './mc'
import { fetchWithRetry } from './net'

export type Dir = [number, number, number]

/**
 * 一个面用 23 个数表示，为的是让 1157 个方块挤进 1.7MB：
 *   [0..11]  4 个顶点 xyz（0..16）
 *   [12..19] 4 个顶点的 uv（已归一化 0..1）
 *   [20] 纹理池索引  [21] tintindex  [22] shade（0/1）
 */
export type BakedFace = number[]

export interface BlockModelFile {
  version: string
  /** 纹理池，面数据里的索引指向这里 */
  textures: string[]
  /** 与 textures 一一对应的动画帧数 */
  frames: number[]
  blocks: Record<string, BakedFace[]>
  items: Record<string, BakedFace[]>
  /** display.gui 视角：模型在物品栏里的标准角度 */
  displays: Record<string, DisplayTransform>
  /** 半截方块（门只有下半、床只有一头），默认不展示 */
  hidden?: string[]
  /** 平面物品（贴图挤出 1 单位厚），要正对相机才看得清 */
  flat?: string[]
}

const cache = new Map<string, Promise<BlockModelFile>>()

/**
 * 面数据格式版本。
 * @constraint 改了字段顺序必须递增：浏览器或网关缓存了旧 JS 时，会把新数据的
 *             u2 当成纹理索引读，整页方块会全部显示成同一张贴图（曾经变成满屏羊毛）。
 */
const FACE_FORMAT = 23

export function loadBlockModels(version: string): Promise<BlockModelFile> {
  const hit = cache.get(version)
  if (hit) return hit

  const task = (async () => {
    // URL 带格式版本，绕开旧缓存
    const response = await fetchWithRetry(`${BASE}/${version}/blockmodels.json?v=${FACE_FORMAT}`)
    if (!response.ok) throw new Error(`方块模型加载失败：${response.status}`)

    const data = (await response.json()) as BlockModelFile
    const sample = Object.values(data.blocks)[0]?.[0]
    if (sample && sample.length !== FACE_FORMAT) {
      throw new Error(
        `模型数据格式不匹配（期望 ${FACE_FORMAT} 字段，收到 ${sample.length}），请强制刷新页面 Ctrl+Shift+R`,
      )
    }
    return data
  })()

  cache.set(version, task)
  return task
}
