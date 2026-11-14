/**
 * 着色器程序：编译、链接、uniform 位置缓存。
 *
 * @why 手写 uniform 位置查找而不是每次 `getUniformLocation`：一次绘制
 *      要设十几个 uniform，列表页有几百个缩略图，每帧上千次字符串查表
 *      是纯浪费。链接后一次性反射出来，之后按下标直接写。
 */
import { expand, toEs } from './glsl'

export interface UniformInfo {
  location: WebGLUniformLocation
  type: number
  size: number
}

export interface AttribInfo {
  location: number
  name: string
  type: number
  size: number
}

export class Program {
  readonly program: WebGLProgram
  readonly uniforms = new Map<string, UniformInfo>()
  readonly attribs = new Map<string, AttribInfo>()
  /** 编译期错过的 uniform（被优化掉或名字打错），记下来只 warn 一次 */
  private readonly missing = new Set<string>()

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertexSource: string,
    fragmentSource: string,
    label: string,
  ) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vsh`)
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.fsh`)
    const program = gl.createProgram()
    if (!program) throw new Error(`创建程序失败：${label}`)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      gl.deleteProgram(program)
      throw new Error(`链接失败（${label}）：${log}`)
    }
    this.program = program

    const uniformCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
    for (let i = 0; i < uniformCount; i += 1) {
      const info = gl.getActiveUniform(program, i)
      if (!info) continue
      // 数组 uniform 的名字带 `[0]`，存一份去下标的别名
      const name = info.name.replace(/\[0\]$/, '')
      const location = gl.getUniformLocation(program, info.name)
      if (!location) continue
      this.uniforms.set(name, { location, type: info.type, size: info.size })
    }

    const attribCount = gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES) as number
    for (let i = 0; i < attribCount; i += 1) {
      const info = gl.getActiveAttrib(program, i)
      if (!info) continue
      this.attribs.set(info.name, {
        location: gl.getAttribLocation(program, info.name),
        name: info.name,
        type: info.type,
        size: info.size,
      })
    }
  }

  use(): void {
    this.gl.useProgram(this.program)
  }

  /** 设一个矩阵（4×4，列主序，与 JOML 一致） */
  mat4(name: string, value: Float32Array | number[]): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniformMatrix4fv(slot.location, false, value)
  }

  vec4(name: string, x: number, y: number, z: number, w: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform4f(slot.location, x, y, z, w)
  }

  vec3(name: string, x: number, y: number, z: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform3f(slot.location, x, y, z)
  }

  vec2(name: string, x: number, y: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform2f(slot.location, x, y)
  }

  vec2i(name: string, x: number, y: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform2i(slot.location, x, y)
  }

  vec3i(name: string, x: number, y: number, z: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform3i(slot.location, x, y, z)
  }

  float(name: string, value: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform1f(slot.location, value)
  }

  int(name: string, value: number): void {
    const slot = this.uniforms.get(name)
    if (!slot) return this.warn(name)
    this.gl.uniform1i(slot.location, value)
  }

  /** 绑定纹理单元并指向 sampler uniform */
  sampler(name: string, unit: number, texture: WebGLTexture | null): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    this.int(name, unit)
  }

  dispose(): void {
    this.gl.deleteProgram(this.program)
  }

  private warn(name: string): void {
    if (this.missing.has(name)) return
    this.missing.add(name)
    // 不是错误：着色器里被 `#ifdef` 关掉的分支不会有这个 uniform
    if (import.meta.env?.DEV) console.warn(`[render] uniform 不存在（可能被 #ifdef 关掉）：${name}`)
  }
}

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error(`创建着色器失败：${label}`)
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`${label} 编译失败：\n${log}\n\n${numberLines(source)}`)
  }
  return shader
}

/** 编译失败时把源码带行号打出来——没有这个基本没法排查 */
function numberLines(source: string): string {
  return source
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(3, ' ')}| ${line}`)
    .join('\n')
}

/** 编译 + 展开 include + 转 ES 3.00，一次做完 */
export function build(gl: WebGL2RenderingContext, label: string, vertex: string, fragment: string): Program {
  return new Program(gl, toEs(expand(vertex), 'vertex'), toEs(expand(fragment), 'fragment'), label)
}
