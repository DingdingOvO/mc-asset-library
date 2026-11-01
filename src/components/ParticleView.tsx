import { useEffect, useRef, useState } from 'react'
import { frameAt, particleSrc, sizeAt, type ParticleDef } from '@/lib/particles'

interface ParticleViewProps {
  version: string
  def: ParticleDef
  size?: number
  /** 放大倍数；不传则按粒子尺寸自动取一个看得清的倍数 */
  zoom?: number
  /** 播放速度，1 = 游戏原速（20 tick/s） */
  speed?: number
  /**
   * 染色。药水漩涡、红石尘、树叶这类粒子的颜色是运行时参数，
   * 源码里只有一个白色贴图；不染色它们就是一片白，在白底上等于没画。
   */
  tint?: string
  className?: string
}

const autoZoom = (def: ParticleDef): number => {
  /**
   * 让粒子首帧占画面约三分之一宽。
   *
   * @constraint 下限必须允许小于 1：爆炸粒子（HugeExplosionParticle）的 quadSize
   *      是 2.0 格，按 1× 画就是画布的两倍宽，整块白色把舞台糊满。
   */
  const target = 0.34
  return Math.min(12, Math.max(0.15, target / Math.max(0.02, def.q)))
}

/**
 * 粒子预览。
 *
 * @why 游戏里粒子就是一块始终朝向相机的四边形（SingleQuadParticle），
 *      正交投影下它退化成屏幕上的正方形，贴图内容才是识别度所在。
 *      所以这里不套立体管线，直接按源码给的 quadSize 缩放、按 lifetime 推进帧，
 *      得到的就是它在游戏里的样子。
 *
 * @constraint 必须用 image-rendering: pixelated：粒子贴图多为 8×8，
 *      插值放大后火焰会变成一团糊，玩家一眼就看不出这是原版粒子。
 */
export function ParticleView({ version, def, size = 320, zoom, speed = 1, tint, className }: ParticleViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(0)
  const factor = zoom ?? autoZoom(def)
  /** 染色用的离屏画布：source-in 需要独立的 alpha 上下文 */
  const tintCanvas = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let alive = true
    let raf = 0
    const images: HTMLImageElement[] = []
    let loaded = 0

    for (const frame of def.f) {
      const image = new Image()
      image.decoding = 'async'
      image.src = particleSrc(version, frame[0])
      image.onload = () => {
        loaded += 1
        if (loaded === def.f.length && alive) setReady((value) => value + 1)
      }
      images.push(image)
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const pixels = Math.round(size * dpr)
    if (canvas.width !== pixels) {
      canvas.width = pixels
      canvas.height = pixels
    }

    const started = performance.now()
    /** 一个完整生命周期（秒）。至少 0.25 秒，否则 4 tick 的粒子会闪成噪点 */
    const span = Math.max(0.25, def.l / 20) / Math.max(0.1, speed)

    const draw = (now: number) => {
      if (!alive) return
      const progress = ((now - started) / 1000 / span) % 1
      const index = frameAt(def, progress)
      const image = images[index]

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, pixels, pixels)
      if (image && image.complete && image.naturalWidth > 0) {
        // 1 格 = 画面宽度的 1/factor；粒子边长按 quadSize 走，并随生命周期缩放
        const side = size * dpr * sizeAt(def, progress) * factor
        const half = pixels / 2
        ctx.imageSmoothingEnabled = false
        let source: CanvasImageSource = image
        if (tint) {
          const layer = tintCanvas.current ?? document.createElement('canvas')
          tintCanvas.current = layer
          if (layer.width !== pixels || layer.height !== pixels) {
            layer.width = pixels
            layer.height = pixels
          }
          const lctx = layer.getContext('2d')
          if (lctx) {
            lctx.setTransform(1, 0, 0, 1, 0, 0)
            lctx.clearRect(0, 0, pixels, pixels)
            lctx.imageSmoothingEnabled = false
            lctx.drawImage(image, half - side / 2, half - side / 2, side, side)
            // @why source-in 只保留已画像素的 alpha，等于"按剪影上色"，
            //      贴图的明暗层次仍然保留（白的地方亮、灰的地方暗）
            lctx.globalCompositeOperation = 'source-in'
            lctx.fillStyle = tint
            lctx.fillRect(0, 0, pixels, pixels)
            lctx.globalCompositeOperation = 'source-over'
            source = layer
          }
        }
        if (tint) ctx.drawImage(source, 0, 0)
        else ctx.drawImage(source, half - side / 2, half - side / 2, side, side)
      }
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
    }
  }, [version, def, size, factor, speed, ready, tint])

  return (
    <canvas
      ref={canvasRef}
      className={className ? `particle-view ${className}` : 'particle-view'}
      width={Math.round(size * Math.min(window.devicePixelRatio || 1, 2))}
      height={Math.round(size * Math.min(window.devicePixelRatio || 1, 2))}
      style={{ width: size, height: size }}
    />
  )
}

/** 列表缩略图：静态首帧，115 张一起跑动画会直接卡死 */
export function ParticleThumb({ version, def, size = 72 }: { version: string; def: ParticleDef; size?: number }) {
  return (
    <img
      className="particle-thumb"
      src={particleSrc(version, def.f[0]?.[0] ?? 'generic_0')}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  )
}
