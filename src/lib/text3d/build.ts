/**
 * 字形场 → 挤出几何。
 *
 * @why 这一层只做「几何」，不碰渲染和 UI。预览走 `paintVoxelsCpu`，导出走
 *      `exportStructureSolid`，两条路径吃的都是 `VoxelBatch[]` —— 和结构页、
 *      地形页同一套。这样立体字不需要自己的渲染器，也不会出现"预览和导出长得
 *      不一样"。
 *
 * @why 输入从"二值点阵"换成了"高分辨率覆盖率场"。点阵只能给出整数格轮廓，
 *      斜笔画必然是一串 90° 台阶；场里取 0.5 等值线能得到浮点顶点，台阶被
 *      插值抹成斜边。参考实现（EaseCation/cube-3d-text，MIT）用的是字体轮廓，
 *      观感上的"干净"主要来自这一条，而不是它的 Three.js 材质。
 *
 * @constraint 描边必须从**场**里做减法（外扩区域 ∩ 非字区域）再取轮廓，
 *      不能用"外轮廓环 + 字形环当洞"。汉字有十几个互不相邻的笔画，
 *      把所有笔画环塞进同一个 `holes` 数组后 earcut 会丢掉一部分，
 *      那块区域整片填成描边色——字面上到处是黑斑。
 */
import { VertexWriter, BLOCK_LAYOUT } from '@/render/core/buffer'
import type { VoxelBatch } from '@/render/world/mesher'
import { extrudeShape } from './extrude'
import { groupRings, type Shape2D } from './outline'
import { SUPERSAMPLE, distanceField, traceField, type Field } from './field'
import { hexToRgb, shadeRgb, whiteTexture, type MaterialPreset } from './material'

/** 与结构页保持一致的贴图透明度判定 */
const OPAQUE = { cutout: false, translucent: false } as const

export interface Text3DOptions {
  /** 挤出厚度（格） */
  depth: number
  /** 描边宽度（格），0 表示不描边 */
  outline: number
  /** 材质预设 */
  material: MaterialPreset
  /** 轮廓简化容差（格）。越大越平滑、三角形越少，字会略瘦 */
  tolerance?: number
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
 * 场里"离墨不超过 radius 格、且本身不是墨"的部分。
 *
 * @why 用距离变换而不是逐像素圆形核膨胀：后者在斜笔画上会把描边撑出方角，
 *      参考实现里描边是等宽的。距离场取 `距离 ≤ r` 就是标准的圆角外扩。
 * @constraint radius 要换算成超采样像素（乘以 SUPERSAMPLE），否则描边细成一根线。
 */
function bandOf(field: Field, radius: number): Field {
  const dist = distanceField(field)
  const limit = radius * SUPERSAMPLE
  const alpha = new Float32Array(field.alpha.length)
  for (let i = 0; i < alpha.length; i += 1) {
    alpha[i] = dist[i]! <= limit && field.alpha[i]! < 0.5 ? 1 : 0
  }
  return { width: field.width, height: field.height, alpha }
}

function extrudeAll(
  shapes: Shape2D[],
  style: Parameters<typeof extrudeShape>[2],
  texture: string,
): VoxelBatch | null {
  if (shapes.length === 0) return null
  const writer = new VertexWriter(BLOCK_LAYOUT, 8192)
  for (const shape of shapes) extrudeShape(writer, shape, style)
  return { texture, data: writer.data(), vertexCount: writer.count, ...OPAQUE }
}

export function buildTextGeometry(source: Field, options: Text3DOptions): Text3DGeometry {
  /**
   * @constraint 这里不能再 trim。描边要靠场四周的空白算距离变换，调用方
   *      已经按描边半径补过一圈；在这里裁掉等于把那一圈又削回去，字的
   *      左右两侧会变成一条直线——描边缺边、字被"切平"。
   */
  const field = source
  const width = field.width / SUPERSAMPLE
  const height = field.height / SUPERSAMPLE
  const material = options.material
  const tolerance = options.tolerance ?? 0.06
  const outline = Math.max(0, options.outline)
  const depth = Math.max(0.4, options.depth)

  /** 有贴图就用方块纹理，没有就用 1×1 纯白——颜色全交给顶点色 */
  const texture = material.texture ?? whiteTexture()
  const face = hexToRgb(material.face)
  const top = material.top ? hexToRgb(material.top) : undefined
  const side = hexToRgb(material.side)
  const back = hexToRgb(material.back)
  const outlineRgb = hexToRgb(material.outline)

  const batches: VoxelBatch[] = []

  const body = groupRings(traceField(field, 0.5, tolerance))
  const bodyBatch = extrudeAll(body, {
    z0: 0,
    z1: depth,
    uScale: width,
    vScale: height,
    flipY: height,
    offsetX: 0,
    face,
    top,
    side,
    back,
    gradient: height,
  }, texture)
  if (bodyBatch) batches.push(bodyBatch)

  if (outline > 0) {
    /**
     * @constraint 描边在 z 上比字多出 `outline`，两侧各一圈——参考实现的
     *      `depth: height + outlineWidth * 2` 就是这个意思。齐平的话从侧面看
     *      黑边只是一条线，字像浮在外面。
     */
    const band = groupRings(traceField(bandOf(field, outline), 0.5, tolerance))
    const bandBatch = extrudeAll(band, {
      z0: -outline * 0.4,
      z1: depth + outline * 0.4,
      uScale: width,
      vScale: height,
      flipY: height,
      offsetX: 0,
      face: outlineRgb,
      side: shadeRgb(outlineRgb, 0.84),
      back: shadeRgb(outlineRgb, 0.62),
      gradient: height,
    }, texture)
    if (bandBatch) batches.push(bandBatch)
  }

  const span = Math.max(width, height) * 1.04
  return {
    batches,
    width: width + outline * 2,
    height: height + outline * 2,
    span,
    pivot: [width / 2, height / 2, depth / 2],
    shapes: body.length,
  }
}
