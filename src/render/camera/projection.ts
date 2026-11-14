/**
 * 相机与取景数学：CPU 光栅化与 GPU 管线共用的一份定义。
 *
 * @why 这两条路径必须逐像素一致。之前 `scene.ts` 里有一份 `rotationXYZ`
 *      加 `pixelScale`，`pipeline.ts` 里又手写了一份 `rotationMatrix` 和
 *      `0.78 / 0.84` 的取景比例——两份代码只要有一处符号或顺序不同，
 *      表现就是「切换渲染后端时模型跳一下大小」或者「俯视变仰视」。
 *      那种错误在静态截图里看不出来，只能靠逐像素对比抓，成本极高。
 *      把数学收进一个文件，另一条路径就只能"派生"而没法"重写"。
 *
 * @constraint 本文件不许依赖 DOM / WebGL / 任何业务模块。
 *      它同时被 Node 侧的导出脚本与浏览器侧的渲染器引用，
 *      一旦引入副作用，那两边就各自打不进同一份代码了。
 */

export type Vec3 = [number, number, number]

const RAD = Math.PI / 180

/** 3×3 行主序 */
export type Mat3 = number[]

function mul3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!
    }
  }
  return out
}

function axisRot(axis: 'x' | 'y' | 'z', deg: number): Mat3 {
  const r = deg * RAD
  const c = Math.cos(r)
  const s = Math.sin(r)
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c]
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c]
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/**
 * joml 的 rotationXYZ 等价于 Rx · Ry · Rz（先应用 Z，最后应用 X）。
 *
 * @constraint 顺序写反会让俯视变仰视——模型完整、角度错误，最难靠肉眼发现。
 */
export function rotationXYZ(rx: number, ry: number, rz: number): Mat3 {
  return mul3(mul3(axisRot('x', rx), axisRot('y', ry)), axisRot('z', rz))
}

export function apply3(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ]
}

/**
 * `rotationXYZ(rx, ry, 0)` 的列主序 4×4 形式，供矩阵管线使用。
 *
 * @why 由 `rotationXYZ` 派生而不是手写展开：手写的那一份在上一版里是
 *      逐项抄的 `Rx · Ry`，抄对了也仍然是个"以后可以抄错"的隐患。
 *      从同一函数取数，等价性由构造保证，不需要注释去提醒后来人对齐。
 */
export function rotationMatrix4(rotX: number, rotY: number): Float32Array {
  const r = rotationXYZ(rotX, rotY, 0)
  const m = new Float32Array(16)
  m[0] = 1
  m[5] = 1
  m[10] = 1
  m[15] = 1
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      m[col * 4 + row] = r[row * 3 + col]!
    }
  }
  return m
}

/**
 * 取景占比：一格的模型在画布上占多少。
 *
 * @why block 用 78% 让按钮、压力板这类"小方块"保持真实比例；auto 用 84%
 *      让高个生物铺满画面。这两个数必须和 `pixelScale` 同源，
 *      GPU 侧算错一点点，切后端时模型就会缩放跳变。
 */
export const FIT_FRACTION = { block: 0.78, auto: 0.84 } as const

export function fitFraction(fit: 'block' | 'auto' | undefined): number {
  return fit === 'auto' ? FIT_FRACTION.auto : FIT_FRACTION.block
}

/** 每格模型在屏幕上占多少物理像素 */
export function pixelScale(size: number, fit: 'block' | 'auto', span: number, zoom = 1): number {
  const base = fit === 'auto' ? (size * FIT_FRACTION.auto) / span : size * FIT_FRACTION.block
  return base * zoom
}
