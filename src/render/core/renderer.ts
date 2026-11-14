/**
 * 绘制调度：把一批 DrawCall 变成一个渲染帧。
 *
 * @why 状态切换集中在这里，而不是让每个 pass 自己 `gl.enable`。
 *      GL 的冗余状态调用不会报错但很贵：地形一帧几百个区块，
 *      如果每个区块各切一遍深度测试和剔除，光状态切换就吃掉大半帧预算。
 *      这里按「程序 → 混合 → 剔除」排序并记住上一笔状态，只在真的变化时下发。
 *
 * @constraint 透明物体必须在不透明之后画，且不写深度。反过来的话，
 *      玻璃后面的水会消失——因为透明片先写了深度，后面更近的透明片
 *      深度测试失败被丢弃，但更远的透明片又因为已经写了深度而没能叠加。
 */
import type { GlContext } from './context'
import type { MeshBuffer } from './buffer'
import type { Program } from './program'
import type { Texture } from './texture'
import type { Vec3 } from './types'

export interface DrawCall {
  program: Program
  mesh: MeshBuffer
  texture: Texture | null
  /** overlay 纹理（实体受伤闪红），terrain 不用 */
  overlay?: Texture | null
  /** 区块原点。顶点坐标是相对它的，用于避免大坐标精度损失 */
  chunkPos: Vec3
  /** 半透明：开启混合、关闭深度写入 */
  blend?: boolean
  /** 双面渲染（草、告示牌这类薄片） */
  doubleSided?: boolean
  vertexCount: number
  /** 绘制顺序，小的先画 */
  order?: number
}

export interface FrameContext {
  /** 投影 × 视图 */
  projMat: Float32Array
  /** 视图矩阵 */
  modelViewMat: Float32Array
  /** 相机所在的方块坐标（原版 CameraBlockPos） */
  cameraBlockPos: [number, number, number]
  /** 相机在方块内的亚格偏移（原版 CameraOffset） */
  cameraOffset: Vec3
  /** 纹理尺寸，RGSS 需要 */
  textureSize: [number, number]
  /** 光照方向 */
  light0: Vec3
  light1: Vec3
  /** 是否启用 RGSS 抗锯齿 */
  rgss: boolean
  /** 雾 */
  fog: {
    color: [number, number, number, number]
    environmentalStart: number
    environmentalEnd: number
    renderDistanceStart: number
    renderDistanceEnd: number
  }
  /** 颜色调制（染色、受伤闪红） */
  colorModulator?: [number, number, number, number]
  /** 光照图纹理。地形与实体着色器都要用它，没绑的话采样到的是别的纹理 */
  lightmap: WebGLTexture | null
}

const DEBUG =
  typeof window !== 'undefined' && (window as unknown as { __mcDebugMesh?: boolean }).__mcDebugMesh === true

export class Renderer {
  private lastProgram: Program | null = null
  private lastBlend = false
  private lastCull = true
  private lastDepthWrite = true

  constructor(private readonly glc: GlContext) {}

  /** 开始一帧：清屏 */
  begin(clear: [number, number, number, number] | null = null): void {
    const gl = this.glc.gl
    gl.clearColor(clear?.[0] ?? 0, clear?.[1] ?? 0, clear?.[2] ?? 0, clear?.[3] ?? 0)
    gl.clearDepth(1)
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(true)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    this.lastProgram = null
    this.lastBlend = false
    this.lastCull = true
    this.lastDepthWrite = true
    gl.disable(gl.BLEND)
    gl.enable(gl.CULL_FACE)
  }

  /** 提交一批绘制。不透明先画、透明后画，各自内部按 order 稳定排序 */
  draw(calls: DrawCall[], frame: FrameContext): void {
    const gl = this.glc.gl
    const sorted = [...calls].sort((a, b) => {
      const ab = a.blend ? 1 : 0
      const bb = b.blend ? 1 : 0
      if (ab !== bb) return ab - bb
      return (a.order ?? 0) - (b.order ?? 0)
    })

    for (const call of sorted) {
      const blend = call.blend === true
      const cull = call.doubleSided !== true
      const depthWrite = !blend

      if (call.program !== this.lastProgram) {
        call.program.use()
        this.applyFrameUniforms(call.program, frame)
        this.lastProgram = call.program
      }
      if (blend !== this.lastBlend) {
        if (blend) gl.enable(gl.BLEND)
        else gl.disable(gl.BLEND)
        this.lastBlend = blend
      }
      if (cull !== this.lastCull) {
        if (cull) gl.enable(gl.CULL_FACE)
        else gl.disable(gl.CULL_FACE)
        this.lastCull = cull
      }
      if (depthWrite !== this.lastDepthWrite) {
        gl.depthMask(depthWrite)
        this.lastDepthWrite = depthWrite
      }

      call.program.vec3i('ChunkPosition', call.chunkPos[0], call.chunkPos[1], call.chunkPos[2])
      call.program.sampler('Sampler0', 0, call.texture?.texture ?? null)
      if (call.overlay !== undefined) call.program.sampler('Sampler1', 1, call.overlay?.texture ?? null)

      call.mesh.bind()
      call.mesh.draw(call.vertexCount)
      if (DEBUG) {
        // @constraint 只在调试开关下读错误。`getError` 会强制同步 GPU 与 CPU，
        //      放在热路径里（几百个 draw call）能让帧率直接掉一半。
        const error = gl.getError()
        if (error !== 0) console.warn('[render] drawArrays 失败', error, call.vertexCount)
      }
    }

    gl.bindVertexArray(null)
    // 恢复默认，避免下一帧的 begin 以为状态没变
    this.lastProgram = null
    this.lastDepthWrite = true
    gl.depthMask(true)
    gl.disable(gl.BLEND)
  }

  /**
   * 设置每帧不变的 uniform。
   *
   * @why 放在程序切换时设，而不是每帧一次：同一帧可能有多个程序，
   *      而同一个程序会被几十个 draw call 复用。按程序设一次，
   *      后面每个 draw call 只需要设区块坐标和纹理。
   */
  private applyFrameUniforms(program: Program, frame: FrameContext): void {
    program.mat4('ProjMat', frame.projMat)
    program.mat4('ModelViewMat', frame.modelViewMat)
    program.vec3i('CameraBlockPos', ...frame.cameraBlockPos)
    program.vec3('CameraOffset', ...frame.cameraOffset)
    program.vec2i('TextureSize', ...frame.textureSize)
    program.int('UseRgss', frame.rgss ? 1 : 0)

    program.vec3('Light0_Direction', ...frame.light0)
    program.vec3('Light1_Direction', ...frame.light1)

    const modulator = frame.colorModulator ?? [1, 1, 1, 1]
    program.vec4('ColorModulator', ...modulator)
    program.vec3('ModelOffset', 0, 0, 0)
    program.float('GlintAlpha', 0)
    program.float('GameTime', 0)
    program.vec2('ScreenSize', this.glc.width, this.glc.height)
    program.int('MenuBlurRadius', 0)
    // overlay 默认指向一张全透明的 1×1，没绑 Sampler1 时也不会采样到垃圾
    program.sampler('Sampler1', 1, emptyOverlayTexture(this.glc.gl))
    program.sampler('Sampler2', 2, frame.lightmap)
    program.float('ChunkVisibility', 1)
    program.float('FogEnvironmentalStart', frame.fog.environmentalStart)
    program.float('FogEnvironmentalEnd', frame.fog.environmentalEnd)
    program.float('FogRenderDistanceStart', frame.fog.renderDistanceStart)
    program.float('FogRenderDistanceEnd', frame.fog.renderDistanceEnd)
    program.vec4('FogColor', ...frame.fog.color)
    program.float('FogSkyEnd', 1)
    program.float('FogCloudsEnd', 1)
  }
}

/**
 * 1×1 白色**不透明**纹理，作为 Sampler1（overlay）的兜底。
 *
 * @constraint 必须是 (255,255,255,255)，不能是透明，也不能是黑。
 *      实体片元里做的是 `color.rgb = mix(overlayColor.rgb, color.rgb, overlayColor.a)`：
 *      alpha 是「用原色的程度」。写成透明（alpha=0）等于整只生物被涂成
 *      overlay 的 rgb——用黑色兜底就是满屏纯黑剪影，这个坑已经踩过一次。
 *      原版 `OverlayTexture` 的默认 UV 指向的就是贴图里一格
 *      「白色、alpha=1」的像素，语义完全一样。
 *
 * @constraint 也不能绑 null。WebGL 里 sampler 指向未绑定的纹理单元时，
 *      部分驱动返回黑色而不是「无」，实体边缘会多出一圈黑边。
 */
let WHITE_OVERLAY: WebGLTexture | null = null
export function emptyOverlayTexture(gl: WebGL2RenderingContext): WebGLTexture {
  if (WHITE_OVERLAY && gl.isTexture(WHITE_OVERLAY)) return WHITE_OVERLAY
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255]),
  )
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
  WHITE_OVERLAY = tex
  return tex
}
