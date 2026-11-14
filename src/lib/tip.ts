/**
 * 网页侧的原生悬停提示。
 *
 * @why 站点是网页，不是游戏窗口。列表页悬停一个物品名，浏览器自带的
 *      title 气泡就够了——延迟、样式、可访问性全由系统负责。之前把原版
 *      tooltip 挂到全站，等于给每个格子套了一层游戏 UI，跟"原版界面"无关，
 *      只是把网页装扮成游戏。
 *
 * @constraint 原版 tooltip 只允许出现在**游戏画布内部**（`/ui` 工作台的
 *      容器界面），由 `McTooltip` 在画布坐标系里绘制，与这里互不干涉。
 */
export interface TipAttrs {
  title?: string
}

/** 把「名称 + 标识」拼成一条原生提示；标识缺省时只给名称 */
export function tipAttrs(name: string, note?: string, sub?: string): TipAttrs {
  const tail = sub ?? note
  return { title: tail ? `${name} · ${tail}` : name }
}
