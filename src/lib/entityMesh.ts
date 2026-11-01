/**
 * 实体模型文件：反编译提取的 box 几何。
 *
 * @why 实体模型硬编码在游戏的 *Model.java 里（addBox + texOffs），资源包只有贴图。
 *      几何由 scripts/extract-entities.py 从反编译源码里挖出来，
 *      部件层级与枢轴一并保留，entityRig.ts 再按每帧的姿势展开。
 */
import { MC_BASE } from './mc'

export interface EntityBox {
  uv: [number, number]
  /** 几何范围：已经含 CubeDeformation 的膨胀量 */
  from: [number, number, number]
  /** 几何尺寸：已经含 CubeDeformation 的膨胀量 */
  size: [number, number, number]
  /**
   * 未膨胀尺寸（addBox 里写的那个 width/height/depth）。
   * @why UV 必须用它：Cube 构造里 u1 = u0 + depth 取的是参数 depth，
   *      膨胀量只作用在 min/max 上。零宽盒子（龙翼、箭羽、耳朵、鳍这类
   *      平板 addBox(..., 0, ...)）的上下前后四面 UV 跨度为 0，vanilla 里
   *      根本画不出像素；若按膨胀后的 0.002 算，就成了一条采样贴图同一列的黑边。
   */
  base?: [number, number, number]
  mirror: boolean
  /** 只渲染这些面（ModelPart.Cube 的 visibleFaces），缺省是全部六面 */
  faces?: string[]
}

export interface EntityPart {
  name: string
  /** 父部件名；null 表示挂在 root 上。坐标与旋转都相对父部件 */
  parent?: string | null
  pos: [number, number, number]
  rot: [number, number, number]
  /**
   * PartPose 的 xScale/yScale/zScale。
   * @why 猫（0.8）、恶魂（4.5）、洞穴蜘蛛（0.7）这些整体缩放全在 MeshTransformer
   *      里，落在 root 部件的 scale 上，靠 poseStack 向下继承。丢掉它，
   *      猫会顶着一只放大的头和一双没放大的腿。
   */
  scale?: [number, number, number]
  boxes: EntityBox[]
}

export interface EntityModel {
  texW: number
  texH: number
  texture: string | null
  parts: EntityPart[]
}

export interface EntityModelFile {
  models: Record<string, EntityModel>
  /** 模型类名（snake）→ 模型键。renderer 只给类名，得靠它回落到图层名 */
  byClass?: Record<string, string>
  /**
   * 图层键（bakeLayer 里的那个）→ 模型键。
   * @why 渲染器给的是 ModelLayers 的注册路径，形状不止一种：
   *      船的 'boat/oak'、鞍具的 'camel:saddle'、普通生物的 'pig'。
   *      对不上这张表就得靠猜，20 多条船/鞍具会全部空白。
   */
  byLayer?: Record<string, string>
}

const cache = new Map<string, Promise<EntityModelFile>>()

export function loadEntityModels(version: string): Promise<EntityModelFile> {
  const hit = cache.get(version)
  if (hit) return hit
  const task = (async () => {
    // @why 带格式版本：几何改为按 LayerDefinitions 的真实 bake 路径提取
    //      （含 scale / visibleFaces / 正确的 material 尺寸）。缓存了旧 JSON 的话
    //      UV 归一化尺寸是错的，整只生物会碎成几块。
    const response = await fetch(`${MC_BASE}/${version}/entitymodels.json?v=9`)
    if (!response.ok) throw new Error(`实体模型加载失败：${response.status}`)
    return (await response.json()) as EntityModelFile
  })()
  cache.set(version, task)
  return task
}

/**
 * 实体模型文件的加载与类型。
 * 骨骼展开见 entityRig.ts：几何保留在部件局部坐标里，每帧按姿势重新变换。
 */
