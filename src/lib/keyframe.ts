/**
 * 关键帧动画求值。
 *
 * @why 26.3 起大量动物把动作从 setupAnim 里的三角函数搬到了 AnimationDefinition：
 *      驼骆的腿、青蛙的跳跃、铜傀儡的走姿都写成关键帧，模型只调
 *      `this.walkAnimation.applyWalk(...)`。不实现这一层，那些生物就永远是
 *      "只有脑袋跟着转"的雕像——腿在本体上，头在子部件上。
 *
 * @constraint 数值全部在提取阶段烘平：角度已转弧度、posVec 的 y 已取负、
 *      scaleVec 已减 1。这里只做插值，不再做单位换算，避免两边不一致。
 */
import type { PartPose } from './entityRig'

export interface KeyChannel {
  target: 'ROTATION' | 'POSITION' | 'SCALE'
  /** [时间(秒), x, y, z, 插值] */
  keys: (number | string)[][]
}

export interface KeyDefinition {
  length: number
  loop: boolean
  bones: Record<string, KeyChannel>
}

export type KeyDefinitions = Record<string, KeyDefinition>

/** joml/Mth 的 catmull-rom，与 AnimationChannel.Interpolations.CATMULLROM 一致 */
function catmullrom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  )
}

interface Frame {
  time: number
  x: number
  y: number
  z: number
  ease: string
}

function framesOf(channel: KeyChannel): Frame[] {
  return channel.keys.map((key) => ({
    time: Number(key[0]),
    x: Number(key[1]),
    y: Number(key[2]),
    z: Number(key[3]),
    ease: String(key[4] ?? 'linear'),
  }))
}

/**
 * 在某个时刻采样一条通道。
 * @param amplitude 0..1，行走速度决定的幅度；0 就是完全不动
 */
export function sampleChannel(channel: KeyChannel, seconds: number, amplitude: number): [number, number, number] {
  const frames = framesOf(channel)
  if (frames.length === 0) return [0, 0, 0]
  if (frames.length === 1) {
    const only = frames[0]!
    return [only.x * amplitude, only.y * amplitude, only.z * amplitude]
  }

  // 找 prev / next：第一帧之前用第一帧，最后一帧之后用最后一帧
  let prev = 0
  while (prev < frames.length - 1 && frames[prev + 1]!.time <= seconds) prev += 1
  const next = Math.min(frames.length - 1, prev + 1)
  const a = frames[prev]!
  const b = frames[next]!
  const span = b.time - a.time
  const alpha = span > 1e-6 ? Math.min(1, Math.max(0, (seconds - a.time) / span)) : 0

  if (a.ease === 'catmullrom') {
    const p0 = frames[Math.max(0, prev - 1)]!
    const p3 = frames[Math.min(frames.length - 1, next + 1)]!
    return [
      catmullrom(alpha, p0.x, a.x, b.x, p3.x) * amplitude,
      catmullrom(alpha, p0.y, a.y, b.y, p3.y) * amplitude,
      catmullrom(alpha, p0.z, a.z, b.z, p3.z) * amplitude,
    ]
  }
  return [
    (a.x + (b.x - a.x) * alpha) * amplitude,
    (a.y + (b.y - a.y) * alpha) * amplitude,
    (a.z + (b.z - a.z) * alpha) * amplitude,
  ]
}

/**
 * 把一条关键帧动画叠加到当前姿势上。
 *
 * @constraint 是「叠加」不是「覆盖」：模型的 setupAnim 先摆好基础姿势，
 *      关键帧再在其上加减（对应 ModelPart.offsetRotation/offsetPos）。
 *      覆盖会把前面算好的头部朝向、手臂姿势全部抹掉。
 */
export function applyKeyframes(
  definition: KeyDefinition,
  poses: Map<string, PartPose>,
  seconds: number,
  amplitude: number,
): void {
  const time = definition.loop && definition.length > 0 ? seconds % definition.length : seconds
  if (amplitude <= 0) return
  for (const [bone, channel] of Object.entries(definition.bones)) {
    const pose = poses.get(bone)
    if (!pose) continue
    const [x, y, z] = sampleChannel(channel, time, amplitude)
    if (channel.target === 'ROTATION') {
      pose.xRot += x
      pose.yRot += y
      pose.zRot += z
    } else if (channel.target === 'POSITION') {
      // @constraint 关键帧的位移是模型单位（16 = 一格），ModelPart 的 x/y/z 也是，
      //              不需要换算；y 已经在提取时取过负。
      pose.x += x
      pose.y += y
      pose.z += z
    } else {
      pose.xScale += x
      pose.yScale += y
      pose.zScale += z
    }
  }
}
