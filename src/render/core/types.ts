/**
 * 渲染层的基础类型。
 *
 * @why 不直接复用 `src/lib/raster.ts` 的 TexelSource：软件光栅化器和 GPU
 *      管线是两条互不依赖的路径，共用类型会让删掉其中一条时另一条断掉。
 *      结构一致，各自声明。
 */

/** 一张解码后的贴图像素 */
export interface TexelSource {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 三维点，y 向上，单位格 */
export type Vec3 = [number, number, number]

/** 4×4 列主序矩阵（与 JOML / OpenGL 一致，16 个元素） */
export type Mat4 = Float32Array

/** 光照坐标：原版的 UV2，把方块光与天空光打包成两个整数 */
export interface LightUV {
  /** 方块光 0..15，乘 16 后落在低字节 */
  block: number
  /** 天空光 0..15，乘 16 后落在高字节 */
  sky: number
}

/** 光照图的固定档位：原版是 16×16，所以 0..15 */
export const LIGHT_STEPS = 16

/**
 * 打包成原版 UV2 的格式。
 *
 * @constraint 低位是方块光、高位是天空光，和 `LightTexture` 里的
 *      `blockLight | skyLight << 16` 一致。反了的话白天背光面会全黑，
 *      因为采样点被钳在光照图的错误角落。
 */
export function packLight(uv: LightUV): [number, number] {
  return [uv.block * 16, uv.sky * 16]
}
