/**
 * 按种子生成一张地形草图。
 *
 * @why 地图页原来只有一张空的灰底图，画一条海岸线全靠手感。真实世界生成要
 *      完整的 biomes/noise 管线（服务端那套 3000 行），这里退一步：用同样的
 *      「大陆度 + 高度 + 河流」三层噪声给一张**示意**底图，画的时候至少有海岸线
 *      和山脉可依，剩下的细节自己补。
 *
 * @constraint 这是示意，不是原版地形。同样的种子在游戏里不会长出这张图——
 *      原版的噪声算法依赖 density function 与生物群系源，参数没有公开契约。
 *      界面上必须这么写，否则用户会拿它去核对种子。
 *
 * @constraint 输出必须是**调色板下标**（1..56），不是 RGB：写进笔刷层的像素
 *      格式就是它，也才能直接喂给 `encodeColors` 转成游戏地图。
 */

/** 32 位整数化种子。数字直接取低 32 位，字符串走 FNV-1a */
export function seedToNumber(seed: string): number {
  const text = seed.trim()
  if (!text) return 0
  if (/^-?\d+$/.test(text)) {
    // @constraint 用 BigInt 截断：用户会贴 64 位种子，Number 在 2^53 之后丢位
    return Number(BigInt.asIntN(32, BigInt(text))) >>> 0
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/** 32 位整数哈希 → [0, 1) */
function rand(seed: number, x: number, y: number): number {
  let h = seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** 值噪声：四角随机 + 双三次平滑 */
function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smooth(x - x0)
  const fy = smooth(y - y0)
  const a = rand(seed, x0, y0)
  const b = rand(seed, x0 + 1, y0)
  const c = rand(seed, x0, y0 + 1)
  const d = rand(seed, x0 + 1, y0 + 1)
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
}

/** 分形叠加：低频决定大轮廓，高频加碎边 */
function fbm(seed: number, x: number, y: number, octaves = 4): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let scale = 1
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += valueNoise(seed + octave * 7919, x * scale, y * scale) * amp
    norm += amp
    amp *= 0.5
    scale *= 2
  }
  return sum / norm
}

/** 调色板下标（1..56）。组下标见 screens.ts 的 MAP_PALETTE */
function paletteIndex(group: number, shade: number): number {
  return group * 4 + Math.max(0, Math.min(3, shade)) + 1
}

/**
 * 生成 128×128 的地形草图。
 * @param radius 大陆半径系数：越小陆地越少、海越多
 */
export function generateTerrain(seedText: string, radius = 1): Uint8Array {
  const seed = seedToNumber(seedText)
  const size = 128
  const out = new Uint8Array(size * size)
  const cell = 0.045 / Math.max(0.35, radius)

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x * cell
      const ny = y * cell

      // 大陆度：低频，决定海陆分布
      const continent = fbm(seed, nx * 0.6, ny * 0.6, 3)
      // 高度：中频，决定山地
      const height = fbm(seed + 1013, nx * 1.7, ny * 1.7, 4)
      // 河流：把一条极窄的等值线当成水
      const riverNoise = fbm(seed + 7717, nx * 2.2, ny * 2.2, 3)
      const river = Math.abs(riverNoise - 0.5) < 0.012

      const land = continent * 0.7 + height * 0.3
      let index: number

      if (land < 0.3) {
        // 深海：越靠外越冷（明暗更深）
        index = paletteIndex(5, land < 0.22 ? 3 : 2)
      } else if (land < 0.4) {
        index = paletteIndex(4, land < 0.35 ? 2 : 1)
      } else if (river && land < 0.62) {
        index = paletteIndex(4, 1)
      } else if (land < 0.45) {
        index = paletteIndex(2, land < 0.43 ? 1 : 0)
      } else if (land > 0.78) {
        index = paletteIndex(6, 0)
      } else if (land > 0.7) {
        index = paletteIndex(0, land > 0.74 ? 1 : 2)
      } else {
        // 森林与草地按湿度分，避免整片一个色
        const moisture = fbm(seed + 4093, nx * 1.1, ny * 1.1, 3)
        index = moisture > 0.56 ? paletteIndex(8, land > 0.6 ? 2 : 1) : paletteIndex(1, land > 0.6 ? 1 : 0)
      }

      out[y * size + x] = index
    }
  }
  return out
}
