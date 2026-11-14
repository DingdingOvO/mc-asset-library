/**
 * 导出目标的统一描述。
 *
 * @why 之前导出是两份互不相干的代码：工作台写死了「PNG / PSD / JSON」三个按钮，
 *      模型页写死了「GLB / OBJ / MP4 / GIF…」一串 chip，两边的格式表、
 *      文件命名、下载逻辑各写一遍。加一种格式要改两处，而且两边能力永远对不齐
 *      （工作台只有 3 项，模型页有 11 项）。
 *      这里把「能导出什么」收敛成一张注册表：每种格式是一个文件，声明自己
 *      属于哪一组、对什么对象成立、怎么产出 Blob。页面只负责把 subject 递进来。
 *
 * @constraint 格式能力必须靠 appliesTo 判断，不能靠页面类型判断。
 *      工作台导不出 GLB 是因为它没有几何，不是因为"它在工作台页"；
 *      模型页导不出 PSD 是因为它没有图层树。写成页面判断，以后场景页
 *      （地形 + 建筑，同时有 2D 和 3D）就没法复用了。
 */
import type { ContainerDef } from '../containers'
import type { RenderOptions } from '../exportLayers'
import type { Workspace } from '../workspace'
import type { ModelSubject } from './model'

/** 分组只影响界面上怎么摆，不影响能力 */
export type ExportGroup = 'raster' | 'layered' | 'vector' | 'data' | '3d' | 'video'

export const GROUP_ORDER: ExportGroup[] = ['raster', 'layered', 'vector', 'data', '3d', 'video']

export const GROUP_LABEL: Record<ExportGroup, string> = {
  raster: '位图',
  layered: '分层',
  vector: '矢量',
  data: '工程数据',
  '3d': '3D 文件',
  video: '视频',
}

/** 工作台画布：一堆容器 + 每格物品 */
export interface LayoutSubject {
  kind: 'layout'
  /** 文件名前缀 */
  name: string
  workspace: Workspace
  defs: Map<string, ContainerDef>
  /** 渲染参数（版本、倍率、语言、取贴图） */
  options: RenderOptions
  /** 底色；null 表示透明 */
  backdrop: string | null
}

export type Subject = LayoutSubject | ModelSubject

export interface ExportTarget {
  id: string
  label: string
  group: ExportGroup
  /** 悬停提示 */
  hint: string
  /** 文件后缀，仅用于展示与命名 */
  ext: string
  /**
   * 自定义文件名。
   * @why GLB 是单文件、glTF 是 gltf+bin 的 zip、PNG 序列是 frames.zip，
   *      后缀不统一。写死 `${id}.${ext}` 会让产物名字和内容对不上。
   */
  fileName?: (subject: Subject) => string
  /** 是否需要较长时间（视频、分层）——界面据此显示进度条 */
  slow?: boolean
  appliesTo: (subject: Subject) => boolean
  run: (subject: Subject) => Promise<Blob | null>
}

/**
 * 定义一个导出目标。
 *
 * @why 用泛型工厂而不是让每个目标自己 cast：run 的参数类型由 appliesTo 的
 *      类型守卫收窄，写 PSD 目标时拿到的是 LayoutSubject 而不是联合类型，
 *      否则每个目标开头都要写三行 `if (subject.kind !== 'layout') throw`。
 */
export function defineTarget<S extends Subject>(spec: {
  id: string
  label: string
  group: ExportGroup
  hint: string
  ext: string
  slow?: boolean
  appliesTo: (subject: Subject) => subject is S
  fileName?: (subject: S) => string
  run: (subject: S) => Promise<Blob | null>
}): ExportTarget {
  return {
    id: spec.id,
    label: spec.label,
    group: spec.group,
    hint: spec.hint,
    ext: spec.ext,
    slow: spec.slow,
    appliesTo: spec.appliesTo,
    fileName: spec.fileName ? (subject) => (spec.appliesTo(subject) ? spec.fileName!(subject) : '') : undefined,
    run: (subject) => {
      if (!spec.appliesTo(subject)) {
        throw new Error(`${spec.label} 不适用于这个对象`)
      }
      return spec.run(subject)
    },
  }
}

/** 触发下载。全站只有这一处 new 一个 <a download> */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // @why 立刻回收会让部分浏览器在下载启动前就把 URL 释放掉
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/** 时间戳后缀：同一秒内导两次也不会互相覆盖 */
export function stamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

export function slug(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
}
