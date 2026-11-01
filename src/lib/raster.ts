/**
 * 软件光栅化器：逐像素深度测试。
 *
 * @why 为什么不用 CSS 3D 或画家算法：
 *      CSS 的 preserve-3d 有真深度缓冲，但每个面都是独立合成层，上千面时只有 15fps；
 *      画家算法（按面中心深度排序）在相交面、共面、薄片模型上必然排错——
 *      箱子内壁透出来、蛋糕顶面被侧壁盖住、栅栏穿插，都是它造成的，调参数无用。
 *
 *      这里自己做三角形光栅化 + z-buffer，遮挡关系逐像素判定，
 *      从原理上没有排序问题。全程 Canvas 2D，不碰 WebGL。
 *
 * @constraint 只做正交投影。透视需要做透视校正插值，收益极小（卡片 300px，
 *      物体 16 单位，透视变形肉眼不可辨），成本却高一个数量级。
 */

export interface ScreenVertex {
  /** 屏幕坐标（y 向下）+ 相机空间深度（越大越近）+ 归一化 uv */
  x: number
  y: number
  z: number
  u: number
  v: number
}

export interface RasterFace {
  /** 4 个顶点，从外侧看顺时针，会被拆成两个三角形 */
  verts: [ScreenVertex, ScreenVertex, ScreenVertex, ScreenVertex]
  /** 纹理像素数据 */
  source: TexelSource
  /** 该面的亮度系数 0..1，已含光照与群系着色 */
  light: number
  /** 群系着色乘数（无着色时省略） */
  tint?: [number, number, number]
}

export interface TexelSource {
  data: Uint8ClampedArray
  width: number
  height: number
}

/**
 * @constraint 用低阈值而不是 0.5：树叶靠透明像素镂空（那部分 alpha 是 0），
 *      但冰、玻璃这类整张都是半透明的贴图 alpha 常在 60-180，
 *      阈值取 96 会把它们整块裁掉变成空气。取 24 既能保留镂空，
 *      又不会让半透明方块消失。
 */
const ALPHA_CUTOFF = 24

/** 复用的暂存画布，避免每帧新建 */
let scratch: HTMLCanvasElement | null = null
let scratchCtx: CanvasRenderingContext2D | null = null

/** 复用的像素缓冲：动画每帧都 new 一次 400 万字节会拖垮 GC */
let colorBuf: ImageData | null = null
let depthBuf: Float32Array | null = null

function getBuffers(width: number, height: number, ctx: CanvasRenderingContext2D): { image: ImageData; depth: Float32Array } {
  const total = width * height
  if (!colorBuf || colorBuf.width !== width || colorBuf.height !== height) {
    colorBuf = ctx.createImageData(width, height)
    /**
     * @constraint 必须显式填 -Infinity。Float32Array 新建时是 0，而深度测试写的是
     *      `z <= depth[index]` 就丢弃——缓冲区刚创建（尺寸变化、或第一帧）时，
     *      所有 z ≤ 0 的面会被整个丢掉，画面就是"模型缺了半边"。之前每次换
     *      画布尺寸，第一帧都是残的，正是这个原因。
     */
    depthBuf = new Float32Array(total).fill(-Infinity)
  } else {
    new Uint32Array(colorBuf.data.buffer).fill(0)
    depthBuf!.fill(-Infinity)
  }
  return { image: colorBuf, depth: depthBuf! }
}

function getScratch(width: number, height: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    scratch = document.createElement('canvas')
    scratchCtx = scratch.getContext('2d')
  }
  if (scratch.width !== width || scratch.height !== height) {
    scratch.width = width
    scratch.height = height
  }
  return scratchCtx
}

/**
 * 光栅化一帧。
 *
 * @constraint 内部按 supersample 倍分辨率绘制再缩回去：软件光栅化没有 MSAA，
 *             多边形边缘会是硬阶梯。超采样后做一次双线性缩小，
 *             边缘平滑度和游戏里开抗锯齿的观感一致。
 */
export function rasterize(
  ctx: CanvasRenderingContext2D,
  outWidth: number,
  outHeight: number,
  faces: RasterFace[],
  supersample = 2,
): void {
  const ss = Math.max(1, supersample)
  const width = Math.round(outWidth * ss)
  const height = Math.round(outHeight * ss)
  const { image, depth } = getBuffers(width, height, ctx)
  const out = image.data

  if (ss === 1) {
    for (const face of faces) emitTriangles(face, 1, out, depth, width, height)
    ctx.putImageData(image, 0, 0)
    return
  }

  for (const face of faces) emitTriangles(face, ss, out, depth, width, height)

  // 超采样结果缩回目标尺寸，缩小过程即抗锯齿
  const temp = getScratch(width, height)
  if (!temp) {
    ctx.putImageData(image, 0, 0)
    return
  }
  temp.putImageData(image, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.clearRect(0, 0, outWidth, outHeight)
  ctx.drawImage(scratch!, 0, 0, width, height, 0, 0, outWidth, outHeight)
}

/** 把一个四边形拆成两个三角形，按 ss 放大后绘制 */
function emitTriangles(
  face: RasterFace,
  ss: number,
  out: Uint8ClampedArray,
  depth: Float32Array,
  width: number,
  height: number,
): void {
  const [a, b, c, d] = face.verts
  const scale = (v: ScreenVertex): ScreenVertex =>
    ss === 1 ? v : { x: v.x * ss, y: v.y * ss, z: v.z, u: v.u, v: v.v }
  const p0 = scale(a)
  const p1 = scale(b)
  const p2 = scale(c)
  const p3 = scale(d)

  const maxX = Math.max(p0.x, p1.x, p2.x, p3.x)
  const maxY = Math.max(p0.y, p1.y, p2.y, p3.y)
  const minX = Math.min(p0.x, p1.x, p2.x, p3.x)
  const minY = Math.min(p0.y, p1.y, p2.y, p3.y)
  if (maxX < 0 || maxY < 0 || minX > width || minY > height) return

  drawTriangle([p0, p1, p2], out, depth, width, height, face)
  drawTriangle([p0, p2, p3], out, depth, width, height, face)
}

function drawTriangle(
  tri: [ScreenVertex, ScreenVertex, ScreenVertex],
  out: Uint8ClampedArray,
  depth: Float32Array,
  width: number,
  height: number,
  face: RasterFace,
): void {
  const v0 = tri[0]
  let v1 = tri[1]
  let v2 = tri[2]

  // @constraint 必须把绕序统一成逆时针：重心坐标的分母一旦为负，
  // 内部点的三个权重全是负数，整个三角形会被判定为"外部"而整片消失。
  const signed = (v1.x - v0.x) * (v2.y - v0.y) - (v2.x - v0.x) * (v1.y - v0.y)
  if (signed === 0) return
  if (signed < 0) {
    const swap = v1
    v1 = v2
    v2 = swap
  }
  const inv = 1 / Math.abs(signed)

  let minX = Math.floor(Math.min(v0.x, v1.x, v2.x))
  let maxX = Math.ceil(Math.max(v0.x, v1.x, v2.x))
  let minY = Math.floor(Math.min(v0.y, v1.y, v2.y))
  let maxY = Math.ceil(Math.max(v0.y, v1.y, v2.y))

  if (minX < 0) minX = 0
  if (minY < 0) minY = 0
  if (maxX > width) maxX = width
  if (maxY > height) maxY = height
  if (minX >= maxX || minY >= maxY) return

  const { data: tex, width: tw, height: th } = face.source
  const light = face.light
  const tint = face.tint

  for (let y = minY; y < maxY; y += 1) {
    const py = y + 0.5
    const rowBase = y * width
    for (let x = minX; x < maxX; x += 1) {
      const px = x + 0.5

      const w0 = ((v1.x - px) * (v2.y - py) - (v2.x - px) * (v1.y - py)) * inv
      const w1 = ((v2.x - px) * (v0.y - py) - (v0.x - px) * (v2.y - py)) * inv
      const w2 = 1 - w0 - w1
      // @why 留一点负容差：相邻三角形共享边上的像素，重心坐标会因为浮点误差
      //      落在 -1e-7 这种值上，严格 < 0 判定会把它判成外部，接缝处就露白线
      if (w0 < -0.00002 || w1 < -0.00002 || w2 < -0.00002) continue

      const z = w0 * v0.z + w1 * v1.z + w2 * v2.z
      const index = rowBase + x
      // 正交投影下 z 线性插值即精确；z 越大越靠近相机
      if (z <= depth[index]!) continue

      const u = w0 * v0.u + w1 * v1.u + w2 * v2.u
      const v = w0 * v0.v + w1 * v1.v + w2 * v2.v

      // 最近邻采样：像素风贴图必须保持硬边
      let tx = (u * tw) | 0
      let ty = (v * th) | 0
      if (tx < 0) tx = 0
      else if (tx >= tw) tx = tw - 1
      if (ty < 0) ty = 0
      else if (ty >= th) ty = th - 1

      const to = (ty * tw + tx) * 4
      const alpha = tex[to + 3]!
      if (alpha < ALPHA_CUTOFF) continue

      depth[index] = z

      const o = index * 4
      if (alpha > 250) {
        if (tint) {
          out[o] = tex[to]! * light * tint[0]
          out[o + 1] = tex[to + 1]! * light * tint[1]
          out[o + 2] = tex[to + 2]! * light * tint[2]
        } else {
          out[o] = tex[to]! * light
          out[o + 1] = tex[to + 1]! * light
          out[o + 2] = tex[to + 2]! * light
        }
        out[o + 3] = 255
        continue
      }

      /**
       * @why 半透明像素要做真正的 over 合成，不能当成不透明直接覆盖：
       *      马斑纹、冰、染色玻璃、史莱姆外层都有 alpha 在 70~180 的像素，
       *      按不透明画会变成一片硬白点（斑纹看起来像"雪花噪点"）。
       * @constraint 结果 alpha 用标准 over 公式：a + da·(1-a)。
       *      直接写 255 会让半透明区域的边缘变成实心色块。
       */
      const a = alpha / 255
      const da = out[o + 3]! / 255
      const oa = a + da * (1 - a)
      const unpre = oa > 0 ? 1 / oa : 0
      const sr = (tint ? tex[to]! * tint[0] : tex[to]!) * light
      const sg = (tint ? tex[to + 1]! * tint[1] : tex[to + 1]!) * light
      const sb = (tint ? tex[to + 2]! * tint[2] : tex[to + 2]!) * light
      out[o] = (sr * a + out[o]! * da * (1 - a)) * unpre
      out[o + 1] = (sg * a + out[o + 1]! * da * (1 - a)) * unpre
      out[o + 2] = (sb * a + out[o + 2]! * da * (1 - a)) * unpre
      out[o + 3] = oa * 255
    }
  }
}
