/**
 * 模型 GPU 渲染管线（对外唯一入口）。
 *
 * @why 对外只暴露「给一批面和一组相机参数，画出这一帧」，内部怎么分程序、
 *      怎么缓存网格、怎么上传纹理全部藏起来。上一版的渲染逻辑散在
 *      `scene.ts`（投影 + 光照）、`raster.ts`（光栅化）、`ModelView.tsx`
 *      （后处理）三处，加一种"能发光的方块"要在三个文件里各改一遍。
 *
 * @constraint 相机必须和 CPU 路径逐像素等价。`toCamera` 的变换是
 *      `(raw - pivot) / 16 * scale → 旋转 → + translate / 16`，
 *      这里原样搬成矩阵 `T(translate/16) · R · S(scale/16) · T(-pivot)`。
 *      顺序写反的话模型会绕世界原点转，一拖鼠标就飞出画面。
 */
import { BLOCK_LAYOUT, ENTITY_LAYOUT, MeshBuffer } from './core/buffer'
import { glContext, hasWebGl, type GlContext } from './core/context'
import { identity, multiply, ortho } from './core/matrix'
import { Program, build } from './core/program'
import { Renderer, type DrawCall, type FrameContext } from './core/renderer'
import { Texture, TextureCache } from './core/texture'
import type { Vec3 } from './core/types'
import { DEFAULT_LIGHTMAP, LightmapTexture, type LightmapParams } from './lighting/lightmap'
import { LIGHTING } from './lighting/directions'
import { withDefines } from './shader/defines'
import { ENTITY_FSH, ENTITY_VSH } from './shader/entity'
import { TERRAIN_FSH, TERRAIN_VSH } from './shader/terrain'
import { buildModelBatches, type ModelBatch, type ModelFace } from './pass/model'
import { buildEntityBatches, type EntityBatch } from './pass/entity'

/** 两种网格批的公共形状 */
type AnyBatch = ModelBatch | EntityBatch
import { loadTexel } from '@/lib/texel'
import { textureSrc } from '@/lib/mc'

export interface ModelCamera {
  /** 画布边长（物理像素） */
  size: number
  /** 俯仰角（度） */
  rotX: number
  /** 水平角（度） */
  rotY: number
  /** 转台枢轴（模型单位） */
  pivot: Vec3
  /** display.gui 的缩放与位移（模型单位） */
  display?: { scale?: number[]; translation?: number[] } | null
  /** 取景：block 视 78%，auto 按包围盒铺 84% */
  fit?: 'block' | 'auto'
  /** 取景跨度（相机空间，单位格）。给了就钉死，不再按当帧包围盒算 */
  span?: number
  /** 取景中心（相机空间）。同上 */
  center?: [number, number]
  zoom?: number
  /** 亮度倍率 */
  light?: number
  /** 模型坐标单位：一格 = 多少模型单位（方块 16，实体也是 16） */
  unitsPerBlock?: number
}

export interface RenderStats {
  batches: number
  vertices: number
  triangles: number
}

/** 网格缓存键：面集合变了、光照表变了就得重建 */
interface MeshEntry {
  kind: 'block' | 'entity'
  meshes: AnyBatch[]
  buffers: MeshBuffer[]
  textures: (Texture | null)[]
  stats: RenderStats
}

export class ModelPipeline {
  private readonly ctx: GlContext
  private readonly renderer: Renderer
  private readonly cache: TextureCache
  private readonly lightmap: LightmapTexture
  private readonly blockOpaque: Program
  private readonly blockCutout: Program
  /** 实体程序，供 `renderEntity` 使用 */
  readonly entityOpaque: Program
  /** 实体 cutout 变体 */
  readonly entityCutout: Program
  /** 实体满亮层（眼睛、发光贴图），不吃光照图 */
  readonly entityEmissive: Program
  private readonly entries = new Map<string, MeshEntry>()

  constructor() {
    this.ctx = glContext()
    const gl = this.ctx.gl

    this.renderer = new Renderer(this.ctx)
    this.cache = new TextureCache(gl, (key) => loadTexel(key), { mipmap: true })
    this.lightmap = new LightmapTexture(
      (source) => new Texture(gl, source, { mipmap: false }),
      DEFAULT_LIGHTMAP,
    )

    this.blockOpaque = build(gl, 'terrain', TERRAIN_VSH, TERRAIN_FSH)
    this.blockCutout = build(
      gl,
      'terrain_cutout',
      withDefines(TERRAIN_VSH, {}),
      withDefines(TERRAIN_FSH, { ALPHA_CUTOUT: '0.100' }),
    )
    this.entityOpaque = build(
      gl,
      'entity',
      withDefines(ENTITY_VSH, { PER_FACE_LIGHTING: true }),
      withDefines(ENTITY_FSH, { PER_FACE_LIGHTING: true }),
    )
    this.entityCutout = build(
      gl,
      'entity_cutout',
      withDefines(ENTITY_VSH, { PER_FACE_LIGHTING: true }),
      withDefines(ENTITY_FSH, { PER_FACE_LIGHTING: true, ALPHA_CUTOUT: '0.100' }),
    )
    this.entityEmissive = build(
      gl,
      'entity_emissive',
      withDefines(ENTITY_VSH, { PER_FACE_LIGHTING: true, EMISSIVE: true }),
      withDefines(ENTITY_FSH, { PER_FACE_LIGHTING: true, EMISSIVE: true, ALPHA_CUTOUT: '0.100' }),
    )
  }

  /**
   * 这组面的纹理是否全部就绪。
   *
   * @why GPU 渲染是同步的，没法在中间 await 纹理下载。没就绪时宁可让
   *      调用方回落 CPU 光栅化，也不要画一屏白模——后者看起来像坏了。
   */
  ready(faces: ModelFace[], version: string): boolean {
    if (!hasWebGl()) return false
    for (const face of faces) {
      if (!this.cache.peek(textureSrc(version, face.tex))) return false
    }
    return faces.length > 0
  }

  /** 预载纹理。渲染是同步的，没预载的面会用占位色 */
  async prepare(texIds: string[], version: string): Promise<void> {
    await Promise.all(texIds.map((id) => this.cache.get(textureSrc(version, id))))
  }

  /**
   * 画一帧。
   *
   * @constraint 同步。调用方（rAF 循环）不能 await，否则 60fps 的
   *      拖拽会变成一帧一个宏任务的抖动。纹理要提前 `prepare`。
   */
  render(
    target: HTMLCanvasElement,
    key: string,
    faces: ModelFace[],
    camera: ModelCamera,
    version: string,
    shading: 'block' | 'entity' = 'block',
  ): RenderStats {
    const entry = this.meshFor(key, faces, version, shading)
    const { ctx } = this
    const gl = ctx.gl

    ctx.resize(camera.size, camera.size)
    this.renderer.begin([0, 0, 0, 0])

    const { view, proj, frame } = this.frameFor(camera)

    const calls: DrawCall[] = []
    entry.meshes.forEach((batch, index) => {
      const buffer = entry.buffers[index]
      if (!buffer || batch.vertexCount === 0) return
      // @constraint 纹理每帧重新取一次而不是建网格时取一次。建网格的那一瞬间
      //      纹理往往还在下载，取到的永远是 null；不重取的话模型会用白色
      //      占位画完整个生命周期，直到换个模型才恢复。
      const texture = this.cache.peek(textureSrc(version, batch.texture))
      entry.textures[index] = texture
      calls.push({
        program: this.programFor(entry.kind, batch),
        mesh: buffer,
        texture,
        chunkPos: [0, 0, 0],
        blend: batch.translucent,
        // @constraint 一律双面。原版的方块模型顶点绕序不统一（导出时按
        //      face 定义来，有的是顺时针），按 CCW 正面剔除会把大部分面
        //      整片丢掉，画面里只剩一条边。用双面 + 深度测试保证正确性，
        //      代价是多画一遍背面——方块模型面数很少，可以接受。
        doubleSided: true,
        vertexCount: batch.vertexCount,
      })
    })

    gl.viewport(0, 0, camera.size, camera.size)
    this.renderer.draw(calls, { ...frame, modelViewMat: view, projMat: proj })

    if (typeof window !== 'undefined' && (window as unknown as { __mcDebugMesh?: boolean }).__mcDebugMesh) {
      const data = entry.meshes[0]?.data
      if (data) {
        const dv = new DataView(data.buffer)
        const ndc: number[][] = []
        for (let i = 0; i < Math.min(4, data.byteLength / 32); i += 1) {
          const o = i * 32
          ndc.push(projectToNdc(view, proj, [dv.getFloat32(o, true), dv.getFloat32(o + 4, true), dv.getFloat32(o + 8, true)]))
        }
        console.log('[ndc]', JSON.stringify(ndc), 'err', gl.getError(), 'err2', gl.getError())
      }
    }

    ctx.blitTo(target, camera.size, camera.size)
    return entry.stats
  }

  /**
   * 选程序。
   *
   * @constraint 方块的不透明批必须走 cutout：树叶、栅栏、铁栏杆都有
   *      alpha=0 的镂空像素，用纯不透明程序会把整片叶子画成实心方块。
   *      实体的满亮层走 emissive，否则发光的眼睛会被光照图压暗。
   */
  private programFor(kind: 'block' | 'entity', batch: AnyBatch): Program {
    if (kind === 'entity') {
      const emissive = 'emissive' in batch && batch.emissive
      if (emissive) return this.entityEmissive
      return batch.translucent ? this.entityOpaque : this.entityCutout
    }
    return batch.translucent ? this.blockOpaque : this.blockCutout
  }

  /** 清掉某个网格缓存（换模型、换版本） */
  invalidate(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    for (const buffer of entry.buffers) buffer.dispose()
    this.entries.delete(key)
  }

  clearCache(): void {
    for (const key of [...this.entries.keys()]) this.invalidate(key)
  }

  setLightmap(params: LightmapParams): void {
    this.lightmap.update(params)
  }

  /** 相机 → 矩阵。与 `scene.ts` 的 `projectFaces` 等价 */
  private frameFor(camera: ModelCamera): { view: Float32Array; proj: Float32Array; frame: FrameContext } {
    const units = camera.unitsPerBlock ?? 16
    const scale = camera.display?.scale ?? [1, 1, 1]
    const translate = camera.display?.translation ?? [0, 0, 0]
    const zoom = camera.zoom ?? 1

    // 模型 → 相机：T(translate/units) · R · S(scale/units) · T(-pivot)
    const model = multiply(
      translateMatrix(translate[0]! / units, translate[1]! / units, translate[2]! / units),
      multiply(
        rotationMatrix(camera.rotX, camera.rotY),
        multiply(
          scaleMatrix(scale[0]! / units, scale[1]! / units, scale[2]! / units),
          translateMatrix(-camera.pivot[0], -camera.pivot[1], -camera.pivot[2]),
        ),
      ),
    )

    const cx = camera.center?.[0] ?? 0
    const cy = camera.center?.[1] ?? 0
    const span = camera.span ?? 1

    // 取景：与 `pixelScale` 一致（block 78% / auto 84%），span 是相机空间跨度
    const fraction = camera.fit === 'auto' ? 0.84 : 0.78
    const viewSize = span / (camera.size * fraction * zoom) // 一个像素对应多少世界单位
    const half = (camera.size * viewSize) / 2

    const view = multiply(translateMatrix(-cx, -cy, 0), model)
    const proj = ortho(-half, half, -half, half, -2000, 2000)

    return {
      view,
      proj,
      frame: {
        projMat: proj,
        modelViewMat: view,
        cameraBlockPos: [0, 0, 0],
        cameraOffset: [0, 0, 0],
        textureSize: [16, 16],
        /**
         * @constraint 用世界光（LEVEL）而不是物品栏光（INVENTORY）。
         *      原版物品栏里的实体确实用 INVENTORY 那组，但它的坐标约定是
         *      GUI 的 y 轴向下；我们的模型和世界一样是 y 向上，照搬会让
         *      所有朝上的面都变成背光，整只生物被压到 0.4 亮度，看起来
         *      像泡在阴影里。世界光在 y 向上的坐标系里对比度是 0.5~1.0，
         *      正好是游戏里站在太阳底下的观感。
         */
        light0: LIGHTING.level.light0,
        light1: LIGHTING.level.light1,
        rgss: true,
        lightmap: this.lightmap.texture.texture,
        fog: {
          color: [0, 0, 0, 0],
          environmentalStart: 1e6,
          environmentalEnd: 1e6 + 1,
          renderDistanceStart: 1e6,
          renderDistanceEnd: 1e6 + 1,
        },
      },
    }
  }

  private meshFor(key: string, faces: ModelFace[], version: string, shading: 'block' | 'entity'): MeshEntry {
    // @constraint 空键表示"每帧都不一样"（动画实体的姿势每帧都在变）。
    //      用一个固定槽位反复覆盖，而不是按帧号建新键——后者一小时能攒出
    //      几万个 Entry，显存和 Map 一起爆。
    const slot = key ? `${shading}|${key}` : TRANSIENT_SLOT
    const hit = this.entries.get(slot)
    if (hit && key) return hit
    if (hit) {
      for (const buffer of hit.buffers) buffer.dispose()
      this.entries.delete(slot)
    }

    const meshes: AnyBatch[] = shading === 'entity' ? buildEntityBatches(faces) : buildModelBatches(faces)
    const gl = this.ctx.gl
    const buffers: MeshBuffer[] = []
    const textures: (Texture | null)[] = []
    let vertices = 0

    const layout = shading === 'entity' ? ENTITY_LAYOUT : BLOCK_LAYOUT
    for (const batch of meshes) {
      const buffer = new MeshBuffer(gl, layout)
      buffer.upload(batch.data)
      buffers.push(buffer)
      textures.push(this.cache.peek(textureSrc(version, batch.texture)))
      vertices += batch.vertexCount
    }

    const entry: MeshEntry = {
      kind: shading,
      meshes,
      buffers,
      textures,
      stats: { batches: meshes.length, vertices, triangles: vertices / 3 },
    }
    this.entries.set(slot, entry)
    return entry
  }
}

function translateMatrix(x: number, y: number, z: number): Float32Array {
  const m = identity()
  m[12] = x
  m[13] = y
  m[14] = z
  return m
}

function scaleMatrix(x: number, y: number, z: number): Float32Array {
  const m = identity()
  m[0] = x
  m[5] = y
  m[10] = z
  return m
}

/**
 * 模型旋转矩阵。
 *
 * @constraint 必须与 `scene.ts` 的 `rotationXYZ(rx, ry, 0)` 逐项一致：
 *      先绕 X 转 rotX，再绕 Y 转 rotY（`mul3(axisRot('x'), axisRot('y'))`
 *      表示先应用 Y 后应用 X，即 `Rx · Ry`）。这里转成列主序 4×4。
 */
function rotationMatrix(rotX: number, rotY: number): Float32Array {
  const rad = Math.PI / 180
  const cx = Math.cos(rotX * rad)
  const sx = Math.sin(rotX * rad)
  const cy = Math.cos(rotY * rad)
  const sy = Math.sin(rotY * rad)

  /**
   * @constraint 这是 `Rx · Ry` 的展开（行主序）。`scene.ts` 的
   *      `rotationXYZ` 是 `mul3(axisRot('x'), axisRot('y'))`，即先应用 Y 后 X。
   *      写成 `Ry · Rx` 或把某一项的符号搞反，画面会变成"从下往上看"——
   *      俯视 30° 变成仰视 30°，模型露出腹部。这个错误极难从静态截图发现，
   *      因为模型本身仍然完整，只是角度不对。
   */
  const r = [
    [cy, 0, sy],
    [sx * sy, cx, -sx * cy],
    [-cx * sy, sx, cx * cy],
  ]

  const m = identity()
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      m[col * 4 + row] = r[row]![col]!
    }
  }
  return m
}

/** 把模型坐标手动走一遍矩阵，输出 NDC，用来核对 GPU 与 CPU 的取景是否一致 */
function projectToNdc(view: Float32Array, proj: Float32Array, p: [number, number, number]): number[] {
  const m = multiply(proj, view)
  const x = m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!
  const y = m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!
  const z = m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!
  const w = m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!
  return [round4(x / w), round4(y / w), round4(z / w), round4(w)]
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000
}

/** 动画实体复用的固定缓存槽 */
const TRANSIENT_SLOT = '__transient__'

let shared: ModelPipeline | null = null
/**
 * @constraint 初始化失败后必须记住，不能下次再试。
 *      构造函数抛错时 `shared` 不会被赋值，调用方每次绘制都会重新 new 一遍，
 *      每次都创建一个新的 WebGL 上下文。几百个缩略图就能把浏览器的
 *      16 个上下文配额耗光，连正常功能一起拖垮。
 */
let initFailed = false

export function modelPipeline(): ModelPipeline {
  if (initFailed) throw new Error('GPU 管线初始化失败')
  if (!shared) {
    try {
      shared = new ModelPipeline()
    } catch (error) {
      initFailed = true
      throw error
    }
  }
  return shared
}
