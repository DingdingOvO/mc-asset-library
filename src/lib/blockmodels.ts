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
  /** 与 textures 一一对应的动画帧数（没动画的是 1） */
  frames: number[]
  /**
   * 与 textures 平行的透明度类别：0 不透明、1 镂空、2 半透明。
   *
   * @why 这个判定以前在浏览器里扫纹素，结果取决于贴图有没有下载完：没下载完
   *      一律当不透明，玻璃于是被当成实心块（邻接面被剔掉，透过玻璃看到空气），
   *      树叶和蜘蛛网的透明像素被画成纯白。打包时算一次，运行时只查表。
   * @constraint 缺这个字段的旧数据要按「未知」处理并退回运行时扫描，
   *      不能让 indexOf 返回 -1 把整页判成半透明。
   */
  alpha?: number[]
  /**
   * 满格全不透明方块的 id 清单，用于体素邻接剔除。
   * @why 同上：运行时按贴图像素猜"这个方块实不实心"会随时序抖动。
   */
  opaque?: string[]
  /** 动画贴图的完整参数，键是纹理池里的下标。 */
  anims?: Record<string, [number, number, number[] | null]>
  /**
   * 方块 / 物品的 id 清单，已按字符串排序。
   * @why 面数据切片下发，列表页必须先知道"有哪些"才能排版。顺序就是切片顺序：
   *      第 k 项属于第 floor(k / shardSize) 片，不用额外存映射表。
   */
  blockIds: string[]
  itemIds: string[]
  shardSize: number
  /** 面数据按片取回后合并到这里（meta 下发时是空对象） */
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
const shardCache = new Map<string, Promise<Record<string, BakedFace[]>>>()

/**
 * 数据格式版本。
 * @constraint 动了字段语义必须递增：浏览器或网关缓存了旧 JSON 时，会把没有 anims
 *             的数据当成"全是静态贴图"，动画方块会集体冻在第一帧而且不报错。
 *             v3：面数据改成分片下发，meta 里的 blocks/items 恒为空。
 *             v4：补 alpha / opaque 两张表，透明度判定从运行时搬到打包阶段。
 */
const DATA_VERSION = 4

/**
 * 单个面的字段数。
 * @constraint 改字段顺序必须递增：浏览器缓存了旧 JS 时会把新数据的 u2 当成纹理
 *             索引读，整页方块会全部显示成同一张贴图（曾经变成满屏羊毛）。
 */
const FACE_FORMAT = 23

export function loadBlockModels(version: string): Promise<BlockModelFile> {
  const hit = cache.get(version)
  if (hit) return hit

  const task = (async () => {
    // URL 带格式版本，绕开旧缓存
    const response = await fetchWithRetry(`${BASE}/${version}/blockmodels.json?v=${DATA_VERSION}`)
    if (!response.ok) throw new Error(`方块模型加载失败：${response.status}`)

    const data = (await response.json()) as BlockModelFile
    if (!Array.isArray(data.blockIds) || !Array.isArray(data.textures)) {
      throw new Error('模型数据格式不匹配，请强制刷新页面 Ctrl+Shift+R')
    }
    return data
  })()

  cache.set(version, task)
  return task
}

/**
 * 取一片面数据。
 *
 * @why 1160 个方块的面数据加起来 1136KB，首屏只看得到十几张卡片。整包下发意味着
 *      手机上要先解析完一兆多 JSON 才能画出第一个方块，滚动还没开始先等一秒。
 * @constraint 必须复用一个 Promise：同一切片在滚动时会前后反复进出视口，
 *      不缓存就会在快速上下滚动时把同一个请求发四五遍。
 */
export function loadBakeShard(
  version: string,
  kind: 'blocks' | 'items',
  index: number,
): Promise<Record<string, BakedFace[]>> {
  const key = `${version}:${kind}:${index}`
  const hit = shardCache.get(key)
  if (hit) return hit

  const task = (async () => {
    const response = await fetchWithRetry(
      `${BASE}/${version}/baked/${kind}.${index}.json?v=${DATA_VERSION}`,
    )
    if (!response.ok) throw new Error(`模型分片加载失败：${kind}.${index} (${response.status})`)
    const data = (await response.json()) as Record<string, BakedFace[]>
    const sample = Object.values(data)[0]?.[0]
    if (sample && sample.length !== FACE_FORMAT) {
      throw new Error(
        `模型数据格式不匹配（期望 ${FACE_FORMAT} 字段，收到 ${sample.length}），请强制刷新页面 Ctrl+Shift+R`,
      )
    }
    return data
  })().catch((error: unknown) => {
    /**
     * @why 失败的分片必须从缓存里摘掉。调用方按「没取到就下次重试」处理，
     *      但缓存里留着 rejected Promise，重试就会原样拿到同一个失败结果，
     *      卡片从此永久停在占位。
     */
    shardCache.delete(key)
    throw error
  })

  shardCache.set(key, task)
  return task
}
