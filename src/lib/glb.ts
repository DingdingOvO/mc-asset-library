/**
 * 导出 glTF 二进制（.glb）。
 *
 * @why 选 GLB 而不是 OBJ：贴图直接嵌在文件里，一个文件拖进 Blender、Windows
 *      3D 查看器、Sketchfab 都能直接看，不用再管"贴图路径对不对"。
 *      OBJ 要另外配 MTL 和 PNG，用户得自己拼目录结构。
 *
 * @constraint 用 glTF 2.0 core 的最小集合：只写 POSITION / TEXCOORD_0 / NORMAL
 *      和一张 baseColorTexture，不引扩展，保证任何查看器都能打开。
 */
import type { Face3D } from './scene'

export interface GlbPart {
  faces: Face3D[]
  /** tex 名 → PNG 字节 */
  pngs: Map<string, Uint8Array>
}

const MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

function pad4(size: number): number {
  return (4 - (size % 4)) % 4
}

interface Primitive {
  positions: number[]
  uvs: number[]
  normals: number[]
  indices: number[]
}

/**
 * 把面按纹理分组，每组一个 primitive。
 * @constraint 顶点不共享：相邻面在 MC 模型里本来就各有各的 UV 和法线，
 *      合并顶点反而要处理 UV 冲突，得不偿失。
 */
export function buildGlb(faces: Face3D[], pngs: Map<string, Uint8Array>): Uint8Array {
  const groups = new Map<string, Primitive>()
  for (const face of faces) {
    let group = groups.get(face.tex)
    if (!group) {
      group = { positions: [], uvs: [], normals: [], indices: [] }
      groups.set(face.tex, group)
    }

    const base = group.positions.length / 3
    const ax = [face.pts[3]! - face.pts[0]!, face.pts[4]! - face.pts[1]!, face.pts[5]! - face.pts[2]!]
    const ay = [face.pts[9]! - face.pts[0]!, face.pts[10]! - face.pts[1]!, face.pts[11]! - face.pts[2]!]
    const nx = ax[1]! * ay[2]! - ax[2]! * ay[1]!
    const ny = ax[2]! * ay[0]! - ax[0]! * ay[2]!
    const nz = ax[0]! * ay[1]! - ax[1]! * ay[0]!
    const len = Math.hypot(nx, ny, nz) || 1

    for (let i = 0; i < 4; i += 1) {
      // 1 格 = 16 单位，缩到 1 米
      group.positions.push(face.pts[i * 3]! / 16, face.pts[i * 3 + 1]! / 16, face.pts[i * 3 + 2]! / 16)
      group.uvs.push(face.uv[i * 2]!, face.uv[i * 2 + 1]!)
      group.normals.push(nx / len, ny / len, nz / len)
    }
    group.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }

  const bufferParts: Uint8Array[] = []
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = []
  let cursor = 0

  const pushView = (bytes: Uint8Array, target: number): number => {
    const offset = cursor
    bufferParts.push(bytes)
    cursor += bytes.length
    const padding = pad4(cursor)
    if (padding) {
      bufferParts.push(new Uint8Array(padding))
      cursor += padding
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target })
    return bufferViews.length - 1
  }

  const accessors: Record<string, unknown>[] = []
  const materials: Record<string, unknown>[] = []
  const meshes: Record<string, unknown>[] = []
  const textures: Record<string, unknown>[] = []
  const images: Record<string, unknown>[] = []
  const samplers: Record<string, unknown>[] = [{ magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071 }]

  const primitives: Record<string, unknown>[] = []
  let materialIndex = 0

  for (const [tex, group] of groups) {
    const count = group.positions.length / 3
    const positions = new Float32Array(group.positions)
    const uvs = new Float32Array(group.uvs)
    const normals = new Float32Array(group.normals)

    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i * 3 + axis]!
        if (value < min[axis]!) min[axis] = value
        if (value > max[axis]!) max[axis] = value
      }
    }

    const posView = pushView(new Uint8Array(positions.buffer), 34962)
    const uvView = pushView(new Uint8Array(uvs.buffer), 34962)
    const nrmView = pushView(new Uint8Array(normals.buffer), 34962)

    const compact = count <= 65535
    const indexData = compact ? new Uint16Array(group.indices) : new Uint32Array(group.indices)
    const idxView = pushView(new Uint8Array(indexData.buffer), 34963)

    const posAccessor = accessors.push({
      bufferView: posView,
      componentType: 5126,
      count,
      type: 'VEC3',
      min,
      max,
    }) - 1
    const uvAccessor = accessors.push({ bufferView: uvView, componentType: 5126, count, type: 'VEC2' }) - 1
    const nrmAccessor = accessors.push({ bufferView: nrmView, componentType: 5126, count, type: 'VEC3' }) - 1
    const idxAccessor = accessors.push({
      bufferView: idxView,
      componentType: compact ? 5123 : 5125,
      count: group.indices.length,
      type: 'SCALAR',
    }) - 1

    const png = pngs.get(tex)
    let material = materialIndex
    if (png) {
      const imageView = pushView(png, 0)
      const imageIndex = images.push({ bufferView: imageView, mimeType: 'image/png' }) - 1
      const textureIndex = textures.push({ source: imageIndex, sampler: 0 }) - 1
      material = materials.push({
        pbrMetallicRoughness: {
          baseColorTexture: { index: textureIndex },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        // MC 的实体/方块是 alpha test，不是混合，MASK 才不会出现半透明排序错乱
        alphaMode: 'MASK',
        alphaCutoff: 0.1,
        doubleSided: true,
        name: tex,
      }) - 1
      materialIndex = materials.length
    }

    primitives.push({
      attributes: { POSITION: posAccessor, TEXCOORD_0: uvAccessor, NORMAL: nrmAccessor },
      indices: idxAccessor,
      material,
    })
  }

  meshes.push({ primitives, name: 'model' })

  const bin = new Uint8Array(cursor)
  let at = 0
  for (const part of bufferParts) {
    bin.set(part, at)
    at += part.length
  }

  const json = {
    asset: { version: '2.0', generator: 'mc-assets' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'model' }],
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
    materials,
    images,
    textures,
    samplers,
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonPadding = pad4(jsonBytes.length)
  const binPadding = pad4(bin.length)
  const total = 12 + 8 + jsonBytes.length + jsonPadding + 8 + bin.length + binPadding

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)

  let offset = 12
  view.setUint32(offset, jsonBytes.length + jsonPadding, true)
  view.setUint32(offset + 4, JSON_CHUNK, true)
  out.set(jsonBytes, offset + 8)
  out.fill(0x20, offset + 8 + jsonBytes.length, offset + 8 + jsonBytes.length + jsonPadding)
  offset += 8 + jsonBytes.length + jsonPadding

  view.setUint32(offset, bin.length + binPadding, true)
  view.setUint32(offset + 4, BIN_CHUNK, true)
  out.set(bin, offset + 8)

  return out
}
