/**
 * 渲染层对外出口。
 *
 * @why 只导出「建管线」「预载纹理」「判定可用」三样。上层（`lib/scene.ts`、
 *      各个页面）不应该 import 到 `core/program` 或 `shader/terrain` 这一层，
 *      否则将来换 WebGPU 后端时，改动会从 `render/` 漏到页面里去。
 */
export { modelPipeline, ModelPipeline, type ModelCamera, type RenderStats } from './pipeline'
export type { ModelFace } from './pass/model'
export { hasWebGl } from './core/context'
export { LIGHTMAP_PRESETS, type LightmapParams } from './lighting/lightmap'
export { LIGHTING, CARDINAL_LIGHTING } from './lighting/directions'
