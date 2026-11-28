/**
 * 背景墙：用方块纹理拼一张壁纸。
 *
 * @why 这是"造图"而不是"查素材"，所以不复用素材页的虚拟滚动那一套：整张图是
 *      一次性画进 canvas 的，块数最多几千，直接 for 循环最快。
 * @constraint 纹理必须 `imageSmoothingEnabled = false` 放大。方块纹理是 16×16 的
 *      像素图，开了平滑就变成一团模糊的色块，一眼就看出不是游戏里的贴图。
 */

export interface WallRatio {
  id: string
  label: string
  w: number
  h: number
}

export const RATIOS: WallRatio[] = [
  { id: '16:9', label: '16 : 9', w: 16, h: 9 },
  { id: '9:16', label: '9 : 16', w: 9, h: 16 },
  { id: '1:1', label: '1 : 1', w: 1, h: 1 },
  { id: '4:3', label: '4 : 3', w: 4, h: 3 },
  { id: '3:4', label: '3 : 4', w: 3, h: 4 },
  { id: '21:9', label: '21 : 9', w: 21, h: 9 },
  { id: '2:3', label: '2 : 3', w: 2, h: 3 },
]

/** 长边像素。短边按比例算 */
export const SIZES = [1080, 1440, 2160, 2880]

/**
 * 可选纹理。
 *
 * @why 全部选"整格不透明"的方块。带镂空的（草、花、玻璃）铺满整面墙会露出
 *      底下的画布，出现一片片空洞，看起来像图没画完。
 */
export const WALL_TEXTURES: { id: string; zh: string }[] = [
  { id: 'block/stone', zh: '石头' },
  { id: 'block/cobblestone', zh: '圆石' },
  { id: 'block/deepslate_tiles', zh: '深板岩砖' },
  { id: 'block/polished_deepslate', zh: '磨制深板岩' },
  { id: 'block/oak_planks', zh: '橡木' },
  { id: 'block/spruce_planks', zh: '云杉木' },
  { id: 'block/dark_oak_planks', zh: '深色橡木' },
  { id: 'block/bricks', zh: '红砖' },
  { id: 'block/stone_bricks', zh: '石砖' },
  { id: 'block/mossy_stone_bricks', zh: '苔石砖' },
  { id: 'block/sandstone', zh: '砂岩' },
  { id: 'block/prismarine_bricks', zh: '海晶石砖' },
  { id: 'block/quartz_block_side', zh: '石英' },
  { id: 'block/white_concrete', zh: '白混凝土' },
  { id: 'block/gray_concrete', zh: '灰混凝土' },
  { id: 'block/black_concrete', zh: '黑混凝土' },
  { id: 'block/terracotta', zh: '陶瓦' },
  { id: 'block/nether_bricks', zh: '下界砖' },
  { id: 'block/end_stone_bricks', zh: '末地石砖' },
  { id: 'block/gold_block', zh: '金块' },
  { id: 'block/iron_block', zh: '铁块' },
  { id: 'block/copper_block', zh: '铜块' },
  { id: 'block/diamond_block', zh: '钻石块' },
  { id: 'block/emerald_block', zh: '绿宝石块' },
]

/** 预设：一键换风格 */
export const WALL_PRESETS: {
  id: string
  zh: string
  hint: string
  textures: string[]
  tint?: string
}[] = [
  {
    id: 'ruins',
    zh: '废弃城堡',
    hint: '石头 + 苔石砖，做暗色背景很稳',
    textures: ['block/stone', 'block/cobblestone', 'block/mossy_stone_bricks', 'block/stone_bricks'],
  },
  {
    id: 'nether',
    zh: '下界要塞',
    hint: '暗红砖面，配红色标题很出效果',
    textures: ['block/nether_bricks', 'block/black_concrete', 'block/polished_deepslate'],
    tint: '#ff7a5c',
  },
  {
    id: 'wood',
    zh: '木屋',
    hint: '木板拼出的暖色墙',
    textures: ['block/oak_planks', 'block/spruce_planks', 'block/dark_oak_planks'],
  },
  {
    id: 'toon',
    zh: '糖果色',
    hint: '高饱和混凝土，适合做活动图',
    textures: ['block/white_concrete', 'block/gray_concrete', 'block/gold_block', 'block/emerald_block'],
  },
  {
    id: 'deep',
    zh: '深井',
    hint: '几乎全黑，只在暗处有细节',
    textures: ['block/black_concrete', 'block/polished_deepslate', 'block/deepslate_tiles'],
  },
]

export interface WallOptions {
  /** 输出宽高（像素） */
  width: number
  height: number
  /** 每格边长（像素）。越小格子越密 */
  cell: number
  /** 参与随机的纹理 id */
  textures: string[]
  /** 随机 90° 旋转 */
  rotate: boolean
  /** 随机镜像 */
  mirror: boolean
  /** 亮度抖动 0..0.3 */
  jitter: number
  /** 单色叠加，null 表示保留原色 */
  tint: string | null
  /** 暗角 0..0.9 */
  vignette: number
  /** 砖缝宽度（像素），0 表示不留缝 */
  gap: number
  /** 错缝砌筑：奇数行整体右移半格 */
  bond: boolean
  /** 随机种子，同一个种子结果一样 */
  seed: number
}

/** mulberry32：小而够用的确定性随机 */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const images = new Map<string, Promise<HTMLImageElement | null>>()

function loadImage(url: string): Promise<HTMLImageElement | null> {
  const hit = images.get(url)
  if (hit) return hit
  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
  images.set(url, task)
  return task
}

/** 亮度变体缓存：每张纹理预生成几档明暗，绘制时直接挑一张画 */
const variants = new Map<string, HTMLCanvasElement[]>()

const LEVELS = [-0.22, -0.11, 0, 0.11, 0.22]

function variantsOf(url: string, image: HTMLImageElement): HTMLCanvasElement[] {
  const hit = variants.get(url)
  if (hit) return hit
  const made = LEVELS.map((delta) => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth || 16
    canvas.height = image.naturalHeight || 16
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(image, 0, 0)
      if (delta !== 0) {
        ctx.globalCompositeOperation = 'source-atop'
        ctx.fillStyle = delta > 0 ? `rgba(255,255,255,${delta})` : `rgba(0,0,0,${-delta})`
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    }
    return canvas
  })
  variants.set(url, made)
  return made
}

export interface WallResult {
  cols: number
  rows: number
  /** 实际参与铺贴的纹理数（加载失败的会被跳过） */
  used: number
}

/**
 * 把一面墙画进 canvas。
 *
 * @constraint 会重设 canvas 的 width/height，等于清空画布；调用方不要先画别的东西。
 */
export async function renderWall(
  canvas: HTMLCanvasElement,
  options: WallOptions,
  textureSrc: (id: string) => string,
): Promise<WallResult> {
  const { width, height, cell } = options
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return { cols: 0, rows: 0, used: 0 }

  const ids = options.textures.length > 0 ? options.textures : ['block/stone']
  const loaded = await Promise.all(
    ids.map(async (id) => {
      const url = textureSrc(id)
      const image = await loadImage(url)
      return image ? { id, url, image } : null
    }),
  )
  const pools = loaded.filter((item): item is { id: string; url: string; image: HTMLImageElement } => item !== null)
  if (pools.length === 0) return { cols: 0, rows: 0, used: 0 }

  const stacks = pools.map((item) => variantsOf(item.url, item.image))
  const cols = Math.ceil(width / cell)
  const rows = Math.ceil(height / cell)
  const rand = random(options.seed || 1)

  ctx.imageSmoothingEnabled = false
  for (let row = 0; row < rows; row += 1) {
    /**
     * @why 错缝：整面墙每行都对齐的话，竖缝会连成一条条贯穿线，看起来像网格
     *      而不是砌起来的墙。奇数行右移半格之后，竖缝被错开，砖墙的观感立刻出来。
     */
    const shift = options.bond && row % 2 === 1 ? cell / 2 : 0
    // @constraint 错缝行要从 -1 开始补一列：右移半格后最左边会空出半格，
    //      不补就是一条贯穿上下的黑边
    for (let col = -1; col <= cols; col += 1) {
      const index = Math.floor(rand() * stacks.length)
      const stack = stacks[index]!
      // 抖动按"档"算：0.11 是一档，最多上下各两档
      const spread = options.jitter / 0.11
      const levelIndex = options.jitter > 0
        ? Math.max(0, Math.min(LEVELS.length - 1, 2 + Math.round((rand() - 0.5) * 2 * spread)))
        : 2
      const level = stack[levelIndex]!
      const x = col * cell + shift
      const y = row * cell
      const turn = options.rotate ? Math.floor(rand() * 4) : 0
      const flip = options.mirror && rand() < 0.5

      if (turn === 0 && !flip) {
        ctx.drawImage(level, x, y, cell, cell)
        continue
      }
      ctx.save()
      ctx.translate(x + cell / 2, y + cell / 2)
      if (turn !== 0) ctx.rotate((turn * Math.PI) / 2)
      if (flip) ctx.scale(-1, 1)
      ctx.drawImage(level, -cell / 2, -cell / 2, cell, cell)
      ctx.restore()
    }
  }

  /**
   * 砖缝。
   * @why 不留缝时，相邻两格的纹理直接拼在一起，看起来是一张噪点图；
   *      压一圈暗边之后每一格才有"一块砖"的边界，整面墙立刻有砌筑感。
   * @constraint 用半透明黑而不是纯黑：纯黑在高光材质（金块、铁块）上会像网格线。
   */
  if (options.gap > 0) {
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.32)'
    ctx.lineWidth = options.gap
    for (let row = 0; row <= rows; row += 1) {
      const y = row * cell
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(width, y)
      ctx.stroke()
    }
    for (let row = 0; row < rows; row += 1) {
      const shift = options.bond && row % 2 === 1 ? cell / 2 : 0
      for (let col = 0; col <= cols; col += 1) {
        const x = col * cell + shift
        ctx.beginPath()
        ctx.moveTo(x, row * cell)
        ctx.lineTo(x, (row + 1) * cell)
        ctx.stroke()
      }
    }
  }

  if (options.tint) {
    /**
     * @why 用 `color` 混合而不是直接盖一层半透明色：直接盖会把整面墙压成同一个
     *      色阶，砖缝、木纹全糊掉。`color` 只换色相、保留明度，纹理还在。
     */
    ctx.globalCompositeOperation = 'color'
    ctx.fillStyle = options.tint
    ctx.fillRect(0, 0, width, height)
    ctx.globalCompositeOperation = 'source-over'
  }

  if (options.vignette > 0) {
    const gradient = ctx.createRadialGradient(
      width / 2, height * 0.46, Math.min(width, height) * 0.16,
      width / 2, height * 0.5, Math.max(width, height) * 0.72,
    )
    gradient.addColorStop(0, 'rgba(0,0,0,0)')
    gradient.addColorStop(1, `rgba(0,0,0,${Math.min(0.92, options.vignette)})`)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, width, height)
  }

  return { cols, rows, used: pools.length }
}

/** 按长边和比例算实际像素尺寸 */
export function sizeOf(longEdge: number, ratio: WallRatio): { width: number; height: number } {
  if (ratio.w >= ratio.h) {
    return { width: longEdge, height: Math.round((longEdge * ratio.h) / ratio.w) }
  }
  return { width: Math.round((longEdge * ratio.w) / ratio.h), height: longEdge }
}
