import { useEffect, useState } from 'react'

/**
 * 设备像素比：画布分辨率与屏幕物理像素的对应关系。
 * @why 浏览器缩放（Ctrl +/-）改的是 devicePixelRatio，不是 CSS 像素。之前这个值
 *      到处写死 `Math.min(devicePixelRatio, 2)`，放大到 150% 以上时画布仍是
 *      2 倍分辨率，被浏览器拉伸显示——模型轮廓的矢量边和贴图的像素块一起糊成
 *      一片，看起来"整个立方体变成一堆像素"。边和贴图是两回事：
 *        边 = 三角形光栅化 + 超采样抗锯齿，跟着分辨率走就是锐的；
 *        贴图 = 逐 texel 采样，永远是方块，不该有过渡色。
 *      这两条只有在"画布分辨率 = 屏幕物理分辨率"时才同时成立。
 *
 * @constraint 上限 3。再高只是给 4K 屏白烧内存：76px 的缩略图在 4 倍下是
 *      304px 的画布，一百张卡片就是 900 万个像素的软件光栅化。
 */
export const DPR_MAX = 3

export function currentDpr(limit = DPR_MAX): number {
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, limit)
}

/**
 * 订阅 DPR 变化。
 *
 * @why 浏览器缩放不会触发 resize，也不会让 React 重渲染——画布会一直停在
 *      旧分辨率上，直到用户滚一下列表把它重新挂载。这里用 matchMedia 盯住
 *      当前 DPR 的精确值：一旦不匹配就说明缩放了。
 * @constraint 每次变化后必须重新注册：媒体查询钉死的是"当前这个浓度"，
 *      change 事件只发一次，不再监听就永远收不到第二次。
 */
export function watchDpr(onChange: (next: number) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }
  let alive = true
  let media: MediaQueryList | null = null

  const handle = () => {
    if (!alive) return
    onChange(currentDpr())
    bind()
  }

  function bind() {
    if (!alive) return
    media?.removeEventListener('change', handle)
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener('change', handle)
  }

  bind()
  return () => {
    alive = false
    media?.removeEventListener('change', handle)
  }
}

/**
 * 跟随设备像素比变化的 hook。
 * @constraint 初始值必须在渲染期同步读出来：等 effect 再设会让首帧按 1 倍画，
 *      然后立刻跳成 3 倍重画一次，卡片会闪。
 */
export function useDpr(limit = DPR_MAX): number {
  const [dpr, setDpr] = useState(() => Math.min(currentDpr(), limit))
  useEffect(() => {
    setDpr(Math.min(currentDpr(), limit))
    return watchDpr((next) => setDpr(Math.min(next, limit)))
  }, [limit])
  return dpr
}
