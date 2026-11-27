/**
 * 地图导出：把画板上的 128×128 像素写成游戏能读的 `map_<id>.dat`。
 *
 * @why 这是整个地图页唯一"能进游戏"的出口。导 PNG 只是一张图，导 .dat 之后
 *      玩家把它放进存档的 `data/` 目录、执行一条 `give`，手里就是自己画的地图——
 *      做地图画、跑酷指引、剧情道具都靠这个。
 *
 * 文件格式（原版 `MapItemSavedData.save`）：
 *   { DataVersion:int, data:{ scale:byte, dimension:string, xCenter:int,
 *     zCenter:int, height:short, width:short, locked:byte, colors:byte[16384] } }
 *
 * @constraint colors 的每一项是 `MapColor.id * 4 + shade`，不是 RGB。
 *      直接写调色板下标的话，游戏会把 1 号色当成「草·最暗」，整张图黑掉一格。
 */
import { MAP_PALETTE } from './mcui/screens'
import { gzip, writeNbt, type WTag } from './nbtWrite'

/**
 * 调色板每一组基色对应的原版 `MapColor` id。
 *
 * @why 顺序必须与 `MAP_PALETTE` 一致，且是 MapColor 的枚举值（`MapColor.STONE`
 *      是 11、`GRASS` 是 1），不是数组下标。
 * @constraint 只改 MAP_PALETTE 的末尾追加新组，不能插入或重排：这里按下标对齐，
 *      一旦错位，用户以前存的地图颜色会整体偏移。
 */
export const MAP_COLOR_IDS: readonly number[] = [
  11, // 石
  1, // 草
  2, // 沙
  10, // 泥土
  12, // 水
  12, // 深海（同 Water，靠 shade 压暗）
  8, // 雪
  5, // 冰
  7, // 树叶
  13, // 木头
  18, // 干草 / 路径
  22, // 石头建筑
  9, // 砖瓦
  29, // 岩浆 / 黑曜石
]

/** 128×128 的地图格子数 */
export const MAP_PIXELS = 128 * 128

/**
 * 画板像素（调色板下标 1..56，0 表示空）→ 游戏的颜色字节。
 * @constraint 0 必须保留为 0（`MapColor.NONE`）：游戏把它画成全透明，
 *      这也是"没画到的地方"唯一诚实的表达。填成石灰色会让人以为画满了。
 */
export function encodeColors(pixels: Uint8Array): Uint8Array {
  if (pixels.length !== MAP_PIXELS) throw new Error(`地图像素数应为 ${MAP_PIXELS}，实际 ${pixels.length}`)
  const out = new Uint8Array(MAP_PIXELS)
  for (let index = 0; index < MAP_PIXELS; index += 1) {
    const value = pixels[index]!
    if (value === 0) continue
    const group = Math.floor((value - 1) / 4)
    const shade = (value - 1) % 4
    const base = MAP_COLOR_IDS[group] ?? MAP_COLOR_IDS[MAP_COLOR_IDS.length - 1]!
    /**
     * @constraint shade 的取向与原版相反：原版 0 是最亮、3 是最暗，而色板里
     *      每一组是从亮到暗排的。直接用 shade 会让"浅色"在地图里显示成深色。
     */
    out[index] = (base * 4 + (3 - shade)) & 0xff
  }
  return out
}

export interface MapFileSpec {
  pixels: Uint8Array
  /** 0..4，每像素多少方块（2^scale） */
  scale: number
  /** 地图中心的世界坐标 */
  xCenter: number
  zCenter: number
  dimension: string
  /** 锁定后游戏里不能继续画 */
  locked: boolean
}

/**
 * DataVersion。
 *
 * @why 写**偏旧**的版本号是刻意的：DataFixerUpper 只向上迁移，版本号比存档新
 *      会被判成"来自未来的数据"而拒绝加载。3465 是 1.20.1，之后的地图数据
 *      结构没变过，游戏自己会补上缺的字段。
 */
const DATA_VERSION = 3465

export async function exportMapDat(spec: MapFileSpec): Promise<Blob> {
  const colors = encodeColors(spec.pixels)
  const root: Record<string, WTag> = {
    DataVersion: { type: 'int', value: DATA_VERSION },
    data: {
      type: 'compound',
      value: {
        scale: { type: 'byte', value: Math.max(0, Math.min(4, Math.round(spec.scale))) },
        dimension: { type: 'string', value: spec.dimension },
        xCenter: { type: 'int', value: Math.round(spec.xCenter) },
        zCenter: { type: 'int', value: Math.round(spec.zCenter) },
        width: { type: 'short', value: 128 },
        height: { type: 'short', value: 128 },
        locked: { type: 'byte', value: spec.locked ? 1 : 0 },
        colors: { type: 'bytes', value: colors as unknown as Uint8Array },
      },
    },
  }
  const raw = writeNbt(root)
  const packed = await gzip(raw)
  return new Blob([packed as unknown as BlobPart], { type: 'application/x-gzip' })
}

/**
 * 给玩家的命令。
 * @why 地图 id 是存档里的文件编号，用户必须知道自己的 id 才能 give 出来。
 *      写死 0 只对"从没存过地图"的存档成立，所以命令里留占位并说明怎么改。
 */
export function mapCommands(id: number): { place: string; give: string } {
  return {
    place: `.minecraft/saves/<存档名>/data/map_${id}.dat`,
    give: `/give @p minecraft:filled_map[minecraft:map_id=${id}]`,
  }
}

/** 调色板分组名，导出界面上用来解释色号 */
export const PALETTE_GROUPS = MAP_PALETTE.length
