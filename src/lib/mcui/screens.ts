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
): void {
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(background, 0, 0, MAP_GUI.width, MAP_GUI.height)

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
