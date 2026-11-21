/**
 * 结构的 3D / 位图导出。
 *
 * @why 结构页之前只能看不能导：预览是 GPU 里的一批交错顶点缓冲，没有任何一条
 *      路径能把它变成文件。做视频的人要的恰恰是「这栋房子拿出去」——放到
 *      Blender 里改、丢进切片软件、或者直接当静帧。
 *
 * @constraint 复用 `lib/export` 的写出器（buildGltf / buildObj / buildStl），
 *      不另写一套。格式清单在注册表里，模型页和结构页拿到的是同一批规则；
 *      分开写的话下次加格式又要改两处，然后两边能力慢慢对不齐。
 */
import type { VoxelBatch } from '@/render/world/mesher'
import {
  asSeparateGltf,
  boundsOf,
  buildGltf,
  packGlb,
  worldGroups,
  type GeoGroup,
  type GltfNode,
} from '../gltf'
import { buildObj, buildStl, textureFile } from '../obj'
import { makeZip, type ZipEntry } from '../zip'
import { textureSrc } from '../mc'
import { slug } from './types'
import { hasWebGl, modelPipeline } from '@/render'
import { paintVoxelsCpu } from '@/render/world/cpuPaint'

/** BLOCK_LAYOUT 的步长：pos f32×3 @0、color u8×4 @12、uv f32×2 @16、light f32×2 @24 */
const STRIDE = 32
const OFFSET_UV = 16

/**
 * 结构导出对象。
 *
 * @why 和 `ModelSubject` 分开而不是硬塞进去：模型有骨骼、有动画、有节点树，
 *      结构只有一整块静态几何 + 一个机位。混成一个类型会让导出面板被迫长出
 *      「时长 / fps」这种对结构毫无意义的字段。
 */
export interface StructureSubject {
  kind: 'structure'
  /** 文件名前缀，用结构 id */
  id: string
  version: string
  /** 已经装配好的顶点批次（贴图分组） */
  batches: VoxelBatch[]
  /** 预览机位，导出静帧复用同一套参数 */
  rotX: number
  rotY: number
  zoom: number
  span: number
  pivot: [number, number, number]
  /** 静帧输出边长（物理像素） */
  size: number
  /** 静帧底色，null 表示透明 */
  backdrop: string | null
}

/**
 * 把交错的顶点缓冲拆成 glTF/OBJ 要的三角形组。
 *
 * @constraint 法线必须现算：BLOCK_LAYOUT 里没有 Normal 字段（方块的六档亮度
 *      烘焙在顶点色里），而 glTF 的材质要有法线才受光。少了它，导出到
 *      Blender 里是一坨没有明暗的平面。
 */
export function structureGroups(batches: VoxelBatch[]): GeoGroup[] {
  const groups: GeoGroup[] = []
  for (const batch of batches) {
    const count = batch.vertexCount
    if (count < 3) continue
    const view = new DataView(batch.data.buffer, batch.data.byteOffset, batch.data.byteLength)
    const positions = new Array<number>(count * 3)
    const uvs = new Array<number>(count * 2)
    const normals = new Array<number>(count * 3)

    for (let i = 0; i < count; i += 1) {
      const at = i * STRIDE
      positions[i * 3] = view.getFloat32(at, true)
      positions[i * 3 + 1] = view.getFloat32(at + 4, true)
      positions[i * 3 + 2] = view.getFloat32(at + 8, true)
      uvs[i * 2] = view.getFloat32(at + OFFSET_UV, true)
      uvs[i * 2 + 1] = view.getFloat32(at + OFFSET_UV + 4, true)
    }

    for (let i = 0; i + 2 < count; i += 3) {
      const ax = positions[i * 3]!
      const ay = positions[i * 3 + 1]!
      const az = positions[i * 3 + 2]!
      const bx = positions[(i + 1) * 3]!
      const by = positions[(i + 1) * 3 + 1]!
      const bz = positions[(i + 1) * 3 + 2]!
      const cx = positions[(i + 2) * 3]!
      const cy = positions[(i + 2) * 3 + 1]!
      const cz = positions[(i + 2) * 3 + 2]!
      const ux = bx - ax
      const uy = by - ay
      const uz = bz - az
      const vx = cx - ax
      const vy = cy - ay
      const vz = cz - az
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const len = Math.hypot(nx, ny, nz) || 1
      for (let k = 0; k < 3; k += 1) {
        normals[(i + k) * 3] = nx / len
        normals[(i + k) * 3 + 1] = ny / len
        normals[(i + k) * 3 + 2] = nz / len
      }
    }

    const indices = new Array<number>(count)
    for (let i = 0; i < count; i += 1) indices[i] = i
    groups.push({ tex: batch.texture, positions, normals, uvs, indices })
  }
  return groups
}

/** 贴图原文，按纹理 id 收成一张表（缺失的跳过，写出器会给白模） */
async function collectTextures(version: string, texes: Iterable<string>): Promise<Map<string, Uint8Array>> {
  const pngs = new Map<string, Uint8Array>()
  const list = [...new Set(texes)]
  await Promise.all(
    list.map(async (tex) => {
      try {
        const response = await fetch(textureSrc(version, tex))
        if (!response.ok) return
        pngs.set(tex, new Uint8Array(await response.arrayBuffer()))
      } catch {
        // 贴图 404 只是这一组没材质，不该让整次导出失败
      }
    }),
  )
  return pngs
}

const enc = new TextEncoder()

/** 根平移：把结构摆到原点、底面贴 y=0（跟模型导出的规则一致） */
function rootOf(nodes: GltfNode[]): [number, number, number] {
  const box = boundsOf(nodes)
  if (!Number.isFinite(box.min[0])) return [0, 0, 0]
  return [-(box.min[0] + box.max[0]) / 2, -box.min[1], -(box.min[2] + box.max[2]) / 2]
}

function shiftMany(groups: GeoGroup[], offset: [number, number, number]): GeoGroup[] {
  return groups.map((group) => {
    const positions = group.positions.slice()
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! + offset[0]
      positions[i + 1] = positions[i + 1]! + offset[1]
      positions[i + 2] = positions[i + 2]! + offset[2]
    }
    return { ...group, positions }
  })
}

export type StructureSolid = 'glb' | 'gltf' | 'obj' | 'stl'

export async function exportStructureSolid(
  subject: StructureSubject,
  solid: StructureSolid,
): Promise<Blob | null> {
  const groups = structureGroups(subject.batches)
  if (groups.length === 0) throw new Error('这个结构没有可导出的几何')
  /**
   * @constraint 文件名必须能当路径用：结构 id 是 `village/plains/houses/...`，
   *      直接写进 OBJ 的 `mtllib` 会让 Blender 去找一个不存在的子目录，
   *      材质静默丢失（模型变白模，贴图还在包里）。
   */
  const base = slug(subject.id) || 'structure'

  const nodes: GltfNode[] = [
    {
      name: base,
      parent: null,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      groups,
    },
  ]
  const root = rootOf(nodes)
  const pngs = await collectTextures(subject.version, groups.map((group) => group.tex))

  if (solid === 'glb') {
    const built = buildGltf(nodes, pngs, { rootTranslation: root })
    return new Blob([packGlb(built) as unknown as BlobPart], { type: 'model/gltf-binary' })
  }

  if (solid === 'gltf') {
    const separate = asSeparateGltf(buildGltf(nodes, pngs, { rootTranslation: root }))
    return makeZip([
      { name: 'model.gltf', data: enc.encode(JSON.stringify(separate.json, null, 2)) },
      { name: 'model.bin', data: separate.bin },
      ...[...pngs].map(([tex, bytes]) => ({ name: textureFile(tex), data: bytes })),
    ])
  }

  const flat = shiftMany(worldGroups(nodes), root)
  if (flat.length === 0) throw new Error('这个结构没有可导出的几何')

  if (solid === 'obj') {
    const obj = buildObj(flat, base)
    const entries: ZipEntry[] = [
      { name: 'model.obj', data: enc.encode(obj.obj) },
      { name: 'model.mtl', data: enc.encode(obj.mtl) },
    ]
    for (const item of obj.textures) {
      const bytes = pngs.get(item.tex)
      if (bytes) entries.push({ name: item.name, data: bytes })
    }
    return makeZip(entries)
  }

  return new Blob([buildStl(flat, base) as unknown as BlobPart], { type: 'model/stl' })
}

/**
 * 静帧：按预览机位重新渲染一张大图。
 *
 * @constraint 不能用屏幕上的 canvas 截图：它是按窗口尺寸和 DPR 分配的，
 *      720 高的小窗里截出来只有 700 多像素，做视频封面不够。这里按传入的
 *      `size` 重新跑一遍渲染。
 */
export async function exportStructureStill(subject: StructureSubject): Promise<Blob | null> {
  const size = Math.max(256, Math.round(subject.size))
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size

  const camera = {
    size,
    rotX: subject.rotX,
    rotY: subject.rotY,
    pivot: subject.pivot,
    fit: 'auto' as const,
    span: subject.span,
    zoom: subject.zoom,
    unitsPerBlock: 1,
  }

  if (hasWebGl()) {
    // @constraint 纹理必须先预热：管线渲染是同步的，贴图还在下载时会画成白模
    await modelPipeline().prepareTextures(
      [...new Set(subject.batches.map((batch) => batch.texture))],
      subject.version,
    )
    modelPipeline().renderWorld(
      canvas,
      `${subject.id}|${subject.batches.reduce((n, batch) => n + batch.vertexCount, 0)}`,
      subject.batches,
      camera,
      subject.version,
    )
  } else {
    const result = await paintVoxelsCpu(canvas, subject.batches, { ...camera, fraction: 0.84 }, subject.version)
    if (result.triangles === 0) return null
  }

  if (!subject.backdrop) {
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
  }

  const out = document.createElement('canvas')
  out.width = size
  out.height = size
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = subject.backdrop
  ctx.fillRect(0, 0, size, size)
  ctx.drawImage(canvas, 0, 0)
  return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'))
}
