import { loadBakeShard, loadBlockModels } from './blockmodels'
import { blockFaces } from './faceBuild'
import { textureSrc } from './mc'
import { DEFAULT_ROTATION, drawScene, pivotOf, type Face3D } from './scene'

/**
 * 物品图标：把一件物品画成一张小图，供容器槽位与导出复用。
 *
 * @why GUI 里的物品不是贴图列表——方块物品（砖块、熔炉、箱子）在游戏里是等轴
 *      3D 渲染，直接贴 16×16 的 item/*.png 会得到一张"正脸照"，和玩家熟悉的
 *      物品栏完全不是一回事。所以方块走软件光栅化，平面物品（钻石、苹果）
 *      才直接采样贴图。
 *
 * @performance 一个容器 90 个格子、工作区放几个容器就是几百个图标。每个图标
 *      单独跑 rAF 渲染循环会直接把主线程打死，所以这里只渲染一次、按
 *      (版本, 物品, 尺寸) 缓存成位图。渲染成本 O(物品种类数)，不是 O(格子数)。
 */

interface IconEntry {
  canvas: HTMLCanvasElement | null
  /** 预转好的 data URL —— 槽位用 <img> 挂，避免每个格子维护一块 canvas */
  url: string | null
  ready: boolean
}

const icons = new Map<string, IconEntry>()
const inFlight = new Map<string, Promise<void>>()

/** 画好的图标 URL；null 表示还没好（或这件物品没有图标） */
export function iconUrl(key: string): string | null {
  const entry = icons.get(key)
  return entry?.ready ? entry.url : null
}

export function iconKey(version: string, itemId: string, size: number): string {
  return `${version}|${itemId}|${size}`
}

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  return [canvas, canvas.getContext('2d')!]
}

/**
 * 取一件物品的图标，必要时现场渲染。
 *
 * @constraint 失败必须落一个「已就绪的空图标」而不是留着 pending —— 否则
 *      每次重渲染都会再排一次任务，一个没有模型的物品能把页面拖成死循环。
 */
export async function ensureIcon(
  version: string,
  itemId: string,
  texture: string,
  size = 32,
): Promise<void> {
  const key = iconKey(version, itemId, size)
  const hit = icons.get(key)
  if (hit) return
  const running = inFlight.get(key)
  if (running) return running

  const task = (async () => {
    let canvas: HTMLCanvasElement | null = null
    try {
      canvas = await renderIcon(version, itemId, texture, size)
    } catch {
      canvas = null
    }
    icons.set(key, { canvas, url: canvas ? canvas.toDataURL() : null, ready: true })
    inFlight.delete(key)
  })()
  inFlight.set(key, task)
  return task
}

async function renderIcon(
  version: string,
  itemId: string,
  texture: string,
  size: number,
): Promise<HTMLCanvasElement | null> {
  const meta = await loadBlockModels(version)
  const index = meta.itemIds.indexOf(itemId)
  const faces = index >= 0 ? await facesOfItem(version, meta.shardSize, index, itemId) : null
  const flat = new Set(meta.flat ?? []).has(itemId)

  const [canvas, ctx] = makeCanvas(size)
  if (faces && faces.length > 0 && !flat) {
    const geometry: Face3D[] = blockFaces(faces, meta.textures, meta.anims, 0)
    drawScene(ctx, {
      faces: geometry,
      size,
      rotX: DEFAULT_ROTATION[0],
      rotY: DEFAULT_ROTATION[1],
      fit: 'block',
      display: meta.displays[itemId] ?? null,
      version,
      supersample: 2,
      // @why 槽位里没有地面，投影会糊在物品自己身上
      shadow: 0,
      pivot: pivotOf(geometry),
    })
    return canvas
  }

  // 平面物品：正对相机 1:1 采样，像素必须硬边，插值会让 16×16 的图标糊成一坨
  const image = await loadImage(textureSrc(version, texture))
  if (!image) return canvas
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight, 0, 0, size, size)
  return canvas
}

async function facesOfItem(
  version: string,
  shardSize: number,
  index: number,
  itemId: string,
): Promise<number[][] | null> {
  const shard = Math.floor(index / (shardSize > 0 ? shardSize : 200))
  const part = await loadBakeShard(version, 'items', shard)
  const faces = part[itemId]
  return faces && faces.length > 0 ? faces : null
}

const images = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(src: string): Promise<HTMLImageElement | null> {
  const hit = images.get(src)
  if (hit) return hit
  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
  images.set(src, task)
  return task
}
