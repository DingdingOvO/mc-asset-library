/**
 * NBT 读取：和原版 NbtIo 一致的二进制格式。
 *
 * @why 建筑结构（.nbt）是原版唯一的"建筑文件格式"，1511 个原版结构全在客户端
 *      jar 的 data/minecraft/structure 下。要做"生成整栋建筑"，第一步就是能读它，
 *      而不是自己发明一套 JSON 再去导。
 *
 * @constraint 数字必须按原版的位宽解码，不能一律读成 double：
 *      pos 是 IntArray（32 位有符号），size 也是；Long 在 NBT 里是 64 位，
 *      用 JS number 读会在大坐标上丢精度（区块级长数组能到 1e15），所以转 bigint。
 *
 * @constraint 不解压整包的 gzip 就直接读会得到乱码头。原版写文件一律
 *      NbtIo.writeCompressed（gzip），但也存在未压缩的原始 NBT
 *      （litematic、部分工具导出），所以按魔数判断，不能写死。
 */

/** 已解码的 NBT 值。数组用 typed array 保留位宽，compound 用普通对象 */
export type NbtTag =
  | number
  | bigint
  | string
  | Int8Array
  | Int32Array
  | BigInt64Array
  | NbtTag[]
  | { [key: string]: NbtTag }

export type NbtCompound = { [key: string]: NbtTag }

const TAG_END = 0
const TAG_BYTE = 1
const TAG_SHORT = 2
const TAG_INT = 3
const TAG_LONG = 4
const TAG_FLOAT = 5
const TAG_DOUBLE = 6
const TAG_BYTE_ARRAY = 7
const TAG_STRING = 8
const TAG_LIST = 9
const TAG_COMPOUND = 10
const TAG_INT_ARRAY = 11
const TAG_LONG_ARRAY = 12

class Reader {
  private view: DataView
  private pos = 0

  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  get done(): boolean {
    return this.pos >= this.bytes.byteLength
  }

  u8(): number {
    const value = this.view.getUint8(this.pos)
    this.pos += 1
    return value
  }

  i8(): number {
    const value = this.view.getInt8(this.pos)
    this.pos += 1
    return value
  }

  i16(): number {
    const value = this.view.getInt16(this.pos)
    this.pos += 2
    return value
  }

  u16(): number {
    const value = this.view.getUint16(this.pos)
    this.pos += 2
    return value
  }

  i32(): number {
    const value = this.view.getInt32(this.pos)
    this.pos += 4
    return value
  }

  i64(): bigint {
    const value = this.view.getBigInt64(this.pos)
    this.pos += 8
    return value
  }

  f32(): number {
    const value = this.view.getFloat32(this.pos)
    this.pos += 4
    return value
  }

  f64(): number {
    const value = this.view.getFloat64(this.pos)
    this.pos += 8
    return value
  }

  /**
   * 字符串是「UTF-8 + 长度前缀」，前缀是 unsigned short。
   * @constraint 用 TextDecoder 而不是逐字节 fromCharCode：结构名和自定义
   *      方块状态里会出现中文（玩家自己保存的结构），逐字节处理会变成乱码。
   */
  str(): string {
    const length = this.u16()
    const slice = this.bytes.subarray(this.pos, this.pos + length)
    this.pos += length
    return new TextDecoder().decode(slice)
  }

  skip(count: number): void {
    this.pos += count
  }

  array<T>(count: number, readOne: () => T, make: (values: T[]) => NbtTag): NbtTag {
    const values: T[] = []
    for (let i = 0; i < count; i += 1) values.push(readOne())
    return make(values)
  }

  readPayload(type: number): NbtTag {
    switch (type) {
      case TAG_BYTE:
        return this.i8()
      case TAG_SHORT:
        return this.i16()
      case TAG_INT:
        return this.i32()
      case TAG_LONG:
        return this.i64()
      case TAG_FLOAT:
        return this.f32()
      case TAG_DOUBLE:
        return this.f64()
      case TAG_BYTE_ARRAY: {
        const length = this.i32()
        const out = new Int8Array(length)
        for (let i = 0; i < length; i += 1) out[i] = this.i8()
        return out
      }
      case TAG_STRING:
        return this.str()
      case TAG_LIST: {
        const itemType = this.u8()
        const length = this.i32()
        const out: NbtTag[] = []
        for (let i = 0; i < length; i += 1) out.push(this.readPayload(itemType))
        return out
      }
      case TAG_COMPOUND: {
        const out: NbtCompound = {}
        for (;;) {
          const childType = this.u8()
          if (childType === TAG_END) break
          const name = this.str()
          out[name] = this.readPayload(childType)
        }
        return out
      }
      case TAG_INT_ARRAY: {
        const length = this.i32()
        const out = new Int32Array(length)
        for (let i = 0; i < length; i += 1) out[i] = this.i32()
        return out
      }
      case TAG_LONG_ARRAY: {
        const length = this.i32()
        const out = new BigInt64Array(length)
        for (let i = 0; i < length; i += 1) out[i] = this.i64()
        return out
      }
      default:
        throw new Error(`未知的 NBT 标签类型 ${type}`)
    }
  }
}

/** 魔数判断是否 gzip：结构文件一律压缩，工具导出的 .nbt 常常不压 */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // @constraint 用平台解压而不是自带 inflate 实现：DecompressionStream 在
  //      所有目标浏览器都有，自带一份纯 JS inflate 是几百行代码换同样的结果。
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 读一个 NBT 文件，返回最外层 compound。
 * @constraint 只返回根标签的内容，丢掉根名字：原版结构文件的根名恒为空字符串，
 *      调用方永远用不到，留着只会让人以为那是结构名。
 */
export async function readNbt(bytes: Uint8Array): Promise<NbtCompound> {
  const raw = isGzip(bytes) ? await gunzip(bytes) : bytes
  const reader = new Reader(raw)
  const rootType = reader.u8()
  if (rootType !== TAG_COMPOUND) throw new Error(`NBT 根标签不是 compound（收到 ${rootType}）`)
  reader.str()
  return reader.readPayload(TAG_COMPOUND) as NbtCompound
}

export function isCompound(value: NbtTag | undefined): value is NbtCompound {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    !(value instanceof Int8Array) && !(value instanceof Int32Array) && !(value instanceof BigInt64Array)
}

export function num(value: NbtTag | undefined, fallback = 0): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  return fallback
}

export function str(value: NbtTag | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * 三元组坐标。
 *
 * @constraint 必须同时吃 IntArray 和 List<Integer>：25 版之前结构文件里
 *        size / pos 是 `[I; x,y,z]`（IntArray），之后的版本改成了普通 int 列表。
 *       只认 IntArray 会让新版本的结构全部退化成 0×0×0（读得出调色板，
 *       却一个方块都读不出来），而且不报错，非常难查。
 */
export function intTriple(value: NbtTag | undefined): [number, number, number] | null {
  if (value instanceof Int32Array) {
    if (value.length < 3) return null
    return [value[0]!, value[1]!, value[2]!]
  }
  if (Array.isArray(value) && value.length >= 3) {
    const nums = value.slice(0, 3).map((item) => num(item as NbtTag, NaN))
    if (nums.some((item) => Number.isNaN(item))) return null
    return [nums[0]!, nums[1]!, nums[2]!]
  }
  return null
}

export function list(value: NbtTag | undefined): NbtTag[] {
  return Array.isArray(value) ? value : []
}
