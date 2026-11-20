/**
 * 群系着色表：资源包里草、树叶、水是灰度图，颜色由代码乘上去。
 *
 * @why 单独一个文件，因为三条渲染路径都要用：方块缩略图（`faceBuild`）、
 *      结构体素（`render/world/mesher`）、导出。之前 mesher 里只有一份
 *      「树叶绿」的常量，于是结构里的水被染成绿色、冰被染成绿色——
 *      同一个 tintindex 在不同页面出不同颜色，看起来像渲染 bug。
 *
 * @constraint 索引对应模型 JSON 的 `tintindex`，不是方块 id。
 *      0 草、1 树叶（略深一档，原版就是这么分的）、2/3 水。
 */
export const TINTS: Record<number, [number, number, number]> = {
  /** 草地：平原 0x91BD59 */
  0: [0.568, 0.741, 0.349],
  /** 树叶（桦木/云杉等固定色）*/
  1: [0.467, 0.671, 0.278],
  /** 水：0x3F76E4 */
  2: [0.247, 0.463, 0.894],
  3: [0.247, 0.463, 0.894],
}

/** 取某个 tintindex 的颜色；没有对应项时返回 null（不染色） */
export function tintOf(index: number): [number, number, number] | null {
  if (index < 0) return null
  return TINTS[index] ?? null
}
