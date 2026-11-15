/**
 * 结构预览的 CPU 兜底光栅化。
 *
 * @why 结构页此前只有 GPU 路径：`hasWebGl()` 为假时直接显示一句"浏览器不支持"，
 *      画布永远空白。用户看到的「3D 崩了」有一半是这种情况——禁用了硬件加速、
 *      远程桌面、虚拟机、企业策略都会关掉 WebGL。结构是**一次性静态预览**，
 *      不像实时场景那样要求每帧 60fps，用画家算法填几千个三角形完全够用，
 *      一帧一两百毫秒，切换结构时才重画一次。
 *
 * @constraint 顶点格式必须与 `BLOCK_LAYOUT` 一致（stride 32：位置 3×f32、
 *      颜色 4×u8、UV0 2×f32、UV2 2×f32）。改了布局这里要跟着改，否则读出来
 *      的位置是乱的——表现为"三角形糊成一坨"，而且不报错。
 */

import { apply3, rotationXYZ } from '../camera/projection'
import { textureSrc } from '@/lib/mc'
import { loadTexel } from '@/lib/texel'
import type { TexelSource } from '@/lib/raster'
import type { VoxelBatch } from './mesher'

const STRIDE = 32
const RAD = Math.PI / 180

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

interface Paintable {
  z: number
  x0: number
  y0: number
  x1: number
  y1: number
  x2: number
  y2: number
  fill: string
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
  const texels = await Promise.all(
    batches.map((batch) => loadTexel(textureSrc(version, batch.texture)).catch(() => null)),
  )

  const items: Paintable[] = []
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

      // 顶点色已含方向亮度（mesher 里算好的），贴图色再乘上去
      const cr = view.getUint8(o0 + 12)
      const cg = view.getUint8(o0 + 13)
      const cb = view.getUint8(o0 + 14)
      let r = cr
      let g = cg
      let bl = cb
      if (texel) {
        const sampled = sampleTexel(texel, view.getFloat32(o0 + 16, true), view.getFloat32(o0 + 20, true))
        if (sampled) {
          if (sampled[3] < 128) continue
          r = (r * sampled[0]) / 255
          g = (g * sampled[1]) / 255
          bl = (bl * sampled[2]) / 255
          textured += 1
        }
      }

      items.push({
        z: (va[2] + vb[2] + vc[2]) / 3,
        x0,
        y0,
        x1,
        y1,
        x2,
        y2,
        fill: `rgb(${r | 0},${g | 0},${bl | 0})`,
      })
    }
  }

  // 画家算法：相机空间 z 越小越远（相机朝 -Z 看），先画远的
  items.sort((a, b) => a.z - b.z)

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (const tri of items) {
    ctx.beginPath()
    ctx.moveTo(tri.x0, tri.y0)
    ctx.lineTo(tri.x1, tri.y1)
    ctx.lineTo(tri.x2, tri.y2)
    ctx.closePath()
    ctx.fillStyle = tri.fill
    ctx.fill()
  }

  return { triangles: items.length, textured }
}

/** 按归一化 UV 取最近的纹素；贴图是 16×16 像素风，最近邻才对 */
function sampleTexel(texel: TexelSource, u: number, v: number): [number, number, number, number] | null {
  const x = Math.min(texel.width - 1, Math.max(0, Math.floor(u * texel.width)))
  const y = Math.min(texel.height - 1, Math.max(0, Math.floor(v * texel.height)))
  const i = (y * texel.width + x) * 4
  const data = texel.data
  if (i + 3 >= data.length) return null
  return [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!]
}
