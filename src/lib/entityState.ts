/**
 * 实体状态推进器：把 LivingEntity 的每 tick 逻辑写成时间的闭式函数。
 *
 * @why 之前 anim.ts 里的驱动量全是估的（`pos = t * 7`、`speed = 0.42 × 输入`），
 *      量纲和游戏对不上：玩家实际 walkAnimationSpeed 是 0.864 而不是 0.42，
 *      position 每秒推进 17.3 而不是 7。腿的摆动相位因此慢了 2.5 倍，
 *      所有四足动物看起来都在"慢动作端着走"，而摆幅又被硬压，两者互相抵消
 *      之后就是"说不上哪里不对，但肯定不是游戏里的样子"。
 *
 * @constraint 必须是 t 的纯函数，不能持有帧间状态。measureCycle 要按任意时刻
 *      采样姿势做自相关（导出时长要按周期取整），一旦引入内部累加器，
 *      同一个 t 采样两次会得到不同结果，周期就测不出来。
 *      所以这里把逐 tick 的递推解成闭式：speed_n = target·(1-0.6^n)，
 *      position_n = n·target − speed_n/0.4。
 */

/**
 * 玩家步行速度，格/tick。
 *
 * @why 4.317 m/s 是 LivingEntity 步行基准，除以 20 tick/s。所有"走多快"的
 *      归一化都以它为 1，这样 targetSpeed = min(0.216×4, 1) = 0.864，
 *      与游戏里玩家行走时的 walkAnimationSpeed 完全一致。
 */
const WALK_SPEED = 0.216

/** LivingEntity.updateWalkAnimation：位移放大 4 倍后当目标速度，上限 1 */
const WALK_GAIN = 4

/** updateWalkAnimation 传给 WalkAnimationState.update 的平滑系数 */
const WALK_SMOOTHING = 0.4

/** 平滑系数的补数：(1 - 0.4) = 0.6，闭式解里的衰减底数 */
const WALK_DECAY = 1 - WALK_SMOOTHING

/**
 * 婴儿的位移缩放。
 * @constraint 是「位置」乘 3 而不是「速度」乘 3：小孩腿短、迈步频率高但步幅小，
 *      游戏里靠 positionScale 实现（update(target, 0.4, isBaby ? 3 : 1)）。
 *      乘到速度上会把摆幅也放大 3 倍，幼年生物会劈叉。
 */
const BABY_POSITION_SCALE = 3

export interface WalkSample {
  /** 累计行走距离（格），模型里的 limbSwing / animationPos */
  pos: number
  /** 平滑后的行走速度 0..1，模型里的 limbSwingAmount / animationSpeed */
  speed: number
}

/**
 * 走 / 跑。
 *
 * @param t 秒
 * @param intensity 用户选的强度，1 是步行，1.6 是奔跑，0 是站立
 * @param baby 幼年体：步幅不变、步频提高
 */
export function walkSample(t: number, intensity: number, baby: boolean): WalkSample {
  const ticks = t * 20
  const distance = WALK_SPEED * intensity
  const target = Math.min(distance * WALK_GAIN, 1)
  const speed = target * (1 - Math.pow(WALK_DECAY, ticks))
  // 等比数列求和：Σ speed_i = n·target − speed_n/0.4
  const position = ticks * target - speed / WALK_SMOOTHING
  return { pos: position * (baby ? BABY_POSITION_SCALE : 1), speed }
}

/**
 * 一个完整步态周期的秒数。
 *
 * @why 导出循环动图/视频时，时长必须是周期的整数倍，否则末帧接回首帧会跳相位。
 *      四足和人形的腿都是 cos(limbSwing · 0.6662)，所以相位转 2π 即一个周期；
 *      而这次 limbSwing 已经是真实的「格」，不再是拍脑袋的斜率。
 */
export function walkCycle(intensity: number, baby: boolean): number | null {
  const target = Math.min(WALK_SPEED * intensity * WALK_GAIN, 1)
  if (!(target > 1e-4)) return null
  const perSecond = 20 * target * (baby ? BABY_POSITION_SCALE : 1)
  return (Math.PI * 2) / (perSecond * 0.6662)
}

/**
 * 史莱姆 / 岩浆怪的挤压量。
 *
 * @why 之前是一条永不停止的正弦（0 ~ 0.7），史莱姆站着不动也在不停鼓包，
 *      像颗心脏在跳。游戏里 squish 只在起跳那一下拉长、落地那一下压扁，
 *      其余时间逐 tick 衰减回 0。
 *
 * 源码（AbstractCubeMob.tick）：
 *   oSquish = squish;  squish += (targetSquish - squish) * 0.5
 *   !onGround && wasOnGround → targetSquish = 1.0f   （离地，拉长）
 *   onGround && !wasOnGround → targetSquish = -0.5f  （落地，压扁）
 *   decreaseSquish()         → targetSquish *= 0.6   （每 tick）
 *
 * @constraint 不能写成闭式。target 每 tick 乘 0.6、squish 又以 0.5 去追它，
 *      两个不同速率的指数叠在一起，解出来是一串不收敛的项；而实测峰值
 *      （约 0.55）恰好出现在第 2 tick，和"只看稳态"的估算差了近一倍。
 *      这里干脆按源码递推跑满一个周期存表，运行时按相位插值——20 次乘法
 *      在模块加载时算一次，每帧只是一次线性插值。
 */
const HOP_TICKS = 30

/**
 * @constraint 滞空固定 10 tick、地面占剩下 20 tick，而不是对半分。
 *      游戏里 getJumpDelay 是 random(20)+10，落地后要停 1~1.5 秒才再跳，
 *      对半分会让史莱姆永远处在"正在变形"的状态，看起来像在喘气；
 *      给足地面时间，观感才是"隔一会儿蹦一下"。
 */
const AIR_TICKS = 10

const SQUISH_TABLE: number[] = (() => {
  const table: number[] = []
  let squish = 0
  let target = 0
  let wasOnGround = true
  for (let i = 0; i < HOP_TICKS; i += 1) {
    const onGround = i >= AIR_TICKS
    if (onGround && !wasOnGround) target = -0.5
    else if (!onGround && wasOnGround) target = 1
    wasOnGround = onGround
    squish += (target - squish) * 0.5
    target *= 0.6
    table.push(squish)
  }
  return table
})()

export function squishSample(t: number): number {
  const raw = (t * 20) % HOP_TICKS
  const phase = raw < 0 ? raw + HOP_TICKS : raw
  const i = Math.floor(phase)
  const next = (i + 1) % HOP_TICKS
  const alpha = phase - i
  return SQUISH_TABLE[i]! + (SQUISH_TABLE[next]! - SQUISH_TABLE[i]!) * alpha
}

/**
 * 鱿鱼触手角。
 *
 * @why 之前是 0.3 + 0.25·sin(t·2.2)，值域 0.05~0.55，形状是双边正弦。
 *      游戏里是整流正弦 |sin(movement)|·π/4：触手只往一个方向摆，
 *      每个 π 一个脉冲，回程是瞬间归零而不是对称摆回来。
 *      Squid.aiStep 非水下分支：tentacleAngle = |sin(tentacleMovement)| · π/4
 *
 * @constraint 只实现"非水下"分支。水下分支要求 tentacleMovement < π，
 *      而客户端的 tentacleMovement 涨到 2π 就永久卡住（Squid.aiStep 里
 *      isClientSide 时直接赋 2π 不重置），水下最终恒为 0——那是渲染端行为，
 *      不是模型该展示的常态。
 */
export function tentacleSample(t: number): number {
  /** tentacleSpeed 初值 1/(rand+1)*0.2，取值区间 0.1~0.2，中位 0.15 */
  const movement = t * 20 * 0.15
  return Math.abs(Math.sin(movement)) * (Math.PI / 4)
}

/**
 * 振翅相位（圈数，0..1 一圈）。
 *
 * @why EnderDragonModel 里是 `flapTime * 2π` 再取 sin，所以这一位是圈数不是弧度。
 *      EnderDragon.flapTime 每 tick += 0.1f，即每秒 2 圈——快飞时略快，
 *      慢飞时略慢，用 0.1 × (0.5 + 0.5·强度) 保留这个差别。
 */
export function flapSample(t: number, intensity: number): number {
  return t * 2 * (0.5 + 0.5 * Math.min(1.6, intensity))
}
