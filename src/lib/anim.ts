/**
 * 实体动作：把反编译出来的 setupAnim 当成脚本执行。
 *
 * @why 不手写"四足动物腿摆 0.6662 弧度"这类公式，是因为每个实体的参数都不同
 *      （鸡有翅膀扇动、蜘蛛有八条腿、人形有手臂对摆）。这些数字就在游戏的
 *      *Model.java 里，scripts/extract-anim.py 已经把它们转译成 JS 语句，
 *      这里只负责按继承链串起来执行。改参数、加实体都不用动前端代码。
 *
 * @constraint 用 new Function 而不是 eval：编译一次、缓存起来，
 *      每帧只是调用一个普通函数，不产生解析开销。
 */
import type { PartPose, Rig } from './entityRig'
import { initialPose } from './entityRig'
import { applyKeyframes, type KeyDefinitions } from './keyframe'
import { MC_BASE } from './mc'
import { fetchWithRetry } from './net'

interface AnimClass {
  extends: string | null
  fields: Record<string, string>
  /** 部件数组字段（鱿鱼八条触手、蠹虫七节身子），字段名 → 部件名列表 */
  arrays?: Record<string, string[]>
  sup: boolean
  code: string
  /** setupAttackAnimation 的转译结果，独立成方法（不是 setupAnim 的一部分） */
  attack?: string
}

/** AnimationUtils 里的静态方法，按形参名转译成函数 */
interface AnimUtility {
  params: string[]
  code: string
}

export interface AnimFile {
  enums: string[]
  classes: Record<string, AnimClass>
  /** 工具方法表；老版本文件没有这个键 */
  anims?: Record<string, AnimUtility>
  /** 每个类的 setupAttackAnimation 分层代码，父在前子在后 */
  attacks?: Record<string, string[]>
  /**
   * 所有 state.isXxx / hasXxx 标记名。
   * @why 前端默认值表列不全（isHidingInShell、isSneezing…），漏掉的会被黑洞
   *      Proxy 当成 truthy，犰狳就永远缩在壳里变成一颗球。
   */
  flags?: string[]
  /** 关键帧动画定义：CAMEL_WALK、FROG_WALK…（26.3 起大部分动物靠它） */
  defs?: KeyDefinitions
}

const cache = new Map<string, Promise<AnimFile>>()

export function loadAnims(version: string): Promise<AnimFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    // @constraint 带版本参数：转译规则改过几轮，浏览器缓存住旧的
    //              entityanims.json 会让新代码读到没有 attacks 的旧数据，
    //              表现就是"改了没生效"。
    const response = await fetchWithRetry(`${MC_BASE}/${version}/entityanims.json?v=10`)
    if (!response.ok) throw new Error(`实体动画加载失败：${response.status}`)
    return (await response.json()) as AnimFile
  })()
  cache.set(version, task)
  return task
}

export interface AnimState {
  /** 秒 */
  t: number
  /** 行走强度 0..1，0 是站立 */
  speed: number
  /** 头部俯仰（度） */
  pitch: number
  /** 头部偏航（度） */
  yaw: number
}

/**
 * Minecraft 的数学库子集，MC 是转译代码里的命名空间。
 * @constraint 外面再包一层 Proxy：Mth 有三十多个函数（triangleWave、catmullRom…），
 *      漏一个就会在运行时抛 TypeError 把整只生物的画布打空。未知函数返回 0，
 *      动作会略失真，但模型还能正常显示。
 */
const MC_IMPL = {
  cos: Math.cos,
  sin: Math.sin,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  atan2: Math.atan2,
  PI: Math.PI,
  clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
  /**
   * Mth.lerp(delta, start, end) —— 参数顺序是「插值系数在前」。
   *
   * @constraint 不能写成 (start, end, delta)：Java 原文一律 `Mth.lerp(eating, a, b)`，
   *      顺序错位后返回值完全离谱。马的 `headParts.z = Mth.lerp(standing, z, -4)`
   *      被算成 `standing + (z - standing) * -4`，脖子从 z=-12 飞到 z=+48，
   *      整颗头脱离身体悬在半空。
   */
  lerp: (delta: number, start: number, end: number) => start + (end - start) * delta,
  /** Mth.clampedLerp(delta, start, end)：船桨全靠它，缺了就整条桨不动 */
  clampedLerp: (delta: number, start: number, end: number) =>
    start + (end - start) * Math.min(1, Math.max(0, delta)),
  rotLerp: (delta: number, start: number, end: number) => {
    let diff = end - start
    while (diff >= 180) diff -= 360
    while (diff < -180) diff += 360
    return start + diff * delta
  },
  wrapDegrees: (deg: number) => {
    let d = deg % 360
    if (d >= 180) d -= 360
    if (d < -180) d += 360
    return d
  },
  approach: (value: number, target: number, step: number) =>
    value < target ? Math.min(value + step, target) : Math.max(value - step, target),
  /** AnimationUtils.bobModelPart：手臂的轻微摆动 */
  bob: (part: { xRot: number; zRot: number }, ageInTicks: number, multiplier: number) => {
    part.zRot += multiplier * (Math.cos(ageInTicks * 0.09) * 0.05 + 0.05)
    part.xRot += multiplier * (Math.sin(ageInTicks * 0.067) * 0.05)
  },
  sign: Math.sign,
  square: (value: number) => value * value,
  frac: (value: number) => value - Math.floor(value),
  triangleWave: (value: number, period: number) => {
    const t = value % period
    return t < period / 2 ? t * 2 : period - t * 2
  },
  degreesDifference: (a: number, b: number) => {
    let diff = (b - a) % 360
    if (diff >= 180) diff -= 360
    if (diff < -180) diff += 360
    return diff
  },
  inverseLerp: (a: number, b: number, v: number) => (v - a) / (b - a || 1),
}

const MC = new Proxy(MC_IMPL as Record<string, unknown>, {
  get(target, key: string) {
    const value = target[key]
    if (typeof value === 'function') return value
    if (typeof value === 'number') return value
    return () => 0
  },
})

/**
 * 黑洞值：任何属性访问、调用、下标都返回它自己，参与算术时等于 0。
 *
 * @why 转译出来的代码里有大量我们没接进来的东西——DragonFlightHistory 采样、
 *      getHeadPartYOffset()、被跳过的 for 循环里声明的 point/start 变量。
 *      这些要么返回 0（然后 0.y() 抛 "not a function"），要么返回 undefined
 *      （然后 undefined.x 抛错）。黑洞值让整条链都能走完，
 *      结果是这段动作失真，而不是整只生物渲染失败。
 *
 * @constraint 每个未知标识符拿到的是**一个新的**黑洞，而不是共享单例。
 *      共享时 `pose === PiglinArmPose.DANCING` 会变成"自己和自己是同一个对象"
 *      恒为 true，猪灵于是永远在跳胜利之舞——这类分支误判比动作失真假得多。
 *      同一个黑洞内部仍然稳定（x.a.b 都指回它自己），链式访问不受影响。
 */
function unknownValue(): Record<string | symbol, unknown> {
  const target = function unknown() {} as unknown as Record<string | symbol, unknown>
  const proxy: Record<string | symbol, unknown> = new Proxy(target, {
    get(_target, key) {
      if (key === Symbol.toPrimitive) return () => 0
      if (key === 'valueOf') return () => 0
      if (key === 'toString') return () => '0'
      if (key === 'then') return undefined
      return proxy
    },
    apply() {
      return proxy
    },
    set() {
      return true
    },
  })
  return proxy
}

/** 枚举桩：HumanoidArm.RIGHT 这类引用返回字符串本身，比较仍然成立 */
const makeEnum = () =>
  new Proxy(
    {},
    {
      get: (_target, key: string) => key,
    },
  )

/** 动画状态的取值：数字、布尔，以及 ArmPose 这类枚举桩字符串 */
type StateBag = Record<string, number | boolean | string>

type Runner = (p: Record<string, PartPose>, state: StateBag) => void

const runners = new Map<string, Runner | null>()

/**
 * 转译出来的动画工具方法挂在共享对象上。
 *
 * @why 不能声明成模块级常量：with(guard) 里任何标识符查找都会先问 guard，
 *      guard.has 恒为 true，模块级变量会被黑洞值盖掉。只有放进 scope、
 *      由 guard.get 返回的对象才拿得到——所以每帧重新绑一次属性（幂等）。
 */
const ANIM: Record<string, (...args: never[]) => unknown> = {}

/**
 * 关键帧求值需要「当前这只生物的姿势表」，而编译出来的动作函数只认识
 * 全局作用域。用一个模块级上下文传进去：pose() 是同步调用，不存在并发。
 */
const KF: { poses: Map<string, PartPose> | null; defs: KeyDefinitions | null; time: number } = {
  poses: null,
  defs: null,
  time: 0,
}

/**
 * 关键帧行走的一次调用。
 * @why 参数顺序与语义照抄 KeyframeAnimation.applyWalk：时间 = pos·50ms·factor，
 *      幅度 = min(speed·scale, 1)。幅度 0 时整体失效，正好对应"站着不动"。
 */
function kfWalk(name: string, pos: number, speed: number, factor: number, scale: number): void {
  const definition = KF.defs?.[name]
  if (!definition || !KF.poses) return
  applyKeyframes(definition, KF.poses, (pos * 50 * factor) / 1000, Math.min(speed * scale, 1))
}

/**
 * 状态型关键帧（蝙蝠振翅、旋风人待机、兔子跳跃）。
 *
 * @why 游戏里这些动画由 AnimationState 按事件启停，素材站没有事件——
 *      统一用同一条时间轴驱动，幅度恒为 1，否则姿态会被整体缩放成静止。
 * @constraint 每只生物只跑一套主状态：多套同时叠加会抢同一批骨骼，
 *      蝙蝠的 flying 与 resting 一起 apply 就是翅膀打架。
 */
function kfApply(name: string): void {
  const definition = KF.defs?.[name]
  if (!definition || !KF.poses) return
  applyKeyframes(definition, KF.poses, KF.time, 1)
}

/** 从叶子往根收集继承链，遇到"没调 super"的类就断开 */
function chainFor(modelClass: string, anim: AnimFile): AnimClass[] {
  const chain: AnimClass[] = []
  let current: string | null = modelClass
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    seen.add(current)
    const node: AnimClass | undefined = anim.classes[current]
    if (!node) break
    chain.push(node)
    // 子类没调 super.setupAnim，父类的姿势不该生效
    if (!node.sup && node.code) break
    current = node.extends
  }
  return chain.reverse()
}

/**
 * 生成 AnimationUtils 的静态方法 + 本模型的 setupAttackAnimation 分层。
 *
 * @why 两件事必须一起做：僵尸手臂的前平举在 animateZombieArms 里，而它由
 *      setupAttackAnimation 调用。只抄 setupAnim 的模型会退化成"正常人走路甩手"。
 * @constraint 父类那一层单独成函数：它的第一句是 `if (swingAnimation <= 0) return`，
 *      拼进子类会让子类的赋值永远跑不到。子类用 __parent(state) 续接。
 */
function compileExtras(anim: AnimFile, modelClass: string): string {
  const utils = anim.anims ?? {}
  const parts: string[] = ['function __noop() {}']

  for (const [name, def] of Object.entries(utils)) {
    parts.push(`function __u_${name}(${def.params.join(', ')}) {\n${def.code}\n}`)
  }
  for (const name of Object.keys(utils)) {
    parts.push(`ANIM.${name} = __u_${name};`)
  }

  const layers = anim.attacks?.[modelClass] ?? []
  layers.forEach((code, index) => {
    const parent = index > 0 ? `__atk${index - 1}(` : '__noop('
    const filled = code.replace(/\b__parent\(/g, parent)
    parts.push(`function __atk${index}(state) {\n${filled}\n}`)
  })
  parts.push(layers.length > 0 ? `ANIM.setupAttackAnimation = __atk${layers.length - 1};` : 'ANIM.setupAttackAnimation = __noop;')

  return parts.join('\n')
}

function compile(modelClass: string, anim: AnimFile): Runner | null {
  if (runners.has(modelClass)) return runners.get(modelClass) ?? null

  const chain = chainFor(modelClass, anim)
  const body = chain
    .filter((node) => node.code)
    .map((node) => `{\n${node.code}\n}`)
    .join('\n')

  if (!body.trim() && !(anim.attacks?.[modelClass]?.length)) {
    runners.set(modelClass, null)
    return null
  }

  const source = `${compileExtras(anim, modelClass)}\n${body}`

  const enums = anim.enums.filter((name) => name !== 'Math')
  try {
    /**
     * @constraint 必须用 with(guard) 而不是普通形参列表：转译出来的代码里
     *      引用了不少局部变量（amplitudeMultiplier、crystalY…），它们的声明语句
     *      在上下文里没被转译出来。guard 的 has() 恒为 true，任何未声明的标识符
     *      都会落到 get() 返回 0，而不是抛 ReferenceError 把整个模型打空。
     *      这也是不能用严格模式的原因——严格模式下 with 是语法错误。
     */
    // eslint-disable-next-line no-new-func
    const fn = new Function('guard', `with (guard) {\n${source}\n}`) as (guard: unknown) => void
    const enumArgs = enums.map(makeEnum)
    const runner: Runner = (p, state) => {
      const scope: Record<string, unknown> = { p, state, MC, Math, ANIM, __kfWalk: kfWalk, __kfApply: kfApply }
      enums.forEach((name, index) => {
        scope[name] = enumArgs[index]
      })
      /**
       * @constraint 单个模型的动作代码出错不能拖垮整页：抛出去会中断
       *      requestAnimationFrame 回调，那只生物就永远停在第一帧之前，
       *      用户看到的是空白卡片。出错就当作没有动作，模型照样显示。
       */
      try {
        fn(makeGuard(scope))
      } catch (error) {
        /* 动作失真但模型必须活着 */
        if ((globalThis as { __animDebug?: boolean }).__animDebug) {
          console.warn('[anim]', modelClass, error)
        }
      }
    }
    runners.set(modelClass, runner)
    return runner
  } catch {
    runners.set(modelClass, null)
    return null
  }
}

function makeGuard(scope: Record<string, unknown>): unknown {
  return new Proxy(scope, {
    has: () => true,
    get(target, key: string | symbol) {
      if (key === Symbol.unscopables) return undefined
      if (typeof key === 'string' && key in target) return target[key]
      return unknownValue()
    },
  })
}

/**
 * 一个模型类（含继承链）的转译后代码。
 * @why 判断"这只生物到底在动什么"只能看代码用了哪些驱动量（walkAnimation、flapTime…），
 *      没有别的数据能回答——RenderState 里的字段是渲染器填的，模型本身才知道读哪个。
 */
export function classSource(modelClass: string, anim: AnimFile): string {
  return chainFor(modelClass, anim)
    .map((node) => node.code)
    .join('\n')
}

export interface Poser {
  /** 按时间算出每个部件的姿势 */
  pose: (state: AnimState) => Map<string, PartPose>
  /** 是否有真实动画代码 */
  animated: boolean
}

/**
 * 行走相位每秒推进多少（limbSwing 的累积速率）。
 * @constraint 不写成常量而跟着 speed 变：站立时相位空转无所谓（幅度为 0），
 *      但奔跑时如果只是加大幅度而不是加快步频，腿会劈到穿模，看起来像在抽搐。
 */
function swingRate(speed: number): number {
  return 7 * (0.55 + 0.45 * Math.min(1.6, speed))
}

/**
 * 一个完整行走周期的秒数（左右腿各迈一次）。
 *
 * @why 导出循环动图时，播放时长必须是它的整数倍，否则最后一帧接回第一帧会跳相位——
 *      用户看到的就是"首尾拼不上"。四足和人形的腿部摆动都是 cos(limbSwing * 0.6662)，
 *      所以相位转 2π 就是一个周期；这个 0.6662 是游戏里写死的。
 */
export function walkCycle(speed: number): number {
  return (Math.PI * 2) / (swingRate(speed) * 0.6662)
}

/**
 * 给一个模型建立姿势生成器。
 * @constraint 复用同一批 PartPose 对象并逐帧重置，避免 60fps 下每秒产生上万个对象。
 */
export function createPoser(modelClass: string | null, rig: Rig, anim: AnimFile | null): Poser {
  const poses = new Map<string, PartPose>()
  const parts: { pose: PartPose; base: PartPose }[] = []
  for (const part of rig.parts) {
    const pose = initialPose(part)
    poses.set(part.name, pose)
    parts.push({ pose, base: { ...pose } })
  }

  const runner = modelClass && anim ? compile(modelClass, anim) : null

  // 字段名（camelCase）→ 部件名（snake_case）的别名，动画代码里用的是 Java 字段名
  const aliases = new Map<string, string>()
  if (modelClass && anim) {
    for (const node of chainFor(modelClass, anim)) {
      for (const [field, part] of Object.entries(node.fields)) aliases.set(field, part)
    }
  }

  /**
   * 数组字段：p.tentacles 要拿到一组部件，而不是哑部件。
   * @why 动作代码里是 `for (const tentacle of p.tentacles)`，哑部件不可迭代，
   *      一抛就把整段动作代码废掉——鱿鱼、蠹虫、末影龙因此完全静止。
   */
  const arrayAliases = new Map<string, PartPose[]>()
  if (modelClass && anim) {
    for (const node of chainFor(modelClass, anim)) {
      for (const [field, names] of Object.entries(node.arrays ?? {})) {
        const list = names.map((name) => poses.get(name)).filter((pose): pose is PartPose => Boolean(pose))
        if (list.length > 0) arrayAliases.set(field, list)
      }
    }
  }

  const bag = new Proxy(
    {} as Record<string, PartPose | PartPose[] | Record<string, unknown>>,
    {
      get(target, key: string) {
        const direct = target[key]
        if (direct) return direct
        const array = arrayAliases.get(key)
        if (array) {
          target[key] = array
          return array
        }
        /**
         * @constraint 基类 Model.resetPose 是 `for (part : this.allParts) …`，
         *      内联进来之后 p.allParts 必须可迭代，否则一抛整段动作代码作废——
         *      所有继承 Model 的生物一起变木偶。
         */
        if (key === 'allParts') {
          const list = [...poses.values()]
          target[key] = list
          return list
        }
        const mapped = aliases.get(key)
        if (mapped) {
          const pose = poses.get(mapped)
          if (pose) {
            target[key] = pose
            return pose
          }
        }
        // 模型里没有这个部件：给个哑对象，姿势写进去也不会炸。
        // 哑对象本身也是 Proxy——代码里有 p.neckParts[0].x 这种下标访问，
        // 普通对象下标会拿到 undefined，然后 .x 就抛了
        const dummy = dummyPart()
        target[key] = dummy
        return dummy
      },
    },
  )

  const stateValues: StateBag = {
    xRot: 0,
    yRot: 0,
    ageInTicks: 0,
    walkAnimationPos: 0,
    walkAnimationSpeed: 0,
    /**
     * @constraint 这三个必须由时间驱动，否则参数量全为 0：
     *      flapTime 是龙/幻翼/恶魂的振翅相位，rowingTime 是船桨相位，
     *      tentacleAngle 是鱿鱼触手的摆角。缺一个，那只生物就凝在起始姿势。
     */
    flapTime: 0,
    rowingTimeLeft: 0,
    rowingTimeRight: 0,
    tentacleAngle: 0,
    /** 史莱姆/岩浆怪的挤压量：游戏里由落地事件驱动，这里用一条正弦代替 */
    squish: 0,
    speedValue: 1,
    swimAmount: 0,
    flap: 0,
    flapSpeed: 1,
    /**
     * @constraint 这几个必须给「真实的默认值」而不是留给黑洞 Proxy：
     *      animateZombieArms 靠 rightArmPose 判断要不要抬胳膊，靠 isBaby 决定
     *      抬多高。全给 SAFE 的话 `rightArmPose === ArmPose.SPEAR` 会变成
     *      两个黑洞比大小（同一个对象，恒等），判定直接走错分支。
     */
    rightArmPose: 'EMPTY',
    leftArmPose: 'EMPTY',
    /** 0 表示没在挥击，setupAttackAnimation 的父类实现会立刻 return */
    swingAnimation: 0,
    attackTime: 0,
    ageScale: 1,
    isAggressive: false,
    isBaby: false,
    isCrouching: false,
    isFallFlying: false,
    isPassenger: false,
    isUsingItem: false,
    isResting: false,
    isUnhappy: false,
  }

  // 所有布尔标记一律先当 false：默认状态是"平静地站着"，而不是某个特例姿势
  for (const flag of anim?.flags ?? []) {
    if (!(flag in stateValues)) stateValues[flag] = false
  }

  /**
   * @constraint state 也要包 Proxy：动画代码里有 state.getHistoricalPos(5).yRot()
   *      这种我们没实现的方法调用，直接访问会抛 "not a function"。
   */
  const state = new Proxy(stateValues, {
    get(target, key: string) {
      if (key in target) return target[key]
      return unknownValue()
    },
  }) as StateBag

  return {
    animated: Boolean(runner),
    pose(input) {
      for (const item of parts) {
        const { pose, base } = item
        pose.xRot = base.xRot
        pose.yRot = base.yRot
        pose.zRot = base.zRot
        pose.x = base.x
        pose.y = base.y
        pose.z = base.z
        // @why 复位到部件的初始 scale 而不是 1：恶魂 4.5 倍、猫 0.8 倍都写在
        //      root 的 PartPose 里，每帧抹成 1 等于把整体缩放取消掉。
        pose.xScale = base.xScale
        pose.yScale = base.yScale
        pose.zScale = base.zScale
        pose.visible = true
      }

      if (runner) {
        state.xRot = input.pitch
        state.yRot = input.yaw
        state.ageInTicks = input.t * 20
        state.walkAnimationPos = input.t * swingRate(input.speed)
        /**
         * @constraint 系数 0.42：人形/四足的步幅系数写死是 1.4 弧度，乘 1 就是
         *      ±80°，腿会劈到穿模、四足动物的身子像趴在地上。游戏里牛走路
         *      约 ±34°，对应 0.42。上限 1 是硬约束——超过腿会互相穿过。
         */
        state.walkAnimationSpeed = Math.min(1, 0.42 * input.speed)
        state.flap = input.t * 6
        state.flapSpeed = input.speed > 0.05 ? 1 : 0.35
        // @why flapTime 是"累计振翅时间"：游戏里每 tick 加一点，模型再乘自己的
        //      频率系数（幻翼 7.448、末影龙 2π）。这里按每 tick 0.1 折算。
        state.flapTime = input.t * 2 * (0.5 + 0.5 * Math.min(1.6, input.speed))
        /**
         * @constraint 两条桨相位差半个周期：同相的话左右桨会像鸭蹼一样一起划，
         *      看起来是船在抖而不是在前进。
         */
        state.rowingTimeLeft = input.t * 7 * input.speed
        state.rowingTimeRight = input.t * 7 * input.speed + Math.PI * 0.5
        state.tentacleAngle = 0.3 + 0.25 * Math.sin(input.t * 2.2)
        state.squish = 0.35 + 0.35 * Math.sin(input.t * 3)
        KF.poses = poses
        KF.defs = anim?.defs ?? null
        /**
         * @constraint 0.35 是待机基准频率：速度为 0 时动画也要走，
         *      否则"站着"的蝙蝠翅膀是僵的，看不出这是一只活的生物。
         */
        KF.time = input.t * (0.35 + 0.65 * Math.min(1.6, input.speed))
        runner(bag as unknown as Record<string, PartPose>, state)
        // 黑洞值被赋进姿势时可能是对象或 NaN，清洗掉，否则整个矩阵变成 NaN
        for (const item of parts) {
          const pose = item.pose
          if (!Number.isFinite(pose.xRot)) pose.xRot = 0
          if (!Number.isFinite(pose.yRot)) pose.yRot = 0
          if (!Number.isFinite(pose.zRot)) pose.zRot = 0
          if (!Number.isFinite(pose.x)) pose.x = item.base.x
          if (!Number.isFinite(pose.y)) pose.y = item.base.y
          if (!Number.isFinite(pose.z)) pose.z = item.base.z
        }
      }

      return poses
    },
  }
}

function createDummy(): PartPose {
  return { xRot: 0, yRot: 0, zRot: 0, x: 0, y: 0, z: 0, xScale: 1, yScale: 1, zScale: 1, visible: true }
}

/** 可下标、可继续点下去的哑部件：p.neckParts[0].xRot = 1 不会炸 */
function dummyPart(): PartPose {
  const base = createDummy()
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key as keyof PartPose]
      return dummyPart()
    },
    set(target, key, value) {
      if (key in target) (target as unknown as Record<string, unknown>)[key as string] = value
      return true
    },
  })
}
