/**
 * 点阵 → 轮廓环。
 *
 * @why 立体字不能靠"一格方块一个立方体"堆出来。那样每个笔画都是独立的小方块，
 *      相邻方块之间留着 1px 的缝，侧看是一排积木；描边也只能围着每个方块外扩，
 *      「日」中间那道缝会被描边吃掉一半。参考开源项目
 *      [Cube 3D Text](https://github.com/EaseCation/cube-3d-text)（MIT）的做法：
 *      先把文字的**轮廓**取出来，再用轮廓挤出成一体，描边是沿轮廓的一圈薄壳。
 *      这里把它的「字体轮廓」换成「点阵字形的轮廓」——本站的字体就是原版点阵字，
 *      字形必须是像素风，但拓扑结构可以和它一致。
 *
 * @constraint 环是闭合的、不重复首点的 `[x0,y0,x1,y1,...]`，坐标是**格点**
 *      （0..width）。挤出面直接拿格点当世界坐标，一个点阵像素 = 一格方块。
 */

/** 一条闭合环，扁平的 `[x,y,x,y,...]` */
export type Ring = number[]

/** 一个可三角化的二维形状：外环 + 若干内洞 */
export interface Shape2D {
  outer: Ring
  holes: Ring[]
}

/** 屏幕坐标下顺/逆时针的方向表：东、南、西、北 */
const STEP: readonly (readonly [number, number])[] = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
]

/**
 * 沿"墨/空"交界走一圈，取出所有轮廓环。
 *
 * @why 每个墨格只朝**暴露在外**的四条边各加一条有向边，这些边天然首尾相接，
 *      走一遍就是一条闭合环；洞会自动走成反向的环。比 marching squares 少一半
 *      判别代码，也不会在四角产生退化三角形。
 * @constraint 交汇点（棋盘格对角相邻）上有多条出边，必须优先右转。
 *      随便挑一条会把两个本该独立的环接成"8 字"，earcut 直接失败、整块面消失。
 */
export function traceMask(mask: Uint8Array, width: number, height: number, tolerance = 0.75): Ring[] {
  const ink = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1

  const stride = width + 1
  const outgoing = new Map<number, number[]>()
  const push = (x: number, y: number, dir: number): void => {
    const key = y * stride + x
    const list = outgoing.get(key)
    if (list) list.push(dir)
    else outgoing.set(key, [dir])
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!ink(x, y)) continue
      if (!ink(x, y - 1)) push(x, y, 0)
      if (!ink(x + 1, y)) push(x + 1, y, 1)
      if (!ink(x, y + 1)) push(x + 1, y + 1, 2)
      if (!ink(x - 1, y)) push(x, y + 1, 3)
    }
  }

  const used = new Set<number>()
  const rings: Ring[] = []

  for (const [key, dirs] of outgoing) {
    for (const startDir of dirs) {
      if (used.has(key * 4 + startDir)) continue
      const ring: Ring = []
      let cx = key % stride
      let cy = (key - cx) / stride
      let dir = startDir

      // 每个格点最多走一次；上限只是防御死循环，正常环的步数是周长
      for (let guard = 0; guard < mask.length * 4; guard += 1) {
        used.add((cy * stride + cx) * 4 + dir)
        ring.push(cx, cy)
        cx += STEP[dir]![0]
        cy += STEP[dir]![1]
        const next = cy * stride + cx
        const exits = outgoing.get(next)
        if (!exits) break

        // 右转 → 直行 → 左转 → 回头：只有前三种都走不通才回头，
        // 保证环始终贴着墨块的外侧，不会穿进内部
        let picked = -1
        for (const turn of [1, 0, 3, 2]) {
          const candidate = (dir + turn) % 4
          if (exits.includes(candidate) && !used.has(next * 4 + candidate)) {
            picked = candidate
            break
          }
        }
        if (picked < 0) break
        if (next === key && picked === startDir) break
        dir = picked
      }

      // 少于三个点的环没有面积（单个像素的退化环除外，它是 4 个点）
      if (ring.length >= 6) rings.push(simplifyDouglasPeucker(simplifyRing(ring), tolerance))
    }
  }

  return rings
}

/** 有向面积的两倍。屏幕坐标（y 向下）里，顺时针为负 */
export function ringArea(ring: Ring): number {
  let sum = 0
  const count = ring.length / 2
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count
    sum += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!
  }
  return sum / 2
}

/**
 * 去掉同一条直线上的中间点。
 *
 * @why 一个 16 像素高的汉字，轮廓有几百个格点，其中绝大多数处在同一条直线上。
 *      不化简的话每条边都要生成一个侧面四边形，三角形数直接翻两倍，而形状
 *      一个像素都没变。化简只删共线点，几何完全等价。
 */
export function simplifyRing(ring: Ring): Ring {
  const count = ring.length / 2
  if (count <= 4) return ring
  const out: Ring = []
  for (let i = 0; i < count; i += 1) {
    const prev = (i - 1 + count) % count
    const next = (i + 1) % count
    const ax = ring[prev * 2]!
    const ay = ring[prev * 2 + 1]!
    const bx = ring[i * 2]!
    const by = ring[i * 2 + 1]!
    const cx = ring[next * 2]!
    const cy = ring[next * 2 + 1]!
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
    if (cross === 0) continue
    out.push(bx, by)
  }
  return out.length >= 6 ? out : ring
}

/**
 * Douglas–Peucker：把一台阶梯压成斜线。
 *
 * @why 光删共线点只够去掉长直边，字形的斜笔画和弧线仍然是每格一个 90° 台阶。
 *      台阶是"点阵字"的特征，但挤出成三维后每一级台阶都是一圈侧面，
 *      三角形数按周长 × 阶梯数增长；而且放大看，字的边缘是一圈方齿，
 *      和参考项目里平滑的轮廓完全不同。按容差把台阶折线拟合成直线/斜线，
 *      形状误差不超过一个格，三角形数能降一半以上。
 * @constraint 容差不能大于 1 格。再大就会把笔画末端的小钩、汉字部件之间的
 *      窄缝一并抹掉，字会粘成一块。
 */
export function simplifyDouglasPeucker(points: number[], tolerance: number): number[] {
  const count = points.length / 2
  if (count < 4) return points

  // 闭合环：先按"最远的两个点"切成两条折线，各自简化，再拼回去
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
    if (worst > tolerance) {
      keep[at] = true
      walk(line, lo, at, keep)
      walk(line, at, hi, keep)
    }
  }

  const keepFirst = new Array<boolean>(first.length / 2).fill(false)
  keepFirst[0] = true
  keepFirst[keepFirst.length - 1] = true
  walk(first, 0, first.length / 2 - 1, keepFirst)

  const keepSecond = new Array<boolean>(second.length / 2).fill(false)
  keepSecond[0] = true
  keepSecond[keepSecond.length - 1] = true
  walk(second, 0, second.length / 2 - 1, keepSecond)

  const out: number[] = []
  for (let i = 0; i < keepFirst.length - 1; i += 1) {
    if (keepFirst[i]) out.push(first[i * 2]!, first[i * 2 + 1]!)
  }
  for (let i = 0; i < keepSecond.length - 1; i += 1) {
    if (keepSecond[i]) out.push(second[i * 2]!, second[i * 2 + 1]!)
  }
  return out.length >= 6 ? out : points
}

/**
 * 射线法判断点是否在环内。
 * @constraint 传进来的点必须**不在环的顶点上**。洞和外环的顶点都是格点，
 *      直接用顶点做测试会落在边界上，结果随浮点噪声摇摆；调用方传的是边中点。
 */
export function insideRing(ring: Ring, px: number, py: number): boolean {
  let inside = false
  const count = ring.length / 2
  for (let i = 0, j = count - 1; i < count; j = i, i += 1) {
    const xi = ring[i * 2]!
    const yi = ring[i * 2 + 1]!
    const xj = ring[j * 2]!
    const yj = ring[j * 2 + 1]!
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * 把环分成「外环 + 它的洞」。
 *
 * @why 不能用绕向分类。绕向只在"每个环都是简单外边界"时可信；描边环带只有
 *      1 格宽，`trace` 走出来的内外环方向常常一致，按符号分组会把内环当成
 *      第二个外环 —— earcut 拿到两个互相包含的外环，直接失效，表现为整块
 *      描边填成实心、把字面盖成一坨黑。
 * @constraint 用**嵌套层数**（even-odd）判定：边中点在奇数个环里 = 洞。
 *      格点坐标全是整数，边中点带 .5，永远不落在别的环的顶点上，
 *      射线法在边界上摇摆的问题也就不存在了。
 */
export function groupRings(rings: Ring[]): Shape2D[] {
  if (rings.length === 0) return []

  const areas = rings.map((ring) => Math.abs(ringArea(ring)))
  /** 每个环的探测点：第一条边的中点 */
  const probes = rings.map((ring) => [
    (ring[0]! + ring[2]!) / 2,
    (ring[1]! + ring[3]!) / 2,
  ] as const)

  const depth = rings.map((_, i) => {
    let count = 0
    for (let j = 0; j < rings.length; j += 1) {
      if (j !== i && insideRing(rings[j]!, probes[i]![0], probes[i]![1])) count += 1
    }
    return count
  })

  const shapes: Shape2D[] = []
  const indexOf = new Map<number, number>()
  for (let i = 0; i < rings.length; i += 1) {
    if (depth[i]! % 2 === 1) continue
    indexOf.set(i, shapes.length)
    shapes.push({ outer: rings[i]!, holes: [] })
  }

  for (let i = 0; i < rings.length; i += 1) {
    if (depth[i]! % 2 === 0) continue
    // 归属到"包含它、且面积最小"的外环
    let target = -1
    for (let j = 0; j < rings.length; j += 1) {
      if (depth[j]! % 2 !== 0) continue
      if (!insideRing(rings[j]!, probes[i]![0], probes[i]![1])) continue
      if (target < 0 || areas[j]! < areas[target]!) target = j
    }
    const slot = target >= 0 ? indexOf.get(target) : undefined
    if (slot !== undefined) shapes[slot]!.holes.push(rings[i]!)
  }

  return shapes
}
