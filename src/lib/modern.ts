/**
 * 现代化 UI 参数组。
 *
 * @why 参照 Modern UI（BloCamLimb，Modrinth `modern-ui`）的**真实配置面**，
 *      不是「圆角 / 阴影 / 描边」三个凭感觉的开关。那个 mod 的 Action Center
 *      里视觉部分可调的是：工具提示的圆角半径、阴影半径、阴影强度、边框样式
 *      （圆角平滑 / 原版带阴影）、标题分隔线、标题居中、背景不透明度
 *      （3.8.0.3 的 "Add in-game option for background opacity"）。
 *
 * @constraint 它的主战场是 **tooltip**，物品栏底板基本不动。所以这里绝大多数
 *      参数都挂在 tip* 上，panel* 只是给做素材图的人留的，默认全 0 —— 一上手
 *      就是原版长相，不会「一进页面就被现代化」。
 *
 * @constraint 全部参数都是**数值**而不是布尔。布尔只能表达「有/没有」，
 *      而 MUI 的阴影是半径 × 强度两个连续的轴、圆角是 0–12 的连续值。
 *      档位 UI 只是在数值上取几个离散点，导出侧拿到的仍是数值。
 */

export type TipBorder = 'vanilla' | 'round'

/**
 * 提示框参数，与 `mcui/tooltip` 的 `TipStyle` 同构。
 * @why 这里重复声明而不是 import：`mcui/tooltip` 又从本文件 import `TipBorder`，
 *      互相 import 会在 vite 的循环依赖检测里报警。结构同构由 `tipStyleOf`
 *      一处承担，两侧字段名对不上会直接编译失败。
 */
export interface TipStyleLike {
  radius: number
  shadowRadius: number
  shadowAlpha: number
  border: TipBorder
  titleRule: boolean
  centerTitle: boolean
  opacity: number
}

export interface ModernUi {
  /**
   * 总开关，对应「装没装这个 mod」。
   *
   * @why 必须有一个总开关而不是让用户把每项调回 0：MUI 在游戏里是一个独立
   *      模组，禁用之后整套视觉立刻退回原版，**参数不会被清掉**，重新启用
   *      还是上次那一套。没有这一层时，用户想「看一眼原版长什么样」就得
   *      把七项逐一调回原版值，然后再逐一调回去。
   * @constraint 关掉时不能写 MODERN_OFF 覆盖 state。参数要留着，
   *      由 `activeModern` 在渲染时降级。
   */
  enabled: boolean
  /** 工具提示圆角，GUI 像素。0 = 原版直角 */
  tipRadius: number
  /** 工具提示阴影扩散半径，GUI 像素。0 = 无阴影 */
  tipShadowRadius: number
  /** 工具提示阴影强度 0–1，对应 MUI 的 shadow strength */
  tipShadowAlpha: number
  /** 边框样式：原版九宫格 / 圆角平滑描边 */
  tipBorder: TipBorder
  /** 标题下方分隔线，MUI 的 title separator */
  tipTitleRule: boolean
  /** 标题行居中 */
  tipCenterTitle: boolean
  /** 底板不透明度 0–1 */
  tipOpacity: number
  /** 容器面板圆角，GUI 像素。0 = 直角 */
  panelRadius: number
  /** 容器面板投影 */
  panelShadow: boolean
}

/** 全关：等价于原版渲染 */
export const MODERN_OFF: ModernUi = {
  enabled: false,
  tipRadius: 0,
  tipShadowRadius: 0,
  tipShadowAlpha: 0,
  tipBorder: 'vanilla',
  tipTitleRule: false,
  tipCenterTitle: false,
  tipOpacity: 1,
  panelRadius: 0,
  panelShadow: false,
}

/**
 * 总开关拨到「开」时的初始值。
 *
 * @why 不能沿用全关的那套数值。打开开关却什么都没变，用户第一反应是
 *      「开关坏了」——原版模组装上 mod 立刻就是新长相，参数还能再调。
 *      这一套取的是「一眼能看出改了，又不至于认不出来」的中档。
 * @constraint 容器面板保持直角：MUI 不动物品栏底板，这里跟着不动，
 *      否则一开开关连物品栏都变形，比原版歪得更厉害。
 */
export const MODERN_DEFAULT: ModernUi = {
  enabled: true,
  tipRadius: 8,
  tipShadowRadius: 7,
  tipShadowAlpha: 0.34,
  tipBorder: 'round',
  tipTitleRule: true,
  tipCenterTitle: true,
  tipOpacity: 0.86,
  panelRadius: 0,
  panelShadow: false,
}

/**
 * 实际拿去渲染的参数。
 *
 * @why 屏幕 DOM、canvas 导出、PSD 三条路径都要过这一层。让每个使用点自己
 *      判断 `enabled` 迟早漏一处，漏掉的那条路径就会「开关关了还在圆角」。
 */
export function activeModern(ui: ModernUi | undefined): ModernUi {
  if (!ui || !ui.enabled) return MODERN_OFF
  return ui
}

/**
 * 拨总开关。打开时如果所有参数还是原版值，套一层默认预设。
 *
 * @why 只判断「参数是否全原版」而不是「是否首次打开」：用户把参数全调回
 *      原版再关再开，也应该重新看到效果，否则还以为是开关坏了。
 */
export function toggleModern(ui: ModernUi, on: boolean): ModernUi {
  if (!on) return { ...ui, enabled: false }
  return { ...(isModernTouched(ui) ? ui : MODERN_DEFAULT), enabled: true }
}

/** 档位表。数值直接进渲染，UI 只负责在这几个点上跳 */
export const TIP_RADII = [0, 4, 8, 12] as const
export const TIP_SHADOWS = [
  { radius: 0, alpha: 0 },
  { radius: 4, alpha: 0.22 },
  { radius: 7, alpha: 0.34 },
  { radius: 11, alpha: 0.46 },
] as const
export const TIP_OPACITIES = [0.7, 0.86, 1] as const
export const PANEL_RADII = [0, 2, 4] as const

/**
 * 把存盘里读出来的东西归一成 ModernUi。
 *
 * @why 早期版本存的是 `{ radius, shadow, outline }` 三个布尔。老工程文件
 *      直接读会得到 `undefined` 半径 → `roundRect(..., undefined)` 抛错 →
 *      整个导出黑屏。这里做一次迁移，比在每个使用点写 `?? 0` 可靠：
 *      使用点分散在屏幕 DOM、canvas 导出、PSD 三处，漏一处就是一处崩。
 */
export function normalizeModern(raw: unknown): ModernUi {
  if (!raw || typeof raw !== 'object') return { ...MODERN_OFF }
  const src = raw as Record<string, unknown>
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

  // 旧格式迁移：radius=true 原本是「容器圆角 4」，outline=true 原本是
  // 「1px 描边」，等价于现在的圆角边框；shadow=true 等价于中档阴影。
  const legacyRadius = src.radius === true
  const legacyShadow = src.shadow === true
  const legacyOutline = src.outline === true

  const next: ModernUi = {
    enabled: false,
    tipRadius: Math.max(0, num(src.tipRadius, legacyOutline ? 8 : 0)),
    tipShadowRadius: Math.max(0, num(src.tipShadowRadius, legacyShadow ? 7 : 0)),
    tipShadowAlpha: clamp01(num(src.tipShadowAlpha, legacyShadow ? 0.34 : 0)),
    tipBorder: src.tipBorder === 'round' || legacyOutline ? 'round' : 'vanilla',
    tipTitleRule: src.tipTitleRule === true,
    tipCenterTitle: src.tipCenterTitle === true,
    tipOpacity: clamp01(num(src.tipOpacity, 1)),
    panelRadius: Math.max(0, num(src.panelRadius, legacyRadius ? 4 : 0)),
    panelShadow: src.panelShadow === true || legacyShadow,
  }

  /**
   * @constraint 老存档没有 `enabled` 字段。不能默认 false —— 用户上次调好的
   *      一套样式会突然「消失」（参数还在，但页面回到原版），看起来就是丢设置。
   *      按「参数有没有偏离原版」反推：调过就是开着。
   */
  next.enabled = typeof src.enabled === 'boolean' ? src.enabled : isModernTouched(next)
  return next
}

/** 是否有任何一项偏离原版。工具栏用它显示「已改」标记 */
export function isModernTouched(ui: ModernUi): boolean {
  // @why 不看 enabled：这里回答的是「参数动没动过」，总开关关着但参数在，
  //      重新打开要还原那一套，所以参数不能丢、也不能算「没改过」。
  return (
    ui.tipRadius > 0 ||
    ui.tipShadowRadius > 0 ||
    ui.tipBorder !== 'vanilla' ||
    ui.tipTitleRule ||
    ui.tipCenterTitle ||
    ui.tipOpacity < 1 ||
    ui.panelRadius > 0 ||
    ui.panelShadow
  )
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

const MODERN_KEY = 'mcui:modern'

/**
 * 读取上次的样式设置。
 *
 * @why 必须持久化：调了半天圆角阴影，刷新一下就回到全关，比没有这个功能
 *      更让人恼火。Modern UI 自己也是把设置写在 config 里而不是每次开游戏重调。
 * @constraint 读失败一律返回 null 交给 normalize 兜底。隐私模式下 localStorage
 *      配额为 0，抛错；旧版本存的是三个布尔；两者都不能让页面白屏。
 */
export function readModernCache(): unknown {
  try {
    const raw = localStorage.getItem(MODERN_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeModernCache(ui: ModernUi): void {
  try {
    localStorage.setItem(MODERN_KEY, JSON.stringify(ui))
  } catch {
    // 存不下就算了，样式不该因为存储失败而报错
  }
}

/**
 * ModernUi → 提示框渲染参数。
 *
 * @why 必须只有这一处映射。屏幕那条路径（`McTooltip`）和导出那条路径
 *      （`exportLayers`）都调它，任何字段漏映射都会让「画布上圆角、导出后直角」。
 */
export function tipStyleOf(ui: ModernUi | undefined): TipStyleLike {
  const src = activeModern(ui)
  return {
    radius: Math.max(0, src.tipRadius),
    shadowRadius: Math.max(0, src.tipShadowRadius),
    shadowAlpha: clamp01(src.tipShadowAlpha),
    border: src.tipBorder,
    titleRule: src.tipTitleRule,
    centerTitle: src.tipCenterTitle,
    opacity: clamp01(src.tipOpacity),
  }
}
