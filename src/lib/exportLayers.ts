import { containerTextureSrc, type ContainerDef } from './containers'
import { drawText, loadFont, textWidth, type GlyphFont } from './font'
import { ensureIcon, iconKey, iconUrl } from './itemIcon'
import { paintLabels, paintLayers } from './layerRender'
import { drawTooltip, measureTooltip, type TipLine, type TipSize, type TipSprites } from './mcui/tooltip'
import { tipStyleOf, type ModernUi } from './modern'
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
  /**
   * 所属容器（组名）。
   * @why PSD 里一个容器的十几层要收进同一个组，否则「箱子@0,0 物品 03」
   *      这种平铺列表四十条，找一层要滚半屏。组名由渲染层给出，因为只有它
   *      知道哪些层属于同一个容器。
   */
  group?: string
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

/**
 * 锁定在画布上的悬停提示。
 *
 * @why 提示框本来就是画面的一部分（做视频时「鼠标停在钻石上」是常见镜头），
 *      但它只在指针悬停时存在，一移动就消失，截不到。锁定之后它变成一个
 *      可导出的元素：位置跟着槽位走，随工作区一起存盘。
 */
export interface PinnedTip {
  uid: string
  slot: number
}

/**
 * 现代化 UI 的参数组，定义在 `lib/modern`。
 *
 * @why 这里只做转发：老代码一律 `from '@/lib/exportLayers'` 拿这个类型，
 *      定义搬走之后如果直接删 export，十几处 import 全要改。转发一行比改
 *      十几处安全——那些地方本来也不需要知道定义在哪。
 */
export type { ModernUi }

export interface RenderOptions {
  version: string
  scale: number
  lang: 'zh' | 'en'
  textureOf: (itemId: string) => string | undefined
  pad?: number
  /**
   * 逐格拆层。
   * @why PSD 是给二次编辑用的：「把第三格的钻石换成下界合金」在合并层里要抠图，
   *      逐格一层就是点一下。但逐格层会让 PNG/SVG 的层数从 4 涨到 40，
   *      所以只有 PSD 打开它。
   */
  detail?: boolean
  tips?: PinnedTip[]
  modern?: ModernUi
  /** 物品中文名，画锁定提示时用 */
  nameOf?: (itemId: string) => string
}

export async function renderLayers(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
  options: RenderOptions,
): Promise<LayeredRender | null> {
  const bounds = workspaceBounds(workspace, defs)
  if (!bounds) return null
  const { version, scale, lang, textureOf, detail, modern, tips } = options
  const pad = options.pad ?? 8

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

  if (tips?.length) {
    jobs.push(preloadSprites(version, ['tooltip/background', 'tooltip/frame']))
  }

  const font = await loadFont(version)

  /**
   * 先算锁定提示框的几何。
   *
   * @why 提示框是从格子往右下摊开的，容器贴着画布右边界时它必然伸出去。
   *      以前画布只按容器包围盒算，导出的 PNG 里提示框右边被切掉半截，
   *      用户看到的是「屏幕上完整、导出缺一块」。
   * @constraint 必须在画容器之前算完：提示框可能向左上溢出，那要整体平移
   *      所有图层，画完再补就来不及了。
   */
  const tipStyle = tipStyleOf(modern)
  const tipBoxes: { pin: PinnedTip; gx: number; gy: number; size: TipSize; lines: TipLine[] }[] = []
  if (tips?.length && font) {
    for (const pin of tips) {
      const node = workspace.nodes.find((entry) => entry.uid === pin.uid)
      if (!node) continue
      const def = defs.get(node.container)
      const spot = def?.slots[pin.slot]
      const item = node.items[pin.slot]
      if (!def || !spot || !item) continue
      /**
       * @constraint 三行结构与屏幕上 `McTooltip` 完全一致（主名 / 数量 / id），
       *      否则「屏幕上三行、导出两行」，锁定提示就成了预览。
       */
      const lines: TipLine[] = [{ text: options.nameOf?.(item.id) ?? item.id, color: '#ffffff' }]
      if (item.count > 1) lines.push({ text: String(item.count), color: '#aaaaaa' })
      lines.push({ text: item.id, color: '#aaaaaa' })
      tipBoxes.push({
        pin,
        // 与原版一致：指针右侧 12px、上方 12px，这里从格子右上角往右让 20
        gx: node.x - bounds.x + pad + spot.x + 20,
        gy: node.y - bounds.y + pad + spot.y,
        size: measureTooltip(font, lines, tipStyle),
        lines,
      })
    }
  }

  let width = Math.ceil((bounds.width + pad * 2) * scale)
  let height = Math.ceil((bounds.height + pad * 2) * scale)
  let shiftX = 0
  let shiftY = 0
  for (const box of tipBoxes) {
    shiftX = Math.max(shiftX, Math.ceil(box.size.inset - box.gx))
    shiftY = Math.max(shiftY, Math.ceil(box.size.inset - box.gy))
  }
  for (const box of tipBoxes) {
    width = Math.max(width, Math.ceil((box.gx - box.size.inset + box.size.boxWidth + shiftX) * scale))
    height = Math.max(height, Math.ceil((box.gy - box.size.inset + box.size.boxHeight + shiftY) * scale))
  }

  const layers: RenderLayer[] = []

  for (const node of workspace.nodes) {
    const def = defs.get(node.container)
    if (!def) continue

    const MARGIN = marginOf(scale)
    const left = Math.round((node.x - bounds.x + pad + shiftX) * scale) - MARGIN
    const top = Math.round((node.y - bounds.y + pad + shiftY) * scale) - MARGIN
    const boxW = def.width * scale + MARGIN * 2
    const boxH = def.height * scale + MARGIN * 2

    const prefix = `${def.name}@${node.x},${node.y}`

    // ---- 投影：现代 UI 才有的「离屏幕有距离」那层，必须压在背景下面
    if (modern?.panelShadow) {
      const sh = makeCanvas(boxW, boxH)
      if (sh) {
        const r = (modern.panelRadius ?? 0) * scale
        /**
         * @constraint 用 filter: blur 而不是 shadowBlur：shadowBlur 需要先有一个
         *      实体再把实体挖掉，多一遍合成；filter 直接产出模糊层，且不会在
         *      9-slice 每一块之间留下接缝阴影。
         */
        sh.ctx.filter = `blur(${Math.max(2, Math.round(3 * scale))}px)`
        sh.ctx.fillStyle = 'rgba(0, 0, 0, 0.42)'
        sh.ctx.beginPath()
        sh.ctx.roundRect(MARGIN, MARGIN + 2 * scale, def.width * scale, def.height * scale, r)
        sh.ctx.fill()
        sh.ctx.filter = 'none'
        layers.push({ name: `${prefix} 投影`, canvas: sh.canvas, left, top, group: prefix })
      }
    }

    // ---- 背景
    const bg = makeCanvas(boxW, boxH)
    if (bg) {
      const image = def.texture ? await loadImage(containerTextureSrc(version, def.texture)) : null
      if (image) {
        const radius = (modern?.panelRadius ?? 0) * scale
        if (radius > 0) {
          // @constraint 先 clip 再贴图：裁完再画等于把四角切掉，圆角外的像素不会
          //      留下毛边；反过来先画再擦会带出一条 1 像素的抗锯齿白边。
          bg.ctx.save()
          bg.ctx.beginPath()
          bg.ctx.roundRect(MARGIN, MARGIN, def.width * scale, def.height * scale, radius)
          bg.ctx.clip()
        }
        for (const draw of def.draws) {
          bg.ctx.drawImage(image, draw.u, draw.v, draw.w, draw.h, MARGIN + draw.dx * scale, MARGIN + draw.dy * scale, draw.w * scale, draw.h * scale)
        }
        if (radius > 0) bg.ctx.restore()
      }
      layers.push({ name: `${prefix} 背景`, canvas: bg.canvas, left, top, group: prefix })
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
        layers.push({ name: `${prefix} 状态`, canvas: overlay.canvas, left, top, group: prefix })
      }
    }

    // ---- 物品
    if (detail) {
      /**
       * 逐格一层。
       * @constraint 每层必须裁到格子大小（16×16 GUI），不能给整张画布：
       *      一张 1200×900 的 RGBA 是 4.3MB，二十个物品就是 86MB，PSD 打不开。
       *      数量数字画在格子右下角，本来就不出格，所以 16×16 足够。
       */
      for (const [slot, item] of Object.entries(node.items)) {
        const spot = def.slots[Number(slot)]
        if (!spot) continue
        const url = iconUrl(iconKey(version, item.id, 64))
        if (!url) continue
        const icon = await loadImage(url)
        if (!icon) continue

        const cell = 16 * scale
        const one = makeCanvas(cell, cell)
        if (!one) continue
        one.ctx.drawImage(icon, 0, 0, cell, cell)
        const spotX = left + MARGIN + spot.x * scale
        const spotY = top + MARGIN + spot.y * scale
        layers.push({
          name: `${prefix} 物品 ${String(Number(slot) + 1).padStart(2, '0')}`,
          canvas: one.canvas,
          left: spotX,
          top: spotY,
          group: prefix,
        })

        // 数量单独一层：视频里改数字比改物品频繁（64 → 1 → 16）
        if (item.count > 1 && font) {
          const num = makeCanvas(cell, cell)
          if (num) {
            num.ctx.save()
            num.ctx.scale(scale, scale)
            drawCount(num.ctx, font, item.count)
            num.ctx.restore()
            layers.push({
              name: `${prefix} 数量 ${String(Number(slot) + 1).padStart(2, '0')}`,
              canvas: num.canvas,
              left: spotX,
              top: spotY,
              group: prefix,
            })
          }
        }
      }
    } else if (Object.keys(node.items).length) {
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
        layers.push({ name: `${prefix} 物品`, canvas: wrap.canvas, left, top, group: prefix })
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
        layers.push({ name: `${prefix} 文字`, canvas: text.canvas, left, top, group: prefix })
      }
    }
  }

  /**
   * 锁定的悬停提示。
   * @constraint 必须画在所有容器之后：提示框在游戏里永远在最上层，
   *      压在容器下面等于被容器底板盖住，导出图里看不见。
   */
  if (tipBoxes.length && font) {
    const sprites: TipSprites = {
      background: spriteOf(version, 'tooltip/background') ?? null,
      frame: spriteOf(version, 'tooltip/frame') ?? null,
    }
    const tipLayer = makeCanvas(width, height)
    if (tipLayer) {
      tipLayer.ctx.save()
      // @why 提示框的几何全是 GUI 像素（padding 3 / margin 9），必须和容器
      //      共用同一个缩放矩阵，否则 3 倍画布上的提示框只有三分之一大。
      tipLayer.ctx.scale(scale, scale)
      for (const box of tipBoxes) {
        drawTooltip(tipLayer.ctx, font, box.lines, box.gx + shiftX, box.gy + shiftY, sprites, tipStyle)
      }
      tipLayer.ctx.restore()
      layers.push({ name: '悬停提示', canvas: tipLayer.canvas, left: 0, top: 0 })
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
