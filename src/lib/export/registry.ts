/**
 * 导出注册表：全站唯一一份「能导出什么」的清单。
 *
 * @why 页面只按 subject 过滤，不各自维护格式表。加一种格式 = 在这里加一条，
 *      工作台、模型页、以后的场景页同时获得它（前提是 appliesTo 成立）。
 *
 * @constraint 列表顺序即界面顺序：先给最常用的，再给工程用的。
 *      按 id 字母序排会让「STL」排在「PNG」前面，第一次用的人找不到截图按钮。
 */
import {
  exportAnimation,
  exportBundle,
  exportSolid,
  exportSources,
  exportStill,
  exportTextures,
  mp4Supported,
  type ModelSubject,
} from './model'
import { LAYOUT_TARGETS } from './layout'
import { exportStructureSolid, exportStructureStill, type StructureSubject } from './structure'
import {
  defineTarget,
  GROUP_ORDER,
  slug,
  stamp,
  type ExportGroup,
  type ExportTarget,
  type LayoutSubject,
  type Subject,
} from './types'

const isModel = (subject: Subject): subject is ModelSubject => subject.kind === 'model'

/** 有几何才谈得上 3D 文件；贴图实体（画、TNT）连节点树都没有 */
const hasGeometry = (subject: Subject): subject is ModelSubject => isModel(subject) && subject.nodesAt != null

/** MP4 需要 WebCodecs；不支持的浏览器直接把这一项从清单里去掉 */
const canMp4 = (subject: Subject): subject is ModelSubject => isModel(subject) && mp4Supported()

/** 画布底色会进文件名，避免「同一次导出的透明版和不透明版」互相覆盖 */
function backdropSuffix(subject: ModelSubject): string {
  return subject.backdrop === 'none' ? 'alpha' : subject.backdrop
}

function modelName(subject: ModelSubject, tail: string): string {
  return `${slug(subject.id)}-${tail}`
}

export const MODEL_TARGETS: ExportTarget[] = [
  defineTarget<ModelSubject>({
    id: 'glb',
    label: 'GLB',
    group: '3d',
    hint: '单文件 glTF，贴图与骨骼动画都嵌在里面',
    ext: 'glb',
    slow: true,
    appliesTo: hasGeometry,
    fileName: (subject) => `${modelName(subject, '')}.glb`,
    run: (subject) => exportSolid({ ...subject, solid: 'glb' }),
  }),
  defineTarget<ModelSubject>({
    id: 'gltf',
    label: 'glTF',
    group: '3d',
    hint: 'model.gltf + model.bin，可文本查看、可手改',
    ext: 'zip',
    slow: true,
    appliesTo: hasGeometry,
    fileName: (subject) => `${modelName(subject, 'gltf')}.zip`,
    run: (subject) => exportSolid({ ...subject, solid: 'gltf' }),
  }),
  defineTarget<ModelSubject>({
    id: 'obj',
    label: 'OBJ',
    group: '3d',
    hint: 'obj + mtl + 贴图，几乎所有 DCC 都能读',
    ext: 'zip',
    slow: true,
    appliesTo: hasGeometry,
    fileName: (subject) => `${modelName(subject, 'obj')}.zip`,
    run: (subject) => exportSolid({ ...subject, solid: 'obj' }),
  }),
  defineTarget<ModelSubject>({
    id: 'stl',
    label: 'STL',
    group: '3d',
    hint: '只有三角面，给 3D 打印和雕刻用',
    ext: 'stl',
    slow: true,
    appliesTo: hasGeometry,
    fileName: (subject) => `${modelName(subject, '')}.stl`,
    run: (subject) => exportSolid({ ...subject, solid: 'stl' }),
  }),

  defineTarget<ModelSubject>({
    id: 'mp4',
    label: 'MP4',
    group: 'video',
    hint: 'H.264，PR / 剪映 / 微信都能直接读',
    ext: 'mp4',
    slow: true,
    appliesTo: canMp4,
    fileName: (subject) => `${modelName(subject, backdropSuffix(subject))}.mp4`,
    run: (subject) => exportAnimation(subject, 'mp4'),
  }),
  defineTarget<ModelSubject>({
    id: 'webp-anim',
    label: 'WebP 动图',
    group: 'video',
    hint: '真透明动图，体积小于 APNG，Web / 安卓首选',
    ext: 'webp',
    slow: true,
    appliesTo: isModel,
    fileName: (subject) => `${modelName(subject, backdropSuffix(subject))}.webp`,
    run: (subject) => exportAnimation(subject, 'webp'),
  }),
  defineTarget<ModelSubject>({
    id: 'apng',
    label: 'APNG',
    group: 'video',
    hint: '逐帧无损 PNG 动画，边缘最干净',
    ext: 'png',
    slow: true,
    appliesTo: isModel,
    fileName: (subject) => `${modelName(subject, backdropSuffix(subject))}.png`,
    run: (subject) => exportAnimation(subject, 'apng'),
  }),
  defineTarget<ModelSubject>({
    id: 'gif',
    label: 'GIF',
    group: 'video',
    hint: '兼容性最好，只有 1 位透明',
    ext: 'gif',
    slow: true,
    appliesTo: isModel,
    fileName: (subject) => `${modelName(subject, backdropSuffix(subject))}.gif`,
    run: (subject) => exportAnimation(subject, 'gif'),
  }),
  defineTarget<ModelSubject>({
    id: 'frames',
    label: 'PNG 序列',
    group: 'video',
    hint: '逐帧 PNG 打包成 zip，导入 AE / PR',
    ext: 'zip',
    slow: true,
    appliesTo: isModel,
    fileName: (subject) => `${modelName(subject, 'frames')}.zip`,
    run: (subject) => exportAnimation(subject, 'png'),
  }),
  defineTarget<ModelSubject>({
    id: 'still',
    label: '单帧 PNG',
    group: 'raster',
    hint: '当前角度的一张静帧',
    ext: 'png',
    appliesTo: isModel,
    fileName: (subject) => `${modelName(subject, 'still')}.png`,
    run: exportStill,
  }),

  defineTarget<ModelSubject>({
    id: 'textures',
    label: '贴图',
    group: 'data',
    hint: '这个模型用到的全部 png',
    ext: 'zip',
    appliesTo: isModel,
    run: exportTextures,
  }),
  defineTarget<ModelSubject>({
    id: 'sources',
    label: '源文件',
    group: 'data',
    hint: '几何与动作的 JSON 原文',
    ext: 'zip',
    appliesTo: isModel,
    run: exportSources,
  }),
  defineTarget<ModelSubject>({
    id: 'bundle',
    label: '全部打包',
    group: 'data',
    hint: 'GLB + 贴图 + 源文件，一个 zip 交出去',
    ext: 'zip',
    slow: true,
    appliesTo: hasGeometry,
    fileName: (subject) => `${modelName(subject, '')}.zip`,
    run: exportBundle,
  }),
]

const isStructure = (subject: Subject): subject is StructureSubject => subject.kind === 'structure'

/**
 * 结构页的导出清单。
 *
 * @why 结构是「一整块静态几何」，没有骨骼也没有时长，所以既没有视频也没有
 *      PSD——只有 3D 文件和静帧。允许导出的格式按这个事实筛，不是按页面类型筛。
 * @constraint 静帧尺寸由 subject.size 决定（页面里可选），不在这里写死：
 *      同一栋房子有人要 1080 封面，有人只要 512 贴进 wiki。
 */
export const STRUCTURE_TARGETS: ExportTarget[] = [
  defineTarget<StructureSubject>({
    id: 'glb',
    label: 'GLB',
    group: '3d',
    hint: '单文件 glTF，贴图一起嵌进去',
    ext: 'glb',
    slow: true,
    appliesTo: isStructure,
    fileName: (subject) => `${slug(subject.id)}.glb`,
    run: (subject) => exportStructureSolid(subject, 'glb'),
  }),
  defineTarget<StructureSubject>({
    id: 'gltf',
    label: 'glTF',
    group: '3d',
    hint: 'model.gltf + bin + 贴图，可文本查看',
    ext: 'zip',
    slow: true,
    appliesTo: isStructure,
    fileName: (subject) => `${slug(subject.id)}-gltf.zip`,
    run: (subject) => exportStructureSolid(subject, 'gltf'),
  }),
  defineTarget<StructureSubject>({
    id: 'obj',
    label: 'OBJ',
    group: '3d',
    hint: 'obj + mtl + 贴图，DCC 通吃',
    ext: 'zip',
    slow: true,
    appliesTo: isStructure,
    fileName: (subject) => `${slug(subject.id)}-obj.zip`,
    run: (subject) => exportStructureSolid(subject, 'obj'),
  }),
  defineTarget<StructureSubject>({
    id: 'stl',
    label: 'STL',
    group: '3d',
    hint: '只有三角形，3D 打印用；没有贴图',
    ext: 'stl',
    slow: true,
    appliesTo: isStructure,
    fileName: (subject) => `${slug(subject.id)}.stl`,
    run: (subject) => exportStructureSolid(subject, 'stl'),
  }),
  defineTarget<StructureSubject>({
    id: 'still',
    label: '单帧 PNG',
    group: 'raster',
    hint: '当前角度的一张静帧，尺寸按右侧选择',
    ext: 'png',
    slow: true,
    appliesTo: isStructure,
    fileName: (subject) => `${slug(subject.id)}-${subject.size}.png`,
    run: exportStructureStill,
  }),
]

export const ALL_TARGETS: ExportTarget[] = [...LAYOUT_TARGETS, ...MODEL_TARGETS, ...STRUCTURE_TARGETS]

export function targetsFor(subject: Subject): ExportTarget[] {
  return ALL_TARGETS.filter((target) => target.appliesTo(subject))
}

/** 某个分组下适用于该对象的格式 */
export function targetsIn(subject: Subject, group: ExportGroup): ExportTarget[] {
  return targetsFor(subject).filter((target) => target.group === group)
}

/** 该对象真的有内容可导出的分组（空分组不画标题，避免一堆空壳） */
export function groupsFor(subject: Subject): ExportGroup[] {
  const present = new Set(targetsFor(subject).map((target) => target.group))
  return GROUP_ORDER.filter((group) => present.has(group))
}

export function targetById(id: string): ExportTarget | null {
  return ALL_TARGETS.find((target) => target.id === id) ?? null
}

/**
 * 产物文件名。
 * @why 统一在这里拼：工作台以前叫 mc-ui-<时间戳>.png，模型页叫 <id>-still.png，
 *      同一个人一天导十份就分不清哪份是哪次。
 */
export function suggestName(subject: Subject, target: ExportTarget): string {
  if (target.fileName) {
    const custom = target.fileName(subject)
    if (custom) return custom
  }
  const base =
    subject.kind === 'layout'
      ? subject.name
      : subject.kind === 'structure'
        ? subject.id
        : subject.id
  return `${slug(base) || 'mc-asset'}-${slug(target.id)}-${stamp()}.${target.ext}`
}

export async function runTarget(subject: Subject, target: ExportTarget): Promise<Blob | null> {
  if (!target.appliesTo(subject)) throw new Error(`${target.label} 不适用于这个对象`)
  return target.run(subject)
}

export type { ExportGroup, ExportTarget, Subject, LayoutSubject, ModelSubject, StructureSubject }
