import type { ContainerDef } from './containers'
import { flatten, renderLayers, type RenderOptions } from './exportLayers'
import type { Workspace } from './workspace'

/**
 * 容器工作区导出。
 *
 * @why 屏幕显示与导出必须共用同一套绘制。导出另写一份的话，两边的切片顺序、
 *      像素对齐迟早分叉——导出的图和屏幕上看到的差一圈边框，用户第一反应是
 *      "导出坏了"。所以这里只负责取景、上底色和编码，画什么交给 exportLayers。
 */

export interface ExportBounds {
  x: number
  y: number
  width: number
  height: number
}

export function workspaceBounds(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
): ExportBounds | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const node of workspace.nodes) {
    const def = defs.get(node.container)
    if (!def) continue
    x0 = Math.min(x0, node.x)
    y0 = Math.min(y0, node.y)
    x1 = Math.max(x1, node.x + def.width)
    y1 = Math.max(y1, node.y + def.height)
  }
  if (!Number.isFinite(x0)) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

export type ExportBackdrop = 'transparent' | 'dark' | 'light'

export const BACKDROPS: Record<ExportBackdrop, string | null> = {
  transparent: null,
  dark: '#1b1b1f',
  light: '#f2f2f4',
}

export interface PngOptions extends RenderOptions {
  backdrop: ExportBackdrop
}

export async function exportWorkspacePng(
  workspace: Workspace,
  defs: Map<string, ContainerDef>,
  options: PngOptions,
): Promise<Blob | null> {
  const render = await renderLayers(workspace, defs, options)
  if (!render) return null
  const canvas = flatten(render, BACKDROPS[options.backdrop])
  if (!canvas) return null
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}
