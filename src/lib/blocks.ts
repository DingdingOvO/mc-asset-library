const BASE = '/mc'

/** 纹理名与方块 id 的差异主要来自这类后缀，用于反查表未命中时兜底 */
const AFFIXES = [
  '_top',
  '_bottom',
  '_side',
  '_front',
  '_back',
  '_inner',
  '_outer',
  '_on',
  '_off',
  '_lit',
  '_head',
  '_foot',
  '_stage0',
  '_stage1',
  '_stage2',
  '_stage3',
]

const cache = new Map<string, Promise<Record<string, string[]>>>()

export function loadBlockMap(version: string): Promise<Record<string, string[]>> {
  const hit = cache.get(version)
  if (hit) return hit

  const task = (async () => {
    const response = await fetch(`${BASE}/${version}/blockmaps.json`)
    if (!response.ok) return {}
    const data = (await response.json()) as { textures?: Record<string, string[]> }
    return data.textures ?? {}
  })()

  cache.set(version, task)
  return task
}

async function blockExists(version: string, block: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/${version}/blockstates/${block}.json`, { method: 'HEAD' })
    return response.ok
  } catch {
    return false
  }
}

/**
 * 一张贴图往往被多个方块共用（木板同时用于楼梯、台阶、床、告示牌），
 * 反查表按「同名优先」排序，第一个就是最该展示的形态。
 */
export async function resolveBlocks(version: string, textureId: string): Promise<string[]> {
  const map = await loadBlockMap(version)
  const known = map[textureId]
  if (known && known.length > 0) return known

  // 回退：贴图名去后缀后逐个探测 blockstate 是否存在
  const base = textureId.split('/').pop() ?? ''
  const candidates = [base]
  for (const affix of AFFIXES) {
    if (base.endsWith(affix)) candidates.push(base.slice(0, -affix.length))
  }

  for (const candidate of candidates) {
    if (await blockExists(version, candidate)) return [candidate]
  }
  return []
}
