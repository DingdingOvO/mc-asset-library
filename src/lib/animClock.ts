/**
 * 列表卡片的共享动画时钟。
 *
 * @why 每张卡片各开一条 requestAnimationFrame，一屏十几张就是十几条回调，
 *      每条都要重画一遍带超采样的缓冲区，整页从 62fps 掉到十几帧。
 *      所有会动的卡片共用一条时钟，按 Minecraft 的 tick（20 tps）推进，
 *      节奏天然和游戏里的贴图动画对齐。
 * @constraint 没有订阅者必须停掉 rAF：离开列表页后还转着，手机上会一直耗电，
 *      而且浏览器会把整个页面判成"持续动画"，省电模式直接降频。
 */
type Listener = (tick: number) => void

/** 游戏 tick 间隔，Minecraft 固定 20 tps */
const TICK_MS = 50

const listeners = new Set<Listener>()
let handle = 0
let lastTick = -1

function loop(now: number) {
  const tick = Math.floor(now / TICK_MS)
  if (tick !== lastTick) {
    lastTick = tick
    for (const listener of listeners) listener(tick)
  }
  handle = listeners.size > 0 ? requestAnimationFrame(loop) : 0
}

/** 订阅全局 tick；返回值必须调用，否则卡片卸载后回调还在跑 */
export function subscribeTicks(listener: Listener): () => void {
  listeners.add(listener)
  if (handle === 0) handle = requestAnimationFrame(loop)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && handle !== 0) {
      cancelAnimationFrame(handle)
      handle = 0
      lastTick = -1
    }
  }
}
