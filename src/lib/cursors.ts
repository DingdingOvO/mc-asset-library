import { CURSOR_HOTSPOTS } from './cursorTable'

const BASE = `${__SITE_BASE__}`

/**
 * 站点鼠标指针。
 *
 * @why 用自己仓库里的 AOSP 矢量指针，而不是 CSS 默认光标：这套站点的界面全是
 *      像素风，系统箭头（边缘带抗锯齿）压在上面很跳。矢量版在 HiDPI 下不会糊。
 *
 * @constraint 这里的 `art` 指的是**图案颜色**，不是站点主题：`dark` = 黑指针
 *      （画在白底上），`light` = 白指针。反色由 useCursors 决定，两处都翻一次
 *      等于没翻——浅色主题会拿到白指针，白底上直接看不见。
 *
 * @constraint 热点必须来自 cursorTable.ts（由 cursors.json 的 dp 值换算），
 *      不要手写。CSS cursor 的第二个参数是热点像素坐标，缺了就默认落在左上角，
 *      点按钮时响应区域会整体偏一格。
 *
 * @constraint SVG 后面要跟 PNG 兜底：Safari 至今不认 SVG cursor，只给 SVG 的话
 *      整个站点的指针会掉回系统箭头，而且不会报任何错。
 */

/** 黑指针 / 白指针 */
export type CursorArt = 'dark' | 'light'

/** AOSP 的 grabbing 没有对应的 .cur 位图，PNG 兜底退到 grab（形状接近，只有 Safari 会看到） */
const PNG_ALIAS: Record<string, string> = { grabbing: 'grab' }

/** 生成 CSS cursor 值；图片没就绪时浏览器自动回退到后面的关键字 */
export function cssCursor(art: CursorArt, key: string, fallback: string): string {
  const spot = CURSOR_HOTSPOTS[key]
  if (!spot) return fallback
  const raster = PNG_ALIAS[key] ?? key
  return [
    `url("${BASE}cursors/${art}-${key}.svg") ${spot.x} ${spot.y}`,
    `url("${BASE}cursors/${art}-${raster}.png") ${spot.x} ${spot.y}`,
    fallback,
  ].join(', ')
}
