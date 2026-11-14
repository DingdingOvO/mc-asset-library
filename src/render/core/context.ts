/**
 * 共享 WebGL2 上下文。
 *
 * @why 全站只开一个 GL 上下文，所有画布都从它上面"借"一帧。
 *      浏览器对同时存活的 WebGL 上下文有硬上限（Chrome 16、Firefox 16+），
 *      而这个站点的列表页一屏就有几百个缩略图。一个 canvas 一个上下文的做法
 *      在第 17 个缩略图时就会把最前面的上下文踢掉——表现是翻两页之后
 *      前面的图全变空白，刷新才恢复。
 *
 *      这里的做法：一块离屏 canvas 按需 resize，渲染完立刻 drawImage 拷到
 *      目标 canvas 的 2D 上下文。缩略图只有 64px，一次拷贝几十微秒，
 *      几百个也就几毫秒，比上下文被踢掉的代价小得多。
 *
 * @constraint premultipliedAlpha 必须是 false。原版的混合是
 *      `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`（非预乘），framebuffer 里存的是
 *      非预乘色；声明成预乘会让浏览器在合成时再乘一次 alpha，
 *      半透明的羊毛、玻璃、染色玻璃会明显发暗。
 *
 * @constraint preserveDrawingBuffer 必须是 true。不开的话
 *      `drawImage(glCanvas, ...)` 在合成之后取到的是空缓冲——因为浏览器
 *      默认在 rAF 结束时清空 drawing buffer。表现是"缩略图偶尔全空白"，
 *      而且随刷新时机变化，极难复现。
 */

export interface GlContextOptions {
  antialias?: boolean
}

export class GlContext {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  /** 当前 drawing buffer 尺寸（= 最近一次 resize 的值） */
  width = 0
  height = 0
  /** 是否支持浮点深度纹理（软粒子、深度预通道要用） */
  readonly floatDepth: boolean
  /** 客户端最大采样数 */
  readonly maxSamples: number

  private readonly blitCanvas: HTMLCanvasElement
  private readonly blitCtx: CanvasRenderingContext2D

  constructor(options: GlContextOptions = {}) {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: options.antialias ?? true,
      depth: true,
      stencil: false,
      // 见类注释：不开会拿到空缓冲
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
      desynchronized: false,
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('这个浏览器不支持 WebGL2')

    this.canvas = canvas
    this.gl = gl
    this.floatDepth = !!gl.getExtension('EXT_color_buffer_float')
    this.maxSamples = (gl.getParameter(gl.MAX_SAMPLES) as number) ?? 1

    // 拷贝用的中转 2D canvas。这里不用离屏 canvas 直出，是因为目标
    // 元素本身可能就是 2D 上下文（缩略图、预览都是），drawImage 最快。
    const blit = document.createElement('canvas')
    const blitCtx = blit.getContext('2d')
    if (!blitCtx) throw new Error('无法创建 2D 上下文')
    this.blitCanvas = blit
    this.blitCtx = blitCtx

    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)
    gl.frontFace(gl.CCW)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

    // 丢失上下文时所有 GPU 资源都作废，标记出来让上层重建
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault()
      this.lost = true
    })
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false
    })
  }

  lost = false

  /**
   * 把 drawing buffer 调整到目标尺寸。
   *
   * @constraint 只在尺寸真的变化时才写 width/height。给 canvas.width 赋同一个值
   *      也会让浏览器重建 drawing buffer 并清空内容，几百个同尺寸缩略图
   *      逐个渲染时，这个重建会把前一步刚渲染的东西抹掉。
   */
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (this.width === w && this.height === h) return
    this.canvas.width = w
    this.canvas.height = h
    this.width = w
    this.height = h
    this.gl.viewport(0, 0, w, h)
  }

  /**
   * 把当前帧拷到目标 canvas。
   *
   * @constraint 必须先 resize 目标。目标 canvas 的 CSS 尺寸由外部决定，
   *      但位图尺寸必须和 drawing buffer 一致，否则会被拉伸。
   */
  blitTo(target: HTMLCanvasElement, width: number, height: number): void {
    if (this.lost) return
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    if (target.width !== w) target.width = w
    if (target.height !== h) target.height = h
    const ctx = target.getContext('2d')
    if (!ctx) return
    /**
     * @constraint 拷贝前必须 flush。`drawArrays` 只是把命令排进 GPU 队列，
     *      并不保证后备缓冲已经更新；紧接着的 `drawImage(glCanvas)` 读的是
     *      后备缓冲，命令没执行完就读到上一次 `begin()` 清出来的透明像素。
     *      单张预览时浏览器往往替我们隐式同步，看不出问题；列表里几十张缩略图
     *      连续 render→blit 时，前面几张赶上了，后面全部拷成空白——现象是
     *      "生物列表只有前几个渲染出来"，而管线统计里三角形数完全正常。
     */
    this.gl.flush()
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(this.canvas, 0, 0, this.width, this.height, 0, 0, w, h)
  }

  /** 导出用：当前帧的 ImageData（调用方负责尺寸一致） */
  readPixels(): ImageData {
    const { gl, width, height } = this
    const data = new Uint8ClampedArray(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
    // GL 的原点在左下，ImageData 在左上，逐行翻转
    const flipped = new Uint8ClampedArray(data.length)
    const stride = width * 4
    for (let y = 0; y < height; y += 1) {
      flipped.set(data.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride)
    }
    return new ImageData(flipped, width, height)
  }

  /** 当前帧编码成 PNG Blob */
  toBlob(): Promise<Blob | null> {
    return new Promise((resolve) => {
      this.blitCanvas.width = this.width
      this.blitCanvas.height = this.height
      this.blitCtx.clearRect(0, 0, this.width, this.height)
      this.blitCtx.drawImage(this.canvas, 0, 0)
      this.blitCanvas.toBlob((blob) => resolve(blob), 'image/png')
    })
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

/** 全站唯一实例，按需创建 */
let shared: GlContext | null = null

export function glContext(options?: GlContextOptions): GlContext {
  if (!shared || shared.lost) shared = new GlContext(options)
  return shared
}

/** 探测：不支持 WebGL2 时上层回落到 CPU 光栅化器 */
export function hasWebGl(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const probe = document.createElement('canvas')
    return !!probe.getContext('webgl2')
  } catch {
    return false
  }
}
