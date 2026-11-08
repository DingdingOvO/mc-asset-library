// 由 scripts/sync-cursors.mjs 生成，不要手改
//
// @why 指针是矢量仓库 DingdingOvO/aosp-cursors-temp 的 SVG，等比缩放到 32px。
//      热点来自 cursors.json 的 dp 值：round(dp * 32 / 24)。
// @constraint 文件名里的 dark/light 是 AOSP 的「主题」命名，跟站点主题是反的：
//      AOSP 深色主题画黑指针（给深色底用），本站浅色主题才需要黑指针。

export interface CursorHotspot {
  x: number
  y: number
}

export const CURSOR_HOTSPOTS: Record<string, CursorHotspot> = {
  arrow: { x: 6, y: 5 },
  hand: { x: 13, y: 3 },
  grab: { x: 16, y: 16 },
  grabbing: { x: 16, y: 16 },
  text: { x: 16, y: 15 },
  crosshair: { x: 16, y: 16 },
  nodrop: { x: 16, y: 16 },
}
