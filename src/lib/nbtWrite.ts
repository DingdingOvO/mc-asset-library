/**
 * NBT 写入：`readNbt` 的逆运算。
 *
 * @why 地图导出成 `map_<id>.dat` 时，游戏读的是 gzip 压缩的 NBT。没有写入器
 *      就只能导 PNG，用户还得自己拿工具转一遍——而"导出的地图能被游戏直接
 *      give 出来"才是这个功能的意义。
 *
 * @constraint 类型必须显式包装，不能像读取那样"猜"。
 *      NBT 里 0x7F 既可能是 byte 127、也可能是 short 的高位；`num()` 在读的
 *      时候靠字段名约定糊过去了，写的时候没有字段名可依。所以这里每一种
 *      标签都带 `type`，少一个字节游戏就会把整个文件判为损坏。
 */

export type WTag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'string'; value: string }
  | { type: 'bytes'; value: Uint8Array }
  | { type: 'ints'; value: Int32Array }
  | { type: 'longs'; value: BigInt64Array }
  /** 同类型列表；地图与结构文件用不到异构列表 */
  | { type: 'list'; of: WTag['type']; value: WTag[] }
  | { type: 'compound'; value: Record<string, WTag> }

const TAG_ID: Record<WTag['type'], number> = {
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  bytes: 7,
  string: 8,
  list: 9,
  compound: 10,
  ints: 11,
  longs: 12,
}

/** 可增长的字节缓冲。手写而不是用数组 push：16384 字节的地图颜色一次 set 就够 */
class Writer {
  private buf = new Uint8Array(1024)
  private view = new DataView(this.buf.buffer)
  private pos = 0

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.byteLength) return
    let size = this.buf.byteLength * 2
    while (size < this.pos + extra) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(value: number): void {
    this.ensure(1)
    this.view.setUint8(this.pos, value & 0xff)
    this.pos += 1
  }

  i16(value: number): void {
    this.ensure(2)
    this.view.setInt16(this.pos, value)
    this.pos += 2
  }

  u16(value: number): void {
    this.ensure(2)
    this.view.setUint16(this.pos, value)
    this.pos += 2
  }

  i32(value: number): void {
    this.ensure(4)
    this.view.setInt32(this.pos, value)
    this.pos += 4
  }

  i64(value: bigint): void {
    this.ensure(8)
    this.view.setBigInt64(this.pos, value)
    this.pos += 8
  }

  f32(value: number): void {
    this.ensure(4)
    this.view.setFloat32(this.pos, value)
    this.pos += 4
  }

  f64(value: number): void {
    this.ensure(8)
    this.view.setFloat64(this.pos, value)
    this.pos += 8
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.byteLength)
    this.buf.set(bytes, this.pos)
    this.pos += bytes.byteLength
  }

  /**
   * UTF-8 字符串。
   * @constraint 长度是**字面字节数**不是字符数：中文地图名写成字符数，游戏读到
   *      一半就开始解析下一个标签，整个文件报废。
   */
  text(value: string): void {
    const bytes = new TextEncoder().encode(value)
    this.u16(bytes.byteLength)
    this.raw(bytes)
  }

  done(): Uint8Array {
    return this.buf.slice(0, this.pos)
  }
}

function writePayload(writer: Writer, tag: WTag): void {
  switch (tag.type) {
    case 'byte':
      writer.u8(tag.value)
      break
    case 'short':
      writer.i16(tag.value)
      break
    case 'int':
      writer.i32(tag.value)
      break
    case 'long':
      writer.i64(tag.value)
      break
    case 'float':
      writer.f32(tag.value)
      break
    case 'double':
      writer.f64(tag.value)
      break
    case 'string':
      writer.text(tag.value)
      break
    case 'bytes':
      writer.i32(tag.value.byteLength)
      writer.raw(tag.value)
      break
    case 'ints':
      writer.i32(tag.value.length)
      for (const value of tag.value) writer.i32(value)
      break
    case 'longs':
      writer.i32(tag.value.length)
      for (const value of tag.value) writer.i64(value)
      break
    case 'list': {
      const id = tag.value.length ? TAG_ID[tag.of] : 0
      writer.u8(id)
      writer.i32(tag.value.length)
      for (const item of tag.value) writePayload(writer, item)
      break
    }
    case 'compound':
      for (const [name, child] of Object.entries(tag.value)) {
        writer.u8(TAG_ID[child.type])
        writer.text(name)
        writePayload(writer, child)
      }
      writer.u8(0)
      break
  }
}

/**
 * 写一个根 compound。
 * @why 根名字固定空串：原版 `NbtIo.writeCompressed` 对根标签不写名字，
 *      这里保持同样行为，读回来的工具（含本项目的 readNbt）才能直接吃。
 */
export function writeNbt(root: Record<string, WTag>, rootName = ''): Uint8Array {
  const writer = new Writer()
  writer.u8(TAG_ID.compound)
  writer.text(rootName)
  writePayload(writer, { type: 'compound', value: root })
  return writer.done()
}

/**
 * gzip 压缩。
 * @constraint 必须用 CompressionStream 而不是自己塞 zlib：浏览器的这个实现是
 *      原生的，1MB 的 NBT 压缩是毫秒级；JS 实现要几百毫秒，页面会卡住。
 */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return bytes
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}
