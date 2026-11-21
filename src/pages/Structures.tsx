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
import { useSearchParams } from 'react-router-dom'
import { hasWebGl, modelPipeline } from '@/render'
import { buildVoxelBatches, type VoxelBatch } from '@/render/world/mesher'
import { paintVoxelsCpu } from '@/render/world/cpuPaint'
import { createVolume, getBlock, setBlock } from '@/lib/world/terrain'
import { INVISIBLE_BLOCKS, rasterize, type StructureTemplate } from '@/lib/world/structure'
import { loadStructure, loadStructureIndex } from '@/lib/world/structureStore'
import { loadGeometry, texturesOf } from '@/lib/world/geometry'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import type { BlockVolume } from '@/lib/world/terrain'
import { currentDpr, watchDpr } from '@/lib/dpr'
import { runTarget, suggestName, targetsFor } from '@/lib/export/registry'
import { saveBlob } from '@/lib/export/types'
import type { StructureSubject } from '@/lib/export/structure'

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

  /**
   * @constraint 必须先把「玩家看不见的方块」滤掉再铺地形。拼图方块是结构生成
   *      器的连接器，一座试炼密室里有几十个，全部有贴图有模型；原版在生成
   *      结束时就消化掉它们，预览里却会变成一堆凭空出现的方块柱子。
   */
  const voxel = rasterize(template, (name) => INVISIBLE_BLOCKS.has(name))
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

export default function Structures() {
  const { version, loading, error } = useLibrary()
  const index = useAsync(`structures:${version ?? ''}`, () =>
    version ? loadStructureIndex(version) : Promise.reject(new Error('版本未就绪')),
  )
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')
  /**
   * 当前结构写进 URL。
   * @why 1511 个结构里要找一个具体的（"帮我看看那个远古城市"）靠滚动是不现实的，
   *      而没有地址就没法把某一个直接发给别人。选中即改 query，刷新、分享、
   *      后退都能回到同一栋建筑。
   */
  const selected = params.get('s')
  const setSelected = (path: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('s', path)
        return next
      },
      { replace: true },
    )
  }

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
  /** 没有 WebGL2 时走 2D 画家算法，见 `render/world/cpuPaint` */
  cpu: boolean
  /**
   * 出现在这个结构里、但没有静态几何的方块。
   * @why 箱子、告示牌、床这类方块实体由渲染器在运行时拼模型，资源包里**没有**
   *      elements，方块模型只有一句 particle 贴图。静默跳过会让房间"少一件家具"
   *      却看不出为什么，所以要把它们报出来。
   */
  hollow: string[]
}

function StructurePreview({ path, version }: PreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [status, setStatus] = useState('准备中…')
  const [pose, setPose] = useState({ rotX: 22, rotY: 40, zoom: 1 })
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  /**
   * 导出参数。
   * @why 静帧尺寸单独给：预览画布是按窗口分配的，720p 窗口里截出来只有 700 多
   *      像素，拿去做视频封面不够；3D 文件不受尺寸影响。
   */
  const [stillSize, setStillSize] = useState(1024)
  const [backdrop, setBackdrop] = useState<'transparent' | '#ffffff' | '#11141a'>('transparent')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  /** 绘制缓冲边长（物理像素）。按容器实测尺寸 × DPR 算，写死会在高分屏上糊 */
  const [size, setSize] = useState(768)

  const template = useAsync(`${version}|${path ?? ''}`, () =>
    path ? loadStructure(version, path) : Promise.resolve(null),
  )

  const scene = useMemo(() => (template.data ? composeVolume(template.data) : null), [template.data])
  const ids = useMemo(() => (scene ? blockIdsOf(scene) : []), [scene])

  /**
   * 绘制缓冲跟随容器与屏幕。
   * @constraint 不能只在挂载时量一次：侧栏是 grid 里的一列，窗口缩放、
   *      字体加载完成都会改它的宽度，量一次之后 canvas 会一直停在旧尺寸上。
   * @constraint 浏览器缩放改的是 DPR 而不是元素尺寸，ResizeObserver 收不到。
   *      之前 DPR 上限写死 2，放大到 150% 以上时整幅结构图被位图拉伸，
   *      方块的直边变成锯齿块——所以这里同时盯 DPR。
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const apply = () => {
      const rect = canvas.getBoundingClientRect()
      const next = Math.max(240, Math.round(Math.min(rect.width, rect.height || rect.width) * currentDpr()))
      if (next === canvas.width) return
      canvas.width = next
      canvas.height = next
      setSize(next)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(canvas)
    const stop = watchDpr(apply)
    return () => {
      observer.disconnect()
      stop()
    }
  }, [])

  // 一：装配网格（只在场景变化时跑一次）
  useEffect(() => {
    if (!scene) {
      setPrepared(null)
      return
    }
    let alive = true
    setStatus('装配方块…')
    setPrepared(null)
    void (async () => {
      const { geometry, models } = await loadGeometry(version, ids)
      const batches = buildVoxelBatches(scene, geometry)
      const cpu = !hasWebGl()      /**
       * @constraint 贴图只给 GPU 路径预热。CPU 兜底自己按批取纹素，
       *      走 `prepareTextures` 会尝试建 GL 纹理，在没有上下文的
       *      环境里直接抛异常，把整页拖下水。
       */
      if (!cpu) await modelPipeline().prepareTextures(texturesOf(ids, models), version)
      if (!alive) return
      const { min, max } = contentBounds(scene)
      const dx = max[0] - min[0]
      const dy = max[1] - min[1]
      const dz = max[2] - min[2]
      /**
       * @constraint 取景跨度不能用三维对角线，也不能只看水平或只看高度。
       *      屏幕上看到的是投影：一栋 40×40×60 的塔，水平对角 57 格、高 60 格，
       *      但俯视 22° 时垂直方向占的是 `60·cos22 + 57·sin22 ≈ 77` 格——
       *      只取两者最大值（60）会让塔顶和塔基各被裁掉一截。
       *      按当前俯仰角把两个方向都投到屏幕轴，取较大者才是真正要装下的范围。
       */
      const horiz = Math.hypot(dx, dz)
      const pitch = (22 * Math.PI) / 180
      const span =
        Math.max(
          horiz * Math.cos(pitch) + dy * Math.sin(pitch) * 0.6,
          dy * Math.cos(pitch) + horiz * Math.sin(pitch),
        ) * 1.06
      setPrepared({
        batches,
        span,
        pivot: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        cpu,
        hollow: ids.filter((id) => !INVISIBLE_BLOCKS.has(id) && geometry.facesOf(id).length === 0),
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

    if (prepared.cpu) {
      /**
       * @constraint CPU 路径一次要排几千个三角形（几十到两百毫秒），
       *      拖拽时每帧都跑会把主线程占满、手感变成幻灯片。这里压到
       *      一次拖拽动作结束前不再重入：定时器被下一次 effect 清掉，
       *      只有停手 40ms 之后才真正重画。
       */
      let cancelled = false
      const timer = window.setTimeout(() => {
        if (cancelled) return
        void paintVoxelsCpu(
          canvas,
          prepared.batches,
          {
            size,
            rotX: pose.rotX,
            rotY: pose.rotY,
            zoom: pose.zoom,
            span: prepared.span,
            pivot: prepared.pivot,
            fraction: 0.84,
          },
          version,
        ).then((result) => {
          if (!cancelled) setStatus(`${result.triangles.toLocaleString()} 个三角形 · CPU 预览`)
        })
      }, 40)
      return () => {
        cancelled = true
        window.clearTimeout(timer)
      }
    }

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

  /**
   * 导出对象。
   * @why 复用预览的机位与枢轴：用户在页面上转到哪个角度，导出的静帧就是那个
   *      角度。分开算的话「看着好导出歪」会反复出现。
   */
  const subject = useMemo<StructureSubject | null>(() => {
    if (!prepared || !path) return null
    return {
      kind: 'structure',
      id: path,
      version,
      batches: prepared.batches,
      rotX: pose.rotX,
      rotY: pose.rotY,
      zoom: pose.zoom,
      span: prepared.span,
      pivot: prepared.pivot,
      size: stillSize,
      backdrop: backdrop === 'transparent' ? null : backdrop,
    }
  }, [prepared, path, version, pose, stillSize, backdrop])

  const targets = useMemo(() => (subject ? targetsFor(subject) : []), [subject])

  const runExport = async (id: string) => {
    const target = targets.find((item) => item.id === id)
    if (!target || !subject) return
    setBusy(id)
    setNote(null)
    try {
      const blob = await runTarget(subject, target)
      if (!blob) {
        setNote('导出失败：这个结构没有可导出的几何')
        return
      }
      saveBlob(blob, suggestName(subject, target))
      setNote(`已导出 ${target.label}`)
    } catch (failure) {
      setNote(`导出失败：${failure instanceof Error ? failure.message : String(failure)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="struct__stage">
      <canvas ref={canvasRef} className="struct__canvas" width={size} height={size} />
      <p className="struct__status">
        {template.loading ? '读取结构文件…' : status}
        {prepared && prepared.hollow.length > 0 && (
          <span className="struct__hollow" title={prepared.hollow.join('\n')}>
            {' '}
            · {prepared.hollow.length} 类方块实体（
            {prepared.hollow
              .slice(0, 3)
              .map((id) => id.replace(/^minecraft:/, ''))
              .join('、')}
            {prepared.hollow.length > 3 ? ' 等' : ''}
            ）的模型在渲染器里，资源包没有静态几何，未参与预览
          </span>
        )}
      </p>

      <div className="struct__export">
        <span className="struct__export-label">导出</span>
        {targets.map((target) => (
          <button
            key={target.id}
            type="button"
            className="chip chip--ghost"
            disabled={busy !== null}
            title={target.hint}
            onClick={() => void runExport(target.id)}
          >
            {busy === target.id ? '导出中…' : target.label}
          </button>
        ))}
        <label className="struct__export-field">
          静帧
          <select value={stillSize} onChange={(event) => setStillSize(Number(event.target.value))}>
            {[512, 768, 1024, 2048].map((value) => (
              <option key={value} value={value}>
                {value}px
              </option>
            ))}
          </select>
        </label>
        <label className="struct__export-field">
          底色
          <select
            value={backdrop}
            onChange={(event) => setBackdrop(event.target.value as 'transparent' | '#ffffff' | '#11141a')}
          >
            <option value="transparent">透明</option>
            <option value="#ffffff">白</option>
            <option value="#11141a">深</option>
          </select>
        </label>
        {note && <span className="struct__export-note">{note}</span>}
      </div>
    </div>
  )
}
