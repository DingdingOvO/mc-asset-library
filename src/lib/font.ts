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
  /**
   * 点阵里第一个 / 最后一个非空列（0..15）。
   *
   * @why 原版 `UnihexProvider.Glyph` 上传的是 `unpackBitsToBytes(contents, left, right)`
   *      —— **裁过边的**位图，宽 right-left+1，再按 oversample 2 变成屏幕上的
   *      (right-left+1)/2 列。不裁边直接把整幅 16 列压成 8 列会有两个后果：
   *      字被横向拉宽 16/(right-left+1) 倍，且 advance 比实际占位小，
   *      相邻两个字互相咬进去——满屏汉字就看成一坨黑。
   */
  left: number
  right: number
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
    // 同 containers.json：不带版本号会被缓存钉住，改完字形还是旧的
    const response = await fetch(`${MC_BASE}/${version}/font-zh.json?v=${__BUILD_ID__}`)
    if (!response.ok) return table
    const data = (await response.json()) as {
      glyphs?: Record<string, { b?: string; a?: number; l?: number; r?: number }>
    }
    for (const [code, glyph] of Object.entries(data.glyphs ?? {})) {
      if (!glyph.b) continue
      table.set(Number(code), {
        bits: glyph.b,
        advance: glyph.a ?? 9,
        left: glyph.l ?? 0,
        right: glyph.r ?? 15,
      })
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
 * 单个中文字的位图，**保持点阵原分辨率**（span × 16）。
 *
 * @why 缩放交给 `drawImage` 在设备像素空间里做，这里绝不预先降采样。
 *      UnihexProvider 的 oversample=2 不是"把 16×16 压成 8×8"——图集里存的
 *      是完整 16×16，绘制时按 1/2 的 GUI 尺寸贴，GPU 采样落在屏幕像素上。
 *      GUI scale 2、DPR 2 时一个汉字正好占 32 个设备像素，16 个点阵列完美
 *      1:2 落位；提前压成 8×8 再放大，等于先丢一半笔画再插值，笔画必然粘连。
 *
 * @constraint 输出必须是原始 span 宽，不能顺手裁。裁掉任何一列都会让
 *      `drawImage` 的源宽与 GUI 目标宽比例失衡，字被横向拉斜。
 */
function zhTile(font: GlyphFont, code: number, color: string): HTMLCanvasElement | null {
  const glyph = font.zh.get(code)
  if (!glyph) return null
  const key = `${code}|${color}`
  const hit = font.zhTiles.get(key)
  if (hit) return hit

  const rows: number[] = []
  for (let row = 0; row < 16; row += 1) rows.push(parseInt(glyph.bits.slice(row * 4, row * 4 + 4), 16))
  const span = glyph.right - glyph.left + 1
  if (span <= 0) return null

  const canvas = document.createElement('canvas')
  canvas.width = span
  canvas.height = 16
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const image = ctx.createImageData(span, 16)
  const rgb = parseColor(color)

  for (let y = 0; y < 16; y += 1) {
    const bits = rows[y] ?? 0
    for (let x = 0; x < span; x += 1) {
      const col = glyph.left + x
      if (col > 15) break
      if (((bits >> (15 - col)) & 1) === 0) continue
      const index = (y * span + x) * 4
      image.data[index] = rgb[0]
      image.data[index + 1] = rgb[1]
      image.data[index + 2] = rgb[2]
      image.data[index + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
  font.zhTiles.set(key, canvas)
  return canvas
}

/**
 * 汉字在位图原分辨率下占的 GUI 宽度。
 * @constraint 必须与 advance 同源（advance = floor(span/2) + 1），
 *      少算半格两个字的笔画会咬在一起，多算半格中间会开一道缝。
 */
function zhGuiWidth(glyph: ZhGlyph): number {
  return Math.max(1, Math.round((glyph.right - glyph.left + 1) / 2))
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
 *
 * @param shadow 原版 text 默认带投影，颜色是原色的 1/4 亮度。信标那种
 *        浅底浅字的标题全靠投影才分得清笔画，所以默认关、需要时开。
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  font: GlyphFont,
  text: string,
  x: number,
  y: number,
  color = '#404040',
  shadow = false,
): void {
  if (shadow) {
    const [r, g, b] = parseColor(color)
    const dark = `#${[r, g, b].map((v) => Math.floor(v / 4).toString(16).padStart(2, '0')).join('')}`
    drawText(ctx, font, text, x + 1, y + 1, dark, false)
  }
  const sheet = atlas(font, color)
  const cellW = font.image.naturalWidth / GRID
  const cellH = font.image.naturalHeight / GRID
  let cursor = x
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    if (code >= 256) {
      const tile = zhTile(font, code, color)
      if (tile) {
        const glyph = font.zh.get(code)!
        const guiW = zhGuiWidth(glyph)
        // @constraint 目标高必须是 CELL(8) 而不是 16：点阵占 8 个 GUI 像素，
        //      与 ascii.png 的 8px 字高对齐，汉字和数字才在同一基线上。
        //      缩放在这里发生，落在设备像素上是 8×ratio，ratio=2 时正好 1:1。
        ctx.drawImage(tile, cursor, y, guiW, CELL)
        cursor += glyph.advance
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
