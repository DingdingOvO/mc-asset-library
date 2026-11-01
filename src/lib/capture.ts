/**
 * 逐帧截图与视频导出。
 *
 * @why MP4 走 WebCodecs + mp4-muxer：MediaRecorder 只能录 webm，而 webm 在
 *      Premiere、Keynote、微信里都放不了。用户要的是"能直接用的素材"。
 *      GIF 走 gifenc，自己写 LZW 和调色板量化不值得。
 *
 * @constraint 逐帧渲染而不是录屏：录屏受实际帧率影响，机器一卡视频就抖；
 *      逐帧渲染保证每一帧的动画时间戳精确等于 i / fps，导出结果和预览一致。
 */
import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { encodeApng, type ApngFrame } from './apng'
import { muxAnimatedWebp, type WebpFrame } from './webp'
import { makeZip, type ZipEntry } from './zip'

export type Backdrop = 'none' | 'green' | 'blue' | 'white' | 'red' | 'dark'

export const BACKDROPS: { id: Backdrop; label: string; color: string | null }[] = [
  { id: 'none', label: '透明', color: null },
  { id: 'green', label: '绿幕', color: '#00b140' },
  { id: 'blue', label: '蓝幕', color: '#0047bb' },
  { id: 'white', label: '白底', color: '#ffffff' },
  { id: 'red', label: '红幕', color: '#cf1322' },
  { id: 'dark', label: '深色', color: '#14141a' },
]

export type CaptureFormat = 'mp4' | 'webp' | 'apng' | 'gif' | 'png'

export interface FormatMeta {
  id: CaptureFormat
  label: string
  /** 悬停提示 */
  hint: string
  /** 能不能带真透明通道 */
  alpha: boolean
  /** 一句话说明，界面上直接显示 */
  note: string
}

/**
 * @why 透明能力写在数据里而不是散在组件里做 if：能不能选"透明"背景、
 *      提示文案怎么写、文件后缀是什么，全都由这一张表推出来，
 *      以后加格式不用再去改三处判断。
 */
export const FORMATS: FormatMeta[] = [
  {
    id: 'mp4',
    label: 'MP4',
    hint: 'H.264，PR / 剪映 / 微信都能直接读',
    alpha: false,
    note: '不透明，靠幕布抠像',
  },
  {
    id: 'webp',
    label: 'WebP',
    hint: '动画 WebP，体积小于 APNG',
    alpha: true,
    note: '真透明动图，Web / 安卓首选',
  },
  {
    id: 'apng',
    label: 'APNG',
    hint: '逐帧无损 PNG 动画',
    alpha: true,
    note: '真透明动图，边缘最干净',
  },
  {
    id: 'gif',
    label: 'GIF',
    hint: '兼容性最好，只有 1 位透明',
    alpha: true,
    note: '真透明受限，边缘是硬的',
  },
  {
    id: 'png',
    label: 'PNG 序列',
    hint: '逐帧 PNG 打包成 zip，导入 AE / PR',
    alpha: true,
    note: '逐帧真透明，后期用',
  },
]

export function formatMeta(id: CaptureFormat): FormatMeta {
  return FORMATS.find((item) => item.id === id) ?? FORMATS[0]!
}

export interface CaptureOptions {
  width: number
  height: number
  /** 秒 */
  duration: number
  fps: number
  backdrop: Backdrop
  /** t 单位是秒 */
  draw: (ctx: CanvasRenderingContext2D, t: number) => void
  onProgress?: (ratio: number) => void
}

function fillBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number, backdrop: Backdrop) {
  const color = BACKDROPS.find((item) => item.id === backdrop)?.color ?? null
  if (color) {
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = color
    ctx.fillRect(0, 0, width, height)
    ctx.restore()
  }
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('无法创建画布')
  return { canvas, ctx }
}

export function supportsMp4(): boolean {
  return typeof window !== 'undefined' && 'VideoEncoder' in window
}

/** 导出单帧 PNG（含当前背景设置） */
export function capturePng(options: CaptureOptions, t: number): Promise<Blob> {
  const { canvas, ctx } = makeCanvas(options.width, options.height)
  ctx.clearRect(0, 0, options.width, options.height)
  fillBackdrop(ctx, options.width, options.height, options.backdrop)
  options.draw(ctx, t)
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 编码失败'))
    }, 'image/png')
  })
}

export async function captureMp4(options: CaptureOptions): Promise<Blob> {
  if (!supportsMp4()) throw new Error('当前浏览器不支持 WebCodecs，无法导出 MP4')

  // H.264 要求宽高为偶数
  const width = options.width - (options.width % 2)
  const height = options.height - (options.height % 2)
  const { ctx } = makeCanvas(width, height)

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    fastStart: 'in-memory',
  })

  let failure: Error | null = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error))
    },
  })

  encoder.configure({
    codec: 'avc1.42002a',
    width,
    height,
    bitrate: Math.round(width * height * 8),
    framerate: options.fps,
  })

  const frames = Math.max(1, Math.round(options.duration * options.fps))
  const step = 1_000_000 / options.fps
  /**
   * @constraint H.264 没有 alpha，透明区域会被编成黑块。调用方漏传幕布时
   *      兜底成深色，至少不是"模型贴在一块死黑上"的观感。
   */
  const backdrop: Backdrop = options.backdrop === 'none' ? 'dark' : options.backdrop

  for (let i = 0; i < frames; i += 1) {
    const t = i / options.fps
    ctx.clearRect(0, 0, width, height)
    fillBackdrop(ctx, width, height, backdrop)
    options.draw(ctx, t)
    options.onProgress?.((i + 1) / frames)

    const frame = new VideoFrame(ctx.canvas, {
      timestamp: Math.round(i * step),
      duration: Math.round(step),
    })
    encoder.encode(frame, { keyFrame: i % Math.max(1, options.fps) === 0 })
    frame.close()

    // 编码队列别堆太长，否则内存直接爆
    if (encoder.encodeQueueSize > 8) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    if (failure) break
  }

  await encoder.flush()
  encoder.close()
  if (failure) throw failure

  muxer.finalize()
  return new Blob([muxer.target.buffer], { type: 'video/mp4' })
}

export async function captureGif(options: CaptureOptions): Promise<Blob> {
  const { ctx, canvas } = makeCanvas(options.width, options.height)
  const gif = GIFEncoder()
  const frames = Math.max(1, Math.round(options.duration * options.fps))
  const delay = Math.round(1000 / options.fps)
  const transparent = options.backdrop === 'none'

  for (let i = 0; i < frames; i += 1) {
    const t = i / options.fps
    ctx.clearRect(0, 0, options.width, options.height)
    fillBackdrop(ctx, options.width, options.height, options.backdrop)
    options.draw(ctx, t)
    options.onProgress?.((i + 1) / frames)

    const data = ctx.getImageData(0, 0, options.width, options.height).data
    if (transparent) {
      // @constraint GIF 只有 1 位透明：半透明像素必须二值化，
      //              否则量化后边缘会渗出一圈黑边
      for (let p = 3; p < data.length; p += 4) {
        data[p] = data[p]! < 110 ? 0 : 255
      }
    }

    const palette = quantize(data, 256, { format: 'rgba4444' })
    const index = applyPalette(data, palette, 'rgba4444')
    gif.writeFrame(index, options.width, options.height, {
      palette,
      delay,
      transparent,
      transparentIndex: 0,
      dispose: transparent ? 2 : 1,
    })

    if (i % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  gif.finish()
  void canvas
  return new Blob([gif.bytes() as unknown as BlobPart], { type: 'image/gif' })
}

/**
 * 逐帧 APNG。
 *
 * @constraint 帧像素必须每帧整幅重新取：光栅化器开了 clear:false，
 *      依赖外部先清屏。这里统一 clearRect + 背景，保证每帧都是干净的整帧，
 *      APNG 的 dispose_op 才能安全地设为 NONE（不依赖前一帧）。
 */
export async function captureApng(options: CaptureOptions): Promise<Blob> {
  const { ctx } = makeCanvas(options.width, options.height)
  const frames = Math.max(1, Math.round(options.duration * options.fps))
  const delay = 1000 / options.fps
  const collected: ApngFrame[] = []

  for (let i = 0; i < frames; i += 1) {
    const t = i / options.fps
    ctx.clearRect(0, 0, options.width, options.height)
    fillBackdrop(ctx, options.width, options.height, options.backdrop)
    options.draw(ctx, t)
    collected.push({ rgba: ctx.getImageData(0, 0, options.width, options.height).data, delay })
    // 编码比渲染慢，每帧都让出一次，进度条才不会卡住
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  // 编码进度直接接管渲染进度：渲染快、压缩慢，用户看到的卡顿都在压缩阶段
  const bytes = await encodeApng(collected, options.width, options.height, 0, options.onProgress)
  return new Blob([bytes as unknown as BlobPart], { type: 'image/apng' })
}

/** 单帧 WebP。quality=1 时 Chrome 走无损（VP8L），alpha 原样保留 */
function canvasToWebp(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('WebP 编码失败'))
          return
        }
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
      },
      'image/webp',
      1,
    )
  })
}

/**
 * 逐帧动画 WebP：每帧编成一张静图，再自己拼动画容器。
 *
 * @performance 不重新编码像素，只搬运位流，比"整段动画一把编"省掉一份
 *      全帧内存；代价是每一帧都要过一次 toBlob（异步），所以循环里必须 await。
 */
export async function captureWebp(options: CaptureOptions): Promise<Blob> {
  const { ctx, canvas } = makeCanvas(options.width, options.height)
  const frames = Math.max(1, Math.round(options.duration * options.fps))
  const delay = 1000 / options.fps
  const collected: WebpFrame[] = []

  for (let i = 0; i < frames; i += 1) {
    const t = i / options.fps
    ctx.clearRect(0, 0, options.width, options.height)
    fillBackdrop(ctx, options.width, options.height, options.backdrop)
    options.draw(ctx, t)
    collected.push({ still: await canvasToWebp(canvas), delay })
    options.onProgress?.((i + 1) / frames)
  }

  const bytes = muxAnimatedWebp(collected, options.width, options.height, 0)
  return new Blob([bytes as unknown as BlobPart], { type: 'image/webp' })
}

/** 导出 PNG 序列，打包成 zip */export async function captureSequence(options: CaptureOptions): Promise<Blob> {
  const { ctx, canvas } = makeCanvas(options.width, options.height)
  const frames = Math.max(1, Math.round(options.duration * options.fps))
  const entries: ZipEntry[] = []

  for (let i = 0; i < frames; i += 1) {
    const t = i / options.fps
    ctx.clearRect(0, 0, options.width, options.height)
    fillBackdrop(ctx, options.width, options.height, options.backdrop)
    options.draw(ctx, t)
    options.onProgress?.((i + 1) / frames)

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (blob) {
      entries.push({
        name: `frame_${String(i + 1).padStart(4, '0')}.png`,
        data: new Uint8Array(await blob.arrayBuffer()),
      })
    }
  }

  return makeZip(entries)
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 立刻 revoke 会让部分浏览器来不及起下载
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    return new Uint8Array(await response.arrayBuffer())
  } catch {
    return null
  }
}

export function slug(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}
