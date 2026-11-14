/**
 * 模型（方块 / 生物 / 粒子）的导出目标。
 *
 * @why 这部分逻辑原本整个住在 ExportPanel 组件里：取景框规划、逐帧渲染、
 *      3D 打包、视频编码全塞在一个 591 行的组件中，所以「导出」能力和页面的
 *      UI 状态绑死，别的页面想复用只能复制。抽到这里之后，组件只做两件事：
 *      把用户选好的参数收成一个 ModelSubject，把注册表给的按钮画出来。
 *
 * @constraint 逐帧渲染而不是录屏：录屏受实际帧率影响，机器一卡视频就抖；
 *      逐帧渲染保证每一帧的动画时间戳精确等于 i / fps。
 */
import type { Box, DisplayTransform, Face3D, FrameBounds } from '../scene'
import { drawScene, emptyCameraBox, frameFromBox, measureFaces, pixelScale } from '../scene'
import {
  asSeparateGltf,
  boundsOf,
  buildGltf,
  packGlb,
  worldGroups,
  type GeoGroup,
  type GltfAnimation,
  type GltfNode,
} from '../gltf'
import { buildObj, buildStl, textureFile } from '../obj'
import { makeZip, type ZipEntry } from '../zip'
import { MC_BASE, textureSrc } from '../mc'
import {
  captureApng,
  captureGif,
  captureMp4,
  capturePng,
  captureSequence,
  captureWebp,
  fetchBytes,
  formatMeta,
  supportsMp4,
  type Backdrop,
  type CaptureFormat,
  type CaptureOptions,
} from '../capture'

export type SolidFormat = 'glb' | 'gltf' | 'obj' | 'stl'

/** 导出分辨率：正方形、偶数边长，H.264 与 GIF 都能直接用 */
export const MODEL_SIZES = [480, 640, 800] as const
export const MODEL_RATES = [12, 24, 30] as const
export const MODEL_DURATIONS = [3, 5, 8] as const

const SUPERSAMPLE = 2
/** 采样多少个时刻来定取景框。太少会漏掉动作的最大张开度，腿会顶出画布 */
const PLAN_SAMPLES = 24

export interface ModelSubject {
  kind: 'model'
  id: string
  version: string
  /** 某一时刻的面数据；t 单位是秒 */
  facesAt: (t: number) => Face3D[]
  /** 3D 导出的节点树（t 秒时刻）。null 表示没有可导出的几何 */
  nodesAt: ((t: number) => GltfNode[]) | null
  /** 有骨骼动作时才给：按导出时长采样成 glTF 动画 */
  sampleAnim: ((duration: number, fps: number, stretch: number) => GltfAnimation) | null
  textures: string[]
  sources: { label: string; path: string }[]

  rotX: number
  rotY: number
  zoom: number
  light: number
  motionBlur: number
  outline: number
  fit: 'block' | 'auto'
  display: DisplayTransform | null
  pivot?: [number, number, number]
  shadow: number
  /** 内容本身是否在动。false 时才做转台 */
  animated: boolean
  animKind: 'entity' | 'texture' | 'spin'
  /** 内容自身的循环周期（秒），用于让首尾帧对齐 */
  cycle: number | null

  /** 输出参数 */
  size: number
  fps: number
  duration: number
  backdrop: Backdrop
  solid: SolidFormat
  withAnim: boolean
  onProgress?: (ratio: number) => void
}

interface Plan {
  frame: FrameBounds
  shadowBox: Box
}

/**
 * 时间轴拉伸系数。
 * @constraint 上限 1.5：为了凑整数周期把一个 3 秒片段拉到 4.5 秒，动作会慢成
 *      慢动作，反而更怪。宁可留一点相位不齐——1 帧的接缝比整体慢下来好忍。
 */
export function stretchOf(subject: ModelSubject): number {
  const { cycle, duration } = subject
  if (!cycle || cycle <= 0) return 1
  const cycles = Math.max(1, Math.round(duration / cycle))
  return Math.min(1.5, (cycles * cycle) / duration)
}

/** 转台：整个 duration 正好转一圈，首尾角度相同才能无缝循环 */
function spinAt(subject: ModelSubject, t: number): number {
  return subject.animated ? subject.rotY : subject.rotY + (t / subject.duration) * 360
}

/**
 * 把整段动画的包围盒并集算成一个固定取景框。
 * @why 不锁的话相机跟着模型的动作走：抬腿时画布缩小、落脚时放大，
 *      60fps 下就是持续呼吸；转台时更是每个角度都在横向漂移。
 */
function planFrames(subject: ModelSubject): Plan | null {
  const stretch = stretchOf(subject)
  const cam = emptyCameraBox()
  for (let i = 0; i < PLAN_SAMPLES; i += 1) {
    const t = (subject.duration * i) / PLAN_SAMPLES
    measureFaces(
      subject.facesAt(t * stretch),
      { rotX: subject.rotX, rotY: spinAt(subject, t), display: subject.display, pivot: subject.pivot },
      cam,
    )
  }
  const frame = frameFromBox(cam)
  if (!frame) return null
  const k = pixelScale(subject.size, subject.fit, frame.span)
  const half = subject.size / 2
  return {
    frame,
    shadowBox: {
      x0: half + (cam.minX - frame.cx) * k,
      x1: half + (cam.maxX - frame.cx) * k,
      y0: half - (cam.maxY - frame.cy) * k,
      y1: half - (cam.minY - frame.cy) * k,
    },
  }
}

function draw(subject: ModelSubject, ctx: CanvasRenderingContext2D, t: number, plan: Plan | null): void {
  const stretch = stretchOf(subject)
  drawScene(ctx, {
    faces: subject.facesAt(t * stretch),
    size: subject.size,
    rotX: subject.rotX,
    rotY: spinAt(subject, t),
    zoom: subject.zoom,
    light: subject.light,
    motionBlur: subject.motionBlur,
    outline: subject.outline,
    fit: subject.fit,
    display: subject.display,
    pivot: subject.pivot,
    version: subject.version,
    supersample: SUPERSAMPLE,
    shadow: subject.shadow,
    clear: false,
    // 首帧清掉拖尾历史，否则上次预览的残影会进入第一帧
    resetTrail: t === 0,
    frame: plan?.frame ?? null,
    shadowBox: plan?.shadowBox,
  })
}

function captureOptions(subject: ModelSubject, plan: Plan | null): CaptureOptions {
  return {
    width: subject.size,
    height: subject.size,
    duration: subject.duration,
    fps: subject.fps,
    backdrop: subject.backdrop,
    draw: (ctx, t) => draw(subject, ctx, t, plan),
    onProgress: subject.onProgress,
  }
}

/** 贴图按需加载一次，3D 与打包共用 */
async function collectPngs(version: string, texes: Iterable<string>): Promise<Map<string, Uint8Array>> {
  const pngs = new Map<string, Uint8Array>()
  for (const tex of new Set(texes)) {
    const bytes = await fetchBytes(textureSrc(version, tex))
    if (bytes) pngs.set(tex, bytes)
  }
  return pngs
}

/**
 * 节点树 + 根节点平移。
 * @why 导出的模型要站在原点、脚底贴 y=0：MC 的实体原点在脚底中心，方块原点
 *      在西北下角，直接导出的话方块有一半在地下、实体偏一边。
 */
function solidScene(subject: ModelSubject) {
  const nodes = subject.nodesAt ? subject.nodesAt(0) : []
  if (nodes.length === 0) return null
  const box = boundsOf(nodes)
  if (!Number.isFinite(box.min[0])) return null
  const rootTranslation: [number, number, number] = [
    -(box.min[0] + box.max[0]) / 2,
    -box.min[1],
    -(box.min[2] + box.max[2]) / 2,
  ]
  return { nodes, rootTranslation }
}

/** 摊平之后再把根节点的平移补回去 */
function shift(groups: GeoGroup[], offset: [number, number, number]): GeoGroup[] {
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

const enc = new TextEncoder()

export async function exportSolid(subject: ModelSubject): Promise<Blob | null> {
  const scene = solidScene(subject)
  if (!scene) throw new Error('这个模型没有可导出的几何')

  const texes = new Set<string>()
  for (const node of scene.nodes) for (const group of node.groups) texes.add(group.tex)
  const pngs = await collectPngs(subject.version, texes)

  const canAnimate = Boolean(subject.sampleAnim) && (subject.solid === 'glb' || subject.solid === 'gltf')
  const animation =
    subject.sampleAnim && subject.withAnim && canAnimate
      ? subject.sampleAnim(subject.duration, subject.fps, stretchOf(subject))
      : null

  if (subject.solid === 'glb' || subject.solid === 'gltf') {
    const built = buildGltf(scene.nodes, pngs, { animation, rootTranslation: scene.rootTranslation })
    if (subject.solid === 'glb') {
      return new Blob([packGlb(built) as unknown as BlobPart], { type: 'model/gltf-binary' })
    }
    const separate = asSeparateGltf(built)
    return makeZip([
      { name: 'model.gltf', data: enc.encode(JSON.stringify(separate.json, null, 2)) },
      { name: 'model.bin', data: separate.bin },
    ])
  }

  // OBJ / STL 是摊平的世界几何，先把根节点平移补偿上
  const groups = shift(worldGroups(scene.nodes), scene.rootTranslation)
  if (groups.length === 0) throw new Error('这个模型没有可导出的几何')

  if (subject.solid === 'obj') {
    const obj = buildObj(groups, subject.id)
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

  return new Blob([buildStl(groups, subject.id) as unknown as BlobPart], { type: 'model/stl' })
}

export async function exportAnimation(subject: ModelSubject, format: CaptureFormat): Promise<Blob | null> {
  const options = captureOptions(subject, planFrames(subject))
  if (format === 'mp4') return captureMp4(options)
  if (format === 'webp') return captureWebp(options)
  if (format === 'apng') return captureApng(options)
  if (format === 'gif') return captureGif(options)
  return captureSequence(options)
}

export async function exportStill(subject: ModelSubject): Promise<Blob | null> {
  return capturePng(captureOptions(subject, planFrames(subject)), 0.6)
}

export async function exportTextures(subject: ModelSubject): Promise<Blob | null> {
  if (subject.textures.length <= 1) {
    const bytes = await fetchBytes(textureSrc(subject.version, subject.textures[0] ?? ''))
    if (!bytes) throw new Error('贴图获取失败')
    return new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
  }
  const entries: ZipEntry[] = []
  for (const tex of subject.textures) {
    const bytes = await fetchBytes(textureSrc(subject.version, tex))
    if (bytes) entries.push({ name: `${tex.replace(/\//g, '_')}.png`, data: bytes })
  }
  if (entries.length === 0) throw new Error('贴图获取失败')
  return makeZip(entries)
}

export async function exportSources(subject: ModelSubject): Promise<Blob | null> {
  const entries: ZipEntry[] = []
  for (const source of subject.sources) {
    const bytes = await fetchBytes(`${MC_BASE}/${subject.version}/${source.path}`)
    if (bytes) entries.push({ name: source.path.replace(/\//g, '_'), data: bytes })
  }
  if (entries.length === 0) throw new Error('源文件获取失败')
  return makeZip(entries)
}

export async function exportBundle(subject: ModelSubject): Promise<Blob | null> {
  const scene = solidScene(subject)
  if (!scene) throw new Error('这个模型没有可导出的几何')

  const entries: ZipEntry[] = []
  const texes = new Set<string>()
  for (const node of scene.nodes) for (const group of node.groups) texes.add(group.tex)
  const pngs = await collectPngs(subject.version, texes)
  for (const [tex, bytes] of pngs) entries.push({ name: textureFile(tex), data: bytes })

  const built = buildGltf(scene.nodes, pngs, { rootTranslation: scene.rootTranslation })
  entries.push({ name: 'model.glb', data: packGlb(built) })

  for (const source of subject.sources) {
    const bytes = await fetchBytes(`${MC_BASE}/${subject.version}/${source.path}`)
    if (bytes) entries.push({ name: `source/${source.path}`, data: bytes })
  }
  return makeZip(entries)
}

/** 视频格式的元信息，界面上的提示与可用性判断都从这张表推出来 */
export function videoMeta(format: CaptureFormat) {
  return formatMeta(format)
}

export function mp4Supported(): boolean {
  return supportsMp4()
}
