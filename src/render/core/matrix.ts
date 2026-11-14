/**
 * 4×4 矩阵运算（列主序，与 OpenGL / JOML 一致）。
 *
 * @why 不引 gl-matrix / three：整个站点只用到透视、正交、lookAt、平移旋转
 *      缩放这五种，一个 8KB 的库换 60KB 的依赖不值得，而且列主序约定
 *      一旦和库对不上，画面会整体镜像，排查起来很费时间。
 *
 * @constraint 索引约定：`m[col * 4 + row]`。即 m[12..14] 是平移分量。
 *      写反了的话 `lookAt` 的结果转置，物体会在整个视锥外面。
 */
import type { Mat4, Vec3 } from './types'

export type { Mat4 }

export function identity(): Mat4 {
  const m = new Float32Array(16)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  return m
}

export function copy(src: Mat4): Mat4 {
  return new Float32Array(src)
}

/** out = a × b（先应用 b，再应用 a） */
export function multiply(a: Mat4, b: Mat4, out = new Float32Array(16)): Mat4 {
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[c * 4]!
    const b1 = b[c * 4 + 1]!
    const b2 = b[c * 4 + 2]!
    const b3 = b[c * 4 + 3]!
    out[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3
    out[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3
    out[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3
    out[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3
  }
  return out
}

export function fromTranslation(x: number, y: number, z: number): Mat4 {
  const m = identity()
  m[12] = x
  m[13] = y
  m[14] = z
  return m
}

export function fromScale(x: number, y: number, z: number): Mat4 {
  const m = identity()
  m[0] = x
  m[5] = y
  m[10] = z
  return m
}

export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovY / 2)
  const m = new Float32Array(16)
  m[0] = f / aspect
  m[5] = f
  m[10] = (far + near) / (near - far)
  m[11] = -1
  m[14] = (2 * far * near) / (near - far)
  return m
}

export function ortho(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
  const m = identity()
  m[0] = 2 / (right - left)
  m[5] = 2 / (top - bottom)
  m[10] = -2 / (far - near)
  m[12] = -(right + left) / (right - left)
  m[13] = -(top + bottom) / (top - bottom)
  m[14] = -(far + near) / (far - near)
  return m
}

export function lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
  const zx = eye[0] - target[0]
  const zy = eye[1] - target[1]
  const zz = eye[2] - target[2]
  let len = Math.hypot(zx, zy, zz)
  if (len === 0) len = 1
  const z0 = zx / len
  const z1 = zy / len
  const z2 = zz / len

  // x = normalize(cross(up, z))
  let xx = up[1] * z2 - up[2] * z1
  let xy = up[2] * z0 - up[0] * z2
  let xz = up[0] * z1 - up[1] * z0
  len = Math.hypot(xx, xy, xz)
  if (len === 0) {
    xx = 1
    xy = 0
    xz = 0
  } else {
    xx /= len
    xy /= len
    xz /= len
  }

  // y = cross(z, x)
  const yx = z1 * xz - z2 * xy
  const yy = z2 * xx - z0 * xz
  const yz = z0 * xy - z1 * xx

  const m = new Float32Array(16)
  m[0] = xx
  m[1] = yx
  m[2] = z0
  m[4] = xy
  m[5] = yy
  m[6] = z1
  m[8] = xz
  m[9] = yz
  m[10] = z2
  m[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2])
  m[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2])
  m[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2])
  m[15] = 1
  return m
}

/** 绕 Y 轴旋转（弧度） */
export function rotateY(radians: number): Mat4 {
  const m = identity()
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  m[0] = c
  m[2] = -s
  m[8] = s
  m[10] = c
  return m
}

/** 绕 X 轴旋转（弧度） */
export function rotateX(radians: number): Mat4 {
  const m = identity()
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  m[5] = c
  m[6] = s
  m[9] = -s
  m[10] = c
  return m
}

/** 法线矩阵的简化版：正交且等比缩放下，直接用旋转部分即可 */
export function normalMatrix(model: Mat4): Mat4 {
  const m = identity()
  m[0] = model[0]!
  m[1] = model[1]!
  m[2] = model[2]!
  m[4] = model[4]!
  m[5] = model[5]!
  m[6] = model[6]!
  m[8] = model[8]!
  m[9] = model[9]!
  m[10] = model[10]!
  return m
}

/** 原地把矩阵平移、缩放、旋转的组合，用于模型 → 世界的摆放 */
export function compose(translation: Vec3, rotationY: number, scale: number): Mat4 {
  const t = fromTranslation(translation[0], translation[1], translation[2])
  const r = rotateY(rotationY)
  const s = fromScale(scale, scale, scale)
  return multiply(t, multiply(r, s))
}
