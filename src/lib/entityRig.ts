/**
 * 实体骨骼：保留 ModelPart 的层级与枢轴，而不是把几何烤死。
 *
 * @why 之前把 PartPose 的旋转直接烘进顶点，模型是"雕像"——腿永远不动。
 *      要放动作就必须保留「顶点在部件局部坐标 + 部件有自己的旋转」这层结构，
 *      每帧按 setupAnim 算出的角度重新摆姿势，这就是游戏里的做法。
 *
 * @constraint 坐标 y 向下（ModelPart 空间），转世界时整体取负。
 */
import type { EntityBox, EntityModel, EntityPart } from './entityMesh'
import type { Face3D } from './scene'

export interface RigFace {
  /** 顶点在 part.verts 里的起始下标（4 个连续顶点） */
  at: number
  uv: number[]
}

export interface RigPart {
  name: string
  /** 父部件名。pivot 与旋转都相对父部件，和游戏的 ModelPart 树一一对应 */
  parent: string | null
  /** 枢轴（相对父部件，ModelPart 空间，y 向下） */
  pivot: [number, number, number]
  /** PartPose 的初始弧度 */
  rot: [number, number, number]
  /** PartPose 的初始缩放，MeshTransformer 的结果落在这里 */
  scale: [number, number, number]
  /** 局部顶点，每 3 个数一个，y 向下 */
  verts: Float32Array
  faces: RigFace[]
}

export interface Rig {
  texW: number
  texH: number
  parts: RigPart[]
  /** 默认纹理（相对 textures/，不含 .png） */
  texture: string | null
}

/**
 * 一个 cuboid 的 6 个面，顶点顺序与 UV 参数逐个照抄 ModelPart$Cube。
 *
 * @constraint uv 里的四个下标是「u0,v0,u1,v1」在 u[]/v[] 里的位置，
 *      不能改用 min/max 归一：UP 面传的是 (u2, v1, u22, v0)，v 是反的，
 *      归一之后顶面贴图上下颠倒，草方块顶面与侧面接缝对不上；
 *      这里保留原始方向，缩放在 Cube 构造时已经完成。
 */
const FACE_DEFS: {
  name: string
  verts: [number, number, number][]
  uv: [number, number, number, number]
}[] = [
  { name: 'down', verts: [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]], uv: [1, 0, 2, 1] },
  { name: 'up', verts: [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]], uv: [2, 1, 3, 0] },
  { name: 'west', verts: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], uv: [0, 1, 1, 2] },
  { name: 'north', verts: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], uv: [1, 1, 2, 2] },
  { name: 'east', verts: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], uv: [2, 1, 4, 2] },
  { name: 'south', verts: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], uv: [4, 1, 5, 2] },
]

function expandBox(
  box: EntityBox,
  texW: number,
  texH: number,
  verts: number[],
  faces: RigFace[],
): void {
  let [fx, fy, fz] = box.from
  const [sx, sy, sz] = box.size
  // @constraint UV 取未膨胀尺寸，几何取膨胀后尺寸——Cube 构造里两者本来就是分开的
  const [bw, bh, bd] = box.base ?? box.size
  let tx = fx + sx
  const ty = fy + sy
  const tz = fz + sz

  if (box.mirror) {
    const swap = fx
    fx = tx
    tx = swap
  }

  const [pu, pv] = box.uv
  /**
   * u/v 序列与 Cube 构造里完全一致，共六段 u、三段 v：
   *   u0 / u1=u0+d / u2=u1+w / u22=u2+w / u3=u22+d / u4=u3+w
   * @constraint 必须有 u22 这一项。UP 面用的是 (u2, u22)：它的跨度是 **宽度**，
   *      而 u3 = u22 + depth。之前把 u3 当成 u22，顶面按深度当跨度取贴图——
   *      凡是 width ≠ depth 的盒子（绝大多数），顶面都会被横向拉伸 w/d 倍，
   *      猪的鼻梁、马的蹄子、箱子盖全是错的。
   */
  const u = [pu, pu + bd, pu + bd + bw, pu + bd + bw + bw, pu + bd + bw + bd, pu + bd + bw + bd + bw]
  const v = [pv, pv + bd, pv + bd + bh]
  const visible = box.faces && box.faces.length > 0 ? new Set(box.faces) : null

  for (const def of FACE_DEFS) {
    if (visible && !visible.has(def.name)) continue
    const [ui0, vi0, ui1, vi1] = def.uv
    const ua = u[ui0]!
    const va = v[vi0]!
    const ub = u[ui1]!
    const vb = v[vi1]!
    /**
     * @constraint 跨度为 0 的面直接丢掉，这是 vanilla 的行为而不是优化：
     *      零宽/零高盒子（翼膜、耳片、箭羽、鳍、鬃毛、船帆）里，那四个面
     *      在 Cube 里 UV 跨度就是 0，光栅化出来是零面积，什么都画不出。
     *      我们的提取把 CubeDeformation(0.001) 膨胀进了几何，这些面会变成
     *      0.002 宽的薄片，再被贴图同一列涂满——渲染成一条硬黑边，
     *      远看像模型长了刺。
     */
    if (ub === ua || vb === va) continue
    const at = verts.length / 3
    for (const pick of def.verts) {
      verts.push(pick[0] ? tx : fx, pick[1] ? ty : fy, pick[2] ? tz : fz)
    }
    // Polygon 的 remap 顺序：顶点 0..3 依次拿 (u1,v0) (u0,v0) (u0,v1) (u1,v1)
    const quad = [ub / texW, va / texH, ua / texW, va / texH, ua / texW, vb / texH, ub / texW, vb / texH]
    /**
     * @why 镜像部件要把 UV 也镜像：Cube 构造交换了 minX/maxX（位置已经镜像），
     *      纹理若还按原方向贴，左右手会各拿半条别人的胳膊。
     */
    faces.push({
      at,
      uv: box.mirror
        ? [quad[6]!, quad[7]!, quad[4]!, quad[5]!, quad[2]!, quad[3]!, quad[0]!, quad[1]!]
        : quad,
    })
  }
}

export function buildRig(model: EntityModel): Rig {
  const parts: RigPart[] = []
  for (const part of model.parts as EntityPart[]) {
    const verts: number[] = []
    const faces: RigFace[] = []
    for (const box of part.boxes) expandBox(box, model.texW, model.texH, verts, faces)
    parts.push({
      name: part.name,
      parent: part.parent ?? null,
      pivot: [part.pos[0], part.pos[1], part.pos[2]],
      rot: [part.rot[0], part.rot[1], part.rot[2]],
      scale: [part.scale?.[0] ?? 1, part.scale?.[1] ?? 1, part.scale?.[2] ?? 1],
      verts: new Float32Array(verts),
      faces,
    })
  }
  return {
    texW: model.texW,
    texH: model.texH,
    parts,
    texture: model.texture,
  }
}

/** 单个部件的姿势，角度单位是弧度 */
export interface PartPose {
  xRot: number
  yRot: number
  zRot: number
  x: number
  y: number
  z: number
  xScale: number
  yScale: number
  zScale: number
  visible: boolean
}

export function initialPose(part: RigPart): PartPose {
  return {
    xRot: part.rot[0],
    yRot: part.rot[1],
    zRot: part.rot[2],
    x: part.pivot[0],
    y: part.pivot[1],
    z: part.pivot[2],
    xScale: part.scale[0],
    yScale: part.scale[1],
    zScale: part.scale[2],
    visible: true,
  }
}

/**
 * M = R · S，R = Rz·Ry·Rx（与 ModelPart.translateAndRotate 的 mulPose 顺序一致）。
 *
 * @why 缩放必须夹在旋转里，不能独立乘到世界的 xyz 上：poseStack 是先 translate、
 *      再 rotate、最后 scale，顶点享受的是「先缩放、再旋转、再平移」。
 *      把 scale 当平移后的轴对齐缩放，猫的斜身子会被压成歪的。
 */
function matrix(pose: PartPose): number[] {
  const { xRot: rx, yRot: ry, zRot: rz } = pose
  const cx = Math.cos(rx)
  const sx = Math.sin(rx)
  const cy = Math.cos(ry)
  const sy = Math.sin(ry)
  const cz = Math.cos(rz)
  const sz = Math.sin(rz)

  // Rx
  // [1 0 0; 0 cx -sx; 0 sx cx]
  // Ry
  // [cy 0 sy; 0 1 0; -sy 0 cy]
  // Rz
  // [cz -sz 0; sz cz 0; 0 0 1]
  const a = cz * cy
  const b = cz * sy * sx - sz * cx
  const c = cz * sy * cx + sz * sx
  const d = sz * cy
  const e = sz * sy * sx + cz * cx
  const f = sz * sy * cx - cz * sx
  const g = -sy
  const h = cy * sx
  const i = cy * cx
  const kx = pose.xScale
  const ky = pose.yScale
  const kz = pose.zScale
  return [a * kx, b * ky, c * kz, d * kx, e * ky, f * kz, g * kx, h * ky, i * kz]
}

/**
 * out = parent ∘ local：先套用 local，再套用 parent。
 * 旋转直接相乘，平移要先被父级旋转再叠加父级平移。
 */
function compose(
  parent: { m: number[]; t: number[] },
  local: { m: number[]; t: number[] },
): { m: number[]; t: number[] } {
  const a = parent.m
  const b = local.m
  const t = local.t
  return {
    m: [
      a[0]! * b[0]! + a[1]! * b[3]! + a[2]! * b[6]!,
      a[0]! * b[1]! + a[1]! * b[4]! + a[2]! * b[7]!,
      a[0]! * b[2]! + a[1]! * b[5]! + a[2]! * b[8]!,
      a[3]! * b[0]! + a[4]! * b[3]! + a[5]! * b[6]!,
      a[3]! * b[1]! + a[4]! * b[4]! + a[5]! * b[7]!,
      a[3]! * b[2]! + a[4]! * b[5]! + a[5]! * b[8]!,
      a[6]! * b[0]! + a[7]! * b[3]! + a[8]! * b[6]!,
      a[6]! * b[1]! + a[7]! * b[4]! + a[8]! * b[7]!,
      a[6]! * b[2]! + a[7]! * b[5]! + a[8]! * b[8]!,
    ],
    t: [
      a[0]! * t[0]! + a[1]! * t[1]! + a[2]! * t[2]! + parent.t[0]!,
      a[3]! * t[0]! + a[4]! * t[1]! + a[5]! * t[2]! + parent.t[1]!,
      a[6]! * t[0]! + a[7]! * t[1]! + a[8]! * t[2]! + parent.t[2]!,
    ],
  }
}

/**
 * 按当前姿势把骨骼展开成可投影的面。
 *
 * @why 必须按父链乘矩阵，而不是每个部件各自「旋转 + 平移」。游戏里 ModelPart 是树：
 *      子部件的 pivot 相对父部件，父部件一转，子部件整枝跟着转。之前把位置拍平成
 *      绝对坐标，父级旋转就丢了——狼的头挂在会转的身体上，头会离位；猫的两级尾巴
 *      直接断开；蜘蛛两段腿折成一根。
 *
 * @constraint 每帧都重建：一只生物几十个面，比维护增量缓存省心，
 *             也不会出现姿势和几何不同步的鬼影。
 *
 * @param style 图层样式：羊毛/项圈要乘染料色（tint），眼睛层不吃方向光照（unlit），
 *        叠加层要给一个极小的深度偏置（bias）才能压在本体表面而不是和它打架。
 */
export function rigFaces(
  rig: Rig,
  poses: Map<string, PartPose>,
  texture: string,
  style?: LayerStyle,
): Face3D[] {
  const byName = new Map<string, RigPart>()
  for (const part of rig.parts) byName.set(part.name, part)

  /** 3×3 旋转 + 平移，部件自己的局部变换 */
  const transforms = new Map<string, { m: number[]; t: number[] }>()

  const resolve = (part: RigPart, depth: number): { m: number[]; t: number[] } => {
    const hit = transforms.get(part.name)
    if (hit) return hit
    const pose = poses.get(part.name) ?? initialPose(part)
    const local = { m: matrix(pose), t: [pose.x, pose.y, pose.z] }
    const parent = part.parent ? byName.get(part.parent) : null
    const out = parent && depth < 16 ? compose(resolve(parent, depth + 1), local) : local
    transforms.set(part.name, out)
    return out
  }

  const visible = (part: RigPart, depth: number, seen: Set<string>): boolean => {
    if (depth > 16 || seen.has(part.name)) return true
    seen.add(part.name)
    const pose = poses.get(part.name)
    if (pose && !pose.visible) return false
    const parent = part.parent ? byName.get(part.parent) : null
    return parent ? visible(parent, depth + 1, seen) : true
  }

  const faces: Face3D[] = []
  for (const part of rig.parts) {
    if (!visible(part, 0, new Set())) continue
    const { m, t } = resolve(part, 0)
    const n = part.verts.length / 3

    // 顶点先经父链旋转，再平移，最后 y 取负转成 y 向上
    const world = new Float32Array(n * 3)
    for (let i = 0; i < n; i += 1) {
      const vx = part.verts[i * 3]!
      const vy = part.verts[i * 3 + 1]!
      const vz = part.verts[i * 3 + 2]!
      world[i * 3] = m[0]! * vx + m[1]! * vy + m[2]! * vz + t[0]!
      world[i * 3 + 1] = -(m[3]! * vx + m[4]! * vy + m[5]! * vz + t[1]!)
      world[i * 3 + 2] = m[6]! * vx + m[7]! * vy + m[8]! * vz + t[2]!
    }

    for (const face of part.faces) {
      faces.push({
        pts: [
          world[face.at * 3]!,
          world[face.at * 3 + 1]!,
          world[face.at * 3 + 2]!,
          world[face.at * 3 + 3]!,
          world[face.at * 3 + 4]!,
          world[face.at * 3 + 5]!,
          world[face.at * 3 + 6]!,
          world[face.at * 3 + 7]!,
          world[face.at * 3 + 8]!,
          world[face.at * 3 + 9]!,
          world[face.at * 3 + 10]!,
          world[face.at * 3 + 11]!,
        ],
        uv: face.uv,
        tex: texture,
        shade: style?.unlit ? false : true,
        tint: style?.tint,
        bias: style?.bias,
        unlit: style?.unlit,
      })
    }
  }
  return faces
}

/** 叠加层的绘制参数 */
export interface LayerStyle {
  /** 乘数着色（羊毛、项圈的染料色） */
  tint?: [number, number, number]
  /** 不吃方向光照：眼睛、发光层在游戏里是满亮渲染 */
  unlit?: boolean
  /** 相机空间深度偏置（格）。叠加层要和本体区分开，否则共面打架 */
  bias?: number
}

/** 一层贴图 + 几何。rig 为 null 表示复用本体几何（眼睛层就是这样） */
export interface EntityLayer {
  rig: Rig | null
  texture: string
  /** 图层类名，UI 里用来配对"花纹"下拉框 */
  cls: string
  tint?: [number, number, number]
  unlit?: boolean
}

/** 叠加层的深度偏置：一格的千分之四，足够压过共面又不会穿过薄片 */
const LAYER_BIAS = 0.004

/**
 * 本体 + 全部图层展开成一串面。
 *
 * @why 一次光栅化画完所有层：软件光栅化器有真 z-buffer，图层只要给一点深度偏置
 *      就能正确压在本体表面；分成多趟光栅化再合成，反而会让叠加层无视前后关系
 *      （羊毛盖住探出来的头）。
 */
export function entityFaces(
  rig: Rig,
  poses: Map<string, PartPose>,
  texture: string,
  layers?: EntityLayer[] | null,
): Face3D[] {
  const faces = rigFaces(rig, poses, texture)
  if (!layers || layers.length === 0) return faces
  /**
   * @constraint 每一层的偏置必须递增。羊毛有底绒和外套两层、它们的几何几乎重合，
   *      给同一个偏置会让两层在同一个深度上打架，画出来是一片斑驳。
   */
  let step = 1
  for (const layer of layers) {
    const extra = rigFaces(layer.rig ?? rig, poses, layer.texture, {
      tint: layer.tint,
      unlit: layer.unlit,
      bias: LAYER_BIAS * step,
    })
    step += 1
    for (const face of extra) faces.push(face)
  }
  return faces
}
