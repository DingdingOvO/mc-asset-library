const BASE = `${__SITE_BASE__}`

/**
 * 站点鼠标指针。
 *
 * @why 用自己仓库里的 Android 风格指针，而不是 CSS 默认光标：这套站点的界面
 *      全是像素风，系统箭头（边缘带抗锯齿）压在上面很跳。
 * @constraint 热点必须逐张写死。CSS cursor 的第二个参数是热点像素坐标，
 *      漏掉就默认落在左上角，点按钮时响应区域会整体偏 6 像素。
 */

export interface CursorImage {
  url: string
  x: number
  y: number
}

type CursorTable = Record<string, CursorImage>

export const CURSORS: Record<"dark" | "light", CursorTable> = {
  dark: {
    arrow: { url: `${BASE}cursors/dark-arrow.png`, x: 6, y: 5 },
    crosshair: { url: `${BASE}cursors/dark-crosshair.png`, x: 16, y: 16 },
    grab: { url: `${BASE}cursors/dark-grab.png`, x: 16, y: 16 },
    hand: { url: `${BASE}cursors/dark-hand.png`, x: 13, y: 3 },
    help: { url: `${BASE}cursors/dark-help.png`, x: 6, y: 5 },
    move: { url: `${BASE}cursors/dark-move.png`, x: 16, y: 16 },
    nodrop: { url: `${BASE}cursors/dark-nodrop.png`, x: 16, y: 16 },
    pan: { url: `${BASE}cursors/dark-pan.png`, x: 16, y: 16 },
    text: { url: `${BASE}cursors/dark-text.png`, x: 16, y: 15 },
  },
  light: {
    arrow: { url: `${BASE}cursors/light-arrow.png`, x: 6, y: 5 },
    cell: { url: `${BASE}cursors/light-cell.png`, x: 16, y: 16 },
    crosshair: { url: `${BASE}cursors/light-crosshair.png`, x: 16, y: 16 },
    grab: { url: `${BASE}cursors/light-grab.png`, x: 16, y: 16 },
    hand: { url: `${BASE}cursors/light-hand.png`, x: 13, y: 3 },
    help: { url: `${BASE}cursors/light-help.png`, x: 6, y: 5 },
    move: { url: `${BASE}cursors/light-move.png`, x: 16, y: 16 },
    nodrop: { url: `${BASE}cursors/light-nodrop.png`, x: 16, y: 16 },
    pan: { url: `${BASE}cursors/light-pan.png`, x: 16, y: 16 },
    text: { url: `${BASE}cursors/light-text.png`, x: 16, y: 15 },
  },
}

/** 生成 CSS cursor 值；图片没就绪时浏览器自动回退到后者 */
export function cssCursor(theme: "dark" | "light", key: string, fallback: string): string {
  const item = CURSORS[theme]?.[key]
  return item ? `url("${item.url}") ${item.x} ${item.y}, ${fallback}` : fallback
}
