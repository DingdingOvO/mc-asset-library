/**
 * OBJ / STL 导出。
 *
 * @why 这两个格式存在的意义不是"再来两个格式"，而是覆盖 glTF 覆盖不到的人：
 *      OBJ 是唯一被所有 DCC 与游戏引擎无脑吃下的交换格式（贴图靠 MTL），
 *      STL 是 3D 打印的通用语言（只有三角形，没有贴图也没有骨骼）。
 *      两者都没有动画通道，姿势只能定格——要动作就用 GLB。
 */
import type { GeoGroup } from './gltf'

export interface ObjResult {
  obj: string
  mtl: string
  /** 需要一起打包的贴图（name 是包内相对路径） */
  textures: { name: string; tex: string }[]
}

/** 贴图在包内的文件名：纹理 id 里的斜杠压成下划线，免得建目录 */
export function textureFile(tex: string): string {
  return `textures/${tex.replace(/\//g, '_')}.png`
}

export function buildObj(groups: GeoGroup[], baseName: string): ObjResult {
  const lines: string[] = [
    `# ${baseName} — 由 MC 素材库导出`,
    `# 1 单位 = 1 格方块，y 轴向上，模型底面贴在 y=0`,
    `mtllib ${baseName}.mtl`,
  ]
  const mtlLines: string[] = [`# ${baseName}`]
  const textures: { name: string; tex: string }[] = []

  // OBJ 的顶点下标是全局的、从 1 开始，跨 material 也要接着数
  let vertexBase = 1
  let uvBase = 1
  let normalBase = 1

  groups.forEach((group, index) => {
    const material = `mat_${index}`
    const file = textureFile(group.tex)
    textures.push({ name: file, tex: group.tex })

    mtlLines.push(
      '',
      `newmtl ${material}`,
      'Kd 1.000 1.000 1.000',
      'Ka 0.000 0.000 0.000',
      'Ks 0.000 0.000 0.000',
      'd 1.0',
      'illum 1',
      // MC 是像素画，线性过滤会把边缘糊成灰边
      `map_Kd ${file}`,
    )

    lines.push('', `usemtl ${material}`, `# ${group.tex}`)

    const count = group.positions.length / 3
    for (let i = 0; i < count; i += 1) {
      lines.push(
        `v ${group.positions[i * 3]!.toFixed(5)} ${group.positions[i * 3 + 1]!.toFixed(5)} ${group.positions[i * 3 + 2]!.toFixed(5)}`,
      )
    }
    for (let i = 0; i < count; i += 1) {
      // @constraint OBJ 的 v 轴朝上，glTF 的 uv 原点在左上角，这里要翻一次，
      //              否则贴图在 Blender 里是上下颠倒的
      lines.push(`vt ${group.uvs[i * 2]!.toFixed(5)} ${(1 - group.uvs[i * 2 + 1]!).toFixed(5)}`)
    }
    for (let i = 0; i < count; i += 1) {
      lines.push(
        `vn ${group.normals[i * 3]!.toFixed(4)} ${group.normals[i * 3 + 1]!.toFixed(4)} ${group.normals[i * 3 + 2]!.toFixed(4)}`,
      )
    }

    for (let i = 0; i < group.indices.length; i += 3) {
      const a = group.indices[i]! + 1
      const b = group.indices[i + 1]! + 1
      const c = group.indices[i + 2]! + 1
      const face = (n: number) =>
        `${vertexBase + n - 1}/${uvBase + n - 1}/${normalBase + n - 1}`
      lines.push(`f ${face(a)} ${face(b)} ${face(c)}`)
    }

    vertexBase += count
    uvBase += count
    normalBase += count
  })

  return { obj: `${lines.join('\n')}\n`, mtl: `${mtlLines.join('\n')}\n`, textures }
}

/**
 * 二进制 STL。
 * @constraint 三角面必须共面且有正确朝外的法线，3D 打印切片才认；这里直接用
 *              面法线（MC 的每个面都是平的），不做重算。
 */
export function buildStl(groups: GeoGroup[], name: string): Uint8Array {
  let triangles = 0
  for (const group of groups) triangles += group.indices.length / 3

  const size = 84 + triangles * 50
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)

  const header = `MC assets — ${name}`.slice(0, 79)
  for (let i = 0; i < header.length; i += 1) out[i] = header.charCodeAt(i)

  view.setUint32(80, triangles, true)

  let at = 84
  for (const group of groups) {
    for (let i = 0; i < group.indices.length; i += 3) {
      const ids = [group.indices[i]!, group.indices[i + 1]!, group.indices[i + 2]!]
      const first = ids[0]!
      // 三角面取第一个顶点的法线：同一个面四个顶点法线相同
      for (let axis = 0; axis < 3; axis += 1) {
        view.setFloat32(at + axis * 4, group.normals[first * 3 + axis]!, true)
      }
      at += 12
      for (const id of ids) {
        for (let axis = 0; axis < 3; axis += 1) {
          view.setFloat32(at + axis * 4, group.positions[id * 3 + axis]!, true)
        }
        at += 12
      }
      view.setUint16(at, 0, true)
      at += 2
    }
  }

  return out
}
