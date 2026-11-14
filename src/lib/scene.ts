/**
 * 场景装配：把 3D 面投影到屏幕，交给光栅化器，并配上地面阴影。
 *
 * @why 方块和实体走同一套投影/光照：方块的几何是烘焙好的 JSON，实体的几何是
 *      每帧按骨骼现算的，但最终都变成 Face3D，后面的流程完全一样。
 *      两套渲染路径是之前"方块和生物看起来不是一个世界"的根源。
 *
 * @constraint 投影必须是正交的。透视要做透视校正插值，而卡片尺寸下肉眼看不出
 *      差别，成本却高一个数量级。
 */
import type { RasterFace, TexelSource } from './raster'
import { rasterize } from './raster'
import { textureSrc } from './mc'
import { peekTexel } from './texel'
import { hasWebGl, modelPipeline, type ModelFace } from '@/render'
import { apply3, pixelScale, rotationXYZ } from '@/render/camera/projection'

export type Vec3 = [number, number, number]

/** 一个待投影的四边形面。坐标单位是模型单位（16 = 一格），y 向上。 */
export interface Face3D {
  /** 4 个顶点 xyz，12 个数 */
  pts: number[]
  /** 4 个顶点 uv，8 个数，已归一化到 0..1 */
  uv: number[]
  /** 纹理路径（相对 textures/，不含 .png） */
  tex: string
  /** 群系/染料着色乘数 */
  tint?: [number, number, number]
  /** 是否参与方向光照（MC 的 face.shade） */
  shade: boolean
  /**
   * 相机空间深度偏置（格）。
   * @why 叠加层（羊毛、项圈、眼睛）和本体是同一块表面，共面时 z 完全相等，
   *      深度测试的浮点误差会让它随机地一半被盖住。给叠加层一点正向偏置，
   *      它才能稳定地"贴"在本体表面。
   */
  bias?: number
  /** 满亮渲染：眼睛、发光层在游戏里不吃光照 */
  unlit?: boolean
}

export interface DisplayTransform {
  rotation: number[]
  translation: number[]
  scale: number[]
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

/**
 * 固定取景框（相机空间，单位格）。
 *
 * @why 取景框默认是按「当前这一帧的面」现算的——实体一抬腿包围盒就变，屏幕中心
 *      和缩放跟着变，60fps 下就是持续的画面呼吸；方块转台转到不同角度包围盒宽度
 *      不同，模型会左右漂移。导出视频里这种漂移会被放大成"镜头在抖"。
 *      把这组数在动画开始前算一次钉死，画面就只剩模型自己在动。
 */
export interface FrameBounds {
  /** 取景中心 */
  cx: number
  cy: number
  /** 取景跨度，取包围盒宽高的较大者 */
  span: number
}

export interface ProjectOptions {
  /** 画布边长（物理像素） */
  size: number
  rotX: number
  rotY: number
  /**
   * 转台枢轴（模型单位，y 向上）。
   * @why 之前固定减 0.5（即枢轴锁在方块中心 8,8,8）。生物的原点在脚底，身体中心
   *      在 16 甚至 24 上，绕 8 转等于让人绕膝盖转——拖动时整个模型是"甩"着走的，
   *      而且取景框又被钉死，看起来就是晕。枢轴必须给模型自己包围盒的中心。
   */
  pivot?: Vec3
  /**
   * block：一格固定占画布 78%，按钮/压力板就是它们真实的大小
   * auto：按包围盒铺满，用于高度 16 以上或 16 以下的实体
   */
  fit?: 'block' | 'auto'
  display?: DisplayTransform | null
  version: string
  /** 额外缩放，>1 放大 */
  zoom?: number
  /**
   * 光照强度倍率，1 是默认档。
   * @why 深色模型（黑曜石、凋灵骷髅）在默认档下糊成一团，用户希望能提亮；
   *      同一套几何不该为此再写一个渲染器，乘一个系数就够。
   */
  light?: number
  /** 钉死的取景框；不传就按当前帧现算（列表缩略图这种单帧场景） */
  frame?: FrameBounds | null
}

/** 相机空间包围盒，用于把多帧拼成一个固定取景框 */
export interface CameraBox {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export function emptyCameraBox(): CameraBox {
  return { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
}

/** 全站统一的等轴测视角：俯视 30°、水平转 225° */
export const DEFAULT_ROTATION: [number, number, number] = [30, 225, 0]
/**
 * 实体默认视角：正面偏 20°、略微俯视。
 *
 * @why 方块用等轴测 225° 好看，因为方块没有正反面；生物有脸，225° 等于从
 *      斜后方看，四足动物会被看成"趴着的一坨"。MC 的实体是面向 -z 建模的，
 *      绕到 180° 才是脸朝镜头。
 */
export const ENTITY_ROTATION: [number, number, number] = [16, 200, 0]

/** 平面物品的正视角：正对相机，只俯 10° 让 1 像素的厚度露出来 */
export const FLAT_ROTATION: [number, number, number] = [10, 0, 0]

/** 主光方向（世界坐标，y 向上） */
const LIGHT: Vec3 = [0.42, 0.78, -0.46]

/**
 * @constraint 用游戏的分面亮度表而不是纯点积：点积让斜面亮度连续渐变，
 *      整块看起来发灰、发"软"；游戏里每个朝向是一个固定档位，转 45° 会跳变，
 *      那种硬朗的层次才是方块世界的观感。这里用的是 MC 的六面亮度，
 *      整体提亮过一档，避免深色方块糊成黑块。
 */
const FACE_LUMA = { up: 1, ns: 0.88, ew: 0.76, down: 0.66 }

/**
 * 一组面的包围盒中心（模型单位，y 向上）。
 *
 * @why 转台枢轴用它。空集合退回方块中心，行为与旧代码一致。
 */
export function pivotOf(faces: Face3D[]): Vec3 {
  if (faces.length === 0) return [8, 8, 8]
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const face of faces) {
    for (let i = 0; i < 4; i += 1) {
      const x = face.pts[i * 3] ?? 0
      const y = face.pts[i * 3 + 1] ?? 0
      const z = face.pts[i * 3 + 2] ?? 0
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2]
}

/**
 * 一个顶点从模型空间到相机空间（单位格，y 向上，原点在枢轴）。
 * @constraint 先减枢轴再除以 16：不减就是绕方块角转，转台看起来是甩不是转。
 */
function toCamera(
  face: Face3D,
  i: number,
  rotation: number[],
  scale: number[],
  translate: number[],
  pivot: Vec3,
): Vec3 {
  const px = ((face.pts[i * 3] ?? 0) - pivot[0]) / 16
  const py = ((face.pts[i * 3 + 1] ?? 0) - pivot[1]) / 16
  const pz = ((face.pts[i * 3 + 2] ?? 0) - pivot[2]) / 16
  const spun = apply3(rotation, [px * scale[0]!, py * scale[1]!, pz * scale[2]!])
  return [spun[0] + translate[0]! / 16, spun[1] + translate[1]! / 16, spun[2] + translate[2]! / 16]
}

const unitScale: number[] = [1, 1, 1]
const noTranslate: number[] = [0, 0, 0]
/**
 * 把一组面累计进相机空间包围盒。
 *
 * @why 单独一遍测量而不是复用 projectFaces 的返回值：projectFaces 的 box 是
 *      屏幕坐标，而屏幕坐标依赖当帧现算的取景框——用它去拼并集是循环依赖。
 *      这里只在相机空间取极值，和取景框无关。
 */
export function measureFaces(
  faces: Face3D[],
  view: { rotX: number; rotY: number; display?: DisplayTransform | null; pivot?: Vec3 },
  into: CameraBox = emptyCameraBox(),
): CameraBox {
  if (faces.length === 0) return into
  const rotation = rotationXYZ(view.rotX, view.rotY, 0)
  const scale: number[] = view.display?.scale ?? unitScale
  const translate: number[] = view.display?.translation ?? noTranslate
  const pivot = view.pivot ?? [8, 8, 8]
  for (const face of faces) {
    for (let i = 0; i < 4; i += 1) {
      const p = toCamera(face, i, rotation, scale, translate, pivot)
      if (p[0] < into.minX) into.minX = p[0]
      if (p[0] > into.maxX) into.maxX = p[0]
      if (p[1] < into.minY) into.minY = p[1]
      if (p[1] > into.maxY) into.maxY = p[1]
    }
  }
  return into
}

export function frameFromBox(box: CameraBox): FrameBounds | null {
  if (!Number.isFinite(box.minX) || !Number.isFinite(box.minY)) return null
  return {
    cx: (box.minX + box.maxX) / 2,
    cy: (box.minY + box.maxY) / 2,
    span: Math.max(box.maxX - box.minX, box.maxY - box.minY) || 1,
  }
}

/**
 * 以枢轴为画面中心的取景框：只取跨度，不取包围盒中心。
 *
 * @why 枢轴已经是模型中心，相机中心就该是 0。若还按包围盒中心取，两者差多少，
 *      模型在屏幕上就偏多少——转动时它绕的是枢轴而不是屏幕中心，看起来在画圈。
 */
export function frameAroundPivot(box: CameraBox): FrameBounds | null {
  if (!Number.isFinite(box.minX) || !Number.isFinite(box.minY)) return null
  return {
    cx: 0,
    cy: 0,
    span: Math.max(box.maxX - box.minX, box.maxY - box.minY) || 1,
  }
}

/** 每格模型在屏幕上占多少物理像素（定义在渲染内核，这里转发以保持既有引用） */
export { pixelScale }

const FALLBACK: TexelSource = {
  data: new Uint8ClampedArray([122, 122, 128, 255]),
  width: 1,
  height: 1,
}

/** 某朝向的固定亮度档位 */
function faceLuma(n: Vec3): number {
  const ax = Math.abs(n[0])
  const ay = Math.abs(n[1])
  const az = Math.abs(n[2])
  if (ay >= ax && ay >= az) return n[1] > 0 ? FACE_LUMA.up : FACE_LUMA.down
  if (ax >= az) return FACE_LUMA.ew
  return FACE_LUMA.ns
}

export interface ProjectResult {
  raster: RasterFace[]
  /** 模型在屏幕上的包围盒，用于摆阴影 */
  box: Box
  /**
   * 取景参数（相机空间）。
   * @why GPU 管线需要它把模型的模型坐标直接送进矩阵，而这两个量
   *      原本是 `projectFaces` 内部的局部变量。不暴露出来，GPU 那边
   *      只能自己再算一遍，两份实现迟早会算出不同的取景框——
   *      表现是切换渲染后端时模型突然跳一下大小。
   */
  camera: { centerX: number; centerY: number; span: number; k: number }
}

export function projectFaces(faces: Face3D[], options: ProjectOptions): ProjectResult {
  const { size, rotX, rotY, display, version } = options
  const fit = options.fit ?? 'block'
  const zoom = options.zoom ?? 1
  // @constraint 上限压到 1.45：再往上调，白色方块会整片过曝成纯白，纹理全糊
  const gain = Math.min(1.45, Math.max(0.45, options.light ?? 1))

  const rotation = rotationXYZ(rotX, rotY, 0)
  const scale = display?.scale ?? [1, 1, 1]
  const translate = display?.translation ?? [0, 0, 0]
  const pivot = options.pivot ?? [8, 8, 8]

  interface Staged {
    pts: Vec3[]
    uv: number[]
    face: Face3D
  }

  const staged: Staged[] = []
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const face of faces) {
    const pts: Vec3[] = []
    for (let i = 0; i < 4; i += 1) {
      const moved = toCamera(face, i, rotation, scale, translate, pivot)
      pts.push(moved)
      if (moved[0] < minX) minX = moved[0]
      if (moved[0] > maxX) maxX = moved[0]
      if (moved[1] < minY) minY = moved[1]
      if (moved[1] > maxY) maxY = moved[1]
    }
    staged.push({ pts, uv: face.uv, face })
  }

  if (!Number.isFinite(minX)) {
    return {
      raster: [],
      box: { x0: 0, y0: 0, x1: 0, y1: 0 },
      camera: { centerX: 0, centerY: 0, span: 1, k: pixelScale(size, fit, 1, zoom) },
    }
  }

  const centerX = options.frame ? options.frame.cx : (minX + maxX) / 2
  const centerY = options.frame ? options.frame.cy : (minY + maxY) / 2
  const span = options.frame ? options.frame.span : Math.max(maxX - minX, maxY - minY) || 1
  const k = pixelScale(size, fit, span, zoom)

  const raster: RasterFace[] = []
  let boxX0 = Infinity
  let boxY0 = Infinity
  let boxX1 = -Infinity
  let boxY1 = -Infinity

  for (const item of staged) {
    const { pts, uv, face } = item

    const ax: Vec3 = [pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1], pts[1]![2] - pts[0]![2]]
    const ay: Vec3 = [pts[3]![0] - pts[0]![0], pts[3]![1] - pts[0]![1], pts[3]![2] - pts[0]![2]]
    const nx = ax[1] * ay[2] - ax[2] * ay[1]
    const ny = ax[2] * ay[0] - ax[0] * ay[2]
    const nz = ax[0] * ay[1] - ax[1] * ay[0]
    const len = Math.hypot(nx, ny, nz) || 1
    const normal: Vec3 = [nx / len, ny / len, nz / len]

    const luma = face.shade ? faceLuma(normal) : 1
    const dot = Math.max(0, normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2])
    // 档位亮度 + 一点点方向光，避免同一档位的面完全同色
    const light = face.unlit ? 1 : luma * (0.9 + 0.1 * dot) * gain

    // @constraint 纹理没就绪时用 1 像素占位而不是跳过：跳过会让整个面消失，
    //              用户看到的是"模型缺了一块"
    const source = peekTexel(textureSrc(version, face.tex)) ?? FALLBACK

    const verts = [] as unknown as RasterFace['verts']
    const bias = face.bias ?? 0
    for (let i = 0; i < 4; i += 1) {
      const p = pts[i]!
      const x = size / 2 + (p[0]! - centerX) * k
      const y = size / 2 - (p[1]! - centerY) * k
      if (x < boxX0) boxX0 = x
      if (x > boxX1) boxX1 = x
      if (y < boxY0) boxY0 = y
      if (y > boxY1) boxY1 = y
      verts[i] = { x, y, z: p[2]! + bias, u: uv[i * 2]!, v: uv[i * 2 + 1]! }
    }

    raster.push({ verts, source, light, tint: face.tint })
  }

  return {
    raster,
    box: { x0: boxX0, y0: boxY0, x1: boxX1, y1: boxY1 },
    camera: { centerX, centerY, span, k },
  }
}

/** 复用的离屏画布，避免每帧新建 */
let layerCanvas: HTMLCanvasElement | null = null
let outlineCanvas: HTMLCanvasElement | null = null
let trailCanvas: HTMLCanvasElement | null = null


function getLayer(size: number): CanvasRenderingContext2D | null {
  if (!layerCanvas) layerCanvas = document.createElement('canvas')
  if (layerCanvas.width !== size || layerCanvas.height !== size) {
    layerCanvas.width = size
    layerCanvas.height = size
  }
  const ctx = layerCanvas.getContext('2d')
  if (ctx) ctx.clearRect(0, 0, size, size)
  return ctx
}

/**
 * 取一块同尺寸的辅助画布。
 *
 * @constraint 尺寸变化时必须重设 width/height（而不是 clearRect）：
 *      改 width 会连上下文状态一起重置，残留的 globalCompositeOperation
 *      会让下一帧的描边/拖尾用错混合模式，画面直接变黑块。
 */
function getAux(
  slot: 'outline' | 'trail',
  size: number,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  let canvas = slot === 'outline' ? outlineCanvas : trailCanvas
  if (!canvas) {
    canvas = document.createElement('canvas')
    if (slot === 'outline') outlineCanvas = canvas
    else trailCanvas = canvas
  }
  if (canvas.width !== size || canvas.height !== size) {
    canvas.width = size
    canvas.height = size
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  return { canvas, ctx }
}

/**
 * 描边：整体剪影向外扩一圈，减去自身，得到一条等宽的轮廓线。
 *
 * @why 之前是「把剪影按 8 个方向糊开、整体染色、半透明压上去」，
 *      得到的是模型背后的一团柔光，不是描边——半径一大就变成白色雾圈，
 *      深色模型配浅色雾圈尤其像渲染坏了。
 *      真正的描边是「膨胀形状 − 原形状」这条环带：它贴着轮廓、宽度恒定、
 *      不受模型内部明暗影响，转到任何角度都是同一条线。
 *
 * @constraint 必须 destination-out 减掉原形状。只膨胀不减，环带内部也会被染色，
 *      叠在本体下面的那部分会从抗锯齿边缘透出来，看起来像一圈内发光。
 *
 * @constraint 用 drawImage 多次偏移而不是 getImageData 做邻域检测：672² 的缓冲区
 *      每帧读一次要 3~5ms，而且会打断 GPU 合成。合成操作便宜一个数量级，
 *      形状由源画布 alpha 决定，镂空处（树叶、栅栏）也能正确描边。
 */
function paintOutline(
  ctx: CanvasRenderingContext2D,
  size: number,
  layer: HTMLCanvasElement,
  strength: number,
  color: string,
): void {
  const aux = getAux('outline', size)
  if (!aux) return
  const { canvas, ctx: octx } = aux
  octx.clearRect(0, 0, size, size)

  /**
   * @constraint 线宽按画布尺寸等比放大：336 是设计基准，672 的导出画布上
   *      2px 的线会细得看不见。上限压住 7px，再粗就不像描边而像贴纸边框。
   */
  const radius = (1.4 + strength * 3.6) * (size / 336)
  // 两圈采样：外圈决定线的外沿，内圈（0.6r）把八边形补成圆环
  for (const scale of [1, 0.6]) {
    const r = radius * scale
    for (let i = 0; i < 8; i += 1) {
      const angle = (i / 8) * Math.PI * 2
      octx.drawImage(layer, Math.cos(angle) * r, Math.sin(angle) * r)
    }
  }

  // 膨胀形状减掉本体 = 纯环带
  octx.globalCompositeOperation = 'destination-out'
  octx.drawImage(layer, 0, 0)
  octx.globalCompositeOperation = 'source-in'
  octx.fillStyle = color
  octx.fillRect(0, 0, size, size)
  octx.globalCompositeOperation = 'source-over'

  ctx.drawImage(canvas, 0, 0)
}

/**
 * 描边色：跟随当前主题的前景色。
 *
 * @why 描边是画在剪影**外面**的一圈，它要和**页面背景**拉开对比，而不是和模型。
 *      之前按模型明暗取反（深模型配浅边），结果深色模型在白底页面上得到一条
 *      白线——线还在模型外面，和白底糊在一起，看起来像一圈发光而不是描边。
 *      直接取主题前景色（浅色主题近黑、深色主题近白），两种主题下这条线
 *      都压得住背景，也永远是"描边"的样子。
 *
 * @constraint 只读一次 var(--text)：getComputedStyle 每帧调用会触发布局，
 *      而主题切换是低频事件，缓存在模块级即可。
 */
let themedOutline = ''
function outlineColor(): string {
  if (themedOutline) return themedOutline
  if (typeof window === 'undefined') return '#12151c'
  const value = getComputedStyle(document.documentElement).getPropertyValue('--text').trim()
  themedOutline = value || '#12151c'
  return themedOutline
}

/** 主题切换后要让缓存失效 */
export function resetOutlineColor(): void {
  themedOutline = ''
}

/**
 * 动态模糊：一层指数衰减的尾部缓冲。
 *
 * @constraint 衰减必须用 destination-out 抹 alpha，不能在自身上叠一层半透明黑：
 *      前者降低的是「历史存在的量」，后者只是把残影涂暗，累积几帧后
 *      整块区域会变成一坨灰雾，模型的轮廓彻底糊掉。
 */
function paintMotionBlur(
  ctx: CanvasRenderingContext2D,
  size: number,
  layer: HTMLCanvasElement,
  strength: number,
  reset: boolean,
): void {
  const aux = getAux('trail', size)
  if (!aux) {
    ctx.drawImage(layer, 0, 0)
    return
  }
  const { canvas, ctx: tctx } = aux
  if (reset) tctx.clearRect(0, 0, size, size)

  /**
   * @constraint 保留比例不能太高：模型多为深色，残影的 alpha 一降就会透出
   *      背景，看起来不是"模糊"而是一层白雾。0.12 ~ 0.42 之间才有拖影感。
   */
  const keep = 0.2 + strength * 0.55
  tctx.globalCompositeOperation = 'destination-out'
  tctx.globalAlpha = 1 - keep
  tctx.fillRect(0, 0, size, size)

  tctx.globalCompositeOperation = 'source-over'
  tctx.globalAlpha = 1
  tctx.drawImage(layer, 0, 0)

  ctx.drawImage(canvas, 0, 0)
}


export interface SceneOptions extends ProjectOptions {
  faces: Face3D[]
  /** 超采样倍率，详情页给 3 */
  supersample?: number
  /** 地面阴影强度，0 关闭 */
  shadow?: number
  /** 是否先清空画布。导出带背景色时传 false，否则会把底色擦掉 */
  clear?: boolean
  /**
   * 动态模糊 0..1。
   *
   * @why 软件光栅化是逐帧硬合成的，快速旋转或奔跑时每帧之间没有任何关联，
   *      眼睛看到的是「跳格」。游戏里靠运动模糊/时间抗锯齿掩盖这一点。
   *      这里用一条指数衰减的尾部缓冲复现：保留上一帧的一部分，
   *      转动越快残影拉得越开。
   */
  motionBlur?: number
  /**
   * 描边 0..1。
   *
   * @why 素材站的白底/透明底上，深色模型和背景糊在一起（黑马、凋灵骷髅、
   *      深板岩），轮廓读不出来。描边就是给剪影加一圈冷色暗边，
   *      同时把模型的边缘从背景里"拔"出来。
   */
  outline?: number
  /** 描边颜色，默认近黑 */
  outlineColor?: string
  /**
   * 清空拖尾历史。
   * @constraint 换对象和导出首帧必须清：不清就会把上一个模型的残影
   *      画到新模型的画面里，导出视频的第一帧还会带着上一段的时间。
   */
  resetTrail?: boolean
  /**
   * 网格缓存键。
   * @why 同一组面每帧都会传进来，但对象的身份每次都变（动画重建的）。
   *      用内容长度当键会让"两个都是 240 面的不同模型"共用一个网格，
   *      拖拽时模型会串。调用方知道自己在画哪个模型，交给它给键最稳。
   */
  gpuKey?: string
  /**
   * 着色路径。
   * @constraint 实体必须和方块分开。方块的方向亮度是六档常量、烘焙进顶点色；
   *      实体是两束方向光按法线做点积。混用会让其中一种失去立体感——
   *      方块变成一片平色，或者实体变成一块块硬边。
   */
  shading?: 'block' | 'entity'
  /**
   * 固定的阴影落点。
   * @why 阴影跟着当帧包围盒走，抬腿、扇翅膀都会让影子忽宽忽窄、上下跳；
   *      导出成视频后这个抖动比模型本身还显眼。锁死取景框时一并锁死它。
   */
  shadowBox?: Box
}

/**
 * 用 GPU 管线画模型。
 *
 * @why 单独抽出来而不是内联进 `drawScene`：`drawScene` 还要处理阴影、
 *      描边、运动模糊、拖尾四种 2D 后处理，那些逻辑和渲染后端无关，
 *      混在一起会让"换成 GPU"这件事看起来像重写了整个绘制流程。
 *
 * @return 是否真的用 GPU 画了。false 表示调用方需要回落 CPU 光栅化。
 */
function paintGpu(
  layer: CanvasRenderingContext2D,
  faces: Face3D[],
  options: SceneOptions,
  camera: { centerX: number; centerY: number; span: number; k: number },
): boolean {
  // 调试用：`?cpu=1` 强制走 CPU 光栅化，用来逐像素对比两条路径
  if (typeof location !== 'undefined' && location.search.includes('cpu=1')) return false
  if (!hasWebGl()) return false

  /**
   * @constraint 整条 GPU 路径必须能失败而不能抛。着色器编译、上下文创建、
   *      显存分配任何一步挂掉，都不应该让整页崩掉——用户看到的是一个
   *      React 错误边界页面，而不是"模型用了慢一点的渲染方式"。
   */
  try {
    const pipeline = modelPipeline()
    if (!pipeline.ready(faces as ModelFace[], options.version)) return false
    const stats = pipeline.render(
      layer.canvas,
      options.gpuKey ?? `f${faces.length}|${options.version}`,
      faces as ModelFace[],
      {
        size: options.size,
        rotX: options.rotX,
        rotY: options.rotY,
        pivot: options.pivot ?? [8, 8, 8],
        display: options.display ?? null,
        fit: options.fit ?? 'block',
        span: camera.span,
        center: [camera.centerX, camera.centerY],
        zoom: options.zoom ?? 1,
        light: options.light ?? 1,
      },
      options.version,
      options.shading ?? 'block',
    )
    /**
     * @constraint 不能只看"没抛异常"就宣告 GPU 画完了。实体顶点转译对一部分
     *      生物产出 0 个三角形（骨骼层、平面部件、特殊渲染器还没接上），
     *      这时管线是"成功画了一帧空气"：画布全透明，又不回落 CPU，
     *      列表里那些生物就永久空白——而且控制台一句报错都没有。
     *      按三角形数判定才能把这类静默失败交还给 CPU 光栅化。
     */
    return stats.triangles > 0
  } catch (error) {
    warnOnce(error)
    return false
  }
}

/** 只报一次，避免几百个缩略图各刷一条控制台 */
let warned = false
function warnOnce(error: unknown): void {
  if (warned) return
  warned = true
  console.warn('[render] GPU 管线不可用，回落到 CPU 光栅化：', error)
}

/**
 * 画一帧。
 *
 * @why 阴影必须画在模型下面，而光栅化用的是 putImageData（整块替换像素，
 *      会连透明像素一起覆盖）。所以先在离屏画布上光栅化，再在主画布上
 *      依次画阴影和模型。顺带解决了透明背景导出。
 */
export function drawScene(ctx: CanvasRenderingContext2D, options: SceneOptions): Box {
  const { size, faces } = options
  if (options.clear !== false) ctx.clearRect(0, 0, size, size)
  if (faces.length === 0) return { x0: 0, y0: 0, x1: 0, y1: 0 }

  const { raster, box, camera } = projectFaces(faces, options)
  const layer = getLayer(size)

  if (!layer) {
    rasterize(ctx, size, size, raster, options.supersample ?? 2)
    return box
  }

  /**
   * @constraint 纹理没全部就绪时必须回落 CPU。GPU 路径是同步的，
   *      纹理还在下载时只能画白模——一整屏白方块比慢 5ms 难看得多。
   *      预载由调用方负责（`preloadTextures`），这里只做就绪判定。
   */
  if (!paintGpu(layer, faces, options, camera)) {
    rasterize(layer, size, size, raster, options.supersample ?? 2)
  }

  const strength = options.shadow ?? 1
  const shadowBox = options.shadowBox ?? box
  if (strength > 0 && Number.isFinite(shadowBox.x1)) drawShadow(ctx, size, shadowBox, strength)

  /**
   * 顺序：阴影 → 描边 → 模型（或带拖尾的模型）。
   * @why 描边必须压��模型下面：它是「模型外面的一圈」，盖在上面就成了镶边，
   *      内部的半透明边缘也会被染黑。
   */
  const outline = options.outline ?? 0
  if (outline > 0) paintOutline(ctx, size, layerCanvas!, outline, options.outlineColor ?? outlineColor())

  const blur = options.motionBlur ?? 0
  if (blur > 0) paintMotionBlur(ctx, size, layerCanvas!, blur, options.resetTrail === true)
  else ctx.drawImage(layerCanvas!, 0, 0)
  return box
}

/**
 * 地面阴影：两层椭圆。
 * @why 不是把模型压扁成投影——那需要额外的深度处理，而且方块压扁后是一块方饼，
 *      不像影子。游戏里实体本来就是脚下画一个椭圆阴影（shadowRadius），
 *      这里照着做，再叠一层更紧的接触阴影让物体"坐"在地上而不是浮着。
 */
function drawShadow(ctx: CanvasRenderingContext2D, size: number, box: Box, strength: number): void {
  const cx = (box.x0 + box.x1) / 2
  const cy = box.y1
  const width = Math.max(8, (box.x1 - box.x0) * 0.92)
  const soften = size * 0.055

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, 0.22)

  const far = ctx.createRadialGradient(0, 0, 0, 0, 0, width / 2)
  far.addColorStop(0, `rgba(0,0,0,${0.22 * strength})`)
  far.addColorStop(0.55, `rgba(0,0,0,${0.12 * strength})`)
  far.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = far
  ctx.beginPath()
  ctx.arc(0, 0, width / 2 + soften * 2, 0, Math.PI * 2)
  ctx.fill()

  const near = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 0.36)
  near.addColorStop(0, `rgba(0,0,0,${0.3 * strength})`)
  near.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = near
  ctx.beginPath()
  ctx.arc(0, 0, width * 0.36, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}
