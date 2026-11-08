import { containerTextureSrc, type ContainerDef } from './containers'
import { drawText, loadFont, textWidth, type GlyphFont } from './font'
import { ensureIcon, iconKey, iconUrl } from './itemIcon'
import { paintLabels, paintLayers } from './layerRender'
import { preloadSprites, spriteOf } from './sprites'
import { workspaceBounds, type ExportBounds } from './containerRender'
import type { Workspace } from './workspace'

/**
 * 分层渲染：导出 PNG 与 PSD 共用。
 *
 * @why 分层不是为了好看。做视频的人拿到一张平面图之后，想把某个格子的物品换掉、
 *      把火焰关掉、把中文标题改成英文，全得自己抠。分层导出（背景 / 状态 / 物品 /
 *      文字各自一层）让这些操作在 PS 里是关一个图层的事。
 * @constraint 图层边界必须各自裁剪，不能都用整张画布。一张 1200×900 的 RGBA
 *      图层是 4.3MB，四个容器十二层就 50MB 起步，PSD 打不开。
 */

export interface RenderLayer {
  name: string
  canvas: HTMLCanvasElement
  /** 相对整张导出图的左上角，整数像素 */
  left: number
  top: number
}

export interface LayeredRender {
  width: number
  height: number
  layers: RenderLayer[]
}

/**
 * 每个容器的图层外扩量，覆盖 hotbar 选中框（y=-1）与副手（x=-29）这类溢出。
 * @constraint 必须跟着 scale 走：32 GUI 像素在 3 倍下是 96，写死 40 会让副手槽
 *      被裁掉一半——导出图里看得见，屏幕上却不会（屏幕上是 DOM 溢出）。
 */
const marginOf = (scale: number) => Math.ceil(32 * scale)

const imageCache = new Map<string, Promise<HTMLImageElement | null>>()

export function loadImage(src: string): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(src)
  if (hit) return hit
  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
  imageCache.set(src, task)
  return task
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(width))
  canvas.height = Math.max(1, Math.ceil(height))
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  return { canvas, ctx }
}

/** 堆叠数字：右下角、右对齐、原色 1/4 亮度投影 */
export function drawCount(ctx: CanvasRenderingContext2D, font: GlyphFont, count: number): void {
  const text = String(count)
  const x = 16 - textWidth(font, text)
  drawText(ctx, font, text, x + 1, 9, '#3f3f3f')
  drawText(ctx, font, text, x, 8, '#ffffff')
}

export interface RenderOptions {
  version: string
  scale: number
  lang: 'zh' | 'en'
  textureOf: (itemId: string) => string | undefined
  pad?: number
}

export async function renderLayers(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
  options: RenderOptions,
): Promise<LayeredRender | null> {
  const bounds = workspaceBounds(workspace, defs)
  if (!bounds) return null
  const { version, scale, lang, textureOf } = options
  const pad = options.pad ?? 8

  const width = Math.ceil((bounds.width + pad * 2) * scale)
  const height = Math.ceil((bounds.height + pad * 2) * scale)

  // 图标与 sprite 必须先全部就绪：它们是按需异步生成的，同步取会得到一片空白，
  // 导出的图看着像没放东西，但屏幕上明明有。
  const jobs: Promise<unknown>[] = []
  for (const node of workspace.nodes) {
    const def = defs.get(node.container)
    if (!def) continue
    for (const item of Object.values(node.items)) {
      jobs.push(ensureIcon(version, item.id, textureOf(item.id) ?? `item/${item.id}`, 64))
    }
    const sprites = def.layers.flatMap((layer) => {
      if (layer.kind === 'progress' || layer.kind === 'sprite' || layer.kind === 'select') return [layer.sprite]
      if (layer.kind === 'effect-button') return ['container/beacon/button', 'container/beacon/button_disabled', 'container/beacon/button_selected', `mob_effect/${layer.effect}`]
      if (layer.kind === 'enchant-row') {
        const n = layer.row + 1
        return ['container/enchanting_table/enchantment_slot', 'container/enchanting_table/enchantment_slot_disabled', `container/enchanting_table/level_${n}`, `container/enchanting_table/level_${n}_disabled`]
      }
      return []
    })
    if (sprites.length) jobs.push(preloadSprites(version, sprites))
  }
  await Promise.all(jobs)

  const font = await loadFont(version)
  const layers: RenderLayer[] = []

  for (const node of workspace.nodes) {
    const def = defs.get(node.container)
    if (!def) continue

    const MARGIN = marginOf(scale)
    const left = Math.round((node.x - bounds.x + pad) * scale) - MARGIN
    const top = Math.round((node.y - bounds.y + pad) * scale) - MARGIN
    const boxW = def.width * scale + MARGIN * 2
    const boxH = def.height * scale + MARGIN * 2

    const prefix = `${def.name}@${node.x},${node.y}`

    // ---- 背景
    const bg = makeCanvas(boxW, boxH)
    if (bg) {
      const image = def.texture ? await loadImage(containerTextureSrc(version, def.texture)) : null
      if (image) {
        for (const draw of def.draws) {
          bg.ctx.drawImage(image, draw.u, draw.v, draw.w, draw.h, MARGIN + draw.dx * scale, MARGIN + draw.dy * scale, draw.w * scale, draw.h * scale)
        }
      }
      layers.push({ name: `${prefix} 背景`, canvas: bg.canvas, left, top })
    }

    // ---- 状态（动态层）：单独一层，视频里想关掉火焰或换个等级直接隐藏即可
    if (def.layers.length) {
      const overlay = makeCanvas(boxW, boxH)
      if (overlay) {
        overlay.ctx.save()
        overlay.ctx.translate(MARGIN, MARGIN)
        overlay.ctx.scale(scale, scale)
        paintLayers(overlay.ctx, def, {
          font,
          lang,
          params: node.params,
          getSprite: (name) => spriteOf(version, name),
        })
        overlay.ctx.restore()
        layers.push({ name: `${prefix} 状态`, canvas: overlay.canvas, left, top })
      }
    }

    // ---- 物品
    if (Object.keys(node.items).length) {
      const wrap = makeCanvas(boxW, boxH)
      if (wrap) {
        for (const [slot, item] of Object.entries(node.items)) {
          const spot = def.slots[Number(slot)]
          if (!spot) continue
          const url = iconUrl(iconKey(version, item.id, 64))
          if (!url) continue
          const icon = await loadImage(url)
          if (!icon) continue
          const dx = MARGIN + spot.x * scale
          const dy = MARGIN + spot.y * scale
          wrap.ctx.drawImage(icon, dx, dy, 16 * scale, 16 * scale)
          if (item.count > 1 && font) {
            wrap.ctx.save()
            wrap.ctx.translate(dx, dy)
            wrap.ctx.scale(scale, scale)
            drawCount(wrap.ctx, font, item.count)
            wrap.ctx.restore()
          }
        }
        layers.push({ name: `${prefix} 物品`, canvas: wrap.canvas, left, top })
      }
    }

    // ---- 文字：标题与背包标签。信标那两句在「状态」层里，因为它们跟参数绑定
    if (font && def.labelSpec.length) {
      const text = makeCanvas(boxW, boxH)
      if (text) {
        text.ctx.save()
        text.ctx.translate(MARGIN, MARGIN)
        text.ctx.scale(scale, scale)
        paintLabels(text.ctx, def, font, lang)
        text.ctx.restore()
        layers.push({ name: `${prefix} 文字`, canvas: text.canvas, left, top })
      }
    }
  }

  return { width, height, layers }
}

/** 把分层结果压成一张图，用于 PNG 导出与屏幕预览 */
export function flatten(
  render: LayeredRender,
  backdrop: string | null,
): HTMLCanvasElement | null {
  const box = makeCanvas(render.width, render.height)
  if (!box) return null
  if (backdrop) {
    box.ctx.fillStyle = backdrop
    box.ctx.fillRect(0, 0, render.width, render.height)
  }
  for (const layer of render.layers) {
    box.ctx.drawImage(layer.canvas, layer.left, layer.top)
  }
  return box.canvas
}

export type { ExportBounds }
