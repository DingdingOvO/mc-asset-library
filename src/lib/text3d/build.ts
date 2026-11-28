/**
 * 点阵字 → 挤出几何。
 *
 * @why 这一层只做「几何」，不碰渲染和 UI。预览走 `paintVoxelsCpu`，导出走
 *      `exportStructureSolid`，两条路径吃的都是 `VoxelBatch[]` —— 和结构页、
 *      地形页同一套。这样立体字不需要自己的渲染器，也不会出现"预览和导出长得
 *      不一样"（这正是之前 tooltip 导出被裁掉一块的原因）。
 *
 * @constraint 一个点阵像素 = 一格。字面尺寸就是 mask 尺寸，不做归一化：
 *      归一化会让「厚度 3 格」这种参数在不同长度的文字上表现不同。
 */
import { VertexWriter, BLOCK_LAYOUT } from '@/render/core/buffer'
import type { VoxelBatch } from '@/render/world/mesher'
import { extrudeShape } from './extrude'
import { groupRings, traceMask, type Shape2D } from './outline'

/** 与结构页保持一致的贴图透明度判定 */
const OPAQUE = { cutout: false, translucent: false } as const

export interface Text3DOptions {
  /** 挤出厚度（格） */
  depth: number
  /** 描边宽度（格），0 表示不描边 */
  outline: number
  /** 主体贴图（`block/xxx`） */
  texture: string
  /** 描边贴图 */
  outlineTexture: string
  /** 轮廓简化容差（格）。越大越平滑、三角形越少，字会略瘦 */
  tolerance?: number
  /** 加粗（格）：先膨胀字形再取轮廓，让笔画更厚 */
  bold?: number
}

export interface Text3DGeometry {
  batches: VoxelBatch[]
  /** 字面尺寸（格），含描边留白 */
  width: number
  height: number
  /** 相机跨度 */
  span: number
  pivot: [number, number, number]
  /** 轮廓环数量，用来判断"是不是一个字都没解析出来" */
  shapes: number
}

/**
 * 圆形核膨胀。
 *
 * @why 用圆而不是方形核：方形核在斜笔画上会把描边撑成方块角，放大后能明显看出
 *      「描边是方的、字是圆的」。欧氏距离核在四个角自然收圆，和参考项目里
 *      「沿轮廓外扩」的效果一致。
 * @constraint 超出字面的部分会被直接裁掉，所以调用方必须先给 mask 留出
 *      `ceil(outline)` 的空白边框，否则贴边的笔画描边会缺一条。
 */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const out = new Uint8Array(mask.length)
  const limit = radius * radius
  const reach = Math.ceil(radius)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] !== 1) continue
      for (let dy = -reach; dy <= reach; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -reach; dx <= reach; dx += 1) {
          if (dx * dx + dy * dy > limit) continue
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          out[ny * width + nx] = 1
        }
      }
    }
  }
  return out
}

/** 在四周补空白，给描边留出膨胀空间 */
function pad(mask: Uint8Array, width: number, height: number, edge: number): {
  data: Uint8Array
  width: number
  height: number
} {
  if (edge <= 0) return { data: mask, width, height }
  const w = width + edge * 2
  const h = height + edge * 2
  const data = new Uint8Array(w * h)
  for (let y = 0; y < height; y += 1) {
    data.set(mask.subarray(y * width, (y + 1) * width), (y + edge) * w + edge)
  }
  return { data, width: w, height: h }
}

/**
 * 去掉孤立墨点。
 *
 * @why 二值化之后，笔画边缘会留下一些只和本体角接触的单像素（抗锯齿的余数），
 *      轮廓追踪会把它们单独描一圈。挤出成三维后，每个这样的点都是一个 1×1×深
 *      的立柱，在字边上竖起一根毛刺 —— 放大看像字在"掉渣"。
 * @constraint 只看 8 邻域里少于 2 个墨像素的点。放宽到 4 会开始吃笔画末端的
 *      细尖（"木"字旁那一撇的收笔只剩一格）。
 */
function despeckle(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask)
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (mask[y * width + x] !== 1) continue
      let around = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          around += mask[(y + dy) * width + x + dx]!
        }
      }
      if (around < 2) out[y * width + x] = 0
    }
  }
  return out
}

/**
 * 标出"和字外连通"的背景，返回 1 = 外部。
 *
 * @why 描边不能画进字内的孔里。膨胀是各向同性的：一个 2 格宽的小孔，描边宽
 *      1.2 格时会被从四边糊死，孔里变成一块描边色 —— 在白色字面上就是一个个
 *      红斑（汉字里这种小孔特别多："素"的横之间、"库"的点下面）。
 *      只有和外界连通的背景才算"字的轮廓外"，孔里的背景不描边。
 */
function outsideOf(mask: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(mask.length)
  const stack: number[] = []
  const seed = (x: number, y: number): void => {
    const i = y * width + x
    if (out[i] === 1 || mask[i] === 1) return
    out[i] = 1
    stack.push(i)
  }
  for (let x = 0; x < width; x += 1) {
    seed(x, 0)
    seed(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    seed(0, y)
    seed(width - 1, y)
  }
  while (stack.length > 0) {
    const i = stack.pop()!
    const x = i % width
    const y = (i - x) / width
    if (x > 0) seed(x - 1, y)
    if (x + 1 < width) seed(x + 1, y)
    if (y > 0) seed(x, y - 1)
    if (y + 1 < height) seed(x, y + 1)
  }
  return out
}

export function buildTextGeometry(
  source: { width: number; height: number; data: Uint8Array },
  options: Text3DOptions,
): Text3DGeometry {
  const bold = Math.max(0, options.bold ?? 0)
  const rim = Math.ceil(Math.max(options.outline, bold)) + 1
  const cleaned = despeckle(source.data, source.width, source.height)
  const padded = pad(cleaned, source.width, source.height, rim)
  /**
   * @why 加粗用膨胀而不是给字体加 text-stroke。`strokeText` 的描边是等宽的，
   *      细笔画会被直接糊死（"了"的竖钩只剩一根粗棒）；膨胀是形态学的，
   *      粗笔画只胖一点、细笔画反而长得更多，观感更接近真正的粗体。
   */
  const data = bold > 0 ? dilate(padded.data, padded.width, padded.height, bold) : padded.data
  const { width, height } = padded

  /**
   * @constraint 容差只能取 0.3~0.4 格。0.75 时汉字的窄缝（"素"字里几条横之间
   *      的 1 格间隙）会被一并抹平，轮廓自交，earcut 切出来的面缺一块 ——
   *      字面上随机出现黑斑，那是后面的描边透出来了。
   */
  const tolerance = options.tolerance ?? 0.02

  const scale = Math.max(width, height)
  const style = {
    shade: 1,
    /** 贴图在字面上铺一次：字宽多少格就铺多少格，方块纹理密度和游戏里一致 */
    uScale: scale,
    vScale: scale,
    flipY: height,
    offsetX: 0,
  }

  const batches: VoxelBatch[] = []
  let shapes = 0

  const write = (list: Shape2D[], texture: string, bottom: number, top: number): void => {
    if (list.length === 0) return
    const writer = new VertexWriter(BLOCK_LAYOUT, 8192)
    for (const shape of list) {
      extrudeShape(writer, shape, { ...style, z0: bottom, z1: top })
    }
    shapes += list.length
    batches.push({ texture, data: writer.data(), vertexCount: writer.count, ...OPAQUE })
  }

  const body = groupRings(traceMask(data, width, height, tolerance))
  write(body, options.texture, 0, options.depth)

  if (options.outline > 0) {
    /**
     * @why 描边取**位图差分**（膨胀后减去字形），不是"外轮廓 + 主体的环当洞"。
     *      后者在纸上成立，在 earcut 里不成立：汉字有十几个互不相邻的笔画，
     *      把每个笔画的外环都塞进同一个 `holes` 数组后，earcut 的孔洞消除会
     *      丢掉其中一部分，那部分区域就整块填成描边色 —— 字面上到处是黑斑。
     *      差分图是"已经算好的环带"，trace 出来的内边界就是字形本身，
     *      孔天然是空的。
     */
    const grown = dilate(data, width, height, options.outline)
    const outside = outsideOf(data, width, height)
    const band = new Uint8Array(grown.length)
    for (let i = 0; i < grown.length; i += 1) {
      band[i] = grown[i] === 1 && data[i] !== 1 && outside[i] === 1 ? 1 : 0
    }
    /**
     * @constraint 环带整体比主体低 `sink`。环带内壁和主体外壁在 xy 上重合，
     *      同高度会共面闪烁；降到主体之后，内壁被主体的外壁挡住。
     */
    const sink = Math.min(0.5, options.depth * 0.15)
    write(groupRings(traceMask(band, width, height, tolerance)), options.outlineTexture, -sink, options.depth - sink)
  }

  const span = Math.max(width, height) * 1.1
  return {
    batches,
    width,
    height,
    span,
    pivot: [width / 2, height / 2, options.depth / 2],
    shapes,
  }
}
