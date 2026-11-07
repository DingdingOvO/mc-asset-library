import { containerTextureSrc, type ContainerDef } from './containers'
import { drawText, loadFont, textWidth, type GlyphFont } from './font'
import { ensureIcon, iconKey, iconUrl } from './itemIcon'
import type { Workspace } from './workspace'

/**
 * 容器背景绘制，屏幕显示与导出共用。
 *
 * @why 如果导出另写一套，两边的切片顺序、像素对齐迟早会分叉——导出的图和
 *      屏幕上看到的差一圈边框，用户第一反应是"导出坏了"。绘制只能有一份实现。
 */
export function paintContainer(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  def: ContainerDef,
  dx: number,
  dy: number,
): void {
  for (const draw of def.draws) {
    ctx.drawImage(
      image,
      draw.u,
      draw.v,
      draw.w,
      draw.h,
      dx + draw.dx,
      dy + draw.dy,
      draw.w,
      draw.h,
    )
  }
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(src: string): Promise<HTMLImageElement | null> {
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

export interface ExportBounds {
  x: number
  y: number
  width: number
  height: number
}

export function workspaceBounds(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
): ExportBounds | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const node of workspace.nodes) {
    const def = defs.get(node.container)
    if (!def) continue
    x0 = Math.min(x0, node.x)
    y0 = Math.min(y0, node.y)
    x1 = Math.max(x1, node.x + def.width)
    y1 = Math.max(y1, node.y + def.height)
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export type ExportBackdrop = 'transparent' | 'dark' | 'light'

const BACKDROPS: Record<ExportBackdrop, string | null> = {
  transparent: null,
  dark: '#1b1b1f',
  light: '#f2f2f4',
}

/**
 * 把整个工作区合成一张 PNG。
 *
 * @constraint 物品图标必须先 await 全部就绪。图标是按需异步光栅化的，直接
 *      同步取会得到一堆空格子——导出图看着像没放东西，但屏幕上明明有。
 */
export async function exportWorkspacePng(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
  version: string,
  scale: number,
  backdrop: ExportBackdrop,
  textureOf: (itemId: string) => string | undefined,
): Promise<Blob | null> {
  const bounds = workspaceBounds(workspace, defs)
  if (!bounds) return null

  const pad = 8
  const width = Math.ceil((bounds.width + pad * 2) * scale)
  const height = Math.ceil((bounds.height + pad * 2) * scale)

  // 图标要在建画布之前全部备好：这里 await 的是渲染任务，失败会落成空图标
  const jobs: Promise<void>[] = []
  for (const node of workspace.nodes) {
    for (const item of Object.values(node.items)) {
      jobs.push(ensureIcon(version, item.id, textureOf(item.id) ?? `item/${item.id}`, 64))
    }
  }
  await Promise.all(jobs)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const fill = BACKDROPS[backdrop]
  if (fill) {
    ctx.fillStyle = fill
    ctx.fillRect(0, 0, width, height)
  }

  ctx.imageSmoothingEnabled = false
  const font = await loadFont(version)
  // 逻辑坐标 → 导出画布坐标：先按 -bounds 平移，再乘缩放
  const toCanvas = (value: number, origin: number) => (value - origin + pad) * scale

  for (const node of workspace.nodes) {
    const def = defs.get(node.container)
    if (!def) continue
    const image = await loadImage(containerTextureSrc(version, def.texture))
    if (!image) continue

    const left = toCanvas(node.x, bounds.x)
    const top = toCanvas(node.y, bounds.y)

    ctx.save()
    ctx.translate(left, top)
    ctx.scale(scale, scale)
    paintContainer(ctx, image, def, 0, 0)
    // 标题与背包标签跟背景同一套 GUI 坐标，必须画在同一个变换里
    if (font) {
      drawText(ctx, font, def.titleText, def.title.x, def.title.y, '#404040')
      drawText(ctx, font, def.labelText, def.inventoryLabel.x, def.inventoryLabel.y, '#404040')
    }
    ctx.restore()

    for (const [slot, item] of Object.entries(node.items)) {
      const index = Number(slot)
      const spot = def.slots[index]
      if (!spot) continue
      const url = iconUrl(iconKey(version, item.id, 64))
      if (!url) continue
      const icon = await loadImage(url)
      if (!icon) continue
      ctx.drawImage(
        icon,
        left + spot.x * scale,
        top + spot.y * scale,
        16 * scale,
        16 * scale,
      )
      if (item.count > 1 && font) {
        ctx.save()
        ctx.translate(left + spot.x * scale, top + spot.y * scale)
        ctx.scale(scale, scale)
        drawCount(ctx, font, item.count)
        ctx.restore()
      }
    }
  }

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

/**
 * 堆叠数字：右下角、右对齐、带 1 像素黑色投影。
 *
 * @constraint 用 textWidth 反推 x，不能写死右边界 —— '9' 和 '64' 宽度不同，
 *      写死会让两种数量的右边缘对不齐。
 */
function drawCount(ctx: CanvasRenderingContext2D, font: GlyphFont, count: number): void {
  const text = String(count)
  const x = 16 - textWidth(font, text)
  // @constraint 阴影不是纯黑：游戏里是原色的 1/4 亮度（0xFFFFFF → 0x3F3F3F）。
  //      用纯黑会让 16px 格子里的两个数字挤成一团，看不清是 64 还是 84。
  drawText(ctx, font, text, x + 1, 9, '#3f3f3f')
  drawText(ctx, font, text, x, 8, '#ffffff')
}
