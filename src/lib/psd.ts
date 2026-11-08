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
  const render = await renderLayers(workspace, defs, options)
  if (!render || !render.layers.length) return null

  // @constraint 动态 import：ag-psd 带 35 个模块，首屏用不到，只为一次导出白担一份解码器
  const { writePsd } = await import('ag-psd')

  // @constraint 背景色不能只画进图层，否则在 PS 里一关图层底下就是透明的。
  //      给一个整幅的「底色」层放最下面，保持和 PNG 导出一致。
  const children = render.layers.map((layer) => ({
    name: layer.name,
    canvas: layer.canvas,
    left: layer.left,
    top: layer.top,
  }))

  if (options.backdrop) {
    const base = flatten(render, options.backdrop)
    if (base) {
      children.unshift({ name: '底色', canvas: base, left: 0, top: 0 })
    }
  }

  const buffer = writePsd(
    {
      width: render.width,
      height: render.height,
      children,
    },
    { generateThumbnail: true, noBackground: true },
  )

  return new Blob([buffer], { type: 'image/vnd.adobe.photoshop' })
}
