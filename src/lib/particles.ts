import { MC_BASE as BASE } from './mc'
import { fetchWithRetry } from './net'

/**
 * 一个粒子的源码参数。
 *
 * @why particles/*.json 只给贴图名，一个字都没说它多大、活多久。
 *      这些全在 Java 里：ParticleResources 的注册表决定了 id 用哪个类，
 *      类的构造函数与 getQuadSize 决定了尺寸和缩小幅度。
 *      scripts/extract-particles.py 把这两处抽出来落成这张表。
 */
export interface ParticleDef {
  /** 注册 id，如 flame */
  id: string
  /** 源码类名，如 FlameParticle；null 表示没在注册表里找到 */
  c: string | null
  /** quadSize：边长，单位是格（1 格 = 16 模型单位） */
  q: number
  /** lifetime：存活 tick 数 */
  l: number
  /** gravity：每 tick 的竖直加速度（负数是上浮） */
  g: number
  /** 末帧相对首帧的尺寸系数，null 表示全程不变 */
  z: number | null
  /** 帧序列：[贴图名, 宽, 高]，顺序就是 setSpriteFromAge 的播放顺序 */
  f: [string, number | null, number | null][]
  /** 1 表示用的是基类默认尺寸（0.1 * 随机(0.5~1) * 2） */
  d: 0 | 1
}

export interface ParticleFile {
  version: string
  items: ParticleDef[]
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetchWithRetry(url, { cache: 'no-cache' })
  return (await response.json()) as T
}

const cache = new Map<string, Promise<unknown>>()

export function loadParticles(version: string): Promise<ParticleFile> {
  const key = `particles:${version}`
  const hit = cache.get(key) as Promise<ParticleFile> | undefined
  if (hit) return hit
  const task = getJson<ParticleFile>(`${BASE}/${version}/particledata.json`).catch((error: unknown) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, task)
  return task
}

export const particleSrc = (version: string, name: string): string =>
  `${BASE}/${version}/textures/particle/${name}.png`

/**
 * 当前时刻的边长（格）。
 *
 * @constraint 尺寸随时间线性过渡到末帧系数：游戏里是 getQuadSize 里的公式
 *      （火焰是 1 - s²·0.5），这里用同样首尾值的线性插值——预览要的是
 *      "越烧越小"这个可读的观感，不是复刻每一条曲线。
 *      真要精确就只能内联八十多个类的公式，代价远大于收益。
 */
export function sizeAt(def: ParticleDef, progress: number): number {
  if (def.z == null) return def.q
  return def.q * (1 + (def.z - 1) * progress)
}

/** 某个时刻应该显示哪一帧（setSpriteFromAge 等价物） */
export function frameAt(def: ParticleDef, progress: number): number {
  const total = def.f.length
  if (total <= 1) return 0
  const index = Math.floor(progress * total)
  return Math.min(total - 1, Math.max(0, index))
}
