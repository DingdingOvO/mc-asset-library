/**
 * 建筑结构页：原版 1511 个 `.nbt` 结构的立体预览。
 *
 * @why 单独开一页而不是塞进「方块」：结构是「多个方块的组合」，价值在于整体形态
 *      （村庄的街道、要塞的走廊、沉船的舱室），逐个方块看没有意义。
 *      这一页同时是 `world/` 数据层 + `render/world` 网格层的端到端验证。
 *
 * @constraint 结构必须铺在一块地形上预览。原版结构文件只存建筑本身，
 *      悬空显示会让"一层薄墙"看起来像一堆散落的方块；铺上草地之后，
 *      高度关系、门窗位置立刻能读出来。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { hasWebGl, modelPipeline } from '@/render'
import { buildVoxelBatches, type VoxelBatch } from '@/render/world/mesher'
import { createVolume, getBlock, setBlock } from '@/lib/world/terrain'
import { rasterize, type StructureTemplate } from '@/lib/world/structure'
import { loadStructure, loadStructureIndex } from '@/lib/world/structureStore'
import { loadGeometry, texturesOf } from '@/lib/world/geometry'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import type { BlockVolume } from '@/lib/world/terrain'

/** 地形铺法：从上到下。草地 1 层、泥土 2 层、石头打底 */
const GROUND_LAYERS: { state: string; height: number }[] = [
  { state: 'minecraft:grass_block[snowy=false]', height: 1 },
  { state: 'minecraft:dirt', height: 2 },
  { state: 'minecraft:stone', height: 1 },
]

/**
 * 结构四周留的空地（格）。
 *
 * @constraint 不能取固定值。取 3 时，7×7 的小营地体积被撑到 13×13，
 *      而取景是按实心包围盒算的（草地平台也是实心），于是帐篷只占
 *      画面一半，四周全是空草地。取景要跟着结构尺寸走才合理：
 *      小结构留 1 格够看出"地面"，大结构留 3 格才不会让边缘贴住画布。
 */
function paddingFor(width: number, depth: number): number {
  return Math.min(3, Math.max(1, Math.round(Math.max(width, depth) * 0.04)))
}
/** 地面顶面往上留的净空（格），够放高塔 */
const HEADROOM = 12
/** 地面总厚度（格） */
const GROUND_DEPTH = GROUND_LAYERS.reduce((sum, layer) => sum + layer.height, 0)

/**
 * 把结构放进一块带地形的体积里。
 *
 * @constraint 结构底面必须正好压在草地表面，不能浮空也不能陷进去。
 *      差一格的表现是"房子陷进地里一截"或"整栋楼悬在半空"，
 *      而且阴影是实时算的，看起来会像渲染出错。
 */
function composeVolume(template: StructureTemplate): BlockVolume {
  const [tw, th, td] = template.size
  const padding = paddingFor(tw, td)
  const size: [number, number, number] = [tw + padding * 2, th + HEADROOM + GROUND_DEPTH, td + padding * 2]
  const ground = createVolume(size)

  /**
   * @constraint 地形必须只填**底部**几层，不能调用 `flatVolume`。
   *      那个函数是从体积顶端往下铺的，用来做"整个世界都是地形"的场景；
   *      这里要的是"地上一片空地"，直接用它会把整个体积填实，
   *      预览出来是一个盖住一切的黑色大立方体。
   */
  let level = GROUND_DEPTH - 1
  for (const layer of GROUND_LAYERS) {
    for (let i = 0; i < layer.height && level >= 0; i += 1, level -= 1) {
      for (let z = 0; z < size[2]; z += 1) {
        for (let x = 0; x < size[0]; x += 1) {
          setBlock(ground, x, level, z, layer.state)
        }
      }
    }
  }

  const voxel = rasterize(template)
  // 草地占最上面那一格，结构从这里往上放
  const baseY = GROUND_DEPTH

  for (let y = 0; y < voxel.size[1]; y += 1) {
    for (let z = 0; z < voxel.size[2]; z += 1) {
      for (let x = 0; x < voxel.size[0]; x += 1) {
        const source = voxel.data[(y * voxel.size[2] + z) * voxel.size[0] + x] ?? 0
        const targetY = baseY + y
        if (targetY < 0 || targetY >= size[1]) continue
        if (source === 0) {
          // @constraint 结构内部标成空气的格子要显式清掉，否则地形会从下面
          //      灌进地下室和门洞里，房子像被土埋了半截
          if (targetY >= baseY) {
            const existing = getBlock(ground, x + padding, targetY, z + padding)
            if (existing.name !== 'minecraft:air') {
              setBlock(ground, x + padding, targetY, z + padding, 'minecraft:air')
            }
          }
          continue
        }
        const state = voxel.palette[source]
        if (state) setBlock(ground, x + padding, targetY, z + padding, state)
      }
    }
  }

  return ground
}

/** 体积里出现过的方块 id */
function blockIdsOf(volume: BlockVolume): string[] {
  const ids = new Set<string>()
  for (let i = 0; i < volume.data.length; i += 1) {
    const index = volume.data[i]!
    if (index === 0) continue
    const state = volume.palette[index]
    if (state) ids.add(state.name)
  }
  return [...ids]
}

/**
 * 实心方块的包围盒（体积坐标，max 为开区间）。
 *
 * @why 取景必须按内容算，不能按体积算。体积为了容纳高塔预留了 12 格净空，
 *      按体积取中点会把枢轴抬到建筑上方——画面里建筑整体沉到下半区；
 *      按体积算跨度又会把净空算进去，小帐篷缩成画面三分之一。
 * @constraint 不跳过空气的话包围盒恒等于体积，等于没算。
 */
function contentBounds(volume: BlockVolume): { min: [number, number, number]; max: [number, number, number] } {
  const [sx, sy, sz] = volume.size
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity

  for (let y = 0; y < sy; y += 1) {
    for (let z = 0; z < sz; z += 1) {
      for (let x = 0; x < sx; x += 1) {
        if ((volume.data[(y * sz + z) * sx + x] ?? 0) === 0) continue
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (z < minZ) minZ = z
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (z > maxZ) maxZ = z
      }
    }
  }

  // 空体积（结构文件只有空气）退化成整块，至少不会出现 Infinity 传进矩阵
  if (minX === Infinity) return { min: [0, 0, 0], max: volume.size }
  return { min: [minX, minY, minZ], max: [maxX + 1, maxY + 1, maxZ + 1] }
}

export function Structures() {
  const { version, loading, error } = useLibrary()
  const index = useAsync(`structures:${version ?? ''}`, () =>
    version ? loadStructureIndex(version) : Promise.reject(new Error('版本未就绪')),
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)

  const files = index.data?.files ?? []
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.path.toLowerCase().includes(needle) || file.name.includes(needle))
  }, [files, query])

  useEffect(() => {
    if (!selected && files.length > 0) setSelected(files[0]!.path)
  }, [files, selected])

  if (loading) return <p className="empty">正在读取版本清单…</p>
  if (error || !version) return <p className="empty">版本清单加载失败</p>

  return (
    <div className="page">
      <header className="page-head">
        <p className="page-head__crumb">MC 素材库 / 结构</p>
        <h1 className="page-head__title">结构</h1>
        <p className="page-head__note">
          {index.data
            ? `${index.data.count} 个原版结构 · 按 .nbt 逐格还原，铺地形预览`
            : '正在读取结构索引…'}
        </p>
      </header>

      <div className="browse-bar">
        <input
          className="browse-bar__input"
          type="search"
          placeholder="搜索结构，比如 village / shipwreck / fortress"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="browse-bar__count">{filtered.length} 项</span>
      </div>

      <div className="struct">
        <ul className="struct__list">
          {filtered.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={`struct__item${file.path === selected ? ' struct__item--on' : ''}`}
                onClick={() => setSelected(file.path)}
                title={file.path}
              >
                <span className="struct__name">{file.name || file.path.split('/').pop()}</span>
                <span className="struct__meta">
                  {file.group} · {(file.bytes / 1024).toFixed(1)} KB
                </span>
              </button>
            </li>
          ))}
        </ul>

        <StructurePreview path={selected} version={version} />
      </div>
    </div>
  )
}

interface PreviewProps {
  path: string | null
  version: string
}

interface Prepared {
  batches: VoxelBatch[]
  span: number
  /** 转台枢轴（体积坐标），取内容包围盒中心 */
  pivot: [number, number, number]
}

function StructurePreview({ path, version }: PreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState('准备中…')
  const [pose, setPose] = useState({ rotX: 22, rotY: 40, zoom: 1 })
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  /** 绘制缓冲边长（物理像素）。按容器实测尺寸 × DPR 算，写死会在高分屏上糊 */
  const [size, setSize] = useState(768)

  const template = useAsync(`${version}|${path ?? ''}`, () =>
    path ? loadStructure(version, path) : Promise.resolve(null),
  )

  const scene = useMemo(() => (template.data ? composeVolume(template.data) : null), [template.data])
  const ids = useMemo(() => (scene ? blockIdsOf(scene) : []), [scene])

  /**
   * 绘制缓冲跟随容器。
   * @constraint 不能只在挂载时量一次：侧栏是 grid 里的一列，窗口缩放、
   *      字体加载完成都会改它的宽度，量一次之后 canvas 会一直停在旧尺寸上。
   *      DPR 上限取 2——结构动辄几千个三角形，3 倍屏再乘 9 倍像素不值。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const apply = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const next = Math.max(240, Math.round(Math.min(rect.width, rect.height || rect.width) * dpr))
      if (next === canvas.width) return
      canvas.width = next
      canvas.height = next
      setSize(next)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  // 一：装配网格（只在场景变化时跑一次）
  useEffect(() => {
    if (!scene) {
      setPrepared(null)
      return
    }
    if (!hasWebGl()) {
      setStatus('这个浏览器不支持 WebGL2，结构预览需要它')
      return
    }
    let alive = true
    setStatus('装配方块…')
    setPrepared(null)
    void (async () => {
      const { geometry, models } = await loadGeometry(version, ids)
      const batches = buildVoxelBatches(scene, geometry)
      await modelPipeline().prepareTextures(texturesOf(ids, models), version)
      if (!alive) return
      const { min, max } = contentBounds(scene)
      const dx = max[0] - min[0]
      const dy = max[1] - min[1]
      const dz = max[2] - min[2]
      /**
       * @constraint 取景跨度不能用三维对角线。对角线算的是「从角到角」，
       *      而屏幕上看到的是投影：一栋 13×23×13 的塔对角线 29 格，
       *      投影出来只有 20 格出头。用对角线会让建筑只占画面四分之一，
       *      四周留一大圈空白。取「水平对角线」与「高度」的较大者才贴近
       *      实际投影范围。
       */
      setPrepared({
        batches,
        span: Math.max(Math.hypot(dx, dz), dy) * 1.05,
        pivot: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      })
      const triangles = batches.reduce((n, batch) => n + batch.vertexCount / 3, 0)
      setStatus(`${batches.length} 张贴图 · ${Math.round(triangles).toLocaleString()} 个三角形`)
    })().catch((failure: unknown) => {
      if (alive) setStatus(`装配失败：${failure instanceof Error ? failure.message : String(failure)}`)
    })
    return () => {
      alive = false
    }
  }, [scene, ids, version])

  // 二：渲染（姿态、网格或画布尺寸变化都重画）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !prepared) return
    modelPipeline().renderWorld(
      canvas,
      /**
       * @constraint 键里不能带画布尺寸。改了尺寸只是换个 viewport，网格本身
       *      一格没动；带上尺寸会让每次窗口缩放都重新上传一遍全部顶点。
       */
      `${path}|${prepared.batches.reduce((n, batch) => n + batch.vertexCount, 0)}`,
      prepared.batches,
      {
        size,
        rotX: pose.rotX,
        rotY: pose.rotY,
        pivot: prepared.pivot,
        fit: 'auto',
        span: prepared.span,
        zoom: pose.zoom,
        // @constraint 体素坐标单位是格，不是模型的 16 单位。忘了传会让
        //      32 格宽的城堡渲染成 2 格高的小方块。
        unitsPerBlock: 1,
      },
      version,
    )
  }, [prepared, pose, path, version, size])

  // 拖拽旋转
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let dragging = false
    let last = { x: 0, y: 0 }

    const down = (event: PointerEvent) => {
      dragging = true
      last = { x: event.clientX, y: event.clientY }
      canvas.setPointerCapture(event.pointerId)
    }
    const move = (event: PointerEvent) => {
      if (!dragging) return
      const dx = event.clientX - last.x
      const dy = event.clientY - last.y
      last = { x: event.clientX, y: event.clientY }
      setPose((current) => ({
        ...current,
        rotY: current.rotY + dx * 0.4,
        rotX: Math.max(-85, Math.min(85, current.rotX + dy * 0.3)),
      }))
    }
    const up = (event: PointerEvent) => {
      dragging = false
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    }
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      setPose((current) => ({
        ...current,
        zoom: Math.max(0.4, Math.min(3, current.zoom * Math.exp(-event.deltaY * 0.0012))),
      }))
    }

    canvas.addEventListener('pointerdown', down)
    canvas.addEventListener('pointermove', move)
    canvas.addEventListener('pointerup', up)
    canvas.addEventListener('pointercancel', up)
    canvas.addEventListener('wheel', wheel, { passive: false })
    return () => {
      canvas.removeEventListener('pointerdown', down)
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', up)
      canvas.removeEventListener('wheel', wheel)
    }
  }, [])

  return (
    <div className="struct__stage">
      <canvas ref={canvasRef} className="struct__canvas" width={size} height={size} />
      <p className="struct__status">{template.loading ? '读取结构文件…' : status}</p>
    </div>
  )
}
