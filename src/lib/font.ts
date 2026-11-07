import { textureSrc } from './mc'

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

export interface GlyphFont {
  version: string
  image: HTMLImageElement
  /** U+0000..U+00FF 的 advance，其余字符按 '?' 处理 */
  advances: Uint8Array
  /** 按颜色缓存整张染色图集，避免逐字做合成 */
  tinted: Map<string, HTMLCanvasElement>
}

const fonts = new Map<string, Promise<GlyphFont | null>>()

export function loadFont(version: string): Promise<GlyphFont | null> {
  const hit = fonts.get(version)
  if (hit) return hit
  const task = (async () => {
    const image = await loadImage(textureSrc(version, 'font/ascii'))
    if (!image) return null
    return { version, image, advances: measureAdvances(image), tinted: new Map() }
  })()
  fonts.set(version, task)
  return task
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

export function textWidth(font: GlyphFont, text: string): number {
  let width = 0
  for (const ch of text) width += font.advances[ch.codePointAt(0) ?? 63] ?? 9
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
    // @constraint 超出行范围的字符（中文、符号）画成 '?'：图集里没有就不瞎画
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
  const width = textWidth(font, text)
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
