import { useEffect, useMemo, useRef } from 'react'
import type { BakedFace } from '@/lib/blockmodels'
import type { Poser } from '@/lib/anim'
import type { EntityLayer, Rig } from '@/lib/entityRig'
import { entityFaces } from '@/lib/entityRig'
import { blockAnimOf, blockFaces, type TextureAnim } from '@/lib/faceBuild'
import { subscribeTicks } from '@/lib/animClock'
import { textureSrc } from '@/lib/mc'
import { modelPipeline } from '@/render'
import {
  DEFAULT_ROTATION,
  ENTITY_ROTATION,
  FLAT_ROTATION,
  boundsOf,
  centerOf,
  drawScene,
  emptyCameraBox,
  frameAroundPivot,
  measureFaces,
  mergeBounds,
  pivotOf,
  type Bounds,
  type DisplayTransform,
  type Face3D,
} from '@/lib/scene'
import {
  beginDrag,
  createOrbit,
  dragOrbit,
  endDrag,
  GLIDE_WINDOW,
  PITCH_PER_PX,
  YAW_PER_PX,
  nearestYaw,
  normalizeYaw,
  orbitBusy,
  seekOrbit,
  snapOrbit,
  stepOrbit,
  yawGap,
} from '@/lib/orbit'
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
      /**
       * 透明度类别表（与 textures 平行）：0 不透明、1 镂空、2 半透明。
       * @why 玻璃、水、冰必须走混合，否则会被画成实心——玻璃背后的东西全被盖住。
       *      判定来自打包产物，不看贴图有没有下载完。
       */
      alpha?: number[]
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
 * 转台枢轴：模型在整个动画范围内的几何中心。
 *
 * @why 方块是 8,8,8 没错，但生物的原点在脚底、身高 32 甚至 40，绕 8 转就是
 *      绕着膝盖甩——拖动时整只生物在画面里画圈。
 * @constraint 生物不能只量静止姿势：垂手站着时中心在腰，抬臂迈腿之后
 *      中心偏到另一侧，转起来模型会"甩偏"几像素。必须把整个步态周期
 *      量一遍取并集中心，转动轴才落在模型的实际中心上。
 */
export function subjectPivot(
  subject: Subject,
  blockFacesAt0?: Face3D[] | null,
  /** 动画相位采样数。列表卡片站着不动，量一帧就够 */
  phases = 8,
): [number, number, number] {
  if (subject.kind === 'block') {
    const faces = blockFacesAt0 ?? blockFaces(subject.faces, subject.textures, subject.anims, 0, subject.alpha)
    return pivotOf(faces)
  }
  let union: Bounds | null = null
  const count = Math.max(1, phases)
  for (let i = 0; i < count; i += 1) {
    const pose = subject.poser.pose({ t: i / count, speed: 1, pitch: 0, yaw: 0 })
    union = mergeBounds(union, boundsOf(entityFaces(subject.rig, pose, subject.texture, subject.layers)))
  }
  return union ? centerOf(union) : [0, 0, 0]
}

/** 缩放范围：小于 0.4 模型缩成一粒，大于 3 只剩几个像素的贴图 */
const ZOOM_MIN = 0.4
const ZOOM_MAX = 3

/**
 * 拖动中向父组件回报的最小间隔（毫秒）。
 * @why 每一像素都 setState 会重渲染整个弹窗（音效列表、下载面板、视角滑块），
 *      拖动因此掉到 30fps 以下，手指上就是"跟不上"。松手时另有一次性回报，
 *      所以这个间隔只影响滑块数字的刷新率。
 */
const REPORT_INTERVAL = 150

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
   * 角度状态放在 ref 里而不是 state。
   *
   * @why 拖动的每一像素都 setState 会重渲染整个弹窗（含下载面板），而且渲染
   *      循环的依赖里有 rotX/rotY，每次重渲染都要拆掉重装 rAF——动画相位因此
   *      每拖一下就归零，模型在拖动过程中"抽搐"。角度只由渲染循环自己的
   *      状态机维护，见 lib/orbit.ts。
   */
  const spin = useRef(createOrbit(baseRx, baseRy))
  /** 上次上报给父组件的角度，用来区分"外部改的"和"自己报回去的" */
  const reported = useRef<{ x: number; y: number }>({ x: baseRx, y: baseRy })
  const dirty = useRef(true)
  /** 当前按下的指针（多指时用第一个，两指进入捏合缩放） */
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  /** 捏合起点：两指距离与当时的缩放 */
  const pinch = useRef<{ dist: number; zoom: number } | null>(null)
  /** 上一点的位置：单指拖动的增量基准 */
  const pending = useRef<{ x: number; y: number } | null>(null)
  /**
   * 最近一小段时间的指针轨迹。
   * @why 松手速度要按窗口平均算。逐帧差分会把"松手前最后一帧零位移"当成静止，
   *      甩出去的手感全部丢掉。
   */
  const trail = useRef<{ t: number; x: number; y: number }[]>([])
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

  /**
   * 缩放的本地值。
   *
   * @why 滚轮/捏合每动一下都要立刻看到结果，而父组件的 state 要等一次重渲染
   *      才回来。只读父组件的话，同一帧里的多个滚轮事件会各自拿同一个基准乘，
   *      滚十格只放大一档。本地值先落，再按需上报。
   */
  const zoomLocal = useRef(view?.zoom ?? 1)
  useEffect(() => {
    zoomLocal.current = view?.zoom ?? 1
  }, [view?.zoom])

  const applyZoom = (next: number) => {
    const value = clamp(next, ZOOM_MIN, ZOOM_MAX)
    if (Math.abs(value - zoomLocal.current) < 0.002) return
    zoomLocal.current = value
    const live = viewLive.current ?? {
      rotX: spin.current.rx,
      rotY: spin.current.ry,
      zoom: value,
      light: 1,
      blur: 0,
      outline: 0,
    }
    onViewChange?.({ ...live, zoom: value })
  }

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
      const built = blockFaces(subject.faces, subject.textures, subject.anims, frame, subject.alpha)
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
      ? /**
         * @constraint 现拼几何（TNT、掉落物）的每个面自带纹理，一张顶、一张侧、
         *      一张底。只预载 subject.texture 的话，GPU 里除第一张之外全是占位色，
         *      TNT 会变成"一面红字、五面纯灰"。
         */
        [
          ...new Set([
            subject.texture,
            ...(subject.layers ?? []).map((layer) => layer.texture),
            ...subject.rig.parts.flatMap((part) => part.faces.map((face) => face.tex ?? '')),
          ]),
        ]
          .filter((tex) => tex.includes('/'))
          .join('|')
      // @constraint 贴图名必须含 `/`：模型里 `textures: { all: "#all" }` 这种
      //      自引用会被解析成裸名字 `all`，拼出来就是 textures/all.png，
      //      每个用到该模型的页面都会多一条 404。裸名字不进预载清单。
      : [...new Set((staticFaces ?? []).map((face) => face.tex).filter((tex) => tex.includes('/')))].join('|')

  /**
   * 预载纹理，让 GPU 管线能接管。
   *
   * @why 渲染循环是同步的（rAF 里不能 await）。纹理没就绪时
   *      `drawScene` 会自动回落 CPU 光栅化，等这批下载完再切到 GPU。
   *      下载完成后必须标脏重绘一次，否则要等到用户拖动才会换成 GPU 版本。
   */
  useEffect(() => {
    if (!textureKey) return
    let alive = true
    try {
      void modelPipeline()
        .prepare(textureKey.split('|'), version)
        .then(() => {
          if (alive) dirty.current = true
        })
        .catch(() => {
          /* GPU 不可用，继续走 CPU 光栅化 */
        })
    } catch {
      /* 同上 */
    }
    return () => {
      alive = false
    }
  }, [textureKey, version])

  /**
   * 转台枢轴：整个动画范围内的几何中心（见 subjectPivot）。
   */
  const pivot = useMemo(() => {
    if (fixedPivot) return fixedPivot
    return subjectPivot(subject, staticFaces, interactive ? 8 : 1)
  }, [subject, staticFaces, fixedPivot, interactive])

  /**
   * 取景框：一次算死，之后动画与拖动都不再变。
   *
   * @why 不锁的话包围盒随每帧姿势变化，缩放跟着变——走路时整只生物在"呼吸"。
   * @constraint 水平方向必须量满一圈（8 个方位，45° 一档），不能只量四个角：
   *      转到 180°~315° 时模型的横向宽度和首帧差得多，用首帧的跨度会在转动
   *      过程中出框（或者反过来，非对角角度显得很小）。
   */
  const frame = useMemo(() => {
    const cam = emptyCameraBox()
    const yaws = interactive ? [0, 45, 90, 135, 180, 225, 270, 315] : [0]
    /**
     * @constraint 缩略图只量一个姿势。之前不区分，一张 68px 的卡片也要把 8 个相位
     *      各展开一遍骨骼——首屏 96 张就是 768 次 rigFaces，主线程被卡住 70ms 以上。
     *      站着不动的预览量一帧就够。
     * @constraint 详情页把姿势采样降到 4 个相位，换取把方位从 4 个扩到 8 个：
     *      总次数不变（32 次），但转动时不再有角度出框。
     */
    const poses = interactive ? 4 : animated ? 8 : 1
    for (const turn of yaws) {
      if (subject.kind === 'entity') {
        for (let i = 0; i < poses; i += 1) {
          const pose = subject.poser.pose({ t: i * (1 / poses), speed, pitch: 0, yaw: 0 })
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
    /**
     * @constraint 方块也按枢轴取景，不再用「包围盒中心」。
     *      frameFromBox 取的是并集包围盒的中心，而枢轴是模型自身的中心：
     *      非对称模型（楼梯、门、火把）两者差得很明显，转起来是绕着屏幕外
     *      某个点甩，用户说的"中心点很怪"就是这里。
     *      带 display 位移的方块把位移量补上即可——那段位移与旋转无关。
     */
    const shift = subject.kind === 'block' ? subject.display?.translation : null
    return frameAroundPivot(cam, shift ? [shift[0]! / 16, shift[1]! / 16] : undefined)
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
    snapOrbit(spin.current, baseRx, baseRy)
    reported.current = { x: baseRx, y: baseRy }
    pointers.current.clear()
    pinch.current = null
    trailFresh.current = true
    dirty.current = true
  }, [subject, baseRx, baseRy])

  /**
   * 外部改角度（滑块、重置按钮）时采纳，自己上报的回声则忽略。
   * @why 不区分的话，父组件把我们的角度存进 state 再传回来，会被当成
   *      "外部要求跳到这个角度"，正在做的滑行每帧被打断。
   * @constraint 滑块要平滑跟手（seek），重置按钮干脆瞬移（snap）：
   *      两者都从同一条路进来，靠"差多少"区分——差得远就是重置。
   */
  useEffect(() => {
    if (!view) return
    /**
     * @constraint 比较必须按环形距离：内部角度是连续的（可能已经 720°），
     *      父组件给的是归一化后的 -180..180。直接用差值比，每次上报都会被
     *      误判成"外部要求跳转"，滑行中途被打断。
     */
    /**
     * @constraint 拖动与滑行期间一律不接受外部同步。
     *      上报是节流的，父组件的 view 会滞后我们几十毫秒；这期间只要父组件
     *      重渲染一次，就会被误判成"外部要求跳到旧角度"，seek 直接接管，
     *      拖到一半的位移全被丢掉——手感上就是"甩一下就卡住"。
     *      滑块/重置只可能在没有指针的时候被操作，不会冲突。
     */
    const mode = spin.current.mode
    if (mode === 'drag' || mode === 'glide') return
    const gapX = Math.abs(view.rotX - reported.current.x)
    const gapY = Math.abs(yawGap(view.rotY, reported.current.y))
    if (gapX < 1e-3 && gapY < 1e-3) return
    const targetY = nearestYaw(spin.current.ry, view.rotY)
    const jump = Math.abs(view.rotX - spin.current.rx) + Math.abs(targetY - spin.current.ry)
    if (jump > 150) snapOrbit(spin.current, view.rotX, targetY)
    else seekOrbit(spin.current, view.rotX, targetY)
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
      /**
       * @constraint 会动的必须跳过缓存。缓存键里只有纹理、角度和光照，没有时间：
       *      第一次画出来那一帧会被永久记住。以前只排除了 blockAnim，实体卡片
       *      悬停播放时每一帧都命中缓存，看起来"打开了动画但完全没动"。
       */
      const cacheKey = interactive || blockAnim || animatedLive.current
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
        /**
         * @constraint yaw 必须给实体的真实朝向，不能加一条正弦摆动。
         *      setupAnim 里的 yaw 是"头与身体的夹角"，喂一个随时间摆的值，
         *      整只生物会不分场合地左右摇头——看着像抽搐，而不是在走路。
         *      站立与前进时头身同向，差值就是 0。
         */
        const poses = subject.poser.pose({
          t: elapsed,
          speed: liveSpeed,
          pitch: 0,
          yaw: 0,
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
      /**
       * @constraint 动画方块按帧号进键，动画实体走空键。
       *      方块动画只有几帧，按帧缓存能省掉每帧的网格重建；
       *      实体姿势每帧都不同，缓存等于每帧写一份新网格，只有坏处。
       */
      const gpuKey =
        subject.kind === 'entity'
          ? ''
          : blockAnim
            ? `${textureKey}|${Math.floor(Math.floor(elapsed * 20) / blockAnim.frametime) % blockAnim.steps}`
            : textureKey
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
        gpuKey,
        shading: subject.kind === 'entity' ? 'entity' : 'block',
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

    const report = (now: number, force = false) => {
      if (!onViewChange) return
      if (!force && now - lastReport < REPORT_INTERVAL) return
      const { rx, ry } = spin.current
      if (Math.abs(rx - reported.current.x) < 0.05 && Math.abs(ry - reported.current.y) < 0.05) return
      lastReport = now
      const yaw = normalizeYaw(ry)
      reported.current = { x: rx, y: yaw }
      const live = viewLive.current ?? { rotX: rx, rotY: yaw, zoom: 1, light: 1, blur: 0, outline: 0 }
      onViewChange({ ...live, rotX: rx, rotY: yaw })
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

      const beforeRx = state.rx
      const beforeRy = state.ry
      if (stepOrbit(state, dt)) dirty.current = true

      /**
       * 转动速度（度/秒）折算成 0..1；骨骼动画按运动强度给一个基础量。
       * @why 150°/s 已经是很用力的甩，再快也不该更糊。
       */
      const moved = Math.abs(state.rx - beforeRx) + Math.abs(state.ry - beforeRy)
      const rate = moved / Math.max(1e-3, dt)
      const anim = animatedLive.current ? Math.min(1, speedLive.current) : 0
      const target = Math.min(1, rate / 90 + anim * 0.7)
      // 上升快、回落慢：松手那一下的余韵不该立刻消失
      activity.current += (target - activity.current) * (target > activity.current ? 0.5 : 0.08)

      if (dirty.current) {
        dirty.current = false
        draw()
      }
      /**
       * @constraint 滑行结束必须补报一次，否则父组件里存的是松手前 120ms 的角度，
       *      滑块停在半路，导出的机位也跟着错。
       */
      const settled =
        !orbitBusy(state) &&
        (Math.abs(state.rx - reported.current.x) > 0.05 || Math.abs(yawGap(state.ry, reported.current.y)) > 0.05)
      report(now, settled)
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
      /**
       * @constraint 实体卡片也要走到订阅那一步：以前这里 `if (!blockAnim) return`
       *      直接退出，animated 只对详情页生效，于是生物列表是九十张静止的模型。
       *      悬停时 animated 变 true 会重建这个 effect，但纹理与光栅化结果都有缓存，
       *      重建本身只多画一帧。
       */
      if (!blockAnim && !animatedLive.current) return

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

  /** 松手/停止时把最终角度交出去，别让导出面板拿着节流窗口内的旧值 */
  const flush = () => {
    const yaw = normalizeYaw(spin.current.ry)
    const live = viewLive.current ?? { rotX: spin.current.rx, rotY: yaw, zoom: 1, light: 1, blur: 0, outline: 0 }
    reported.current = { x: spin.current.rx, y: yaw }
    onViewChange?.({ ...live, rotX: spin.current.rx, rotY: yaw })
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.current.size === 1) {
      pending.current = { x: event.clientX, y: event.clientY }
      trail.current = [{ t: event.timeStamp, x: event.clientX, y: event.clientY }]
      beginDrag(spin.current)
      return
    }
    /**
     * 第二根手指按下来：立刻退出旋转，改成缩放。
     * @constraint 必须同时清掉角速度，否则松手后还会带着捏合前的惯性甩出去。
     */
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      if (a && b) pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: zoomLocal.current }
      spin.current.mode = 'idle'
      spin.current.vrx = 0
      spin.current.vry = 0
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!interactive) return
    const tracked = pointers.current.get(event.pointerId)
    if (!tracked) return
    tracked.x = event.clientX
    tracked.y = event.clientY

    // 双指：只做缩放，不动角度
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()]
      if (!a || !b) return
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      applyZoom(pinch.current.zoom * (dist / pinch.current.dist))
      return
    }

    if (spin.current.mode !== 'drag') return
    /**
     * 用 coalesced 事件能拿到被合并掉的中间点：快甩时浏览器每帧只派发一个
     * pointermove，中间那几十像素全丢了，速度算出来偏小，表现为"甩不动"。
     */
    const raw = event.nativeEvent
    const events = typeof raw.getCoalescedEvents === 'function' ? raw.getCoalescedEvents() : []
    const points = events.length > 0 ? events : [raw]

    const state = spin.current
    for (const point of points) {
      const prev = pending.current
      if (!prev) continue
      pending.current = { x: point.clientX, y: point.clientY }
      dragOrbit(state, point.clientX - prev.x, point.clientY - prev.y)
      trail.current.push({ t: point.timeStamp, x: point.clientX, y: point.clientY })
    }
    // 只留窗口内的采样点，长按拖动不至于攒出几千个
    const cutoff = event.timeStamp - GLIDE_WINDOW
    while (trail.current.length > 2 && trail.current[0]!.t < cutoff) trail.current.shift()
    dirty.current = true
  }

  /**
   * 滚轮缩放。
   *
   * @constraint 必须用原生监听器加 passive:false：React 的 onWheel 在部分浏览器上
   *      是 passive 的，preventDefault 会被忽略，缩放时整页跟着滚。
   * @constraint 基准值取 zoomLocal 而不是父组件的 zoom：连续滚轮事件在同一帧里
   *      派发好几次，父组件的 state 还没回流，每次都拿旧值乘，滚十格只放大一档。
   */
  useEffect(() => {
    const element = holderRef.current
    if (!element || !interactive) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // 触控板的双指缩放会带 ctrlKey，步长比滚轮细，给大一档系数才跟手
      const gain = event.ctrlKey ? 0.006 : 0.0016
      applyZoom(zoomLocal.current * Math.exp(-event.deltaY * gain))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, baseRx, baseRy])

  const endPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    /**
     * @constraint 只有"确实摘掉了一个还在按着的指针"才算松手。
     *      浏览器在 pointerup 之后还会补一个 lostpointercapture，两个 handler
     *      都挂在这里；不挡住第二次，第一次算好的惯性会被第二次的
     *      "零速度松手"清掉，松手就完全没有余韵。
     */
    const had = pointers.current.delete(event.pointerId)
    if (!had) return
    pinch.current = null

    if (pointers.current.size === 0) {
      pending.current = null
      /**
       * @constraint 用窗口内的首尾位移算速度，不用"最后一帧的差分"：
       *      手指松开会先派发一个同位置 move，那一帧位移为 0，直接差分
       *      等于把速度清零——这正是"甩了没反应"的原因。
       */
      const points = trail.current
      if (points.length >= 2) {
        const first = points[0]!
        const last = points[points.length - 1]!
        const span = Math.max(0.008, (last.t - first.t) / 1000)
        endDrag(
          spin.current,
          ((last.x - first.x) / span) * YAW_PER_PX,
          ((last.y - first.y) / span) * PITCH_PER_PX,
        )
      } else {
        endDrag(spin.current, 0, 0)
      }
      trail.current = []
      flush()
      return
    }
    /**
     * @constraint 从两指回到一指时不能沿用旧的锚点：捏合过程中手指位置一直在变，
     *      用旧锚点会让剩下那根手指一落下就把模型转掉一大截。
     */
    const [rest] = [...pointers.current.values()]
    if (!rest) return
    pending.current = { x: rest.x, y: rest.y }
    if (pointers.current.size === 1) beginDrag(spin.current)
  }

  /** 双击回到默认机位：用户转晕了总得有个出口 */
  const onDoubleClick = () => {
    if (!interactive) return
    snapOrbit(spin.current, baseRx, baseRy)
    applyZoom(1)
    dirty.current = true
  }

  return (
    <div
      ref={holderRef}
      className={`thumb${interactive ? ' thumb--interactive' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onLostPointerCapture={endPointer}
      onDoubleClick={onDoubleClick}
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
