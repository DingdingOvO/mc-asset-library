/**
 * 按需装配方块几何：只加载这一栋建筑真正用到的分片。
 *
 * @why 方块面数据是按分片下发的（1100 多个方块约 1.1MB）。建筑常见的情况是
 *      只用十几种方块：石砖、木板、玻璃、台阶。全量加载意味着为了看一栋
 *      小屋要等一兆多 JSON 解析完，而实际需要的可能只有第 3 片。
 *
 * @constraint 分片必须全部到齐才能建 `BlockGeometry`。少一片时那些方块
 *      会静默变成「没有模型」，建筑上出现一片空气——不报错、不提示，
 *      看起来像结构文件坏了。
 */
import { loadBakeShard, loadBlockModels, type BakedFace, type BlockModelFile } from '@/lib/blockmodels'
import { BlockGeometry } from '@/lib/blockGeometry'

/** 已合并的分片缓存：同一个版本只合并一次 */
const merged = new Map<string, Promise<BlockModelFile>>()

async function mergedModels(version: string, ids: Iterable<string>): Promise<BlockModelFile> {
  const meta = await loadBlockModels(version)
  const size = meta.shardSize || 1

  const needed = new Set<number>()
  for (const id of ids) {
    const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
    // 数据里的 id 有的带命名空间有的不带，两种都查
    const index = meta.blockIds.indexOf(id) >= 0 ? meta.blockIds.indexOf(id) : meta.blockIds.indexOf(bare)
    if (index >= 0) needed.add(Math.floor(index / size))
  }

  const key = `${version}|${[...needed].sort((a, b) => a - b).join(',')}`
  const hit = merged.get(key)
  if (hit) return hit

  const task = (async () => {
    const shards = await Promise.all([...needed].map((index) => loadBakeShard(version, 'blocks', index)))
    const blocks: Record<string, BakedFace[]> = { ...meta.blocks }
    for (const shard of shards) Object.assign(blocks, shard)
    return { ...meta, blocks }
  })()
  merged.set(key, task)
  return task
}

/**
 * 装配几何索引，同时把合并后的模型表带出去。
 *
 * @constraint 必须一起返回。`texturesOf` 要用同一份 `blocks` 表去找每个方块
 *      引用了哪些贴图；拿 `loadBlockModels` 那份 meta 去查，`blocks` 是空的
 *      （面数据都在分片里），于是预载的贴图列表恒为空——渲染时纹理全部
 *      拿不到，建筑变成一坨纯黑剪影。
 */
export async function loadGeometry(
  version: string,
  ids: Iterable<string>,
): Promise<{ geometry: BlockGeometry; models: BlockModelFile }> {
  const models = await mergedModels(version, ids)
  return { geometry: new BlockGeometry(models, version), models }
}

/** 这批方块用到的全部贴图 id，用于预载纹理 */
export function texturesOf(ids: Iterable<string>, models: BlockModelFile): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const bare = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
    const faces = models.blocks[id] ?? models.blocks[bare] ?? []
    for (const face of faces) {
      const texture = models.textures[face[20] ?? -1]
      if (texture) out.add(texture)
    }
  }
  return [...out]
}
