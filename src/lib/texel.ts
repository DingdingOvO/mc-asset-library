/**
 * 纹理像素缓存。
 *
 * @why 光栅化需要逐像素采样，必须拿到 ImageData；用 <img> 只能拿到缩放的位图，
 *      拿不到原始像素。这里统一走 canvas 取一次，之后全程复用。
 */
import type { TexelSource } from './raster'

const cache = new Map<string, Promise<TexelSource | null>>()
/**
 * @why 动画每帧都要纹理，而 loadTexel 是异步的。把已解码的结果另存一份同步表，
 *      渲染循环里直接查，帧内不再产生任何 Promise。
 */
const ready = new Map<string, TexelSource>()

/** 同步取已解码的纹理；未准备好时返回 null */
export function peekTexel(url: string): TexelSource | null {
  return ready.get(url) ?? null
}

function decode(url: string): Promise<TexelSource | null> {
  return new Promise((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) {
        resolve(null)
        return
      }
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(image, 0, 0)
      try {
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
        resolve({ data: data.data, width: canvas.width, height: canvas.height })
      } catch {
        resolve(null)
      }
    }
    image.onerror = () => resolve(null)
    image.src = url
  })
}

export function loadTexel(url: string, attempt = 0): Promise<TexelSource | null> {
  const hit = cache.get(url)
  if (hit) return hit

  const task = decode(url).then((result) => {
    // 网关偶发丢请求，失败的不缓存，下次重试
    if (result) {
      ready.set(url, result)
      return result
    }
    cache.delete(url)
    if (attempt >= 3) return null
    return new Promise<TexelSource | null>((resolve) => {
      setTimeout(() => resolve(loadTexel(url, attempt + 1)), 180 * (attempt + 1))
    })
  })

  cache.set(url, task)
  return task
}
