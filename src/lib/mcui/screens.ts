import { drawText, textWidth, type GlyphFont } from '../font'

/**
 * 非容器类界面：告示牌、书与笔、地图。
 *
 * @why `/ui` 之前只有容器工作台（箱子、熔炉、附魔台…），而做视频要的界面远不止
 *      这些：一句话的告示牌、一页手写书、一张插了标记的地图，都是常见画面。
 *      这些界面没有槽位、没有物品，套不进「容器 + 槽位」的数据结构，
 *      所以单独走一条绘制路径——但字体、贴图、整数缩放仍与容器共用同一套。
 *
 * @constraint 所有几何都按 GUI 像素写，由 `mcui/surface` 的缩放矩阵统一放大。
 *      在绘制函数里乘设备像素比，等于把「多少像素画一格」这件事抄了两份。
 */

/** 告示牌板面：24×26 的贴图按 4 倍放（板面 96×48，木柱在下面） */
export const SIGN_BOARD = { texW: 24, texH: 26, scale: 4 } as const
export const SIGN_GUI = {
  width: SIGN_BOARD.texW * SIGN_BOARD.scale,
  height: SIGN_BOARD.texH * SIGN_BOARD.scale,
} as const

/**
 * 书写区。
 *
 * @why 贴图上半部分是木板（24×12 个 texel），下面是木柱。字号保持 8 GUI 像素
 *      不缩小——原版在编辑界面里就是这么排的：板面放大 4 倍，文字仍是标准字高，
 *      四行等距落进板面。
 */
const SIGN_TEXT = { x: SIGN_GUI.width / 2, top: 7, line: 9 } as const

export interface SignSpec {
  /** 四行文本，缺的行留空 */
  lines: string[]
  /** 文字颜色（染料） */
  color: string
  /** 发光字：原版会去掉描边阴影、整体提亮 */
  glow: boolean
}

export function drawSign(ctx: CanvasRenderingContext2D, font: GlyphFont, board: CanvasImageSource, spec: SignSpec): void {
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(board, 0, 0, SIGN_GUI.width, SIGN_GUI.height)

  spec.lines.slice(0, 4).forEach((line, index) => {
    if (!line) return
    const width = textWidth(font, line)
    // 居中落位：原版四行都是水平居中，不是左对齐
    const x = Math.round(SIGN_TEXT.x - width / 2)
    const y = SIGN_TEXT.top + index * SIGN_TEXT.line
    drawText(ctx, font, line, x, y, spec.color, !spec.glow)
  })
}

/** 书与笔：192×192 的一页 */
export const BOOK_GUI = { width: 192, height: 192 } as const
/** 原版 BookEditScreen 的文本区：宽 114，从 (36, 32) 起 */
const BOOK_TEXT = { x: 36, y: 32, width: 114, line: 9 } as const

export interface BookSpec {
  /** 一页的原始文本（换行由排版决定） */
  text: string
  /** 标题/作者只在成书封面上出现，编辑页右上角也显示一次 */
  title?: string
  author?: string
}

/**
 * 按字宽折行。
 *
 * @constraint 必须按**实际字宽**累加，不能按字符数切：中文一个字 9px、英文
 *      `i` 只占 2px，按字数切会让中文页溢出版心、英文页空掉半页。
 */
export function wrapLines(font: GlyphFont, text: string, maxWidth: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const ch of paragraph) {
      const next = line + ch
      if (textWidth(font, next) > maxWidth && line) {
        out.push(line)
        line = ch
      } else {
        line = next
      }
    }
    out.push(line)
  }
  return out
}

export function drawBook(
  ctx: CanvasRenderingContext2D,
  font: GlyphFont,
  page: CanvasImageSource,
  spec: BookSpec,
): void {
  ctx.imageSmoothingEnabled = false
  /**
   * @constraint 必须按 9 参数形式只取左上 192×192：book.png 是 256×256 的图集，
   *      整张画进 192 会把书页缩到 75%，正文区（36..150）就跑到纸外面去了。
   */
  ctx.drawImage(page, 0, 0, BOOK_GUI.width, BOOK_GUI.height, 0, 0, BOOK_GUI.width, BOOK_GUI.height)

  const lines = wrapLines(font, spec.text, BOOK_TEXT.width).slice(0, 13)
  lines.forEach((line, index) => {
    drawText(ctx, font, line, BOOK_TEXT.x, BOOK_TEXT.y + index * BOOK_TEXT.line, '#3b2d1f', false)
  })
}

/** 地图控件：64×64 的底图按 2 倍画，标记 8×8 texel 按 1 倍 */
export const MAP_GUI = { width: 128, height: 128, icon: 8 } as const

/**
 * 地图色板。
 *
 * @why 原版地图每一格是 44 个基色 × 4 档明暗（`MapColor`），共 236 项。全抄过来
 *      是 236 个按钮、四列滚动，找「草地的浅色」要滑半天。这里按基色分组、
 *      每组四档明暗压成一行，取最常见的 14 组 × 4 = 56 色——够画村庄、海、
 *      雪原、矿洞这几种常见构图，色块数量也能在一屏里排完。
 * @constraint 顺序即 `paint` 数组里存的值（值是下标 + 1，0 表示空格）。
 *      改动顺序会让已存的工程文件颜色整体错位，只能在末尾追加。
 */
export const MAP_PALETTE: readonly (readonly [string, string, string, string])[] = [
  ['#8b8b8b', '#7a7a7a', '#6a6a6a', '#585858'], // 石
  ['#7fb238', '#6ea031', '#5c8828', '#4a6f20'], // 草
  ['#c7b299', '#b09e88', '#97876f', '#7a6d59'], // 沙
  ['#736c56', '#645e4b', '#544f3f', '#413d31'], // 泥土
  ['#5a8bd0', '#4f79b4', '#426596', '#355078'], // 水
  ['#3a5a8c', '#324d78', '#2a4063', '#21324d'], // 深海
  ['#e8f4f8', '#d6e6ee', '#bccfd9', '#9fb2bd'], // 雪
  ['#a8c8e8', '#93b2d2', '#7d99b6', '#667e97'], // 冰
  ['#4f7a28', '#446a22', '#39581c', '#2d4616'], // 树叶
  ['#8f7a52', '#7d6a46', '#6b5a3a', '#574a2f'], // 木头
  ['#d8c88a', '#c0b078', '#a59666', '#877a53'], // 干草/路径
  ['#b0b0b0', '#9a9a9a', '#848484', '#6e6e6e'], // 石头建筑
  ['#8899a0', '#76868c', '#647277', '#525e63'], // 砖/瓦
  ['#2b2b2b', '#232323', '#1b1b1b', '#131313'], // 岩浆/黑曜石
] as const

/** 色板下标 → CSS 颜色；0 预留为「空」，从 1 开始 */
export function paletteColor(index: number): string | null {
  if (index <= 0) return null
  const flat = Math.floor((index - 1) / 4)
  const level = (index - 1) % 4
  return MAP_PALETTE[flat]?.[level] ?? null
}

export interface MapMarker {
  /** 贴图名，见 `map/decorations/*` */
  icon: string
  /** GUI 坐标（0..128），原点左上 */
  x: number
  y: number
}

export interface MapSpec {
  markers: MapMarker[]
  /** 0–4：与原版地图缩放等级同一含义，只画刻度提示，不生成地形 */
  scale: number
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  background: CanvasImageSource,
  spec: MapSpec,
  /** 标记贴图，按 `MapMarker.icon` 索引；缺的标记直接跳过而不是画一块底图 */
  icons: Map<string, CanvasImageSource>,
  /**
   * 已光栅化的笔刷层（128×128 的离屏画布），null 表示没画过。
   * @constraint 必须由调用方缓存并只在脏了时重画：每帧遍历 16384 个像素再
   *      putImageData 是纯 CPU 循环，拖动笔刷时会直接掉到个位数帧率。
   */
  paint: CanvasImageSource | null = null,
): void {
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(background, 0, 0, MAP_GUI.width, MAP_GUI.height)
  if (paint) ctx.drawImage(paint, 0, 0, MAP_GUI.width, MAP_GUI.height)

  /**
   * 缩放等级用刻度表达：原版这一档由服务端地图数据决定（一格代表多少方块），
   * 站上没有地形，只能把「倍率」画成角标，让人知道自己在哪一档。
   */
  if (spec.scale > 0) {
    ctx.save()
    ctx.globalAlpha = 0.55
    ctx.fillStyle = '#1a1a1a'
    for (let i = 0; i < spec.scale; i += 1) {
      ctx.fillRect(MAP_GUI.width - 6 - i * 3, 2, 2, 2)
    }
    ctx.restore()
  }

  for (const marker of spec.markers) {
    const image = icons.get(marker.icon)
    if (!image) continue
    const size = MAP_GUI.icon
    ctx.drawImage(image, marker.x - size / 2, marker.y - size / 2, size, size)
  }
}
