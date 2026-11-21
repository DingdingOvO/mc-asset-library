import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 网页侧的悬停提示卡片。
 *
 * @why 工作台里其实有两类悬停，之前共用一个 `McTooltip`：
 *      ① 容器**内部**的槽位——那是游戏画面的一部分，就该是原版九宫格 + 位图字；
 *      ② 容器**外面**的物品栏——那是网页控件，套一层像素提示框等于把浏览器
 *        装扮成游戏，和「原版界面」也没关系。
 *      这里给后者一个和站点同一套 token 的普通浮层：圆角、描边、阴影、系统字。
 *
 * @constraint 必须 `position: fixed` + `pointer-events: none`：
 *      跟着指针走的东西一旦能命中，就会把 pointerenter/leave 打乱，
 *      物品栏会开始闪。
 */

export interface SiteTipState {
  /** 视口坐标：被悬停元素的左上角 */
  x: number
  y: number
  title: string
  /** 第二行：数量之类的附加信息 */
  note?: string
  /** 第三行：等宽小字，放 id */
  sub?: string
}

/** 浮层与被悬停元素之间的间隙 */
const GAP = 10

export function SiteTip({ tip }: { tip: SiteTipState | null }) {
  const ref = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState({ x: false, y: false })

  /**
   * @constraint 位置要在挂载后量一次再定，不能按估算宽度算：
   *      提示宽度取决于最长的那个物品名，中文名能到十来个字。
   *      估算值一旦偏小，贴右边栏的物品就会把提示顶出视口。
   */
  useLayoutEffect(() => {
    const node = ref.current
    if (!node || !tip) return
    const box = node.getBoundingClientRect()
    setFlip({
      x: tip.x + GAP + box.width > window.innerWidth - 8,
      y: tip.y + GAP + box.height > window.innerHeight - 8,
    })
  }, [tip])

  if (!tip) return null

  return (
    <div
      ref={ref}
      className="site-tip"
      role="tooltip"
      style={{
        left: flip.x ? Math.max(8, tip.x - GAP) : tip.x + GAP,
        top: flip.y ? tip.y - GAP : tip.y + GAP,
        transform: `${flip.x ? 'translateX(-100%)' : ''} ${flip.y ? 'translateY(-100%)' : ''}`.trim() || undefined,
      }}
    >
      <span className="site-tip__title">{tip.title}</span>
      {tip.note && <span className="site-tip__note">{tip.note}</span>}
      {tip.sub && <span className="site-tip__sub">{tip.sub}</span>}
    </div>
  )
}
