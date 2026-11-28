/**
 * 结构预览的 CPU 兜底光栅化。
 *
 * @why 结构页此前只有 GPU 路径：`hasWebGl()` 为假时直接显示一句"浏览器不支持"，
 *      画布永远空白。用户看到的「3D 崩了」有一半是这种情况——禁用了硬件加速、
 *      远程桌面、虚拟机、企业策略都会关掉 WebGL。结构是**一次性静态预览**，
 *      不像实时场景那样要求每帧 60fps，用画家算法填几千个三角形完全够用。
 *
 * @constraint 顶点格式必须与 `BLOCK_LAYOUT` 一致（stride 32：位置 3×f32、
 *      颜色 4×u8、UV0 2×f32、UV2 2×f32）。改了布局这里要跟着改，否则读出来
 *      的位置是乱的——表现为"三角形糊成一坨"，而且不报错。
 *
 * @constraint 贴图必须逐像素做仿射插值，不能只采第一个顶点。之前整面填一个
 *      颜色，结构里的草地、砖墙、木板全成了纯色积木，看起来像"低模预览"。
 *      三角形的 uv 在屏幕空间是线性的，重心坐标插值就是精确解，没有误差。
 */

import { apply3, rotationXYZ } from '../camera/projection'
import { textureSrc } from '@/lib/mc'
import { loadTexel } from '@/lib/texel'
import type { TexelSource } from '@/lib/raster'
import type { VoxelBatch } from './mesher'

const STRIDE = 32
const RAD = Math.PI / 180
/** 低于这个 alpha 的纹素当成透明（与地形着色器的 ALPHA_CUTOUT 一致） */
const ALPHA_CUTOFF = 0.1

export interface VoxelCamera {
  /** 画布边长（物理像素） */
  size: number
  rotX: number
  rotY: number
  zoom: number
  /** 相机空间跨度，与 GPU 侧同源 */
  span: number
  pivot: [number, number, number]
  /** 取景比例，默认按 `auto`（0.84），与 `camera/projection.ts` 保持一致 */
  fraction?: number
}

export interface CpuPaintResult {
  triangles: number
  /** 成功取到贴图色的三角形数，用来判断是"画了"还是"画成了纯色积木" */
  textured: number
}

/**
 * 补上相邻三角形之间的 1 像素缝。
 *
 * @why 画家算法逐三角形填充，两个共边的三角形在公共边上都会把像素判成"外部"
 *      （重心坐标在边界处是 ±1e-9 的浮点噪声），于是每两个面之间漏一条 1px 的
 *      透明缝。单独一个面只有 8 像素宽时，这条缝占笔画的八分之一——整幅字看
 *      起来像"网格线拼的空心字"，而这跟几何、跟光照都没关系。
 * @constraint 只补「四邻里有 ≥2 个不透明」的洞。放宽到 1 个会把字的外轮廓也
 *      吞掉一圈，字会变胖、描边消失；放宽到"只要有邻居"就等于对整张图做膨胀。
 * @constraint 必须读快照写原图。边补边读会让同一条缝沿着扫描方向一路蔓延，
 *      最后把背景也填成实心。
 */
function sealSeams(out: Uint8ClampedArray, width: number, height: number): void {
  const src = new Uint8ClampedArray(out)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      if (src[i + 3]! !== 0) continue
      let count = 0
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      const take = (x2: number, y2: number) => {
        if (x2 < 0 || y2 < 0 || x2 >= width || y2 >= height) return
        const j = (y2 * width + x2) * 4
        if (src[j + 3]! === 0) return
        count += 1
        r += src[j]!
        g += src[j + 1]!
        b += src[j + 2]!
        a += src[j + 3]!
      }
      take(x - 1, y)
      take(x + 1, y)
      take(x, y - 1)
      take(x, y + 1)
      if (count < 2) continue
      out[i] = r / count
      out[i + 1] = g / count
      out[i + 2] = b / count
      out[i + 3] = a / count
    }
  }
}

/** 一个待填充的屏幕空间三角形 */
interface Sprite {
  /** 画家算法排序用的相机空间深度（越小越远） */
  z: number
  x0: number
  y0: number
  x1: number
  y1: number
  x2: number
  y2: number
  /** 三个顶点的 uv */
  u0: number
  v0: number
  u1: number
  v1: number
  u2: number
  v2: number
  /** 顶点色（已含方向亮度） */
  r: number
  g: number
  b: number
  texel: TexelSource | null
  /** 贴图带中间 alpha，需要与已有像素混合 */
  blend: boolean
}

/**
 * 把体素批直接画进 2D 画布。
 *
 * @side-effect 会清空并覆盖 `canvas` 的当前内容。
 */
export async function paintVoxelsCpu(
  canvas: HTMLCanvasElement,
  batches: VoxelBatch[],
  camera: VoxelCamera,
  version: string,
): Promise<CpuPaintResult> {
  const ctx = canvas.getContext('2d')
  if (!ctx) return { triangles: 0, textured: 0 }

  const size = camera.size
  const pxPerUnit = (size * (camera.fraction ?? 0.84) * camera.zoom) / camera.span
  const half = size / 2
  const rot = rotationXYZ(camera.rotX * RAD, camera.rotY * RAD, 0)
  const [px, py, pz] = camera.pivot

  // 贴图先全部取到手：画家算法要求逐三角形知道颜色，中途 await 会打乱顺序
  /**
   * @why 贴图不一定来自素材目录。立体字的纯色/渐变材质用一张 1×1 的
   *      data URL 当底，颜色全在顶点色里；这里如果无脑套 `textureSrc`，
   *      拼出来的地址是 `/mc/26.3/textures/data:image/png...png`，
   *      取不到图 → 整块字退化成没有贴图的兜底色。
   */
  const texels = await Promise.all(
    batches.map((batch) => {
      const url = batch.texture.startsWith('data:') ? batch.texture : textureSrc(version, batch.texture)
      return loadTexel(url).catch(() => null)
    }),
  )

  const items: Sprite[] = []
  let textured = 0

  for (let b = 0; b < batches.length; b += 1) {
    const batch = batches[b]!
    const texel = texels[b]
    const view = new DataView(batch.data.buffer, batch.data.byteOffset, batch.data.byteLength)
    const triangleCount = Math.floor(batch.vertexCount / 3)

    for (let t = 0; t < triangleCount; t += 1) {
      const o0 = t * 3 * STRIDE
      const o1 = o0 + STRIDE
      const o2 = o1 + STRIDE

      const ax = view.getFloat32(o0, true) - px
      const ay = view.getFloat32(o0 + 4, true) - py
      const az = view.getFloat32(o0 + 8, true) - pz
      const bx = view.getFloat32(o1, true) - px
      const by = view.getFloat32(o1 + 4, true) - py
      const bz = view.getFloat32(o1 + 8, true) - pz
      const cx = view.getFloat32(o2, true) - px
      const cy = view.getFloat32(o2 + 4, true) - py
      const cz = view.getFloat32(o2 + 8, true) - pz

      const va = apply3(rot, [ax, ay, az])
      const vb = apply3(rot, [bx, by, bz])
      const vc = apply3(rot, [cx, cy, cz])

      const x0 = half + va[0] * pxPerUnit
      const y0 = half - va[1] * pxPerUnit
      const x1 = half + vb[0] * pxPerUnit
      const y1 = half - vb[1] * pxPerUnit
      const x2 = half + vc[0] * pxPerUnit
      const y2 = half - vc[1] * pxPerUnit

      if (Math.max(x0, x1, x2) < 0 || Math.min(x0, x1, x2) > size) continue
      if (Math.max(y0, y1, y2) < 0 || Math.min(y0, y1, y2) > size) continue

      // 退化成一条线的三角形（侧面被压扁）没有填充面积，跳过省像素循环
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
      if (Math.abs(area) < 1e-6) continue

      // 顶点色已含方向亮度（mesher 里算好的），贴图色再乘上去
      if (texel) textured += 1
      items.push({
        z: (va[2] + vb[2] + vc[2]) / 3,
        x0,
        y0,
        x1,
        y1,
        x2,
        y2,
        u0: view.getFloat32(o0 + 16, true),
        v0: view.getFloat32(o0 + 20, true),
        u1: view.getFloat32(o1 + 16, true),
        v1: view.getFloat32(o1 + 20, true),
        u2: view.getFloat32(o2 + 16, true),
        v2: view.getFloat32(o2 + 20, true),
        r: view.getUint8(o0 + 12),
        g: view.getUint8(o0 + 13),
        b: view.getUint8(o0 + 14),
        texel: texel ?? null,
        blend: batch.translucent,
      })
    }
  }

  // 画家算法：相机空间 z 越小越远（相机朝 -Z 看），先画远的
  items.sort((a, b) => a.z - b.z)

  const image = ctx.createImageData(size, size)
  const out = image.data
  const width = size
  const height = size

  for (const tri of items) {
    drawTriangle(out, width, height, tri)
  }

  sealSeams(out, width, height)
  ctx.putImageData(image, 0, 0)
  return { triangles: items.length, textured }
}

/**
 * 填充一个三角形：重心坐标插值 uv，逐像素采样贴图。
 *
 * @constraint 混合必须按 over 公式写回目标像素的 alpha，不能直接写 255。
 *      结构画布本身是透明的，半透明的水叠在不透明地形上要得到"半透明的地形色"，
 *      叠在空白处要保留 alpha 让页面背景透出来——写死 255 会让水面变成一块实心色。
 */
function drawTriangle(
  out: Uint8ClampedArray,
  width: number,
  height: number,
  tri: Sprite,
): void {
  const minX = Math.max(0, Math.floor(Math.min(tri.x0, tri.x1, tri.x2)))
  const maxX = Math.min(width - 1, Math.ceil(Math.max(tri.x0, tri.x1, tri.x2)))
  const minY = Math.max(0, Math.floor(Math.min(tri.y0, tri.y1, tri.y2)))
  const maxY = Math.min(height - 1, Math.ceil(Math.max(tri.y0, tri.y1, tri.y2)))
  if (minX > maxX || minY > maxY) return

  const area = (tri.x1 - tri.x0) * (tri.y2 - tri.y0) - (tri.x2 - tri.x0) * (tri.y1 - tri.y0)
  if (Math.abs(area) < 1e-6) return
  const inv = 1 / area
  /**
   * @constraint 绕向必须先归一化。
   *      重心坐标的符号跟着三角形绕向走：顺时针三角形的 w0/w1 全是负的，
   *      下面的 `w0 < 0 → continue` 会把**整面**丢掉。方块六个面的绕向在
   *      网格里并不统一（mesher 按面的法线方向生成），所以同一个方块会有
   *      一半的面被静默跳过——表现就是"字只剩描边、中间透明"。
   */
  const flip = area < 0
  const texel = tri.texel
  const data = texel?.data
  const tw = texel?.width ?? 0
  const th = texel?.height ?? 0

  for (let y = minY; y <= maxY; y += 1) {
    const py = y + 0.5
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5
      // 重心坐标：w0 对应 (x1,y1)、(x2,y2) 那条边，其余同理
      const raw0 = ((tri.x1 - px) * (tri.y2 - py) - (tri.x2 - px) * (tri.y1 - py)) * inv
      const raw1 = ((tri.x2 - px) * (tri.y0 - py) - (tri.x0 - px) * (tri.y2 - py)) * inv
      const w0 = flip ? -raw0 : raw0
      const w1 = flip ? -raw1 : raw1
      const w2 = 1 - w0 - w1
      if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue

      let r = tri.r
      let g = tri.g
      let b = tri.b
      let a = 255

      if (data && tw > 0 && th > 0) {
        const u = w0 * tri.u0 + w1 * tri.u1 + w2 * tri.u2
        const v = w0 * tri.v0 + w1 * tri.v1 + w2 * tri.v2
        const tx = Math.min(tw - 1, Math.max(0, Math.floor(u * tw)))
        const ty = Math.min(th - 1, Math.max(0, Math.floor(v * th)))
        const o = (ty * tw + tx) * 4
        const ta = data[o + 3]! / 255
        if (ta < ALPHA_CUTOFF) continue
        r = (r * data[o]!) / 255
        g = (g * data[o + 1]!) / 255
        b = (b * data[o + 2]!) / 255
        a = data[o + 3]!
      }

      const index = (y * width + x) * 4
      if (tri.blend) {
        const sa = a / 255
        const da = out[index + 3]! / 255
        const oa = sa + da * (1 - sa)
        if (oa <= 0) continue
        out[index] = (r * sa + out[index]! * da * (1 - sa)) / oa
        out[index + 1] = (g * sa + out[index + 1]! * da * (1 - sa)) / oa
        out[index + 2] = (b * sa + out[index + 2]! * da * (1 - sa)) / oa
        out[index + 3] = oa * 255
      } else {
        out[index] = r
        out[index + 1] = g
        out[index + 2] = b
        out[index + 3] = a
      }
    }
  }
}
