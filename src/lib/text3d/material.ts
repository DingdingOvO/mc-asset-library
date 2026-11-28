/**
 * 立体字材质。
 *
 * @why 以前材质只有"选一张方块贴图"一个选项，字面就是 16×16 的石头纹理铺满，
 *      远看是一片灰噪点：没有主色、没有上下渐变、侧面和正面一样亮，所以整块字
 *      像纸板剪出来的。参考实现（EaseCation/cube-3d-text）的观感来自三件事——
 *      正面有竖向渐变、侧面按朝向压暗一档、描边是一圈比字更深的实色。
 *      这里把这三点做成"顶点色 + 一张纯色底贴图"，比换一整套 shader 便宜得多，
 *      而且 CPU 预览、GPU 导出、GLB 文件三条路径拿到的是同一套颜色。
 *
 * @constraint 颜色必须是 hex 字符串而不是 THREE.Color 之类的对象：这套数据要
 *      能直接存进 localStorage、能写进 URL 分享，也不该把渲染库拖进配置层。
 */

export type Rgb = [number, number, number]

export interface MaterialPreset {
  id: string
  /** 面板上的名字 */
  label: string
  /** 一句话说明，给不熟悉这些名词的人看 */
  hint: string
  /** 正面主色 */
  face: string
  /** 正面顶部的颜色，和 face 组成竖向渐变；不给就是纯色 */
  top?: string
  /** 侧面（挤出厚度那一圈） */
  side: string
  /** 背面 */
  back: string
  /** 描边 */
  outline: string
  /** 底贴图。给了就用 MC 方块纹理，不给就是纯色 */
  texture?: string
}

export const MATERIALS: MaterialPreset[] = [
  {
    id: 'aurora',
    label: '极光蓝',
    hint: '白面 + 冷蓝侧壁，最像参考站的那种清爽感',
    face: '#d7e6ff',
    top: '#ffffff',
    side: '#5b93ff',
    back: '#28499f',
    outline: '#101a33',
  },
  {
    id: 'gold',
    label: '鎏金',
    hint: '暖金渐变，适合标题、活动图',
    face: '#ffc93c',
    top: '#fff3bd',
    side: '#d08a12',
    back: '#7a4d08',
    outline: '#2a1704',
  },
  {
    id: 'candy',
    label: '草莓奶油',
    hint: '粉面 + 玫红侧壁，偏可爱',
    face: '#ff86b8',
    top: '#ffd7e7',
    side: '#e0487f',
    back: '#8d2350',
    outline: '#3a0f22',
  },
  {
    id: 'mint',
    label: '薄荷汽水',
    hint: '青绿渐变，深色背景上很跳',
    face: '#7ef0c8',
    top: '#d6fff2',
    side: '#2fb894',
    back: '#12664f',
    outline: '#062a20',
  },
  {
    id: 'ink',
    label: '墨板',
    hint: '深灰字面 + 白描边，适合浅色底图',
    face: '#2b2f3a',
    top: '#454b5c',
    side: '#171a22',
    back: '#0b0d12',
    outline: '#ffffff',
  },
  {
    id: 'stone',
    label: '石头方块',
    hint: '经典 MC 灰石纹理，像素风',
    face: '#ffffff',
    side: '#c8c8c8',
    back: '#8a8a8a',
    outline: '#1d1d1d',
    texture: 'block/stone',
  },
  {
    id: 'grass',
    label: '草方块',
    hint: '顶面草绿、侧壁泥土，最有原版味',
    face: '#ffffff',
    side: '#d8d8d8',
    back: '#909090',
    outline: '#1d1d1d',
    texture: 'block/grass_block_side',
  },
  {
    id: 'goldblock',
    label: '金块',
    hint: '原版金块纹理，比纯金渐变更有颗粒感',
    face: '#ffffff',
    side: '#e8d27a',
    back: '#a8892f',
    outline: '#241a05',
    texture: 'block/gold_block',
  },
]

export function hexToRgb(hex: string): Rgb {
  const raw = hex.replace('#', '').trim()
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const value = Number.parseInt(full.slice(0, 6), 16)
  if (!Number.isFinite(value)) return [255, 255, 255]
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

/** 线性混色，t=0 取 a，t=1 取 b */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = Math.max(0, Math.min(1, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

/** 整体乘一个亮度系数，用来做侧壁/背面的明暗分层 */
export function shadeRgb(color: Rgb, factor: number): Rgb {
  return [
    Math.max(0, Math.min(255, Math.round(color[0] * factor))),
    Math.max(0, Math.min(255, Math.round(color[1] * factor))),
    Math.max(0, Math.min(255, Math.round(color[2] * factor))),
  ]
}

/**
 * 生成 1×1 的纯白贴图（data URL）。
 *
 * @why 顶点色只有在"有贴图"的分支里才会被乘上去看效果——没有贴图时渲染器
 *      走的是另一条兜底路径，导出 GLB 也会写成白模。给一张纯白贴图当底，
 *      颜色就完全由顶点色决定，三条渲染路径的表现一致。
 */
let whiteTexel: string | null = null
export function whiteTexture(): string {
  if (whiteTexel) return whiteTexel
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 1, 1)
  }
  whiteTexel = canvas.toDataURL('image/png')
  return whiteTexel
}
