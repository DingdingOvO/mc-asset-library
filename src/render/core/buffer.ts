/**
 * 顶点缓冲与写入器。
 *
 * @why 顶点格式照抄原版的 `DefaultVertexFormat`，不是随便排的：
 *      BLOCK 是 position(f32×3) + color(u8×4) + uv0(f32×2) + uv2(f32×2)，
 *      ENTITY 在此基础上多 overlay(f32×2) 和 normal(i8×3)。
 *      颜色用 u8 归一化而不是 f32，一个顶点省 12 字节——地形区块动辄
 *      十万顶点，这一项就差几 MB。
 *
 * @constraint 所有字段偏移必须是 4 的倍数。WebGL 对 `vertexAttribPointer`
 *      的 offset 没有对齐要求，但把 u8 颜色放在非 4 对齐位置会让 V8 的
 *      TypedArray 视图退化成 DataView 路径，逐顶点写速度差三倍。
 */

/** 一个顶点格式的字段声明，等价于原版的 VertexFormatElement 列表 */
export interface VertexField {
  name: string
  /**
   * 对应着色器里的 `layout(location = N)`。
   * @why 每个格式各自声明而不是全局查表：原版的 BLOCK 把光照坐标放在
   *      location 3，ENTITY 却把 overlay 放 3、光照放 4。全局映射表
   *      没法表达这种差异，只能二选一，结果就是其中一个格式的
   *      属性绑错位置——表现是方块的光照值被当成 overlay 采样。
   */
  location: number
  /** 分量个数 */
  size: number
  /** 字节偏移 */
  offset: number
  /** 数据类型：决定走哪个 TypedArray 视图 */
  type: 'float' | 'ubyte' | 'ushort' | 'byte'
  /** 是否归一化到 0..1（颜色、法线） */
  normalized: boolean
}

export interface VertexLayout {
  name: string
  stride: number
  fields: VertexField[]
}

/**
 * @constraint 光照坐标用 float 而不是原版的 unsigned short。
 *      原版是 `ivec2` 整数属性，WebGL2 要用 `vertexAttribIPointer` 单独设置；
 *      部分实现（包括 SwiftShader 和某些移动 GPU 驱动）会在 drawArrays 时
 *      抛 `INVALID_OPERATION`，且不给出任何说明——画面全空，控制台只有
 *      一串 1282。值域只有 0..240，float 能精确表示，精度上没有任何损失。
 */
export const BLOCK_LAYOUT: VertexLayout = {
  name: 'block',
  stride: 32,
  fields: [
    { name: 'Position', location: 0, size: 3, offset: 0, type: 'float', normalized: false },
    { name: 'Color', location: 1, size: 4, offset: 12, type: 'ubyte', normalized: true },
    { name: 'UV0', location: 2, size: 2, offset: 16, type: 'float', normalized: false },
    { name: 'UV2', location: 3, size: 2, offset: 24, type: 'float', normalized: false },
  ],
}

export const ENTITY_LAYOUT: VertexLayout = {
  name: 'entity',
  stride: 44,
  fields: [
    { name: 'Position', location: 0, size: 3, offset: 0, type: 'float', normalized: false },
    { name: 'Color', location: 1, size: 4, offset: 12, type: 'ubyte', normalized: true },
    { name: 'UV0', location: 2, size: 2, offset: 16, type: 'float', normalized: false },
    { name: 'UV1', location: 3, size: 2, offset: 24, type: 'float', normalized: false },
    { name: 'UV2', location: 4, size: 2, offset: 32, type: 'float', normalized: false },
    { name: 'Normal', location: 5, size: 3, offset: 40, type: 'byte', normalized: true },
  ],
}

/**
 * 顶点写入器。内部是一块可增长的 ArrayBuffer + 叠加的 TypedArray 视图。
 *
 * @why 不用 `number[]` 攒着最后 `new Float32Array(list)`：一个区块
 *      十万顶点、每顶点 7 个 float，等于一个 70 万元素的稀疏数组，
 *      每次 GC 都要扫一遍，滚动浏览时帧率会周期性掉到 20。
 */
export class VertexWriter {
  private buffer: ArrayBuffer
  private f32: Float32Array
  private u8: Uint8Array
  private i8: Int8Array
  /** 已写入的顶点数 */
  count = 0

  constructor(
    readonly layout: VertexLayout,
    capacity = 4096,
  ) {
    this.buffer = new ArrayBuffer(layout.stride * capacity)
    this.f32 = new Float32Array(this.buffer)
    this.u8 = new Uint8Array(this.buffer)
    this.i8 = new Int8Array(this.buffer)
  }

  /** 顶点容量上限 */
  get capacity(): number {
    return this.buffer.byteLength / this.layout.stride
  }

  reset(): void {
    this.count = 0
  }

  private grow(): void {
    const next = new ArrayBuffer(this.buffer.byteLength * 2)
    new Uint8Array(next).set(this.u8)
    this.buffer = next
    this.f32 = new Float32Array(next)
    this.u8 = new Uint8Array(next)
    this.i8 = new Int8Array(next)
  }

  /** 预留一个顶点，返回其字节偏移 */
  private slot(): number {
    if (this.count >= this.capacity) this.grow()
    const offset = this.count * this.layout.stride
    this.count += 1
    return offset
  }

  /** BLOCK 顶点：位置、RGBA、UV、光照坐标 */
  block(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    a: number,
    u: number,
    v: number,
    lightU: number,
    lightV: number,
  ): void {
    const o = this.slot()
    const f = o >> 2
    this.f32[f] = x
    this.f32[f + 1] = y
    this.f32[f + 2] = z
    this.u8[o + 12] = r
    this.u8[o + 13] = g
    this.u8[o + 14] = b
    this.u8[o + 15] = a
    this.f32[f + 4] = u
    this.f32[f + 5] = v
    this.f32[f + 6] = lightU
    this.f32[f + 7] = lightV
  }

  /** ENTITY 顶点：比 BLOCK 多 overlay 与法线 */
  entity(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
    a: number,
    u: number,
    v: number,
    overlayU: number,
    overlayV: number,
    lightU: number,
    lightV: number,
    nx: number,
    ny: number,
    nz: number,
  ): void {
    const o = this.slot()
    const f = o >> 2
    this.f32[f] = x
    this.f32[f + 1] = y
    this.f32[f + 2] = z
    this.u8[o + 12] = r
    this.u8[o + 13] = g
    this.u8[o + 14] = b
    this.u8[o + 15] = a
    this.f32[f + 4] = u
    this.f32[f + 5] = v
    this.f32[f + 6] = overlayU
    this.f32[f + 7] = overlayV
    this.f32[f + 8] = lightU
    this.f32[f + 9] = lightV
    // 法线是 i8 归一化，值域 -128..127（即 -1.0..0.992）
    this.i8[o + 40] = Math.max(-127, Math.min(127, Math.round(nx * 127)))
    this.i8[o + 41] = Math.max(-127, Math.min(127, Math.round(ny * 127)))
    this.i8[o + 42] = Math.max(-127, Math.min(127, Math.round(nz * 127)))
    this.i8[o + 43] = 0
  }

  /** 取走一份紧凑拷贝（不含预留的空余容量） */
  data(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.count * this.layout.stride)
  }
}

/**
 * GPU 上的顶点缓冲 + 顶点数组对象。
 *
 * @constraint 必须用 VAO。WebGL2 的默认 VAO 在切换格式时残留旧状态，
 *      地形（28 字节）和实体（36 字节）交替绘制时，如果不重置，
 *      处理器会按上一个格式去解读新的缓冲，画面变成一堆乱飞的三角片。
 */
export class MeshBuffer {
  readonly vao: WebGLVertexArrayObject
  readonly vbo: WebGLBuffer
  private bytes = 0

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly layout: VertexLayout,
  ) {
    const vao = gl.createVertexArray()
    const vbo = gl.createBuffer()
    if (!vao || !vbo) throw new Error('创建顶点缓冲失败')
    this.vao = vao
    this.vbo = vbo

    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    for (const field of layout.fields) {
      const location = field.location
      gl.enableVertexAttribArray(location)
      if (field.type === 'float') {
        gl.vertexAttribPointer(location, field.size, gl.FLOAT, false, layout.stride, field.offset)
      } else if (field.type === 'ubyte') {
        gl.vertexAttribPointer(location, field.size, gl.UNSIGNED_BYTE, true, layout.stride, field.offset)
      } else if (field.type === 'byte') {
        gl.vertexAttribPointer(location, field.size, gl.BYTE, true, layout.stride, field.offset)
      } else {
        // 光照坐标是整数不是归一化值：0..240 表示 15 档 × 16
        gl.vertexAttribIPointer(location, field.size, gl.UNSIGNED_SHORT, layout.stride, field.offset)
      }
    }
    gl.bindVertexArray(null)
  }

  upload(data: Uint8Array): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    if (data.byteLength > this.bytes) {
      // 扩容时用 DYNAMIC_DRAW 重新分配，之后都走 subData
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      this.bytes = data.byteLength
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    }
  }

  bind(): void {
    this.gl.bindVertexArray(this.vao)
  }

  draw(vertexCount: number): void {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, vertexCount)
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao)
    this.gl.deleteBuffer(this.vbo)
  }
}
