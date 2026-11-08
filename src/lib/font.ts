import { MC_BASE, textureSrc } from './mc'

/**
 * Minecraft 位图字体（ascii.png）的排版与绘制。
 *
 * @why 容器标题、物品堆叠数字在游戏里都走这套字体：8×8 的字形图集、逐字
 *      硬件对齐。用系统字体会在 3 倍放大下糊成一团，一眼就不像截图。
 *
 * @constraint advance 必须是「字形最右侧非透明像素列 + 1」，这不是拍脑袋：
 *      BitmapProvider.Glyph 的 advance = int(0.5 + actualGlyphWidth * pixelScale) + 1，
 *      actualGlyphWidth 又是从右往左扫出的第一个非透明列。少了这一步，'i' 会占
 *      和 'w' 一样的宽度，整行文字松垮得不像话。
 */

const GRID = 16
const CELL = 8

/**
 * 一个中文字形。
 *
 * @why 中文不在 ascii.png 里：原版走 unihex provider，点阵是 16×16 的十六进制
 *      位图，绘制时按 oversample=2 缩到 8px 高。advance 由 UnihexProvider.Glyph
 *      算出：width()/2 + 1，width 是左右各裁掉全透明列之后的宽度。
 */
interface ZhGlyph {
  /** 16 行 × 4 个 hex 字符 = 32 位十六进制串 */
  bits: string
  advance: number
}

export interface GlyphFont {
  version: string
  image: HTMLImageElement
  /** U+0000..U+00FF 的 advance，其余字符按 '?' 处理 */
  advances: Uint8Array
  /** 按颜色缓存整张染色图集，避免逐字做合成 */
  tinted: Map<string, HTMLCanvasElement>
  /** 中文字形，键是码点；没有说明是没抽到的字 */
  zh: Map<number, ZhGlyph>
  /** 单个中文字的染色位图，键是 `码点|颜色` */
  zhTiles: Map<string, HTMLCanvasElement>
}

const fonts = new Map<string, Promise<GlyphFont | null>>()

export function loadFont(version: string): Promise<GlyphFont | null> {
  const hit = fonts.get(version)
  if (hit) return hit
  const task = (async () => {
    const [image, zh] = await Promise.all([loadImage(textureSrc(version, 'font/ascii')), loadZh(version)])
    if (!image) return null
    return { version, image, advances: measureAdvances(image), tinted: new Map(), zh, zhTiles: new Map() }
  })()
  fonts.set(version, task)
  return task
}

/**
 * 读取中文点阵子集。
 * @constraint 失败必须静默降级为空表：缺字时标题会退化成 '?'，但整个界面
 *             不能因为一个可选字体文件挂掉而白屏。
 */
async function loadZh(version: string): Promise<Map<number, ZhGlyph>> {
  const table = new Map<number, ZhGlyph>()
  try {
    const response = await fetch(`${MC_BASE}/${version}/font-zh.json`)
    if (!response.ok) return table
    const data = (await response.json()) as {
      glyphs?: Record<string, { b?: string; a?: number }>
    }
    for (const [code, glyph] of Object.entries(data.glyphs ?? {})) {
      if (!glyph.b) continue
      table.set(Number(code), { bits: glyph.b, advance: glyph.a ?? 9 })
    }
  } catch {
    // 网络抖动不影响拉丁字形可用
  }
  return table
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = src
  })
}

function measureAdvances(image: HTMLImageElement): Uint8Array {
  const advances = new Uint8Array(256).fill(CELL + 1)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return advances
  ctx.drawImage(image, 0, 0)
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const cellW = Math.floor(width / GRID)
  const cellH = Math.floor(height / GRID)

  for (let code = 0; code < 256; code += 1) {
    const cellX = (code % GRID) * cellW
    const cellY = Math.floor(code / GRID) * cellH
    let actual = cellW
    // 从右往左找第一个有像素的列，与 getActualGlyphWidth 同序
    outer: for (let x = cellW - 1; x >= 0; x -= 1) {
      for (let y = 0; y < cellH; y += 1) {
        const alpha = data[((cellY + y) * width + (cellX + x)) * 4 + 3]
        if (alpha !== 0) {
          actual = x + 1
          break outer
        }
      }
      actual = 0
    }
    advances[code] = actual + 1
  }
  // @constraint 空格在 ascii.png 里是全透明的，逐格扫描会算出 advance=1，
  //      于是 "Large Chest" 渲染成 "LargeChest"。真实宽度来自 font/include/space.json
  //      的 space provider：{" ": 4}。
  advances[32] = 4
  return advances
}

function atlas(font: GlyphFont, color: string): HTMLCanvasElement {
  const hit = font.tinted.get(color)
  if (hit) return hit
  const canvas = document.createElement('canvas')
  canvas.width = font.image.naturalWidth
  canvas.height = font.image.naturalHeight
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(font.image, 0, 0)
  // ascii.png 是白色字形 + alpha，用 source-in 一把染成目标色
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  font.tinted.set(color, canvas)
  return canvas
}

/**
 * 单个中文字的位图。
 *
 * @why 每个字单独缓存而不是拼大图集：容器标题一共十来个字，按需生成比维护
 *      一张需要动态扩容的图集便宜得多，而且颜色只有两三种。
 */
function zhTile(font: GlyphFont, code: number, color: string): HTMLCanvasElement | null {
  const glyph = font.zh.get(code)
  if (!glyph) return null
  const key = `${code}|${color}`
  const hit = font.zhTiles.get(key)
  if (hit) return hit

  // @constraint 必须在这里把 16×16 合并成 8×8，不能交给 drawImage 缩放：
  //      最近邻会丢掉一半像素，汉字笔画碎成孤立点（实测"箱子"完全认不出）；
  //      双线性又会糊成灰块。2×2 里任意一点亮就算亮，是唯一能保住笔画的降采样，
  //      相当于把笔画加粗半像素，正好抵消原版 unifont 在小字号下的细笔画。
  const canvas = document.createElement('canvas')
  canvas.width = CELL
  canvas.height = CELL
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const image = ctx.createImageData(CELL, CELL)
  const rgb = parseColor(color)
  const rows: number[] = []
  for (let row = 0; row < 16; row += 1) rows.push(parseInt(glyph.bits.slice(row * 4, row * 4 + 4), 16))
  for (let y = 0; y < CELL; y += 1) {
    for (let x = 0; x < CELL; x += 1) {
      let on = 0
      for (let dy = 0; dy < 2; dy += 1) {
        const bits = rows[y * 2 + dy] ?? 0
        for (let dx = 0; dx < 2; dx += 1) {
          if ((bits >> (15 - (x * 2 + dx))) & 1) on += 1
        }
      }
      if (on > 0) {
        const index = (y * CELL + x) * 4
        image.data[index] = rgb[0]
        image.data[index + 1] = rgb[1]
        image.data[index + 2] = rgb[2]
        image.data[index + 3] = 255
      }
    }
  }
  ctx.putImageData(image, 0, 0)
  font.zhTiles.set(key, canvas)
  return canvas
}

function parseColor(color: string): [number, number, number] {
  const hex = color.replace('#', '')
  if (hex.length !== 6) return [64, 64, 64]
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ]
}

export function textWidth(font: GlyphFont, text: string): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    const zh = font.zh.get(code)
    width += zh ? zh.advance : (font.advances[code] ?? 9)
  }
  return width
}

/**
 * 画一行字。坐标是 GUI 像素，(x, y) 是文字**左上角**，与 GuiGraphics.text 一致。
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  font: GlyphFont,
  text: string,
  x: number,
  y: number,
  color = '#404040',
): void {
  const sheet = atlas(font, color)
  const cellW = font.image.naturalWidth / GRID
  const cellH = font.image.naturalHeight / GRID
  let cursor = x
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    if (code >= 256) {
      const tile = zhTile(font, code, color)
      if (tile) {
        // 点阵已在 zhTile 里合并成 8×8，这里 1:1 贴上去，与原版 8px 字高一致
        ctx.drawImage(tile, cursor, y)
        cursor += font.zh.get(code)?.advance ?? 9
        continue
      }
    }
    // @constraint 图集里没有的字符画成 '?'：宁可见到问号，也不要悄悄吞掉
    const slot = code < 256 ? code : 63
    const sx = (slot % GRID) * cellW
    const sy = Math.floor(slot / GRID) * cellH
    ctx.drawImage(sheet, sx, sy, cellW, cellH, cursor, y, cellW, cellH)
    cursor += font.advances[slot] ?? CELL + 1
  }
}

/**
 * 把一行字画成独立位图，供 HTML 层叠在容器面板上。
 * @why 面板背景是 canvas，标题用另一个 canvas 叠上去，缩放交给外层 transform，
 *      这样和背景共享同一套 GUI 像素坐标，不需要再算一遍比例。
 */
export function renderLine(
  font: GlyphFont,
  text: string,
  color: string,
): HTMLCanvasElement | null {
  if (!text) return null
  const width = Math.ceil(textWidth(font, text))
  if (width <= 0) return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = CELL
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  drawText(ctx, font, text, 0, 0, color)
  return canvas
}
