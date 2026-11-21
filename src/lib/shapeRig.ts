/**
 * 没有骨骼的实体：用渲染器实际绘制的东西凑出可渲染的几何。
 *
 * @why 有一类实体在原版里根本没有 ModelPart 树——掉落物、TNT、投掷药水、
 *      经验球。它们的几何是在渲染器里现拼的：`BlockRenderDispatcher.renderSingleBlock`
 *      画一个方块、`ItemStackRenderState` 画一件物品、或者干脆贴一张 billboard。
 *      之前这些实体在站上只显示一张物品图标，点开弹窗还写着"没有骨骼模型"，
 *      看起来像整类功能坏了。
 *
 * @constraint 结果要转成 `Rig`，而不是新开一条渲染路径。骨架、图层、导出、
 *      GLB 都挂在 Rig 上，多一条路径就多一套要维护的坐标系。
 */
import { loadBakeShard, loadBlockModels, type BakedFace } from './blockmodels'
import type { Face3D } from './scene'
import type { Rig, RigFace } from './entityRig'
import { blockFaces } from './faceBuild'

export interface EntityShape {
  /** block = 方块模型，item = 物品模型（已挤出厚度），sprite = 单张 billboard */
  k: 'block' | 'item' | 'sprite'
  /** 方块 / 物品 id，或纹理路径（sprite） */
  id: string
  /**
   * sprite 在贴图里的子矩形 [u0, v0, u1, v1]，缺省用整张。
   *
   * @why 经验球的贴图是 4×4 的图集（64×64 里放 16 个 16×16 图标），
   *      整张画出来会变成"一格贴图里九个球"。
   */
  uv?: [number, number, number, number]
  /** sprite 的世界尺寸（格），缺省 1 */
  s?: number
  /**
   * 乘数着色。药水贴图本身是灰度的，颜色来自药水数据里的 RGB；
   * 不染的话三种药水在站上都是同一只灰瓶子。
   */
  tint?: [number, number, number]
}

/** sprite 的默认边长：原版投射物贴图都是 16×16，按 1 格渲染 */
const SPRITE_SIZE = 16

/**
 * 一张正对 +z 的四边形。
 *
 * @constraint 不要给它补一张反向的背面：渲染管线本来就双面渲染，
 *      两张共面的四边形只会互相打架，远看是一层斑。
 */
function spriteFaces(tex: string, shape: EntityShape): Face3D[] {
  const half = (SPRITE_SIZE * (shape.s ?? 1)) / 2
  const [u0, v0, u1, v1] = shape.uv ?? [0, 0, 1, 1]
  return [
    {
      pts: [-half, -half, 0, half, -half, 0, half, half, 0, -half, half, 0],
      uv: [u0, v1, u1, v1, u1, v0, u0, v0],
      tex,
      // @why 原版这些 billboard 都是 entityTranslucentEmissive 一类，
      //      按普通面吃方向光会变成一块灰板
      shade: false,
      unlit: true,
    },
  ]
}

/**
 * 取一个形状的静态面。
 *
 * @constraint 方块与物品都走打过包的 `BakedFace`，不要在这里重新解析 models/*.json：
 *      方块模型的继承、旋转、UV 锁定规则全在打包阶段算过一次了。
 */
export async function shapeFaces(shape: EntityShape, version: string): Promise<Face3D[]> {
  if (shape.k === 'sprite') return spriteFaces(shape.id, shape)

  const models = await loadBlockModels(version)
  const kind = shape.k === 'block' ? 'blocks' : 'items'
  const ids = shape.k === 'block' ? models.blockIds : models.itemIds
  const index = ids.indexOf(shape.id)
  if (index < 0) return []
  const shard = Math.floor(index / models.shardSize)
  const data = await loadBakeShard(version, kind, shard)
  const faces: BakedFace[] | undefined = data[shape.id]
  if (!faces || faces.length === 0) return []
  const out = blockFaces(faces, models.textures, models.anims, 0, models.alpha)
  if (shape.tint) for (const face of out) face.tint = shape.tint
  return out
}

/** 顶点数上限：方块模型最多几十个面，给一倍余量 */
function rigFaceOf(faces: Face3D[]): { verts: Float32Array; faces: RigFace[] } {
  const verts: number[] = []
  const out: RigFace[] = []
  for (const face of faces) {
    const at = verts.length / 3
    for (let i = 0; i < 4; i += 1) {
      // @constraint y 要按 ModelPart 的约定存成「向下」：rigFaces 出去时会按 flipY
      //      取负，一来一回才是原来的 y 向上。
      verts.push(face.pts[i * 3]!, -face.pts[i * 3 + 1]!, face.pts[i * 3 + 2]!)
    }
    out.push({ at, uv: face.uv, tex: face.tex })
  }
  return { verts: new Float32Array(verts), faces: out }
}

/**
 * 静态面 → 只有一个根部件的骨架。
 *
 * @why 每个面自带纹理（TNT 的顶/侧/底是三张图），所以 RigFace 需要 tex 覆盖；
 *      拆成图层反而会让每个图层把所有面重画一遍。
 */
export function rigFromFaces(faces: Face3D[], fallbackTexture: string): Rig | null {
  if (faces.length === 0) return null
  const { verts, faces: refs } = rigFaceOf(faces)
  return {
    texW: SPRITE_SIZE,
    texH: SPRITE_SIZE,
    parts: [
      {
        name: 'root',
        parent: null,
        index: 0,
        parentIndex: -1,
        pivot: [0, 0, 0],
        rot: [0, 0, 0],
        scale: [1, 1, 1],
        verts,
        faces: refs,
      },
    ],
    texture: faces[0]?.tex ?? fallbackTexture,
    /**
     * @constraint 必须为 true。顶点在 rigFaceOf 里已经翻成「y 向下」存进部件空间，
     *      rigFaces 出去时再翻回来，一来一回才是原来的 y 向上。
     *      设成 false 会少翻一次，方块整体上下颠倒（顶面贴到底面），
     *      侧面文字也跟着镜像。
     */
    flipY: true,
  }
}

export async function loadShapeRig(shape: EntityShape, version: string): Promise<Rig | null> {
  const faces = await shapeFaces(shape, version)
  return rigFromFaces(faces, shape.k === 'sprite' ? shape.id : shape.id)
}
