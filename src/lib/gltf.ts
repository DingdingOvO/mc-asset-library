/**
 * glTF 2.0 导出：静态模型 + 真实骨骼动画。
 *
 * @why 之前的 .glb 只导第一帧，导出的是一尊雕像——用户拿到 Blender 里看不见
 *      任何动作，只有视频能看。这里按 ModelPart 树建节点，每帧把 PartPose 的
 *      旋转写成 rotation 通道，导入后是一套可以逐帧搓的骨骼。
 *
 * @constraint 坐标只做两件事：1 格缩到 1 米、y 由向下翻成向上。
 *      y 翻转是一次镜像，绕 x/z 的旋转角要跟着取反（详见 nodeQuat 的注释），
 *      否则整只生物的四肢会朝反方向摆。
 */
import type { Face3D } from './scene'
import type { PartPose, Rig, RigPart } from './entityRig'

/** 一组织合在一起的几何，共用一张贴图 */
export interface GeoGroup {
  tex: string
  positions: number[]
  normals: number[]
  uvs: number[]
  indices: number[]
}

export interface GltfNode {
  name: string
  parent: number | null
  translation: [number, number, number]
  rotation: [number, number, number, number]
  groups: GeoGroup[]
}

export interface GltfTrack {
  node: number
  /** frameCount * 4 */
  rotation: Float32Array | null
  /** frameCount * 3 */
  translation: Float32Array | null
  /** frameCount * 3 */
  scale: Float32Array | null
}

export interface GltfAnimation {
  name: string
  /** 每个采样点的时刻，秒 */
  times: Float32Array
  tracks: GltfTrack[]
}

const UNIT = 1 / 16

/** 四元数乘法（Hamilton），a ⊗ b 表示先 b 后 a 的旋转复合 */
function qmul(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  const [ax, ay, az, aw] = a
  const [bx, by, bz, bw] = b
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ]
}

/**
 * MC 的旋转顺序 Rz·Ry·Rx，转换到 y 向上的空间。
 *
 * @why ModelPart.translateAndRotate 用的是 Rz*Ry*Rx（弧度）；渲染时我们统一把
 *      y 取负翻到屏幕坐标，而 y 翻转等价于共轭 S·R·S（S = diag(1,-1,1)）。
 *      对单轴旋转来说，共轭的结果就是绕 x 和绕 z 的角度取反，绕 y 不变。
 *      不取反的话左腿会跟右腿反着摆，整只生物的四肢是镜像的。
 */
export function nodeQuat(xRot: number, yRot: number, zRot: number): [number, number, number, number] {
  const rx = -xRot / 2
  const ry = yRot / 2
  const rz = -zRot / 2
  const qx: [number, number, number, number] = [Math.sin(rx), 0, 0, Math.cos(rx)]
  const qy: [number, number, number, number] = [0, Math.sin(ry), 0, Math.cos(ry)]
  const qz: [number, number, number, number] = [0, 0, Math.sin(rz), Math.cos(rz)]
  return qmul(qz, qmul(qy, qx))
}

/** 把一个面的 4 个顶点加成两个三角形，法线按面算法线（MC 的面是平的） */
function pushQuad(
  group: GeoGroup,
  points: number[][],
  uv: number[],
): void {
  const base = group.positions.length / 3
  const ax = [points[1]![0]! - points[0]![0]!, points[1]![1]! - points[0]![1]!, points[1]![2]! - points[0]![2]!]
  const ay = [points[3]![0]! - points[0]![0]!, points[3]![1]! - points[0]![1]!, points[3]![2]! - points[0]![2]!]
  let nx = ax[1]! * ay[2]! - ax[2]! * ay[1]!
  let ny = ax[2]! * ay[0]! - ax[0]! * ay[2]!
  let nz = ax[0]! * ay[1]! - ax[1]! * ay[0]!
  const len = Math.hypot(nx, ny, nz) || 1
  nx /= len
  ny /= len
  nz /= len

  for (let i = 0; i < 4; i += 1) {
    group.positions.push(points[i]![0]!, points[i]![1]!, points[i]![2]!)
    group.normals.push(nx, ny, nz)
    group.uvs.push(uv[i * 2] ?? 0, uv[i * 2 + 1] ?? 0)
  }
  group.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
}

/**
 * 方块/物品已经烘焙成世界坐标（y 向上），这里只需要缩放。
 * @param offset 整体平移，用来把 0..16 的方块挪到以原点为中心
 */
export function groupsFromFaces(
  faces: Face3D[],
  offset: [number, number, number] = [0, 0, 0],
): GeoGroup[] {
  const byTex = new Map<string, GeoGroup>()
  for (const face of faces) {
    let group = byTex.get(face.tex)
    if (!group) {
      group = { tex: face.tex, positions: [], normals: [], uvs: [], indices: [] }
      byTex.set(face.tex, group)
    }
    const points: number[][] = []
    for (let i = 0; i < 4; i += 1) {
      points.push([
        (face.pts[i * 3] ?? 0) * UNIT + offset[0],
        (face.pts[i * 3 + 1] ?? 0) * UNIT + offset[1],
        (face.pts[i * 3 + 2] ?? 0) * UNIT + offset[2],
      ])
    }
    pushQuad(group, points, face.uv)
  }
  return [...byTex.values()]
}

/** 实体部件：顶点在部件局部坐标（y 向下），翻成 y 向上后缩放 */
function groupsFromPart(part: RigPart, tex: string): GeoGroup[] {
  const group: GeoGroup = { tex, positions: [], normals: [], uvs: [], indices: [] }
  const local = (i: number): number[] => [
    (part.verts[i * 3] ?? 0) * UNIT,
    -(part.verts[i * 3 + 1] ?? 0) * UNIT,
    (part.verts[i * 3 + 2] ?? 0) * UNIT,
  ]
  for (const face of part.faces) {
    pushQuad(group, [local(face.at), local(face.at + 1), local(face.at + 2), local(face.at + 3)], face.uv)
  }
  return [group]
}

/** 方块的静态节点树：只有一个根节点，几何按贴图拆成多个 primitive */
export function nodesFromFaces(faces: Face3D[], name = 'model'): GltfNode[] {
  return [
    {
      name,
      parent: null,
      translation: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      groups: groupsFromFaces(faces),
    },
  ]
}

/**
 * 实体的节点树：一个 ModelPart 一个节点，父子关系照抄骨骼。
 * @param poses 传进来就按这一帧的姿势摆好（导静态 OBJ / STL 用），
 *              不传则是模型定义里的初始姿势。
 */
export function nodesFromRig(
  rig: Rig,
  texture: string,
  poses?: Map<string, PartPose> | null,
): GltfNode[] {
  const byName = new Map<string, RigPart>()
  for (const part of rig.parts) byName.set(part.name, part)

  /** 与 rigFaces 的可见性判定保持一致：父部件藏了，子部件也一起藏 */
  const visible = (part: RigPart, depth: number, seen: Set<string>): boolean => {
    if (depth > 16 || seen.has(part.name)) return true
    seen.add(part.name)
    const pose = poses?.get(part.name)
    if (pose && !pose.visible) return false
    const parent = part.parent ? byName.get(part.parent) : null
    return parent ? visible(parent, depth + 1, seen) : true
  }

  return rig.parts.map((part) => {
    const pose = poses?.get(part.name)
    return {
      name: part.name,
      parent: part.parent ? (rig.parts.findIndex((item) => item.name === part.parent) ?? null) : null,
      translation: [
        (pose?.x ?? part.pivot[0]) * UNIT,
        -(pose?.y ?? part.pivot[1]) * UNIT,
        (pose?.z ?? part.pivot[2]) * UNIT,
      ],
      rotation: pose
        ? nodeQuat(pose.xRot, pose.yRot, pose.zRot)
        : nodeQuat(part.rot[0], part.rot[1], part.rot[2]),
      // @constraint 不可见的部件不写几何，而不是留一堆藏在别的部件里的面：
      //              GLB 没有可见性通道，导出的静态模型会被这些面"穿"出来
      groups: visible(part, 0, new Set()) ? groupsFromPart(part, texture) : [],
    }
  })
}

/**
 * 逐帧采样骨骼，产出 glTF 的动画通道。
 *
 * @param stretch 时间轴拉伸系数，与视频导出共用：让整数个动作周期铺满时长，
 *                循环播放时首尾才接得上。
 */
export function sampleAnimation(
  rig: Rig,
  pose: (t: number) => Map<string, PartPose>,
  options: { duration: number; fps: number; stretch?: number; name?: string },
): GltfAnimation {
  const stretch = options.stretch ?? 1
  const frames = Math.max(2, Math.round(options.duration * options.fps))
  // 多采一帧：最后一帧的相位要和第一帧重合，动画才是无缝循环
  const count = frames + 1
  const times = new Float32Array(count)
  for (let i = 0; i < count; i += 1) times[i] = (i / frames) * options.duration

  const tracks: GltfTrack[] = rig.parts.map((_part, i) => ({
    node: i,
    rotation: new Float32Array(count * 4),
    translation: new Float32Array(count * 3),
    scale: new Float32Array(count * 3),
  }))
  const index = new Map<string, number>()
  rig.parts.forEach((part, i) => index.set(part.name, i))

  for (let i = 0; i < count; i += 1) {
    const poses = pose(times[i]! * stretch)
    for (const part of rig.parts) {
      const at = index.get(part.name)!
      const track = tracks[at]!
      const pose0 = poses.get(part.name)
      const rot = pose0 ? nodeQuat(pose0.xRot, pose0.yRot, pose0.zRot) : nodeQuat(part.rot[0], part.rot[1], part.rot[2])

      // 相邻关键帧必须在同一半球，否则 LINEAR 插值会绕远路，四肢会甩一圈
      if (i > 0) {
        const p = (i - 1) * 4
        const dot = track.rotation![p]! * rot[0] + track.rotation![p + 1]! * rot[1]
          + track.rotation![p + 2]! * rot[2] + track.rotation![p + 3]! * rot[3]
        if (dot < 0) {
          rot[0] = -rot[0]
          rot[1] = -rot[1]
          rot[2] = -rot[2]
          rot[3] = -rot[3]
        }
      }
      track.rotation!.set(rot, i * 4)

      const px = (pose0?.x ?? part.pivot[0]) * UNIT
      const py = -(pose0?.y ?? part.pivot[1]) * UNIT
      const pz = (pose0?.z ?? part.pivot[2]) * UNIT
      track.translation!.set([px, py, pz], i * 3)

      // glTF 没有可见性通道，缩放到 0 是唯一能让部件"消失"的办法
      const on = pose0 ? pose0.visible : true
      track.scale!.set(on ? [1, 1, 1] : [0, 0, 0], i * 3)
    }
  }

  // 整段都没变的通道直接丢掉：僵尸的 hat 不需要 73 个关键帧
  const changed = (data: Float32Array, stride: number): boolean => {
    for (let i = stride; i < data.length; i += 1) {
      if (Math.abs(data[i]! - data[i % stride]!) > 1e-6) return true
    }
    return false
  }

  const kept = tracks
    .map((track) => ({
      node: track.node,
      rotation: changed(track.rotation!, 4) ? track.rotation : null,
      translation: changed(track.translation!, 3) ? track.translation : null,
      scale: changed(track.scale!, 3) ? track.scale : null,
    }))
    .filter((track) => track.rotation || track.translation || track.scale)

  return { name: options.name ?? 'action', times, tracks: kept }
}

const MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

function pad4(size: number): number {
  return (4 - (size % 4)) % 4
}

function align(bytes: Uint8Array): Uint8Array {
  const padding = pad4(bytes.length)
  if (!padding) return bytes
  const out = new Uint8Array(bytes.length + padding)
  out.set(bytes)
  return out
}

export interface GltfResult {
  json: Record<string, unknown>
  bin: Uint8Array
}

export interface GltfBuildOptions {
  animation?: GltfAnimation | null
  /** 根节点平移：把模型摆到原点、脚底贴 y=0 */
  rootTranslation?: [number, number, number]
}

export function buildGltf(
  nodes: GltfNode[],
  pngs: Map<string, Uint8Array>,
  options: GltfBuildOptions = {},
): GltfResult {
  const animation = options.animation ?? null
  const bufferParts: Uint8Array[] = []
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = []
  const accessors: Record<string, unknown>[] = []
  const materials: Record<string, unknown>[] = []
  const textures: Record<string, unknown>[] = []
  const images: Record<string, unknown>[] = []
  const samplers = [{ magFilter: 9728, minFilter: 9984, wrapS: 33071, wrapT: 33071 }]
  let cursor = 0

  const pushView = (bytes: Uint8Array, target?: number): number => {
    const offset = cursor
    const padded = align(bytes)
    bufferParts.push(padded)
    cursor += padded.length
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.length,
      ...(target ? { target } : {}),
    })
    return bufferViews.length - 1
  }

  const materialCache = new Map<string, number>()
  const materialFor = (tex: string): number | undefined => {
    const hit = materialCache.get(tex)
    if (hit !== undefined) return hit
    const png = pngs.get(tex)
    if (!png) return undefined
    const imageView = pushView(png)
    const imageIndex = images.push({ bufferView: imageView, mimeType: 'image/png' }) - 1
    const textureIndex = textures.push({ source: imageIndex, sampler: 0 }) - 1
    const index = materials.push({
      name: tex,
      pbrMetallicRoughness: {
        baseColorTexture: { index: textureIndex },
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      // MC 是 alpha test 不是混合；MASK 才不会在半透明贴图上排错面序
      alphaMode: 'MASK',
      alphaCutoff: 0.1,
      doubleSided: true,
    }) - 1
    materialCache.set(tex, index)
    return index
  }

  const meshes: Record<string, unknown>[] = []
  const gltfNodes: Record<string, unknown>[] = []

  // 根部统一加一个空节点，导入后可以整只移动/缩放到场景里
  const rootIndex = 0
  gltfNodes.push({
    name: 'root',
    children: [] as number[],
    translation: options.rootTranslation ?? [0, 0, 0],
  })

  for (const node of nodes) {
    if (node.groups.length === 0) continue
    const primitives: Record<string, unknown>[] = []

    for (const group of node.groups) {
      const count = group.positions.length / 3
      if (count === 0) continue
      const positions = new Float32Array(group.positions)
      const normals = new Float32Array(group.normals)
      const uvs = new Float32Array(group.uvs)

      const min = [Infinity, Infinity, Infinity]
      const max = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < count; i += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          const value = positions[i * 3 + axis]!
          if (value < min[axis]!) min[axis] = value
          if (value > max[axis]!) max[axis] = value
        }
      }

      const posView = pushView(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 34962)
      const nrmView = pushView(new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength), 34962)
      const uvView = pushView(new Uint8Array(uvs.buffer, uvs.byteOffset, uvs.byteLength), 34962)

      const compact = count <= 65535
      const indexData = compact ? new Uint16Array(group.indices) : new Uint32Array(group.indices)
      const idxView = pushView(
        new Uint8Array(indexData.buffer, indexData.byteOffset, indexData.byteLength),
        34963,
      )

      const posAccessor = accessors.push({
        bufferView: posView,
        componentType: 5126,
        count,
        type: 'VEC3',
        min,
        max,
      }) - 1
      const nrmAccessor = accessors.push({ bufferView: nrmView, componentType: 5126, count, type: 'VEC3' }) - 1
      const uvAccessor = accessors.push({ bufferView: uvView, componentType: 5126, count, type: 'VEC2' }) - 1
      const idxAccessor = accessors.push({
        bufferView: idxView,
        componentType: compact ? 5123 : 5125,
        count: group.indices.length,
        type: 'SCALAR',
      }) - 1

      primitives.push({
        attributes: { POSITION: posAccessor, NORMAL: nrmAccessor, TEXCOORD_0: uvAccessor },
        indices: idxAccessor,
        material: materialFor(group.tex),
      })
    }

    if (primitives.length === 0) continue
    const meshIndex = meshes.push({ name: node.name, primitives }) - 1

    const index = gltfNodes.push({
      name: node.name,
      mesh: meshIndex,
      translation: node.translation,
      rotation: node.rotation,
    }) - 1

    // 节点下标偏移 1，因为 0 号是 root
    const parent = node.parent === null || node.parent === undefined ? rootIndex : node.parent + 1
    const bucket = gltfNodes[parent] as { children?: number[] }
    bucket.children = [...(bucket.children ?? []), index]
  }

  if (!(gltfNodes[rootIndex] as { children?: number[] }).children?.length) {
    ;(gltfNodes[rootIndex] as { children?: number[] }).children = []
  }

  const animations: Record<string, unknown>[] = []
  if (animation && animation.tracks.length > 0) {
    const timeView = pushView(new Uint8Array(animation.times.buffer, animation.times.byteOffset, animation.times.byteLength))
    const timeAccessor = accessors.push({
      bufferView: timeView,
      componentType: 5126,
      count: animation.times.length,
      type: 'SCALAR',
      min: [animation.times[0] ?? 0],
      max: [animation.times[animation.times.length - 1] ?? 0],
    }) - 1

    const channels: Record<string, unknown>[] = []
    const animSamplers: Record<string, unknown>[] = []

    for (const track of animation.tracks) {
      // 0 号是 root，部件节点整体后移一位
      const target = track.node + 1
      for (const [path, data, type] of [
        ['rotation', track.rotation, 'VEC4'],
        ['translation', track.translation, 'VEC3'],
        ['scale', track.scale, 'VEC3'],
      ] as const) {
        if (!data) continue
        const view = pushView(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        const accessor = accessors.push({
          bufferView: view,
          componentType: 5126,
          count: data.length / (type === 'VEC4' ? 4 : 3),
          type,
        }) - 1
        const sampler = animSamplers.push({ input: timeAccessor, output: accessor, interpolation: 'LINEAR' }) - 1
        channels.push({ sampler, target: { node: target, path } })
      }
    }

    animations.push({ name: animation.name, channels, samplers: animSamplers })
  }

  const binLength = cursor
  const bin = new Uint8Array(binLength)
  let at = 0
  for (const part of bufferParts) {
    bin.set(part, at)
    at += part.length
  }

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'mc-assets' },
    scene: 0,
    scenes: [{ name: 'scene', nodes: [rootIndex] }],
    nodes: gltfNodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
    // @constraint 空数组必须整个删掉：glTF 校验器把 materials: [] 判为
    //              EMPTY_ENTITY 硬错误，贴图没取到时有些加载器会直接打不开
    ...(materials.length > 0 ? { materials } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(textures.length > 0 ? { textures } : {}),
    ...(textures.length > 0 ? { samplers } : {}),
    ...(animations.length > 0 ? { animations } : {}),
  }

  return { json, bin }
}

/**
 * 分离式 glTF：json 里把 buffer 指向外部 .bin。
 * @why 有人要拿 .gltf 去做文本 diff 或者手改 accessor，GLB 是二进制看不懂。
 */
export function asSeparateGltf(result: GltfResult, binName = 'model.bin'): GltfResult {
  const json = JSON.parse(JSON.stringify(result.json)) as {
    buffers: { byteLength: number; uri?: string }[]
  }
  json.buffers[0] = { uri: binName, byteLength: result.bin.length }
  return { json: json as unknown as Record<string, unknown>, bin: result.bin }
}

/** 把 json + bin 打成单文件 GLB 容器 */
export function packGlb(result: GltfResult): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(result.json))
  const jsonPadding = pad4(jsonBytes.length)
  const bin = result.bin
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

/** 四元数转 3×3 旋转矩阵（列主序，3 个一组存行） */
function quatMatrix(q: [number, number, number, number]): number[] {
  const [x, y, z, w] = q
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ]
}

function mulM(a: number[], b: number[]): number[] {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    }
  }
  return out
}

/**
 * 整体包围盒，用来把模型摆到原点、脚底贴地。
 *
 * @why 必须按节点树累积变换，不能只加 translation：狼的头挂在会转的身体上，
 *      只加平移会让包围盒算偏，导出的模型浮在空中或者半个身子埋进地面。
 */
export function boundsOf(nodes: GltfNode[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  const visit = (index: number, parentM: number[], parentT: number[]): void => {
    const node = nodes[index]
    if (!node) return
    const m = mulM(parentM, quatMatrix(node.rotation))
    const t: number[] = [
      parentM[0]! * node.translation[0] + parentM[1]! * node.translation[1] + parentM[2]! * node.translation[2] + parentT[0]!,
      parentM[3]! * node.translation[0] + parentM[4]! * node.translation[1] + parentM[5]! * node.translation[2] + parentT[1]!,
      parentM[6]! * node.translation[0] + parentM[7]! * node.translation[1] + parentM[8]! * node.translation[2] + parentT[2]!,
    ]

    for (const group of node.groups) {
      for (let i = 0; i < group.positions.length; i += 3) {
        const vx = group.positions[i]!
        const vy = group.positions[i + 1]!
        const vz = group.positions[i + 2]!
        const world = [
          m[0]! * vx + m[1]! * vy + m[2]! * vz + t[0]!,
          m[3]! * vx + m[4]! * vy + m[5]! * vz + t[1]!,
          m[6]! * vx + m[7]! * vy + m[8]! * vz + t[2]!,
        ]
        for (let axis = 0; axis < 3; axis += 1) {
          if (world[axis]! < min[axis]!) min[axis] = world[axis]!
          if (world[axis]! > max[axis]!) max[axis] = world[axis]!
        }
      }
    }

    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i]!.parent === index) visit(i, m, t)
    }
  }

  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const origin = [0, 0, 0]
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]!.parent === null) visit(i, identity, origin)
  }
  return { min, max }
}

/**
 * 把整棵节点树摊平成世界坐标的几何。
 *
 * @why OBJ / STL 没有骨骼也没有节点层级，只能导"某一瞬间的雕像"。
 *      摊平是唯一能表达的方式；动画请用 GLB。
 */
export function worldGroups(nodes: GltfNode[]): GeoGroup[] {
  const byTex = new Map<string, GeoGroup>()

  const visit = (index: number, parentM: number[], parentT: number[]): void => {
    const node = nodes[index]
    if (!node) return
    const m = mulM(parentM, quatMatrix(node.rotation))
    const t: number[] = [
      parentM[0]! * node.translation[0] + parentM[1]! * node.translation[1] + parentM[2]! * node.translation[2] + parentT[0]!,
      parentM[3]! * node.translation[0] + parentM[4]! * node.translation[1] + parentM[5]! * node.translation[2] + parentT[1]!,
      parentM[6]! * node.translation[0] + parentM[7]! * node.translation[1] + parentM[8]! * node.translation[2] + parentT[2]!,
    ]

    for (const group of node.groups) {
      let target = byTex.get(group.tex)
      if (!target) {
        target = { tex: group.tex, positions: [], normals: [], uvs: [], indices: [] }
        byTex.set(group.tex, target)
      }
      const base = target.positions.length / 3
      for (let i = 0; i < group.positions.length; i += 3) {
        const vx = group.positions[i]!
        const vy = group.positions[i + 1]!
        const vz = group.positions[i + 2]!
        target.positions.push(
          m[0]! * vx + m[1]! * vy + m[2]! * vz + t[0]!,
          m[3]! * vx + m[4]! * vy + m[5]! * vz + t[1]!,
          m[6]! * vx + m[7]! * vy + m[8]! * vz + t[2]!,
        )
        const nx = group.normals[i]!
        const ny = group.normals[i + 1]!
        const nz = group.normals[i + 2]!
        target.normals.push(
          m[0]! * nx + m[1]! * ny + m[2]! * nz,
          m[3]! * nx + m[4]! * ny + m[5]! * nz,
          m[6]! * nx + m[7]! * ny + m[8]! * nz,
        )
      }
      for (let i = 0; i < group.uvs.length; i += 1) target.uvs.push(group.uvs[i]!)
      for (let i = 0; i < group.indices.length; i += 1) target.indices.push(group.indices[i]! + base)
    }

    for (let i = 0; i < nodes.length; i += 1) {
      if (nodes[i]!.parent === index) visit(i, m, t)
    }
  }

  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  const origin = [0, 0, 0]
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i]!.parent === null) visit(i, identity, origin)
  }
  return [...byTex.values()]
}
