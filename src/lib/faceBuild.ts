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
 * 动画贴图的完整参数：[帧数, frametime, 回放序列]。
 * @why frametime 决定节奏（水是每 2 tick 一帧，火是每 tick 一帧），序列决定顺序
 *      （岩浆是 0..19 再 18..1 来回）。只有帧数的话，水会快一倍、岩浆会硬循环。
 */
export type TextureAnim = [number, number, number[] | null]

/**
 * 这个方块自己会不会动、按什么节奏动。
 *
 * @why 一个方块常挂多张贴图（水 + 水底、火 + 火苗），各自帧数可能不同。取步数最多的
 *      那张当主控：它决定一遍动画有多长，其余贴图按自己的帧数取模自然循环。
 * @constraint 必须按面实际引用到的纹理下标统计，不能看整个 frames 池——
 *      池里有一千多张静态贴图，取最大值等于让每个方块都以为自己在动。
 */
export function blockAnimOf(
  faces: BakedFace[],
  anims: Record<string, TextureAnim> | undefined,
): { steps: number; frametime: number } | null {
  if (!anims) return null
  let best: { steps: number; frametime: number } | null = null
  const seen = new Set<number>()
  for (const face of faces) {
    const index = face[20] ?? 0
    if (seen.has(index)) continue
    seen.add(index)
    const entry = anims[index]
    if (!entry) continue
    const [frames, frametime, seq] = entry
    const steps = seq && seq.length > 0 ? seq.length : frames
    if (steps <= 1) continue
    if (!best || steps > best.steps) best = { steps, frametime: Math.max(1, frametime) }
  }
  return best
}

/**
 * @param frame 逻辑帧序号（已经按 frametime 折算过的动画步数），静态方块传 0。
 * @constraint 不能拿帧序号直接当贴图帧用：有回放序列的贴图要走序列，
 *             否则岩浆这种「正放 + 倒放」的动画会从中间硬切回第一帧。
 */
export function blockFaces(
  faces: BakedFace[],
  textures: string[],
  anims: Record<string, TextureAnim> | undefined,
  frame = 0,
): Face3D[] {
  const out: Face3D[] = []
  for (const face of faces) {
    const index = face[20] ?? 0
    const tex = textures[index]
    if (!tex) continue
    const anim = anims?.[index]
    let step = 0
    let frameCount = 1
    if (anim) {
      frameCount = anim[0] > 0 ? anim[0] : 1
      const seq = anim[2]
      step = seq && seq.length > 0 ? seq[frame % seq.length]! : ((frame % frameCount) + frameCount) % frameCount
    }
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
