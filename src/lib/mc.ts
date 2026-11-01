import { fetchWithRetry } from './net'

/**
 * 素材根地址。
 *
 * @why 站点可能被挂在子路径下（GitHub Pages 是 `/<repo>/`），素材目录跟着站点走；
 *      也可能整包丢到外部 CDN 上，那时不该再带子路径。两种情况只能靠构建期变量区分。
 * @constraint 结尾不带斜杠，调用处统一用 `${MC_BASE}/<版本>/...` 拼接。
 */
export const MC_BASE = (import.meta.env.VITE_ASSET_BASE ?? `${__SITE_BASE__}mc`).replace(
  /\/+$/,
  '',
)

const BASE = MC_BASE

export interface McGroup {
  id: string
  label: string
  count: number
  cover: string | null
}

export interface McVersion {
  id: string
  generatedAt: string
  counts: Record<string, number>
  groups: McGroup[]
  itemGroups?: McGroup[]
  itemCount?: number
  blockCount?: number
  registrySummary?: {
    id: string
    label: string
    kind?: 'registry' | 'asset'
    count: number
    route: string
  }[]
}

export interface McManifest {
  latest: string
  versions: McVersion[]
}

export interface Texture {
  /** 相对 textures/ 的路径，不含 .png */
  p: string
  /** 显示名，优先中文 */
  n: string
  /** 官方英文名，未命中语言文件时为 null */
  e: string | null
  g: string
  w: number | null
  h: number | null
  /** 1 表示存在 .png.mcmeta 动画 */
  a: 0 | 1
}

export interface Sound {
  p: string
  g: string
  /** 文件字节数 */
  k: number
  /** 官方字幕中文名（subtitles.* 的中文翻译） */
  s?: string
  /** 字幕对应的事件 id */
  e?: string
}

export interface TextureFile {
  version: string
  groups: McGroup[]
  items: Texture[]
}

export interface SoundFile {
  version: string
  items: Sound[]
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetchWithRetry(url, { cache: 'no-cache' })
  return (await response.json()) as T
}

const cache = new Map<string, Promise<unknown>>()

/** @why 页面来回切换时避免重复拉取 400KB 的纹理索引 */
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Promise<T> | undefined
  if (hit) return hit
  const task = load().catch((error: unknown) => {
    cache.delete(key)
    throw error
  })
  cache.set(key, task)
  return task
}

export function loadManifest(): Promise<McManifest> {
  return cached('manifest', () => getJson<McManifest>(`${BASE}/versions.json`))
}

export function loadTextures(version: string): Promise<TextureFile> {
  return cached(`textures:${version}`, () => getJson<TextureFile>(`${BASE}/${version}/textures.json`))
}

export function loadSounds(version: string): Promise<SoundFile> {
  return cached(`sounds:${version}`, () => getJson<SoundFile>(`${BASE}/${version}/sounds.json`))
}

export const textureSrc = (version: string, id: string): string => `${BASE}/${version}/textures/${id}.png`

export const soundSrc = (version: string, id: string): string => `${BASE}/${version}/sounds/${id}.ogg`

/** 命名空间路径，方便直接粘进资源包 */
export const namespacePath = (kind: 'textures' | 'sounds', id: string, ext: string): string =>
  `minecraft:${kind}/${id}.${ext}`

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
