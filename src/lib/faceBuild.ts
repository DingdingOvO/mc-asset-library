/**
 * 把烘焙好的面数据（23 字段的紧凑数组）转成场景要的 Face3D。
 *
 * @why 烘焙格式为的是体积小、传输快，直接在渲染循环里解包会让代码到处是魔法下标。
 *      在这里一次性翻译成带名字的对象，渲染层就干净了。
 */
import type { BakedFace } from './blockmodels'
import type { Face3D } from './scene'

/**
 * 群系着色：草、树叶、水在资源包里是灰度图，颜色由代码乘上去。
 * @constraint 游戏里草地颜色取自当前群系（平原是 0x91BD59），这里固定成平原，
 *             否则同一张灰度图会在不同方块上出现不同颜色，看着像 bug。
 */
const TINTS: Record<number, [number, number, number]> = {
  0: [0.568, 0.741, 0.349],
  1: [0.467, 0.671, 0.278],
  2: [0.247, 0.463, 0.894],
  /** 水：0x3F76E4，和 2 同色但分开写——2 是「水方块」的历史色调，3 给液体立方体用 */
  3: [0.247, 0.463, 0.894],
}

/**
 * 动画贴图的总帧数。
 *
 * @why 资源包里的动画贴图是一张竖条 PNG（16×512 就是 32 帧 × 16px），帧数来自
 *      .mcmeta 的 animation.frames，烘焙时记进 frames 池。取最大值就能判断
 *      "这个方块自己会动"，不用逐面看。
 */
export function frameCountOf(frames: number[] | undefined): number {
  if (!frames || frames.length === 0) return 1
  let max = 1
  for (const count of frames) if (count > max) max = count
  return max
}

/**
 * @param frame 当前贴图帧。只有 .mcmeta 动画贴图（水、岩浆、火、海带…）用到，
 *              静态方块固定传 0。uv 的 v 烘焙时是「相对整条竖图」的 0..1，
 *              所以取第 n 帧就是 (v + n) / 总帧数。
 */
export function blockFaces(
  faces: BakedFace[],
  textures: string[],
  frames: number[],
  frame = 0,
): Face3D[] {
  const out: Face3D[] = []
  for (const face of faces) {
    const index = face[20] ?? 0
    const tex = textures[index]
    if (!tex) continue
    const frameCount = frames[index] ?? 1
    const step = frameCount > 1 ? frame % frameCount : 0
    const tintIndex = face[21] ?? -1
    const uv: number[] = []
    for (let i = 0; i < 4; i += 1) {
      uv.push(face[12 + i * 2] ?? 0, ((face[13 + i * 2] ?? 0) + step) / frameCount)
    }
    out.push({
      pts: [face[0]!, face[1]!, face[2]!, face[3]!, face[4]!, face[5]!, face[6]!, face[7]!, face[8]!, face[9]!, face[10]!, face[11]!],
      uv,
      tex,
      tint: tintIndex >= 0 ? TINTS[tintIndex] : undefined,
      shade: (face[22] ?? 1) === 1,
    })
  }
  return out
}
