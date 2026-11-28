/**
 * 亚像素轮廓：高分辨率灰度场 → 等值线环。
 *
 * @why 立体字以前是在二值点阵上沿着「墨格/空格」的交界走一圈，所以轮廓顶点
 *      全落在整数格上，一条斜笔画必然是一串 90° 台阶。挤出成三维之后，每一级
 *      台阶都是一圈侧面，转到 3/4 视角就是一圈方齿；字号一大，栅格化后的
 *      台阶宽度还会跟着变，同一个字在不同字号下"胖瘦"都不一样。
 *      参考实现（EaseCation/cube-3d-text，MIT）取的是字体轮廓，天生是平滑折线。
 *      这里不引入 three.js 那一套，改成在**超采样的 alpha 场**上取 0.5 等值线：
 *      marching squares 出来的交点是浮点坐标，台阶被插值抹成斜边，视觉上和
 *      矢量轮廓挤出没有区别，而且对任意系统字体、原版点阵字体都成立。
 *
 * @constraint 场里的单位是"超采样像素"，除以 `SUPERSAMPLE` 才是格。
 *      所有对外接口（`traceField` 返回的环）已经除过，调用方不用关心倍率。
 */

/** 一张覆盖率场。alpha 取值 0..1，1 表示完全被字形覆盖 */
export interface Field {
  width: number
  height: number
  alpha: Float32Array
}

/** 一条闭合环，扁平 `[x,y,x,y,...]`，单位是格 */
export type Ring = number[]

/** 超采样倍率。4 倍已经能把 40px 字的台阶抹到看不出来，再高收益递减 */
export const SUPERSAMPLE = 4

/** 从 canvas 的 RGBA 像素里取 alpha 通道 */
export function fieldFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Field {
  const alpha = new Float32Array(width * height)
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = data[i * 4 + 3]! / 255
  return { width, height, alpha }
}

/** 二值掩码 → 场。给旧的点阵字体路径留的后门 */
export function fieldFromMask(mask: Uint8Array, width: number, height: number): Field {
  const alpha = new Float32Array(width * height)
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = mask[i] === 1 ? 1 : 0
  return { width, height, alpha }
}

/**
 * 场的横向/纵向极值，用来裁掉四周的空白。
 *
 * @why 不裁的话，一屏空白也会被扫一遍，而且字的包围盒会带着栅格化时留的
 *      8 像素边距，缩放到画布时会整体偏小一圈。
 */
export function trimField(field: Field, iso = 0.02): Field {
  const { width, height, alpha } = field
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alpha[y * width + x]! <= iso) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return field
  minX = Math.max(0, minX - 1)
  minY = Math.max(0, minY - 1)
  maxX = Math.min(width - 1, maxX + 1)
  maxY = Math.min(height - 1, maxY + 1)
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y += 1) {
    out.set(alpha.subarray((y + minY) * width + minX, (y + minY) * width + maxX + 1), y * w)
  }
  return { width: w, height: h, alpha: out }
}

interface Segment {
  /** 两个端点在网格边上的唯一编号 */
  a: number
  b: number
  ax: number
  ay: number
  bx: number
  by: number
}

/**
 * marching squares：取 0.5 等值线。
 *
 * @why 用无向图拼接，不靠"内部始终在左手边"的约定。约定一旦写反，环就会
 *      在自己身上打结（汉字里笔画密集处特别容易），earcut 直接失败、那一块
 *      字面消失。无向图只要求"每个交点被两条线段共用"，方向错不了。
 * @constraint 鞍点（对角两角在墨内、另两角在外）必须拆成两条线段，不能连一条。
 *      连一条会把本该分离的两条笔画粘成一个 8 字，中间那块被当成内部填实。
 */
export function traceField(field: Field, iso = 0.5, tolerance = 0.55): Ring[] {
  const { width, height, alpha } = field
  if (width < 2 || height < 2) return []
  const at = (x: number, y: number): number => alpha[y * width + x]!

  /** 交点编号：水平边与垂直边各占一套，保证相邻格子指同一个点 */
  const keyH = (x: number, y: number): number => (y * width + x) * 2
  const keyV = (x: number, y: number): number => (y * width + x) * 2 + 1

  const segments: Segment[] = []
  const push = (a: number, b: number, ax: number, ay: number, bx: number, by: number): void => {
    segments.push({ a, b, ax, ay, bx, by })
  }

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = at(x, y)
      const b = at(x + 1, y)
      const c = at(x + 1, y + 1)
      const d = at(x, y + 1)
      const ia = a > iso
      const ib = b > iso
      const ic = c > iso
      const id = d > iso
      const code = (ia ? 1 : 0) | (ib ? 2 : 0) | (ic ? 4 : 0) | (id ? 8 : 0)
      if (code === 0 || code === 15) continue

      // 四条边上的交点，插值到等值线上
      const top = ia !== ib
        ? { key: keyH(x, y), x: x + (iso - a) / (b - a), y }
        : null
      const right = ib !== ic
        ? { key: keyV(x + 1, y), x: x + 1, y: y + (iso - b) / (c - b) }
        : null
      const bottom = id !== ic
        ? { key: keyH(x, y + 1), x: x + (iso - d) / (c - d), y: y + 1 }
        : null
      const left = ia !== id
        ? { key: keyV(x, y), x, y: y + (iso - a) / (d - a) }
        : null

      const emit = (p: typeof top, q: typeof top): void => {
        if (p && q) push(p.key, q.key, p.x, p.y, q.x, q.y)
      }

      switch (code) {
        case 1:
        case 14:
          emit(top, left)
          break
        case 2:
        case 13:
          emit(top, right)
          break
        case 3:
        case 12:
          emit(left, right)
          break
        case 4:
        case 11:
          emit(right, bottom)
          break
        case 6:
        case 9:
          emit(top, bottom)
          break
        case 7:
        case 8:
          emit(left, bottom)
          break
        // 鞍点：按格心平均决定连法，避免把两笔粘成一片
        case 5:
        case 10: {
          const center = (a + b + c + d) / 4 > iso
          if (center === (code === 5)) {
            emit(top, right)
            emit(bottom, left)
          } else {
            emit(top, left)
            emit(bottom, right)
          }
          break
        }
        default:
          break
      }
    }
  }

  if (segments.length === 0) return []

  // 无向图：交点 → 参与的线段
  const adj = new Map<number, number[]>()
  segments.forEach((segment, index) => {
    for (const key of [segment.a, segment.b]) {
      const list = adj.get(key)
      if (list) list.push(index)
      else adj.set(key, [index])
    }
  })

  const used = new Uint8Array(segments.length)
  const scale = 1 / SUPERSAMPLE
  const rings: Ring[] = []

  for (let seed = 0; seed < segments.length; seed += 1) {
    if (used[seed] === 1) continue
    const ring: Ring = []
    let current = seed
    let forward: boolean = true
    for (let guard = 0; guard <= segments.length; guard += 1) {
      const segment = segments[current]!
      used[current] = 1
      if (forward) ring.push(segment.ax * scale, segment.ay * scale)
      else ring.push(segment.bx * scale, segment.by * scale)
      const exitKey: number = forward ? segment.b : segment.a
      const candidates = adj.get(exitKey) ?? []
      let next = -1
      for (const index of candidates) {
        if (used[index] === 1) continue
        next = index
        break
      }
      if (next < 0) break
      const following = segments[next]!
      forward = following.a === exitKey
      current = next
    }
    if (ring.length >= 6) {
      const simplified = simplifyClosed(ring, tolerance)
      if (simplified.length >= 6) rings.push(simplified)
    }
  }

  return rings
}

/** 闭合折线的 Douglas–Peucker：先切成两半再各自简化，避免首尾被切断 */
export function simplifyClosed(points: number[], tolerance: number): number[] {
  const count = points.length / 2
  if (count < 4 || tolerance <= 0) return points
  let far = 0
  let best = -1
  for (let i = 1; i < count; i += 1) {
    const dx = points[i * 2]! - points[0]!
    const dy = points[i * 2 + 1]! - points[1]!
    const d = dx * dx + dy * dy
    if (d > best) {
      best = d
      far = i
    }
  }
  if (best <= 0) return points

  const first: number[] = []
  for (let i = 0; i <= far; i += 1) first.push(points[i * 2]!, points[i * 2 + 1]!)
  const second: number[] = []
  for (let i = far; i < count; i += 1) second.push(points[i * 2]!, points[i * 2 + 1]!)
  second.push(points[0]!, points[1]!)

  const walk = (line: number[], lo: number, hi: number, keep: boolean[]): void => {
    if (hi <= lo + 1) return
    const ax = line[lo * 2]!
    const ay = line[lo * 2 + 1]!
    const bx = line[hi * 2]!
    const by = line[hi * 2 + 1]!
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy) || 1
    let worst = -1
    let at = -1
    for (let i = lo + 1; i < hi; i += 1) {
      const px = line[i * 2]!
      const py = line[i * 2 + 1]!
      const distance = Math.abs(dy * (px - ax) - dx * (py - ay)) / length
      if (distance > worst) {
        worst = distance
        at = i
      }
    }
    if (worst <= tolerance || at < 0) return
    keep[at] = true
    walk(line, lo, at, keep)
    walk(line, at, hi, keep)
  }

  const keepFirst = new Array<boolean>(first.length / 2).fill(false)
  const keepSecond = new Array<boolean>(second.length / 2).fill(false)
  keepFirst[0] = true
  keepFirst[keepFirst.length - 1] = true
  keepSecond[0] = true
  keepSecond[keepSecond.length - 1] = true
  walk(first, 0, first.length / 2 - 1, keepFirst)
  walk(second, 0, second.length / 2 - 1, keepSecond)

  const out: number[] = []
  for (let i = 0; i < keepFirst.length - 1; i += 1) {
    if (keepFirst[i]) out.push(first[i * 2]!, first[i * 2 + 1]!)
  }
  for (let i = 1; i < keepSecond.length - 1; i += 1) {
    if (keepSecond[i]) out.push(second[i * 2]!, second[i * 2 + 1]!)
  }
  return out.length >= 6 ? out : points
}

/**
 * 精确欧氏距离变换（Felzenszwalb & Huttenlocher）。
 *
 * @why 描边要的是"沿轮廓均匀外扩 r 格"，不是方形核膨胀。方形核在斜笔画上会把
 *      描边撑出方角，而参考实现里描边是等宽的。距离变换之后取 `距离 = r` 的
 *      等值线，就是标准的圆角外扩，且整张场只扫两遍，比逐像素圆形核快两个数量级。
 * @constraint 输入是二值（墨/非墨）。灰度的半步覆盖会得到"半格距离"，
 *      外轮廓会抖，先按 0.5 二值化再算。
 */
export function distanceField(field: Field, ink = 0.5): Float32Array {
  const { width, height, alpha } = field
  const INF = 1e20
  const grid = new Float32Array(width * height)
  for (let i = 0; i < grid.length; i += 1) grid[i] = alpha[i]! >= ink ? 0 : INF

  const n = Math.max(width, height)
  const f = new Float64Array(n)
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)

  const pass = (values: Float64Array, length: number, writeBack: (index: number, value: number) => void): void => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < length; q += 1) {
      let s = ((values[q]! + q * q) - (values[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      while (s <= z[k]!) {
        k -= 1
        s = ((values[q]! + q * q) - (values[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      }
      k += 1
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < length; q += 1) {
      while (z[k + 1]! < q) k += 1
      const delta = q - v[k]!
      writeBack(q, delta * delta + values[v[k]!]!)
    }
  }

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) f[y] = grid[y * width + x]!
    pass(f, height, (index, value) => {
      d[index] = value
    })
    for (let y = 0; y < height; y += 1) grid[y * width + x] = d[y]!
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) f[x] = grid[y * width + x]!
    pass(f, width, (index, value) => {
      d[index] = value
    })
    for (let x = 0; x < width; x += 1) grid[y * width + x] = d[x]!
  }
  for (let i = 0; i < grid.length; i += 1) grid[i] = Math.sqrt(grid[i]!)
  return grid
}

/** 距离场包成 Field，方便直接喂给 traceField（等值线取 `distance = r`） */
export function fieldOfDistance(distance: Float32Array, width: number, height: number): Field {
  return { width, height, alpha: distance }
}

/**
 * 四周补空白。
 *
 * @constraint 描边靠距离变换取等值线，而距离变换只在场内部统计。贴边笔画
 *      外侧没有空白，`距离 = r` 的等值线会被场边界截断，那一条边的描边就
 *      直接缺掉——表现为字的某一侧没有黑边。
 */
export function padField(field: Field, edge: number): Field {
  const pad = Math.max(0, Math.ceil(edge))
  if (pad === 0) return field
  const width = field.width + pad * 2
  const height = field.height + pad * 2
  const alpha = new Float32Array(width * height)
  for (let y = 0; y < field.height; y += 1) {
    alpha.set(field.alpha.subarray(y * field.width, (y + 1) * field.width), (y + pad) * width + pad)
  }
  return { width, height, alpha }
}
