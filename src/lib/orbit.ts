/**
 * 转台：把指针位移、惯性滑行、外部跳转统一成每帧一个角度。
 *
 * @why 之前角度由三处同时维护（指针直接改目标、渲染循环做平滑、父组件的
 *      state 再回灌一次），任何一处改动都会让拖动"黏手"或"抽搐"。
 *      这里只有一个状态机：谁在驱动角度是显式的，别的路径不许写 rx/ry。
 *
 * @constraint 所有与时间有关的量都用「度/秒」和 `exp(-dt/τ)`，不用「每帧乘 0.9」。
 *      逐帧衰减在 60Hz 与 144Hz 上是两种手感，同一个页面在两台机器上滑行距离
 *      差一倍多。
 */

/** 俯仰上下限：到 90° 会万向锁，模型翻过去之后方向键全反 */
export const PITCH_LIMIT = 86

/** 拖动灵敏度：每像素多少度。横向比纵向大一点，符合"甩一圈"的直觉 */
export const YAW_PER_PX = 0.55
export const PITCH_PER_PX = 0.42

/** 松手后角速度的衰减时间常数（秒）。滑行距离 ≈ v·τ */
export const GLIDE_TAU = 0.18
/** 低于这个角速度（度/秒）就停，省得无限趋近 0 一直重绘 */
export const GLIDE_STOP = 12
/** 松手瞬间的角速度上限（度/秒）。不限的话一次瞬移能转到下个世纪 */
export const GLIDE_MAX = 700
/** 算松手速度用的回看窗口（毫秒）。太短会被末帧抖到，太长会把停顿也算成速度 */
export const GLIDE_WINDOW = 120

/** 外部跳转（滑块、重置）的平滑时间常数（秒）。大了显得拖沓，小了像瞬移 */
export const SEEK_TAU = 0.1

export type OrbitMode = 'idle' | 'drag' | 'glide' | 'seek'

export interface OrbitState {
  /** 当前角度（度） */
  rx: number
  ry: number
  /** 目标角度（度）。glide 时由速度积分推进，seek 时由外部给定 */
  trx: number
  try: number
  /** 角速度（度/秒），只在 glide 里有意义 */
  vrx: number
  vry: number
  mode: OrbitMode
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 把水平角收进 (-180, 180]。
 *
 * @why 拖动会一直累加（转三圈就是 1080°），但父组件的滑块只有 -180..180。
 *      上报前归一化，滑块才不会顶在端点不动、跟模型对不上。
 * @constraint 内部状态不要归一化：归一化后再累加，转一圈会从 179 直接跳到 -179，
 *      中间那一帧画面会倒撇一下。
 */
export function normalizeYaw(deg: number): number {
  const wrapped = ((deg % 360) + 360) % 360
  return wrapped > 180 ? wrapped - 360 : wrapped
}

/**
 * 与角度 b 等价、但离 a 最近的角度。
 *
 * @why 从 720° 拖到 30° 时不能让它倒转 690°：取同余里最近的那个，
 *      视觉上就是"往回转一点点"。
 */
export function nearestYaw(current: number, target: number): number {
  return target + 360 * Math.round((current - target) / 360)
}

/** 两个角度的环形差值（-180..180），用来判断"是不是同一个朝向" */
export function yawGap(a: number, b: number): number {
  return normalizeYaw(a - b)
}

export function createOrbit(rx: number, ry: number): OrbitState {
  return { rx, ry, trx: rx, try: ry, vrx: 0, vry: 0, mode: 'idle' }
}

/** 立刻落位，清掉速度。换模型、外部强制设值时用 */
export function snapOrbit(state: OrbitState, rx: number, ry: number): void {
  state.rx = rx
  state.ry = ry
  state.trx = rx
  state.try = ry
  state.vrx = 0
  state.vry = 0
  state.mode = 'idle'
}

/** 平滑转到某角度。滑块拖动、重置按钮用 */
export function seekOrbit(state: OrbitState, rx: number, ry: number): void {
  state.trx = rx
  state.try = ry
  state.vrx = 0
  state.vry = 0
  state.mode = 'seek'
}

/**
 * 指针按下：进入拖动，清掉残余惯性。
 *
 * @why 必须清速度：上一甩的滑行还没停就按下去，模型会继续朝旧方向漂，
 *      手指还没动模型先动，这就是"抓不住"的来源。
 */
export function beginDrag(state: OrbitState): void {
  state.vrx = 0
  state.vry = 0
  state.mode = 'drag'
}

/**
 * 指针位移 → 角度。
 *
 * @constraint 拖动期间角度必须 1:1 跟随，不能做低通平滑。40ms 的平滑在
 *      手指停下时还在追，看着像"模型被橡皮筋拖着"。
 * @constraint 这里不算速度。逐帧差分会把"松手前最后一帧零位移"当成静止，
 *      甩出去的惯性全部丢掉——那一下松手毫无余韵，是手感差的主因。
 *      速度改由调用方按时间窗口算（见 endDrag）。
 */
export function dragOrbit(state: OrbitState, dx: number, dy: number): void {
  const nextTrx = clamp(state.trx + dy * PITCH_PER_PX, -PITCH_LIMIT, PITCH_LIMIT)
  const nextTry = state.try + dx * YAW_PER_PX
  state.trx = nextTrx
  state.try = nextTry
  state.rx = nextTrx
  state.ry = nextTry
  state.mode = 'drag'
}

/**
 * 松手：把松手前的平均速度交给滑行。
 *
 * @param yawV 水平角速度（度/秒）
 * @param pitchV 俯仰角速度（度/秒）
 */
export function endDrag(state: OrbitState, yawV: number, pitchV: number): void {
  const vry = clamp(yawV, -GLIDE_MAX, GLIDE_MAX)
  /**
   * @constraint 俯仰已经顶到边界时不能带速度：模型会贴着 ±86° 抖一下再弹回来。
   */
  const atLimit = state.trx <= -PITCH_LIMIT + 1e-6 || state.trx >= PITCH_LIMIT - 1e-6
  const vrx = atLimit ? 0 : clamp(pitchV, -GLIDE_MAX, GLIDE_MAX)
  if (Math.abs(vrx) < GLIDE_STOP && Math.abs(vry) < GLIDE_STOP) {
    state.vrx = 0
    state.vry = 0
    state.mode = 'idle'
    return
  }
  state.vrx = vrx
  state.vry = vry
  state.mode = 'glide'
}

/** 是否还在动（渲染循环据此决定要不要继续请求帧） */
export function orbitBusy(state: OrbitState): boolean {
  return state.mode === 'drag' || state.mode === 'glide' || state.mode === 'seek'
}

/**
 * 推进一帧。
 *
 * @param dt 秒
 * @returns 角度是否发生变化
 */
export function stepOrbit(state: OrbitState, dt: number): boolean {
  if (state.mode === 'drag') return false

  if (state.mode === 'glide') {
    // 帧率无关的指数衰减：dt 越大衰减越多，总滑行距离与帧率无关
    const decay = Math.exp(-dt / GLIDE_TAU)
    state.trx = clamp(state.trx + state.vrx * dt, -PITCH_LIMIT, PITCH_LIMIT)
    state.try += state.vry * dt
    state.vrx *= decay
    state.vry *= decay
    // 顶到边界就把该轴的速度吃掉，否则会贴着边界抖
    if (state.trx <= -PITCH_LIMIT || state.trx >= PITCH_LIMIT) state.vrx = 0
    if (Math.abs(state.vrx) < GLIDE_STOP && Math.abs(state.vry) < GLIDE_STOP) {
      state.vrx = 0
      state.vry = 0
      state.mode = 'idle'
    }
  } else if (state.mode === 'seek') {
    const ease = 1 - Math.exp(-dt / SEEK_TAU)
    state.rx += (state.trx - state.rx) * ease
    state.ry += (state.try - state.ry) * ease
    if (Math.abs(state.trx - state.rx) < 0.05 && Math.abs(state.try - state.ry) < 0.05) {
      state.rx = state.trx
      state.ry = state.try
      state.mode = 'idle'
    }
    return true
  } else {
    return false
  }

  const before = state.rx
  state.rx = state.trx
  state.ry = state.try
  return Math.abs(state.rx - before) > 1e-4
}
