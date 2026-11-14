/**
 * 着色器变体开关。
 *
 * @constraint `#define` 必须插在 `#version` 之后。GLSL 规范要求
 *      `#version` 是源码里第一条非注释语句，一旦有 `#define` 出现在它前面，
 *      编译器直接判 `#version` 非法，报的错还指在版本行上，很容易看走眼。
 */
export function withDefines(source: string, defines: Record<string, string | number | true>): string {
  const entries = Object.entries(defines)
  if (entries.length === 0) return source
  const lines = entries
    .map(([key, value]) => (value === true ? `#define ${key}` : `#define ${key} ${value}`))
    .join('\n')
  return source.replace(/^(#version[^\n]*\n)/, `$1${lines}\n`)
}

/** 预先声明好的变体，避免各处手写 define 组合时拼错 */
export const VARIANT = {
  /** 实体：按面法线分正反面光照（原版 DEFAULT） */
  perFaceLighting: { PER_FACE_LIGHTING: true },
  /** 实体：剔除 alpha 低于阈值的像素（头盔、箭、蛛网） */
  cutout: (threshold: number) => ({ ALPHA_CUTOUT: threshold.toFixed(3) }),
  /** 地形：不做剔除，用于不透明方块 */
  opaque: {},
} as const
