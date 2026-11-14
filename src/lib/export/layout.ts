/**
 * 工作台画布的导出目标。
 *
 * @why 一个容器界面的产出远不止一张 PNG：做视频的人要分层（改物品、关火焰、
 *      换语言）、做网页的人要矢量（缩放到 4K 不糊）、做素材库的人要工程文件
 *      （下次还能改）。这些不是"炫技格式"，每一种都对应一条真实的下游工作流。
 *
 * @constraint 所有分层格式都必须走同一次 renderLayers。分开渲染会让 PSD、
 *      ZIP、SVG 三份产物之间出现 1 像素级的错位（图标异步生成、字体度量缓存），
 *      而这正是分层导出最容易被骂的地方。
 */
import { flatten, renderLayers, type LayeredRender } from '../exportLayers'
import { exportWorkspacePsd } from '../psd'
import { serialize } from '../workspace'
import { makeZip, type ZipEntry } from '../zip'
import { defineTarget, type LayoutSubject } from './types'

const isLayout = (subject: { kind: string }): subject is LayoutSubject => subject.kind === 'layout'

async function render(subject: LayoutSubject): Promise<LayeredRender | null> {
  return renderLayers(subject.workspace, subject.defs, subject.options)
}

/** 画布 → Blob。统一在这里收口，便于以后换编码质量参数 */
function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality))
}

async function flatBlob(subject: LayoutSubject, type: string, quality?: number): Promise<Blob | null> {
  const layers = await render(subject)
  if (!layers) return null
  const canvas = flatten(layers, subject.backdrop)
  if (!canvas) return null
  return toBlob(canvas, type, quality)
}

/**
 * 把图层裁到文档范围内。
 *
 * @constraint 图层画布是外扩过的（容器四周留了 MARGIN，用来兜住 hotbar 选中框、
 *      副手槽这类溢出）。PSD 会在画布外自动裁掉，但 PNG 序列和 SVG 不会：
 *      SVG 里 x=-48 的 <image> 直接被 viewBox 切掉，ZIP 里则是一张比文档还大的图，
 *      导进 AE 之后整层偏移 48 像素。所以导出前先按文档矩形裁一次。
 */
function cropLayer(layer: { canvas: HTMLCanvasElement; left: number; top: number }, width: number, height: number) {
  const x0 = Math.max(0, layer.left)
  const y0 = Math.max(0, layer.top)
  const x1 = Math.min(width, layer.left + layer.canvas.width)
  const y1 = Math.min(height, layer.top + layer.canvas.height)
  if (x1 <= x0 || y1 <= y0) return null
  if (x0 === layer.left && y0 === layer.top && x1 - x0 === layer.canvas.width && y1 - y0 === layer.canvas.height) {
    return { canvas: layer.canvas, left: x0, top: y0 }
  }
  const out = document.createElement('canvas')
  out.width = x1 - x0
  out.height = y1 - y0
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(layer.canvas, layer.left - x0, layer.top - y0)
  return { canvas: out, left: x0, top: y0 }
}

/** 分层数据：每层一张裁好的 PNG + 一份记录偏移的清单，不依赖 Photoshop 也能用 */
async function layerEntries(layers: LayeredRender): Promise<{ files: ZipEntry[]; manifest: string }> {
  const files: ZipEntry[] = []
  const list: { name: string; file: string; x: number; y: number; width: number; height: number }[] = []
  let index = 0
  for (const layer of layers.layers) {
    const cut = cropLayer(layer, layers.width, layers.height)
    if (!cut) continue
    index += 1
    const safe = layer.name.replace(/[\\/:*?"<>|]/g, '_')
    const file = `layers/${String(index).padStart(2, '0')}-${safe}.png`
    const blob = await toBlob(cut.canvas, 'image/png')
    if (!blob) continue
    files.push({ name: file, data: new Uint8Array(await blob.arrayBuffer()) })
    list.push({
      name: layer.name,
      file,
      x: cut.left,
      y: cut.top,
      width: cut.canvas.width,
      height: cut.canvas.height,
    })
  }
  const manifest = JSON.stringify(
    { width: layers.width, height: layers.height, layers: list },
    null,
    2,
  )
  return { files, manifest }
}

/**
 * SVG。
 *
 * @why 不做成"用 <rect> 重画一遍界面"：容器界面的贴图是像素画，重画要靠
 *      shape-rendering 硬边模拟，结果和 PNG 不一致。这里每层包一个 <image>，
 *      既保真又能被 Figma / Illustrator 认成分组图层（g + data-name），
 *      缩放由工具自己做重采样。要真矢量的话，那是另一条"从 .mcmeta 生成路径"的活。
 */
async function svgBlob(subject: LayoutSubject): Promise<Blob | null> {
  const layers = await render(subject)
  if (!layers) return null
  const esc = (text: string) =>
    text.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layers.width}" height="${layers.height}" viewBox="0 0 ${layers.width} ${layers.height}">`,
  ]
  if (subject.backdrop) {
    parts.push(`<rect width="${layers.width}" height="${layers.height}" fill="${esc(subject.backdrop)}"/>`)
  }
  for (const layer of layers.layers) {
    const cut = cropLayer(layer, layers.width, layers.height)
    if (!cut) continue
    parts.push(
      `<g id="${esc(layer.name)}" data-name="${esc(layer.name)}">` +
        `<image x="${cut.left}" y="${cut.top}" width="${cut.canvas.width}" height="${cut.canvas.height}" href="${cut.canvas.toDataURL('image/png')}"/>` +
        `</g>`,
    )
  }
  parts.push('</svg>')
  return new Blob([parts.join('')], { type: 'image/svg+xml' })
}

function jsonBlob(subject: LayoutSubject): Blob {
  const payload = serialize(subject.workspace, subject.options.version)
  return new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
}

export const LAYOUT_TARGETS = [
  defineTarget<LayoutSubject>({
    id: 'png',
    label: 'PNG 图片',
    group: 'raster',
    hint: '扁平图，直接发出去',
    ext: 'png',
    appliesTo: isLayout,
    run: (subject) => flatBlob(subject, 'image/png'),
  }),
  defineTarget<LayoutSubject>({
    id: 'webp',
    label: 'WebP 图片',
    group: 'raster',
    hint: '有损压缩，体积约为 PNG 的 1/4，支持透明',
    ext: 'webp',
    appliesTo: isLayout,
    run: (subject) => flatBlob(subject, 'image/webp', 0.95),
  }),
  defineTarget<LayoutSubject>({
    id: 'psd',
    label: 'PSD 分层',
    group: 'layered',
    hint: '背景 / 状态 / 物品 / 文字各一层，PS 里直接改',
    ext: 'psd',
    slow: true,
    appliesTo: isLayout,
    run: (subject) => exportWorkspacePsd(subject.workspace, subject.defs, { ...subject.options, backdrop: subject.backdrop }),
  }),
  defineTarget<LayoutSubject>({
    id: 'layers',
    label: '分层 PNG',
    group: 'layered',
    hint: '每层一张透明 PNG + 偏移清单，不装 PS 也能用',
    ext: 'zip',
    slow: true,
    appliesTo: isLayout,
    run: async (subject) => {
      const layers = await render(subject)
      if (!layers) return null
      const { files, manifest } = await layerEntries(layers)
      if (files.length === 0) return null
      files.push({ name: 'layout.json', data: new TextEncoder().encode(manifest) })
      return makeZip(files)
    },
  }),
  defineTarget<LayoutSubject>({
    id: 'svg',
    label: 'SVG 矢量',
    group: 'vector',
    hint: 'Figma / AI 拖进去就是分组图层，缩放不糊',
    ext: 'svg',
    appliesTo: isLayout,
    run: svgBlob,
  }),
  defineTarget<LayoutSubject>({
    id: 'json',
    label: '布局 JSON',
    group: 'data',
    hint: '可以再导回来继续改',
    ext: 'json',
    appliesTo: isLayout,
    run: async (subject) => jsonBlob(subject),
  }),
  defineTarget<LayoutSubject>({
    id: 'bundle',
    label: '全部打包',
    group: 'data',
    hint: 'PNG + 分层 + 布局 JSON 一个 zip 交出去',
    ext: 'zip',
    slow: true,
    appliesTo: isLayout,
    run: async (subject) => {
      const layers = await render(subject)
      if (!layers) return null
      const entries: ZipEntry[] = []
      const canvas = flatten(layers, subject.backdrop)
      if (canvas) {
        const blob = await toBlob(canvas, 'image/png')
        if (blob) entries.push({ name: 'preview.png', data: new Uint8Array(await blob.arrayBuffer()) })
      }
      const { files, manifest } = await layerEntries(layers)
      entries.push(...files)
      entries.push({ name: 'layout.json', data: new TextEncoder().encode(manifest) })
      entries.push({ name: 'workspace.json', data: new TextEncoder().encode(JSON.stringify(serialize(subject.workspace, subject.options.version), null, 2)) })
      return makeZip(entries)
    },
  }),
]
