/**
 * 动画 WebP 封装。
 *
 * @why 浏览器没有 WebP 动画编码 API，但 canvas.toBlob('image/webp') 能出单帧
 *      带 alpha 的 WebP。动画 WebP 的 ANMF 帧数据里装的正是"单帧 WebP 去掉
 *      RIFF 头之后的那几个 chunk"（ALPH + VP8/VP8L），所以完全可以逐帧拿静图、
 *      自己只做容器拼装——不需要重新编码像素，速度和多花的内存都很划算。
 *
 * @constraint 只能搬运位流，不能改尺寸：每个 ANMF 的子帧宽高必须等于画布宽高
 *      （这里每帧都是全幅），否则 x/y 偏移和裁剪会算错，播出来是错位的残影。
 */

interface WebpChunk {
  fourcc: string
  data: Uint8Array
}

function readU32le(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)
}

/** 24 位小端，WebP 的 x/y/宽/高 都是这个编码 */
function u24(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]
}

function fourcc(name: string): number[] {
  return [name.charCodeAt(0), name.charCodeAt(1), name.charCodeAt(2), name.charCodeAt(3)]
}

function parseStill(bytes: Uint8Array): { chunks: WebpChunk[]; alpha: boolean } {
  const signature = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
  if (signature !== 'RIFF' || brand !== 'WEBP') {
    throw new Error('浏览器返回的不是 WebP（可能不支持该格式）')
  }

  const chunks: WebpChunk[] = []
  let at = 12
  while (at + 8 <= bytes.length) {
    const name = String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!)
    const size = readU32le(bytes, at + 4)
    const start = at + 8
    if (start + size > bytes.length) break
    chunks.push({ fourcc: name, data: bytes.subarray(start, start + size) })
    // chunk 按偶数字节对齐
    at = start + size + (size & 1)
  }

  const hasAlph = chunks.some((item) => item.fourcc === 'ALPH')
  const lossless = chunks.some((item) => item.fourcc === 'VP8L')
  return { chunks, alpha: hasAlph || lossless }
}

function riff(payload: number[]): Uint8Array {
  // 12 = 'RIFF' + size + 'WEBP'
  const out = new Uint8Array(12 + payload.length)
  out.set(fourcc('RIFF'), 0)
  const size = 4 + payload.length // 'WEBP' + chunks
  out[4] = size & 0xff
  out[5] = (size >>> 8) & 0xff
  out[6] = (size >>> 16) & 0xff
  out[7] = (size >>> 24) & 0xff
  out.set(fourcc('WEBP'), 8)
  out.set(payload, 12)
  return out
}

function chunkBytes(name: string, data: number[]): number[] {
  const pad = data.length & 1 ? [0] : []
  return [
    ...fourcc(name),
    data.length & 0xff,
    (data.length >>> 8) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 24) & 0xff,
    ...data,
    ...pad,
  ]
}

export interface WebpFrame {
  /** 单帧 WebP 文件字节（canvas.toBlob 的产物） */
  still: Uint8Array
  /** 毫秒 */
  delay: number
}

/**
 * 把若干张单帧 WebP 拼成动画 WebP。
 *
 * @param loop 0 表示无限循环
 */
export function muxAnimatedWebp(frames: WebpFrame[], width: number, height: number, loop = 0): Uint8Array {
  if (frames.length === 0) throw new Error('没有可封装的帧')

  const parsed = frames.map((frame) => parseStill(frame.still))
  const alpha = parsed.some((item) => item.alpha)

  // VP8X 标志位：bit1 动画、bit4 alpha（按 LSB 记）
  const flags = 0x02 | (alpha ? 0x10 : 0)
  const payload: number[] = []

  payload.push(
    ...chunkBytes('VP8X', [flags, 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]),
    // 背景色 BGRA + 循环次数；每帧都是全幅 SOURCE，背景色用不到，留全透明
    ...chunkBytes('ANIM', [0, 0, 0, 0, loop & 0xff, (loop >>> 8) & 0xff]),
  )

  for (let i = 0; i < frames.length; i += 1) {
    const { chunks } = parsed[i]!
    const framePayload: number[] = []

    // 只搬像素位流，元数据（ICCP/EXIF/XMP）留给容器
    for (const item of chunks) {
      if (item.fourcc === 'ALPH' || item.fourcc === 'VP8 ' || item.fourcc === 'VP8L') {
        framePayload.push(...chunkBytes(item.fourcc, Array.from(item.data)))
      }
    }
    if (framePayload.length === 0) throw new Error('单帧 WebP 里找不到像素数据')

    /**
     * @why 帧标志位取 2（do not blend）：每帧都覆盖整张画布，用 alpha 混合
     *      会让上一帧的半透明像素透出来，转台动画就会出现拖影。
     */
    payload.push(
      ...chunkBytes('ANMF', [
        ...u24(0),
        ...u24(0),
        ...u24(width - 1),
        ...u24(height - 1),
        ...u24(Math.max(1, Math.round(frames[i]!.delay))),
        2,
        ...framePayload,
      ]),
    )
  }

  return riff(payload)
}
