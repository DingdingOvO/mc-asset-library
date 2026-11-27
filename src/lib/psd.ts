import type { ContainerDef } from './containers'
import { flatten, renderLayers, type RenderOptions } from './exportLayers'
import type { Workspace } from './workspace'

/**
 * PSD 导出：每个容器拆成「背景 / 状态 / 物品 / 文字」四层，按容器分组。
 *
 * @why 生成 PSD 而不是扁平图片，是因为截图之外还有后续工作：把某个格子的物品
 *      换掉、关掉熔炉火焰、把标题改回英文。分层之后这些都是关一个图层。
 * @constraint ag-psd 体积不小（约 200KB），必须动态 import，否则首屏白拿一份
 *      只用一次的编码器。
 */

export interface PsdOptions extends RenderOptions {
  backdrop: string | null
}

export async function exportWorkspacePsd(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
  options: PsdOptions,
): Promise<Blob | null> {
  /**
   * @constraint 一律走逐格拆层。PSD 存在的唯一理由是二次编辑，合并成一层的
   *      「物品」和 PNG 没有区别；逐格层的代价（层数 × 每层 16×16 GUI 的位图）
   *      在 PSD 这个场景里是划得来的。
   */
  const render = await renderLayers(workspace, defs, { ...options, detail: true })
  if (!render || !render.layers.length) return null

  // @constraint 动态 import：ag-psd 带 35 个模块，首屏用不到，只为一次导出白担一份解码器
  const { writePsd } = await import('ag-psd')

  interface PsdGroup {
    name: string
    children: { name: string; canvas: HTMLCanvasElement; left: number; top: number }[]
  }

  /**
   * 按容器分组。
   * @why 一个三行箱子拆出 41 层（27 格物品 + 27 格数量 + 背景/状态/文字），
   *      平铺在 PS 图层面板里根本没法找。收进组之后是「箱子」一栏、展开才见格。
   */
  const groups = new Map<string, PsdGroup>()
  const loose: { name: string; canvas: HTMLCanvasElement; left: number; top: number }[] = []
  for (const layer of render.layers) {
    const flat = { name: layer.name, canvas: layer.canvas, left: layer.left, top: layer.top }
    if (!layer.group) {
      loose.push(flat)
      continue
    }
    const group = groups.get(layer.group) ?? { name: layer.group, children: [] }
    // 组内去掉前缀，只剩「物品 03」这种短名
    flat.name = layer.name.startsWith(`${layer.group} `)
      ? layer.name.slice(layer.group.length + 1)
      : layer.name
    group.children.push(flat)
    groups.set(layer.group, group)
  }

  const children = [...groups.values(), ...loose]

  if (options.backdrop) {
    const base = flatten(render, options.backdrop)
    if (base) {
      children.unshift({ name: '底色', canvas: base, left: 0, top: 0 } as never)
    }
  }

  const buffer = writePsd(
    {
      width: render.width,
      height: render.height,
      children: children as never,
    },
    { generateThumbnail: true, noBackground: true },
  )

  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' })
}
