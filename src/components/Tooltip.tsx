import { useLayoutEffect, useRef, useState } from 'react'
import { MC_BASE } from '@/lib/mc'

/**
 * 游戏风格悬停提示。
 *
 * @why 用 HTML 而不是 canvas 里画：提示框要能超出画布边界、不能被容器裁掉，
 *      而且它是"界面"而不是"截图内容"，不参与导出。
 * @constraint 背景与边框是原版的九宫格 sprite（tooltip/background 与 tooltip/frame，
 *      border 分别是 9 和 10）。自己用 CSS 画圆角矩形做不出那圈渐变紫边。
 */

export interface TipState {
  /** 视口坐标，指向被悬停的元素左上角 */
  x: number
  y: number
  title: string
  sub?: string
  /** 数量、耐久之类的第二行灰字 */
  note?: string
}

const OFFSET = 12

/**
 * 两层九宫格叠在同一个矩形上。
 *
 * @constraint 原版是把 background 和 frame 分别 blit 到**同一个**区域
 *      （TooltipRenderUtil.extractTooltipBackground 两个 blitSprite 参数一致），
 *      不是嵌套。所以伪元素用 inset:-10px 拉回 border box 外沿，再以 9px
 *      的 slice 画底图——比 frame 的 10px 少一圈，正好落在内侧。
 */
export function tooltipVars(version: string): React.CSSProperties {
  const base = `${MC_BASE}/${version}/textures/gui/sprites/tooltip`
  return {
    ['--tip-bg' as string]: `url("${base}/background.png")`,
    ['--tip-frame' as string]: `url("${base}/frame.png")`,
  }
}

export function Tooltip({ tip, version }: { tip: TipState | null; version: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 })

  useLayoutEffect(() => {
    if (!tip) return
    const box = ref.current?.getBoundingClientRect()
    const width = box?.width ?? 180
    const height = box?.height ?? 36
    let left = tip.x + OFFSET
    let top = tip.y + OFFSET
    // 贴边翻转：不做的话靠近窗口右下的提示会被切掉一半
    if (left + width > window.innerWidth - 4) left = Math.max(4, tip.x - width - OFFSET)
    if (top + height > window.innerHeight - 4) top = Math.max(4, tip.y - height - OFFSET)
    setPlace({ left, top })
  }, [tip])

  if (!tip) return null

  return (
    <div
      ref={ref}
      className="mc-tip"
      style={{ ...tooltipVars(version), left: place.left, top: place.top }}
      role="tooltip"
    >
      <span className="mc-tip__title">{tip.title}</span>
      {tip.note && <span className="mc-tip__note">{tip.note}</span>}
      {tip.sub && <span className="mc-tip__sub">{tip.sub}</span>}
    </div>
  )
}
