import { useEffect, useMemo, useRef } from 'react'
import type { BakedFace } from '@/lib/blockmodels'
import type { Poser } from '@/lib/anim'
import type { EntityLayer, Rig } from '@/lib/entityRig'
import { entityFaces } from '@/lib/entityRig'
import { blockAnimOf, blockFaces, type TextureAnim } from '@/lib/faceBuild'
import { subscribeTicks } from '@/lib/animClock'
import { textureSrc } from '@/lib/mc'
import {
  DEFAULT_ROTATION,
  ENTITY_ROTATION,
  FLAT_ROTATION,
  drawScene,
  emptyCameraBox,
  frameAroundPivot,
  frameFromBox,
  measureFaces,
  pivotOf,
  type DisplayTransform,
  type Face3D,
} from '@/lib/scene'
import { loadTexel } from '@/lib/texel'

export type Subject =
  | {
      kind: 'block'
      faces: BakedFace[]
      textures: string[]
      /**
       * 动画贴图参数，键是 textures 的下标。
       * @why 只有帧数不够：水的 frametime 是 2、火是 1，岩浆还带一条来回序列。
       *      少了这项，水流快一倍、岩浆朝一个方向硬循环。
       */
      anims?: Record<string, TextureAnim>
      display?: DisplayTransform | null
      /** 平面物品：正对相机才看得清，斜着看会被压扁 */
      flat?: boolean
    }
  | {
      kind: 'entity'
      rig: Rig
      poser: Poser
      texture: string
      /**
       * 叠加图层：羊毛、项圈、眼睛、斑纹…
       * @why 游戏里生物从来不是"一层贴图"——SheepRenderer 挂着羊毛层，
       *      EndermanRenderer 挂着发光眼睛层。只画主模型，羊就是秃的、
       *      末影人就是一条黑柱子。图层参数由 scripts/extract-layers.py
       *      从 addLayer(...) 与图层类源码里挖出来。
       */
      layers?: EntityLayer[]
    }

/**
 * 详情页的可调视角。预览与导出共用同一份，用户调成什么样就导出什么样。
 */
export interface ViewState {
  rotX: number
  rotY: number
  /** 1 是铺满，>1 放大 */
  zoom: number
  /** 光照倍率 */
  light: number
  /** 动态模糊 0..1 */
  blur: number
  /** 描边 0..1 */
  outline: number
}

interface ModelViewProps {
  subject: Subject
  version: string
  size: number
  interactive?: boolean
  /** 播放动作（仅实体有效） */
  animated?: boolean
  /** 运动强度，0 是站立 */
  speed?: number
  /** 受控视角；不传就用默认等轴测（列表缩略图） */
  view?: ViewState | null
  /** 拖动、滚轮、惯性之后回调 */
  onViewChange?: (next: ViewState) => void
  /**
   * 转台枢轴。不传就按模型包围盒自己算。
   * @why 导出面板必须拿到同一个值，否则导出的构图和屏幕上看到的差一点点。
   */
  pivot?: [number, number, number]
  className?: string
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 转台枢轴：模型自己包围盒的中心。
 * @why 方块是 8,8,8 没错，但生物的原点在脚底、身高 32 甚至 40，绕 8 转就是
 *      绕着膝盖甩——拖动时整只生物在画面里画圈。导出面板也要用这个值。
 */
export function subjectPivot(
  subject: Subject,
  blockFacesAt0?: Face3D[] | null,
): [number, number, number] {
  if (subject.kind === 'block') {
    const faces = blockFacesAt0 ?? blockFaces(subject.faces, subject.textures, subject.anims, 0)
    return pivotOf(faces)
  }
  const rest = subject.poser.pose({ t: 0, speed: 0, pitch: 0, yaw: 0 })
  return pivotOf(entityFaces(subject.rig, rest, subject.texture, subject.layers))
}

/** 转动速度：每像素多少度 */
const YAW_PER_PX = 0.62
const PITCH_PER_PX = 0.5
/** 松手后的惯性衰减（每帧保留比例）与停止阈值（度/帧） */
const INERTIA_DECAY = 0.9
const INERTIA_STOP = 0.08

/**
 * @constraint 必须按设备真实 DPR 渲染：固定倍率在 2x 屏上会被拉伸，
 *      1.25 倍 → 95px 位图铺 152px 物理像素，糊就是这么来的。
 *      上限 2 防止 3x 屏把光栅化成本翻一倍多。
 */
function deviceDpr(): number {
  if (typeof window === 'undefined') return 1
  return Math.min(window.devicePixelRatio || 1, 2)
}

/**
 * 缩略图位图缓存。
 *
 * @why 列表一屏 100 张卡片，滚动时它们不断挂载/卸载，每次挂载都要重新光栅化一遍，
 *      来回滚两下 CPU 就满了。非交互预览的机位是固定的，画一次存下来，
 *      再滚回来直接 drawImage。
 * @constraint 必须限额：块页面 + 生物页面加起来上千个组合，全存会吃掉几十 MB 显存。
 */
const thumbCache = new Map<string, HTMLCanvasElement>()
const THUMB_LIMIT = 320

function rememberThumb(key: string, canvas: HTMLCanvasElement): void {
  if (thumbCache.size >= THUMB_LIMIT) {
    const oldest = thumbCache.keys().next().value
    if (oldest !== undefined) thumbCache.delete(oldest)
  }
  const store = document.createElement('canvas')
  store.width = canvas.width
  store.height = canvas.height
  store.getContext('2d')?.drawImage(canvas, 0, 0)
  thumbCache.set(key, store)
}

/**
 * 模型预览。
 *
 * @why 用 Canvas 2D 软件光栅化，不用 CSS 3D 也不用 WebGL：
 *      CSS 3D 有真深度缓冲，但每个面都是独立合成层，上千面只有 15fps；
 *      画家算法（按面中心深度排序）在相交面、共面、薄片模型上必然排错；
 *      WebGL 要引入整套管线，代价太大。
 *      自己光栅化是唯一能同时拿到"逐像素深度测试"和"零运行时依赖"的做法。
 *
 * @constraint 列表里的卡片不跑动画循环：一百个 rAF 一起跑会直接卡死。
 *      只有详情页（interactive）才常驻循环，而且没变化就跳过重绘。
 */
export function ModelView({
  subject,
  version,
  size,
  interactive = false,
  animated = false,
  speed = 1,
  view = null,
  onViewChange,
  pivot: fixedPivot,
  className,
}: ModelViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)
  const isFlat = subject.kind === 'block' && Boolean(subject.flat)
  const base = isFlat ? FLAT_ROTATION : subject.kind === 'entity' ? ENTITY_ROTATION : DEFAULT_ROTATION
  const baseRx = base[0]
  const baseRy = base[1]

  /**
   * 转动状态放在 ref 里而不是 state。
   *
   * @why 拖动的每一像素都 setState 会重渲染整个弹窗（含下载面板），而且渲染
   *      循环的依赖里有 rotX/rotY，每次重渲染都要拆掉重装 rAF——动画相位因此
   *      每拖一下就归零，模型在拖动过程中"抽搐"。转动必须是渲染循环自己维护的量：
   *      指针只改目标值，循环负责逼近、惯性、重绘。
   */
  const spin = useRef({ rx: baseRx, ry: baseRy, trx: baseRx, try: baseRy, vrx: 0, vry: 0 })
  /** 上次上报给父组件的角度，用来区分"外部改的"和"自己报回去的" */
  const reported = useRef<{ x: number; y: number }>({ x: baseRx, y: baseRy })
  const dirty = useRef(true)
  const dragging = useRef(false)
  const pending = useRef<{ x: number; y: number } | null>(null)
  /** 时间轴自己累计，不随循环重建归零 */
  const clock = useRef(0)
  /** 自适应画质：帧时间超标就降超采样，省得高 DPR 屏卡成幻灯片 */
  const quality = useRef({ ss: 1.5, avg: 0, frames: 0 })
  /**
   * 下一帧是否清空动态模糊的历史。
   * @constraint 换对象必须清：拖尾缓冲是模块级单例，不清就会把上一只
   *      生物的残影拖到这一只身上，看起来像鬼影。
   */
  const trailFresh = useRef(true)
  /**
   * 当前画面的"运动量" 0..1，用来调制动态模糊。
   * @constraint 静止时必须归零：模型不动却一直在拖尾，边缘会糊成一团，
   *      看起来像渲染坏了。只有真在转、真在走的时候才拉丝。
   */
  const activity = useRef(0)

  const viewLive = useRef(view)
  viewLive.current = view
  const speedLive = useRef(speed)
  speedLive.current = speed
  const animatedLive = useRef(animated)
  animatedLive.current = animated

  const dpr = deviceDpr()
  const pixels = Math.round(size * dpr * (interactive ? 1.05 : 1))

  /**
   * 方块的面按帧解包并按帧缓存。
   *
   * @why 动画贴图（水、岩浆、火、海带…）是竖条 PNG，换帧就是改 uv 的 v 偏移。
   *      每帧重建 Face3D 对几十个面来说不贵，但缓存下来滚动列表时能省掉
   *      大部分分配——同一帧会反复出现。
   */
  const facesOf = useMemo(() => {
    if (subject.kind !== 'block') return null
    const cache = new Map<number, Face3D[]>()
    return (frame: number): Face3D[] => {
      const hit = cache.get(frame)
      if (hit) return hit
      const built = blockFaces(subject.faces, subject.textures, subject.anims, frame)
      cache.set(frame, built)
      return built
    }
  }, [subject])

  /**
   * 这个方块会不会动、一遍动画有多长、每帧几 tick。
   * @constraint 必须按面实际引用的贴图算，不能扫整个帧池：池里一千多张静态贴图，
   *             取最大值等于让每个方块都以为自己在动，整页上百条动画回调一起跑。
   */
  const blockAnim = useMemo(
    () => (subject.kind === 'block' ? blockAnimOf(subject.faces, subject.anims) : null),
    [subject],
  )
  const staticFaces = useMemo(() => (facesOf ? facesOf(0) : null), [facesOf])

  const textureKey =
    subject.kind === 'entity'
      ? [subject.texture, ...(subject.layers ?? []).map((layer) => layer.texture)].join('|')
      : [...new Set((staticFaces ?? []).map((face) => face.tex))].join('|')

  /**
   * 转台枢轴：模型自己包围盒的中心。
   * @why 方块是 8,8,8 没错，但生物的原点在脚底、身高 32 甚至 40，绕 8 转就是
   *      绕着膝盖甩，拖动时整只生物在画面里画圈。
   */
  const pivot = useMemo(() => {
    if (fixedPivot) return fixedPivot
    return subjectPivot(subject, staticFaces)
  }, [subject, staticFaces, fixedPivot])

  /**
   * 取景框：一次算死，之后动画与拖动都不再变。
   *
   * @why 不锁的话包围盒随每帧姿势变化，缩放跟着变——走路时整只生物在"呼吸"。
   *      水平方向再采样几个角度取并集：枢轴在中心，各角度包围盒宽度不同，
   *      只按默认角度算，转到侧面就会出框；按并集算则转动过程中缩放恒定。
   */
  const frame = useMemo(() => {
    const cam = emptyCameraBox()
    const yaws = interactive ? [0, 45, 90, 135] : [0]
    /**
     * @constraint 缩略图只量一个姿势。之前不区分，一张 68px 的卡片也要把 8 个相位
     *      各展开一遍骨骼——首屏 96 张就是 768 次 rigFaces，主线程被卡住 70ms 以上。
     *      站着不动的预览量一帧就够。
     */
    const poses = interactive || animated ? 8 : 1
    for (const turn of yaws) {
      if (subject.kind === 'entity') {
        for (let i = 0; i < poses; i += 1) {
          const pose = subject.poser.pose({ t: i * 0.25, speed, pitch: 0, yaw: 0 })
          measureFaces(
            entityFaces(subject.rig, pose, subject.texture, subject.layers),
            { rotX: baseRx, rotY: baseRy + turn, pivot },
            cam,
          )
        }
      } else if (staticFaces) {
        measureFaces(
          staticFaces,
          { rotX: baseRx, rotY: baseRy + turn, display: subject.display, pivot },
          cam,
        )
      }
    }
    // 实体必须让枢轴正好落在画面中心；方块保留包围盒中心，带 display 位移的才不歪
    return subject.kind === 'entity' ? frameAroundPivot(cam) : frameFromBox(cam)
  }, [subject, speed, baseRx, baseRy, pivot, staticFaces, interactive, animated])

  /**
   * @constraint 缩放、光照、运动强度都是父组件直接给的量，渲染循环不依赖它们，
   *      不在这里标脏就永远只画第一帧（拖动才更新）。
   */
  useEffect(() => {
    dirty.current = true
  }, [view?.zoom, view?.light, view?.blur, view?.outline, speed])

  // 换模型：枢轴与机位一起回默认
  useEffect(() => {
    spin.current = { rx: baseRx, ry: baseRy, trx: baseRx, try: baseRy, vrx: 0, vry: 0 }
    reported.current = { x: baseRx, y: baseRy }
    trailFresh.current = true
    dirty.current = true
  }, [subject, baseRx, baseRy])

  /**
   * 外部改角度（滑块、重置按钮）时采纳，自己上报的回声则忽略。
   * @why 不区分的话，父组件把我们的角度存进 state 再传回来，会被当成
   *      "外部要求跳到这个角度"，正在做的平滑与惯性每帧被打断。
   */
  useEffect(() => {
    if (!view) return
    if (Math.abs(view.rotX - reported.current.x) < 1e-3 && Math.abs(view.rotY - reported.current.y) < 1e-3) {
      return
    }
    spin.current.trx = view.rotX
    spin.current.rx = view.rotX
    spin.current.try = view.rotY
    spin.current.ry = view.rotY
    spin.current.vrx = 0
    spin.current.vry = 0
    reported.current = { x: view.rotX, y: view.rotY }
    dirty.current = true
  }, [view?.rotX, view?.rotY, view])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let alive = true
    let raf = 0
    let last = performance.now()
    let lastReport = 0

    const needed = textureKey ? textureKey.split('|') : []
    const urls = needed.map((item) => textureSrc(version, item))

    const draw = () => {
      const live = viewLive.current
      const liveSpeed = speedLive.current
      const elapsed = clock.current
      /**
       * @constraint 只有非交互预览走缓存。详情页的机位每一帧都可能被拖动，
       *      缓存等于每一帧都写一张新图，纯浪费。
       */
      /**
       * @constraint 会动的方块不能走缩略图缓存：缓存键里没有时间，
       *      第一次画出来那一帧会被永久记住，滚动回来永远是同一帧。
       */
      const cacheKey = interactive || blockAnim
        ? null
        : `t|${textureKey}|${pixels}|${Math.round(spin.current.rx)}|${Math.round(spin.current.ry)}|${Math.round((live?.light ?? 1) * 100)}|${Math.round((live?.zoom ?? 1) * 100)}`
      if (cacheKey) {
        const hit = thumbCache.get(cacheKey)
        if (hit) {
          ctx.setTransform(1, 0, 0, 1, 0, 0)
          ctx.clearRect(0, 0, pixels, pixels)
          ctx.drawImage(hit, 0, 0)
          return
        }
      }
      let faces: Face3D[]
      if (subject.kind === 'entity') {
        const poses = subject.poser.pose({
          t: elapsed,
          speed: liveSpeed,
          pitch: 0,
          yaw: Math.sin(elapsed * 0.7) * 10,
        })
        faces = entityFaces(subject.rig, poses, subject.texture, subject.layers)
      } else {
        /**
         * @constraint 动画贴图按游戏节奏走：Minecraft 的动画是每 frametime 个 tick
         *      换一帧（水 2、火 1），不是每渲染帧。跟着 rAF 走会让 60fps 的水流快三倍；
         *      不分 frametime 则会让水和火用同一个速度，至少有一半是错的。
         */
        const frameIndex = blockAnim
          ? Math.floor(Math.floor(elapsed * 20) / blockAnim.frametime) % blockAnim.steps
          : 0
        faces = facesOf ? facesOf(frameIndex) : []
      }

      const started = performance.now()
      trailFresh.current = false
      drawScene(ctx, {
        faces,
        size: pixels,
        rotX: spin.current.rx,
        rotY: spin.current.ry,
        fit: subject.kind === 'entity' ? 'auto' : 'block',
        display: subject.kind === 'block' ? (subject.display ?? null) : null,
        version,
        supersample: quality.current.ss,
        zoom: live?.zoom ?? 1,
        light: live?.light ?? 1,
        motionBlur: (live?.blur ?? 0) * activity.current,
        outline: live?.outline ?? 0,
        resetTrail: trailFresh.current,
        shadow: subject.kind === 'entity' ? 1 : 0.55,
        pivot,
        frame,
      })

      // 自适应：连续偏慢就降超采样，一直很快就不再降
      const cost = performance.now() - started
      const meter = quality.current
      meter.avg = meter.avg * 0.85 + cost * 0.15
      meter.frames += 1
      if (meter.frames > 20 && meter.avg > 20 && meter.ss > 1) {
        meter.ss = 1
        meter.avg = 0
        meter.frames = 0
      }
      if (cacheKey) rememberThumb(cacheKey, canvas)
    }

    const report = (now: number) => {
      if (!onViewChange || now - lastReport < 40) return
      const { rx, ry } = spin.current
      if (Math.abs(rx - reported.current.x) < 0.05 && Math.abs(ry - reported.current.y) < 0.05) return
      lastReport = now
      reported.current = { x: rx, y: ry }
      const live = viewLive.current ?? { rotX: rx, rotY: ry, zoom: 1, light: 1, blur: 0, outline: 0 }
      onViewChange?.({ ...live, rotX: rx, rotY: ry })
    }

    const tick = (now: number) => {
      if (!alive) return
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
      last = now

      const state = spin.current
      const playing = animatedLive.current || blockAnim !== null

      if (playing) {
        clock.current += dt
        dirty.current = true
      }

      if (!dragging.current) {
        // 惯性：松手后按上一帧的速度继续转，慢慢停下
        if (Math.abs(state.vrx) > INERTIA_STOP || Math.abs(state.vry) > INERTIA_STOP) {
          state.trx = clamp(state.trx + state.vrx, -85, 85)
          if (state.trx > -85 && state.trx < 85) state.try += state.vry
          state.vrx *= INERTIA_DECAY
          state.vry *= INERTIA_DECAY
        } else {
          state.vrx = 0
          state.vry = 0
        }
      }

      /**
       * 平滑逼近目标角度。
       * @constraint 时间常数取 40ms：再小就跟不上手（拖动时模型明显落后于指针，
       *      松手才发现转过头了），再大就会看到"一卡一卡"的量化感。
       */
      const ease = 1 - Math.exp(-dt / 0.04)
      const nx = state.rx + (state.trx - state.rx) * ease
      const ny = state.ry + (state.try - state.ry) * ease
      const moved = Math.abs(nx - state.rx) + Math.abs(ny - state.ry)
      if (moved > 1e-4) {
        state.rx = nx
        state.ry = ny
        dirty.current = true
      }

      /**
       * 转动速度（度/秒）折算成 0..1；骨骼动画按运动强度给一个基础量。
       * @why 150°/s 已经是很用力的甩，再快也不该更糊。
       */
      const rate = moved / Math.max(1e-3, dt)
      const anim = animatedLive.current ? Math.min(1, speedLive.current) : 0
      const target = Math.min(1, rate / 90 + anim * 0.7)
      // 上升快、回落慢：松手那一下的余韵不该立刻消失
      activity.current += (target - activity.current) * (target > activity.current ? 0.5 : 0.08)

      if (dirty.current) {
        dirty.current = false
        draw()
      }
      report(now)
      raf = requestAnimationFrame(tick)
    }

    let stopTicks: (() => void) | null = null
    let observer: IntersectionObserver | null = null

    // 纹理是逐像素采样的，必须先解码完成，否则第一帧全是占位灰
    void Promise.all(urls.map((url) => loadTexel(url))).then(() => {
      if (!alive) return
      /**
       * @constraint 详情页跑自己的循环（要跟随拖动与惯性），列表卡片只跑贴图动画。
       *      以前列表卡片完全不跑：有动画的水、火、岩浆全冻在第一帧，
       *      整页看起来像是"方块就是不会动的静态图"。
       */
      if (interactive) {
        raf = requestAnimationFrame(tick)
        return
      }
      clock.current = 0.48
      draw()
      if (!blockAnim) return

      /**
       * 只让真正在视口里的卡片订阅共享时钟。
       * @why 一页一百多张卡片全订阅，每 50ms 就是一百多次软件光栅化，滚动直接卡死。
       *      视口内通常只有十来张会动的方块，这个量级刚好在预算内。
       */
      const holder = holderRef.current
      if (!holder) return
      observer = new IntersectionObserver(
        (entries) => {
          const visible = entries.some((entry) => entry.isIntersecting)
          if (visible && !stopTicks) {
            stopTicks = subscribeTicks((gameTick) => {
              clock.current = gameTick / 20
              draw()
            })
          } else if (!visible && stopTicks) {
            stopTicks()
            stopTicks = null
          }
        },
        { rootMargin: '120px' },
      )
      observer.observe(holder)
    })

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      observer?.disconnect()
      stopTicks?.()
    }
  }, [subject, facesOf, blockAnim, textureKey, version, pixels, animated, onViewChange, frame, pivot])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = true
    spin.current.vrx = 0
    spin.current.vry = 0
    pending.current = { x: event.clientX, y: event.clientY }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive || !dragging.current) return
    // 用 coalesced 事件能拿到被合并掉的中间点，快甩时不再一顿一顿
    const events = typeof event.nativeEvent.getCoalescedEvents === 'function'
      ? event.nativeEvent.getCoalescedEvents()
      : [event.nativeEvent]
    const state = spin.current
    for (const point of events.length > 0 ? events : [event.nativeEvent]) {
      const prev = pending.current
      if (!prev) continue
      const dx = point.clientX - prev.x
      const dy = point.clientY - prev.y
      pending.current = { x: point.clientX, y: point.clientY }
      state.trx = clamp(state.trx + dy * PITCH_PER_PX, -85, 85)
      state.try += dx * YAW_PER_PX
      // 记录瞬时速度给惯性用（限幅，否则一次瞬移能让它转半分钟）
      /**
       * @constraint 惯性系数 0.4 而不是 1：位移会被按 0.9 逐帧衰减，累计大约是
       *      单帧位移的 10 倍，取满就等于松手后再多转半个屏幕——用户只是想看侧面，
       *      结果甩到了背面。
       */
      state.vrx = clamp(dy * PITCH_PER_PX * 0.4, -5, 5)
      state.vry = clamp(dx * YAW_PER_PX * 0.4, -7, 7)
    }
    dirty.current = true
  }

  /**
   * @constraint 滚轮必须用原生监听器加 passive:false：React 的 onWheel 在
   *      部分浏览器上是 passive 的，preventDefault 会被忽略，缩放时页面跟着滚。
   */
  useEffect(() => {
    const element = holderRef.current
    if (!element || !interactive) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const live = viewLive.current ?? { rotX: baseRx, rotY: baseRy, zoom: 1, light: 1, blur: 0, outline: 0 }
      const step = Math.exp(-event.deltaY * 0.0016)
      const next = clamp(live.zoom * step, 0.5, 2.6)
      onViewChange?.({ ...live, zoom: next })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [interactive, onViewChange, baseRx, baseRy])

  /** 松手时立刻把最终角度交给父组件，别让导出面板拿着 40ms 前的值 */
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!dragging.current) return
    dragging.current = false
    pending.current = null
    const live = viewLive.current ?? { rotX: baseRx, rotY: baseRy, zoom: 1, light: 1, blur: 0, outline: 0 }
    reported.current = { x: spin.current.rx, y: spin.current.ry }
    onViewChange?.({ ...live, rotX: spin.current.rx, rotY: spin.current.ry })
  }

  return (
    <div
      ref={holderRef}
      className={`thumb${interactive ? ' thumb--interactive' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
    >
      <canvas
        ref={canvasRef}
        className="thumb__canvas"
        width={pixels}
        height={pixels}
        style={{ width: size, height: size }}
      />
    </div>
  )
}
