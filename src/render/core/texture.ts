/**
 * 纹理上传与缓存。
 *
 * @constraint mag 必须是 NEAREST。整个站点的立足点是像素风贴图，
 *      mag=LINEAR 会把 16×16 的贴图放大成一团糊，边角出现灰边。
 *
 * @constraint min 必须是 NEAREST_MIPMAP_LINEAR 而不是 NEAREST。
 *      远距离的方块（地形区块边缘、缩小到 64px 的缩略图）一个纹素
 *      覆盖不到一个屏幕像素，只点采样会随机跳纹素，画面上是持续闪烁的
 *      彩色噪点——这跟 Sodium 的 RGSS 要解决的问题是同一个。
 *      mipmap 提供正确的预滤波，RGSS 再在其上做旋转网格采样。
 *
 * @constraint 必须有 ANISOTROPY 才在小角度斜面上不糊。原版没开，
 *      但那是因为它按区块合并网格、面朝向稳定；我们的相机可以自由旋转，
 *      地面在掠射角下没有各向异性过滤会拉成一片糊。
 */
import type { TexelSource } from './types'

export interface TextureOptions {
  /** 是否生成 mipmap（RGSS 与远处地形需要） */
  mipmap?: boolean
  /** 各向异性等级，默认取硬件上限 */
  anisotropy?: number
  /** 重复模式，地形方块面需要 REPEAT 才能平铺 */
  wrap?: 'clamp' | 'repeat'
}

export class Texture {
  readonly texture: WebGLTexture
  /** 逻辑尺寸（贴图原始像素） */
  readonly width: number
  readonly height: number

  constructor(
    private readonly gl: WebGL2RenderingContext,
    source: TexelSource,
    options: TextureOptions = {},
  ) {
    const tex = gl.createTexture()
    if (!tex) throw new Error('创建纹理失败')
    this.texture = tex
    this.width = source.width
    this.height = source.height

    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      source.width,
      source.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(source.data.buffer, source.data.byteOffset, source.data.byteLength),
    )

    const wrap = options.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)

    if (options.mipmap !== false) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_LINEAR)
      gl.generateMipmap(gl.TEXTURE_2D)
      const ext = gl.getExtension('EXT_texture_filter_anisotropic')
      if (ext) {
        const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(max, options.anisotropy ?? max))
      }
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    }
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture)
  }
}

/**
 * 纹理缓存：同一个路径只上传一次。
 *
 * @why 一个生物的每一层、一个方块的每个面都指向同一张贴图；不缓存的话
 *      1024×1024 的实体图集每帧被 texImage2D 上传几十次，
 *      光上传就要吃掉整个帧预算。
 */
export class TextureCache {
  private readonly byKey = new Map<string, Texture | null>()
  private readonly loader: (key: string) => Promise<TexelSource | null>
  private readonly options: TextureOptions

  constructor(
    private readonly gl: WebGL2RenderingContext,
    loader: (key: string) => Promise<TexelSource | null>,
    options: TextureOptions = {},
  ) {
    this.loader = loader
    this.options = options
  }

  /** 同步取：没上传过返回 null（让调用方决定是否等待） */
  peek(key: string): Texture | null {
    return this.byKey.get(key) ?? null
  }

  async get(key: string): Promise<Texture | null> {
    const hit = this.byKey.get(key)
    if (hit !== undefined) return hit
    // 先占位，避免同一张贴图被并发上传多次
    this.byKey.set(key, null)
    const source = await this.loader(key)
    if (!source) return null
    const tex = new Texture(this.gl, source, this.options)
    this.byKey.set(key, tex)
    return tex
  }

  dispose(): void {
    for (const tex of this.byKey.values()) tex?.dispose()
    this.byKey.clear()
  }
}
