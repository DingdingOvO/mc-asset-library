/**
 * 一个实体「到底会做什么动作」。
 *
 * @why 之前所有生物都挂着「站立 / 走动 / 行走 / 奔跑」四个档，船、鱿鱼、恶魂
 *      也在里面——它们根本没有腿。档位必须按模型真实用到的驱动量给出：
 *      桨看 rowingTime、翅膀看 flapTime、鱼和乌贼看触手角、四足和人形才看
 *      walkAnimation。用户点开就知道这是什么动作，也不用瞎猜参数。
 */
import type { AnimFile, Poser } from './anim'
import { classSource, walkCycle } from './anim'

export type MotionKind = 'walk' | 'fly' | 'swim' | 'row' | 'hop' | 'idle' | 'static'

export interface MotionStop {
  value: number
  label: string
}

export interface Motion {
  kind: MotionKind
  /** 底栏标签：内容在动什么，就写什么 */
  label: string
  stops: MotionStop[]
  /** 默认档 */
  initial: number
  /** 一个完整周期的秒数，导出时长按它的整数倍对齐；null 表示测不出来 */
  cycle: number | null
}

const PRESETS: Record<MotionKind, { label: string; stops: MotionStop[] }> = {
  walk: {
    label: '骨骼动作 · 行走步态',
    stops: [
      { value: 0, label: '站立' },
      { value: 0.55, label: '走动' },
      { value: 1, label: '行走' },
      { value: 1.6, label: '奔跑' },
    ],
  },
  fly: {
    label: '骨骼动作 · 振翅',
    stops: [
      { value: 0, label: '悬停' },
      { value: 0.6, label: '慢飞' },
      { value: 1.2, label: '快飞' },
    ],
  },
  hop: {
    label: '骨骼动作 · 跳跃',
    stops: [
      { value: 0, label: '蹲伏' },
      { value: 0.7, label: '小跳' },
      { value: 1.4, label: '连跳' },
    ],
  },
  swim: {
    label: '骨骼动作 · 游动',
    stops: [
      { value: 0, label: '静止' },
      { value: 0.7, label: '游动' },
      { value: 1.4, label: '疾游' },
    ],
  },
  row: {
    label: '骨骼动作 · 划桨',
    stops: [
      { value: 0, label: '漂浮' },
      { value: 0.6, label: '慢划' },
      { value: 1.2, label: '快划' },
    ],
  },
  idle: {
    label: '骨骼动作 · 待机',
    stops: [{ value: 1, label: '待机' }],
  },
  static: {
    label: '静态模型 · 转台预览',
    stops: [],
  },
}

/**
 * 从转译后的动作代码反推驱动量。
 *
 * @constraint 顺序不能乱：船/螃蟹这类既有桨又有腿的，先看桨；青蛙既游又走，
 *      先看走。判错只影响标签与档位，不影响动作本身。
 */
export function detectMotion(modelClass: string | null, anim: AnimFile | null, animated: boolean): MotionKind {
  if (!animated || !modelClass || !anim) return 'static'
  const code = classSource(modelClass, anim)
  if (!code.trim()) return 'static'
  if (/rowingTime/.test(code)) return 'row'
  if (/walkAnimation(Pos|Speed)|limbSwing/.test(code)) return 'walk'
  if (/flapTime|flapSpeed|\.flap\b/.test(code)) return 'fly'
  // @why 蝙蝠这类把整套动作写成关键帧（BAT_FLYING），代码里连 walkAnimation
  //      都没有；动画名里带「飞」就该给飞的档位，而不是退回待机
  if (/__kfApply\("(BAT|PHANTOM|BEE|ALLAY|PARROT|GHAST)?_?\w*(FLY|FLYING)"/.test(code)) return 'fly'
  // @why 兔子的整套腿脚动作只有一个 HOP 关键帧，代码里没有步行相位，
  //      按名字判断比按驱动量猜更准
  if (/__kfApply\("\w*HOP"/.test(code)) return 'hop'
  if (/tentacleAngle|isSwimming|swimAmount|swimAnimation/.test(code)) return 'swim'
  return 'idle'
}

/**
 * 数出一个动作的周期。
 *
 * @why 导出循环视频/动图时播放时长必须是周期的整数倍，否则末帧接回首帧会跳相位
 *      （腿停在半空）。各模型的驱动频率天差地别（桨 7rad/s、翅膀按 flapTime、
 *      行走 cos(0.6662·pos)），算不出统一公式，直接从姿势序列里量：
 *      取所有部件角度之和当指纹，找自相关最小的滞后。
 */
export function measureCycle(poser: Poser, speed: number, max = 4): number | null {
  const rate = 30
  const count = Math.round(max * rate)
  const signal = new Float32Array(count)
  for (let i = 0; i < count; i += 1) {
    const poses = poser.pose({ t: i / rate, speed, pitch: 0, yaw: 0 })
    let sum = 0
    for (const pose of poses.values()) {
      sum += pose.xRot + pose.yRot * 1.31 + pose.zRot * 1.73 + pose.x * 0.07 + pose.y * 0.05
    }
    signal[i] = sum
  }

  let min = Infinity
  let maxValue = -Infinity
  for (const value of signal) {
    if (value < min) min = value
    if (value > maxValue) maxValue = value
  }
  const range = maxValue - min
  if (!(range > 1e-4)) return null

  let bestLag = -1
  let bestScore = Infinity
  const shortest = Math.round(0.2 * rate)
  for (let lag = shortest; lag <= Math.floor(count / 2); lag += 1) {
    let diff = 0
    for (let i = 0; i + lag < count; i += 1) diff += Math.abs(signal[i]! - signal[i + lag]!)
    const score = diff / (count - lag) / range
    if (score < bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  return bestScore < 0.03 && bestLag > 0 ? bestLag / rate : null
}

export function motionOf(
  modelClass: string | null,
  anim: AnimFile | null,
  animated: boolean,
  poser: Poser | null,
): Motion {
  const kind = detectMotion(modelClass, anim, animated)
  const preset = PRESETS[kind]
  const initial = kind === 'walk' || kind === 'idle' ? 1 : kind === 'static' ? 0 : preset.stops[1]?.value ?? 0
  let cycle: number | null = null
  if (poser && kind !== 'static') {
    cycle = measureCycle(poser, initial) ?? (kind === 'walk' ? walkCycle(initial, false) : null)
  }
  return { kind, label: preset.label, stops: preset.stops, initial, cycle }
}
