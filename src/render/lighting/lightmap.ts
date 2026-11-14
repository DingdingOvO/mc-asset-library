/**
 * 光照图（等价 `net.minecraft.client.renderer.Lightmap` + `lightmap.fsh`）。
 *
 * @why 必须真的做一张 16×16 的光照图，而不是在片元里算一个亮度系数。
 *      原版把「方块光 × 天空光 × 环境光 × 夜视 × 亮度选项」全部烘进这张
 *      小纹理，绘制时只做一次采样。用系数代替会丢掉两件东西：
 *        1. 方块的 16 档明暗台阶（0..15 级光照的分级感）
 *        2. 方块光的暖色调（低亮度时偏橙，高亮度趋白）
 *      这两点正是"火把光看起来是橙的、洞穴深处是暖褐而不是纯黑"的原因。
 *
 * @constraint 光照图必须立即生成并与 `sample_lightmap` 的采样约定对齐：
 *      纹理 x 轴 = 方块光、y 轴 = 天空光。写反的话白天地下会全亮、地表全黑。
 *
 * @constraint 这张纹理不能生成 mipmap，过滤器必须 NEAREST。16×16 的
 *      光照图只有 16 档，任何插值都会把相邻档位糊成中间值，
 *      台阶感消失，画面变"灰蒙蒙"。
 */
import type { TexelSource } from '../core/types'
import type { Texture } from '../core/texture'

/** 与 `lightmap.fsh` 同名的常量 */
export interface LightmapParams {
  /** 天空光强度，白天 1.0，夜晚 0.24 */
  skyFactor: number
  /** 方块光强度，原版是 `blockLightFlicker + 1.4` */
  blockFactor: number
  /** 夜视强度 0..1 */
  nightVision: number
  /** 黑暗效果（监守者、幽匿）0..1，直接减色 */
  darknessScale: number
  /** Boss 血条存在时的整体压暗 0..1 */
  bossOverlay: number
  /** 亮度选项（gamma），0..1，原版默认 0.5 */
  brightness: number
}

export const DEFAULT_LIGHTMAP: LightmapParams = {
  skyFactor: 1,
  blockFactor: 1.4,
  nightVision: 0,
  darknessScale: 0,
  bossOverlay: 0,
  brightness: 0.5,
}

/** `ARGB.vector3fFromRGB24(-10100)` = 0xFFD88C，方块光的暖色基准 */
const BLOCK_LIGHT_TINT: [number, number, number] = [255 / 255, 216 / 255, 140 / 255]
/** `ARGB.vector3fFromRGB24(-1)` = 0xFFFFFF */
const SKY_LIGHT_COLOR: [number, number, number] = [1, 1, 1]
/** `ARGB.vector3fFromRGB24(-16777216)` = 0xFF000000，RGB 全 0 */
const AMBIENT_COLOR: [number, number, number] = [0, 0, 0]
/** `ARGB.vector3fFromRGB24(-6710887)` = 0xFF999999 */
const NIGHT_VISION_COLOR: [number, number, number] = [0.6, 0.6, 0.6]

/**
 * 原版 `get_brightness`：把 0..1 的档位压成非线性曲线。
 *
 * @why 不是 `level` 本身。光照等级是感知量，0 级和 1 级的差别远大于
 *      14 级和 15 级。这条曲线 `l / (4 - 3l)` 让低等级之间的跳变更明显，
 *      高等级几乎拉平——不做这一步，洞穴里每一档都是一样的暗。
 */
function brightnessOf(level: number): number {
  return level / (4 - 3 * level)
}

/**
 * 原版 `notGamma`：把线性色往感知均匀方向推一点。
 *
 * @why 严格说这是"去 gamma"而不是"加 gamma"，名字反着但公式是对的：
 *      先找出最大分量，按 `1-(1-m)^4` 抬升，再按比例缩放回去。
 *      作用是保住暗部层次，不让深色方块糊成一块纯黑。
 */
function notGamma(color: [number, number, number]): [number, number, number] {
  const maxComponent = Math.max(color[0], color[1], color[2])
  if (maxComponent <= 0) return [0, 0, 0]
  const maxInverted = 1 - maxComponent
  const maxScaled = 1 - maxInverted * maxInverted * maxInverted * maxInverted
  const scale = maxScaled / maxComponent
  return [color[0] * scale, color[1] * scale, color[2] * scale]
}

/** 生成 16×16 光照图的像素数据 */
export function buildLightmap(params: LightmapParams = DEFAULT_LIGHTMAP): TexelSource {
  const size = 16
  const data = new Uint8ClampedArray(size * size * 4)
  const nightVisionColor: [number, number, number] = [
    NIGHT_VISION_COLOR[0] * params.nightVision,
    NIGHT_VISION_COLOR[1] * params.nightVision,
    NIGHT_VISION_COLOR[2] * params.nightVision,
  ]

  for (let sky = 0; sky < size; sky += 1) {
    for (let block = 0; block < size; block += 1) {
      const blockLevel = block / 15
      const skyLevel = sky / 15

      const blockBrightness = brightnessOf(blockLevel) * params.blockFactor
      const skyBrightness = brightnessOf(skyLevel) * params.skyFactor

      let r = Math.max(AMBIENT_COLOR[0], nightVisionColor[0])
      let g = Math.max(AMBIENT_COLOR[1], nightVisionColor[1])
      let b = Math.max(AMBIENT_COLOR[2], nightVisionColor[2])

      r += SKY_LIGHT_COLOR[0] * skyBrightness
      g += SKY_LIGHT_COLOR[1] * skyBrightness
      b += SKY_LIGHT_COLOR[2] * skyBrightness

      // 方块光低强度时偏暖，高强度时趋白。抛物线的顶点在 0 和 1，中间最深。
      const parabola = (2 * blockLevel - 1) * (2 * blockLevel - 1)
      const mixToWhite = 0.9 * parabola
      const blockR = BLOCK_LIGHT_TINT[0] + (1 - BLOCK_LIGHT_TINT[0]) * mixToWhite
      const blockG = BLOCK_LIGHT_TINT[1] + (1 - BLOCK_LIGHT_TINT[1]) * mixToWhite
      const blockB = BLOCK_LIGHT_TINT[2] + (1 - BLOCK_LIGHT_TINT[2]) * mixToWhite
      r += blockR * blockBrightness
      g += blockG * blockBrightness
      b += blockB * blockBrightness

      if (params.bossOverlay > 0) {
        r += (r * 0.7 - r) * params.bossOverlay
        g += (g * 0.6 - g) * params.bossOverlay
        b += (b * 0.6 - b) * params.bossOverlay
      }

      r -= params.darknessScale
      g -= params.darknessScale
      b -= params.darknessScale

      r = Math.min(1, Math.max(0, r))
      g = Math.min(1, Math.max(0, g))
      b = Math.min(1, Math.max(0, b))

      const lifted = notGamma([r, g, b])
      const t = params.brightness
      r = r + (lifted[0] - r) * t
      g = g + (lifted[1] - g) * t
      b = b + (lifted[2] - b) * t

      const index = (sky * size + block) * 4
      data[index] = Math.round(Math.min(1, r) * 255)
      data[index + 1] = Math.round(Math.min(1, g) * 255)
      data[index + 2] = Math.round(Math.min(1, b) * 255)
      data[index + 3] = 255
    }
  }

  return { data, width: size, height: size }
}

/** 白天 / 夜晚 / 洞穴三种常用预设 */
export const LIGHTMAP_PRESETS = {
  day: { ...DEFAULT_LIGHTMAP },
  night: { ...DEFAULT_LIGHTMAP, skyFactor: 0.24 },
  /** 洞穴：没有天空光，只有火把能照亮 */
  cave: { ...DEFAULT_LIGHTMAP, skyFactor: 0 },
  /** 展示用：全亮，颜色最接近贴图原色 */
  flat: { ...DEFAULT_LIGHTMAP, skyFactor: 1, blockFactor: 1.4, brightness: 1 },
} satisfies Record<string, LightmapParams>

/** 光照图纹理管理器：参数变了才重新上传 */
export class LightmapTexture {
  private current: Texture | null = null
  private key = ''

  constructor(
    private readonly factory: (source: TexelSource) => Texture,
    initial: LightmapParams = DEFAULT_LIGHTMAP,
  ) {
    this.update(initial)
  }

  get texture(): Texture {
    return this.current!
  }

  update(params: LightmapParams): void {
    const key = [
      params.skyFactor,
      params.blockFactor,
      params.nightVision,
      params.darknessScale,
      params.bossOverlay,
      params.brightness,
    ].join('|')
    if (key === this.key && this.current) return
    this.key = key
    this.current?.dispose()
    this.current = this.factory(buildLightmap(params))
  }

  dispose(): void {
    this.current?.dispose()
    this.current = null
  }
}
