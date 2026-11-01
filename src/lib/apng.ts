/**
 * APNG 编码器。
 *
 * @why GIF 只有 1 位透明，半透明边缘必然渗出锯齿；H.264 干脆没有 alpha 通道。
 *      「真透明 + 能当动图用」的格式只剩 APNG 和动画 WebP，而浏览器没有
 *      canvas.toBlob('image/apng') 这种东西，只能自己拼容器。
 *
 * @constraint 帧数据必须走 zlib 流（RFC1950），不是 raw deflate。
 *      CompressionStream('deflate') 输出的正是带 2 字节头和 Adler-32 的 zlib
 *      数据流，可以直接塞进 IDAT；用 'deflate-raw' 反而会让解码器报错。
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function writeU16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 8) & 0xff
  target[offset + 1] = value & 0xff
}

/** 一个 PNG chunk：长度 + 类型 + 数据 + CRC（CRC 覆盖类型和数据） */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  writeU32(out, 0, data.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)))
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

async function zlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 CompressionStream，无法编码 APNG')
  }
  const stream = new Blob([bytes as unknown as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * 逐行做 Up 滤波再压缩。
 *
 * @why PNG 不滤波直接压缩，这种大面积纯透明/纯色的图会压得还行，但每行开头
 *      的 alpha 跳变会把 deflate 的字典打断。Up 滤波把"和上一行相同"变成连续的
 *      0，压缩率提升一大截，代价只是解码时多一次加法。
 */
async function packFrame(rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 4
  const raw = new Uint8Array((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowAt = y * (stride + 1)
    raw[rowAt] = 2 // filter = Up
    const src = y * stride
    const prev = (y - 1) * stride
    if (y === 0) {
      for (let i = 0; i < stride; i += 1) raw[rowAt + 1 + i] = rgba[src + i]!
    } else {
      for (let i = 0; i < stride; i += 1) raw[rowAt + 1 + i] = (rgba[src + i]! - rgba[prev + i]!) & 0xff
    }
  }
  return zlib(raw)
}

export interface ApngFrame {
  /** 已带背景/透明信息的整帧像素 */
  rgba: Uint8ClampedArray
  /** 毫秒 */
  delay: number
}

/**
 * 组装 APNG。
 *
 * @performance 每帧单独压缩（fdAT 各自独立），而不是把所有帧串成一条流：
 *      单独压缩可以边渲染边编码，不必等所有帧都在内存里；代价是帧间冗余没吃到，
 *      对这种主体在动的转台动画影响不大。
 */
export async function encodeApng(
  frames: ApngFrame[],
  width: number,
  height: number,
  loop = 0,
  onProgress?: (ratio: number) => void,
): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error('没有可编码的帧')

  const ihdr = new Uint8Array(13)
  writeU32(ihdr, 0, width)
  writeU32(ihdr, 4, height)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型 6 = RGBA
  ihdr[10] = 0 // 压缩方法
  ihdr[11] = 0 // 滤波方法
  ihdr[12] = 0 // 隔行扫描

  const actl = new Uint8Array(8)
  writeU32(actl, 0, frames.length)
  writeU32(actl, 4, loop)

  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
  ]

  let sequence = 0
  for (let i = 0; i < frames.length; i += 1) {
    const frame = frames[i]!
    const data = await packFrame(frame.rgba, width, height)

    const fctl = new Uint8Array(26)
    writeU32(fctl, 0, sequence)
    writeU32(fctl, 4, width)
    writeU32(fctl, 8, height)
    writeU32(fctl, 12, 0) // x
    writeU32(fctl, 16, 0) // y
    writeU16(fctl, 20, Math.max(1, Math.round(frame.delay)))
    writeU16(fctl, 22, 1000) // 分母：毫秒
    fctl[24] = 0 // dispose = NONE
    fctl[25] = 0 // blend = SOURCE
    parts.push(chunk('fcTL', fctl))
    sequence += 1

    if (i === 0) {
      // 第一帧的像素直接放 IDAT，这是 APNG 与普通 PNG 兼容的关键：
      // 不认识 acTL 的老解码器会当成一张静态图，看到的就是第一帧
      parts.push(chunk('IDAT', data))
    } else {
      const fdat = new Uint8Array(4 + data.length)
      writeU32(fdat, 0, sequence)
      fdat.set(data, 4)
      parts.push(chunk('fdAT', fdat))
      sequence += 1
    }

    onProgress?.((i + 1) / frames.length)
    // 让出主线程，否则进度条和按钮状态都不会重绘
    if (i % 3 === 2) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  parts.push(chunk('IEND', new Uint8Array(0)))
  return concat(parts)
}
