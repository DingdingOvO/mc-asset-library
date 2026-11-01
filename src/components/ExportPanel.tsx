import { useMemo, useState } from 'react'
import type { Box, Face3D, DisplayTransform, FrameBounds } from '@/lib/scene'
import { drawScene, emptyCameraBox, frameFromBox, measureFaces, pixelScale } from '@/lib/scene'
import {
  asSeparateGltf,
  boundsOf,
  buildGltf,
  packGlb,
  worldGroups,
  type GeoGroup,
  type GltfAnimation,
  type GltfNode,
} from '@/lib/gltf'
import { buildObj, buildStl, textureFile } from '@/lib/obj'
import { makeZip, type ZipEntry } from '@/lib/zip'
import { MC_BASE, textureSrc } from '@/lib/mc'
import {
  BACKDROPS,
  FORMATS,
  captureApng,
  captureGif,
  captureMp4,
  capturePng,
  captureSequence,
  captureWebp,
  fetchBytes,
  formatMeta,
  saveBlob,
  slug,
  supportsMp4,
  type Backdrop,
  type CaptureFormat,
  type CaptureOptions,
} from '@/lib/capture'

/** 导出分辨率：正方形、偶数边长，H.264 与 GIF 都能直接用 */
const SIZES = [480, 640, 800]
const RATES = [12, 24, 30]
const SUPERSAMPLE = 2

/** 3D 文件格式。前两个带动画，后两个只有几何 */
const SOLIDS = [
  { id: 'glb', label: 'GLB', hint: '单文件 glTF，贴图与骨骼动画都嵌在里面' },
  { id: 'gltf', label: 'glTF', hint: 'model.gltf + model.bin，可文本查看、可手改' },
  { id: 'obj', label: 'OBJ', hint: 'obj + mtl + 贴图，几乎所有 DCC 都能读' },
  { id: 'stl', label: 'STL', hint: '只有三角面，给 3D 打印和雕刻用' },
] as const

type SolidFormat = (typeof SOLIDS)[number]['id']

export interface ExportPanelProps {
  id: string
  version: string
  /** 某一时刻的面数据；t 单位是秒 */
  facesAt: (t: number) => Face3D[]
  /** 3D 导出的节点树（t 秒时刻）。不传就按 facesAt(0) 拼一个单节点模型 */
  nodesAt?: ((t: number) => GltfNode[]) | null
  /** 有骨骼动作时才给：按导出时长采样成 glTF 动画 */
  sampleAnim?: ((duration: number, fps: number, stretch: number) => GltfAnimation) | null
  /** 用到的贴图（不含 .png） */
  textures: string[]
  /** 可直接下载的源文件（相对资源根） */
  sources: { label: string; path: string }[]
  rotX: number
  rotY: number
  zoom: number
  light: number
  /** 动态模糊 / 描边强度，与预览共用同一组滑杆 */
  motionBlur?: number
  outline?: number
  fit: 'block' | 'auto'
  display?: DisplayTransform | null
  /** 转台枢轴（模型单位）；跟预览必须一致，否则导出的构图和看到的不一样 */
  pivot?: [number, number, number]
  shadow: number
  /**
   * 内容本身是否在动。false 时才做转台。
   * entity：骨骼动作；texture：.mcmeta 动画贴图；spin：静态模型转台
   */
  animated: boolean
  animKind?: 'entity' | 'texture' | 'spin'
  /**
   * 内容自身的循环周期（秒）。
   * @why 动图/视频是要循环播放的，播放时长不是周期的整数倍时，最后一帧接回第一帧
   *      会跳一下相位（腿停在半空）。传进来之后这里会把时间轴整体微缩放，
   *      让整数个周期刚好铺满 duration——观感上只是快了或慢了几个百分点。
   */
  cycle?: number | null
}

const DURATIONS = [3, 5, 8]

/** 采样多少个时刻来定取景框。太少会漏掉动作的最大张开度，腿会顶出画布 */
const PLAN_SAMPLES = 24

interface Plan {
  frame: FrameBounds
  shadowBox: Box
}

/**
 * 详情页的下载区。
 *
 * @why 把「3D 文件 / 贴图 / 源文件 / 视频」放在一起，而不是给单个下载按钮：
 *      素材站真正被用到的场景是"我要把这个方块放进我的项目"，
 *      光有 PNG 没有几何体和 JSON 定义是拼不回去的。
 */
export function ExportPanel({
  id,
  version,
  facesAt,
  nodesAt = null,
  sampleAnim = null,
  textures,
  sources,
  rotX,
  rotY,
  zoom,
  light,
  motionBlur = 0,
  outline = 0,
  fit,
  display,
  pivot,
  shadow,
  animated,
  animKind = 'spin',
  cycle = null,
}: ExportPanelProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [format, setFormat] = useState<CaptureFormat>('mp4')
  const [solid, setSolid] = useState<SolidFormat>('glb')
  const [withAnim, setWithAnim] = useState(true)
  const [backdrop, setBackdrop] = useState<Backdrop>('green')
  const [duration, setDuration] = useState(3)
  const [size, setSize] = useState(640)
  const [fps, setFps] = useState(24)

  const mp4Ready = useMemo(supportsMp4, [])
  const meta = formatMeta(format)
  const base = slug(id)
  const canAnimate = Boolean(sampleAnim) && (solid === 'glb' || solid === 'gltf')

  /**
   * 时间轴拉伸系数。
   * @constraint 上限 1.5：为了凑整数周期把一个 3 秒片段拉到 4.5 秒，动作会慢成
   *      慢动作，反而更怪。宁可留一点相位不齐——1 帧的接缝比整体慢下来好忍。
   */
  const stretch = useMemo(() => {
    if (!cycle || cycle <= 0) return 1
    const cycles = Math.max(1, Math.round(duration / cycle))
    return Math.min(1.5, (cycles * cycle) / duration)
  }, [cycle, duration])

  /** 转台：整个 duration 正好转一圈，首尾角度相同才能无缝循环 */
  const spinAt = (t: number) => (animated ? rotY : rotY + (t / duration) * 360)

  /**
   * 把整段动画的包围盒并集算成一个固定取景框。
   * @why 不锁的话相机跟着模型的动作走：抬腿时画布缩小、落脚时放大，
   *      60fps 下就是持续呼吸；转台时更是每个角度都在横向漂移。
   *      取并集而不是取首帧，是因为首帧可能是腿并拢的那一帧，后面腿一张开就出框。
   */
  const planFrames = (): Plan | null => {
    const cam = emptyCameraBox()
    for (let i = 0; i < PLAN_SAMPLES; i += 1) {
      const t = (duration * i) / PLAN_SAMPLES
      measureFaces(facesAt(t * stretch), { rotX, rotY: spinAt(t), display, pivot }, cam)
    }
    const frame = frameFromBox(cam)
    if (!frame) return null
    const k = pixelScale(size, fit, frame.span)
    const half = size / 2
    return {
      frame,
      shadowBox: {
        x0: half + (cam.minX - frame.cx) * k,
        x1: half + (cam.maxX - frame.cx) * k,
        y0: half - (cam.maxY - frame.cy) * k,
        y1: half - (cam.minY - frame.cy) * k,
      },
    }
  }

  const render = (ctx: CanvasRenderingContext2D, t: number, plan: Plan | null) => {
    drawScene(ctx, {
      faces: facesAt(t * stretch),
      size,
      rotX,
      rotY: spinAt(t),
      zoom,
      light,
      motionBlur,
      outline,
      fit,
      display,
      pivot,
      version,
      supersample: SUPERSAMPLE,
      shadow,
      clear: false,
      // 首帧清掉拖尾历史，否则上次预览的残影会进入第一帧
      resetTrail: t === 0,
      frame: plan?.frame ?? null,
      shadowBox: plan?.shadowBox,
    })
  }

  const captureOptions = (plan: Plan | null, override?: Partial<CaptureOptions>): CaptureOptions => ({
    width: size,
    height: size,
    duration,
    fps,
    backdrop,
    draw: (ctx, t) => render(ctx, t, plan),
    onProgress: (ratio) => setProgress(ratio),
    ...override,
  })

  const run = async (label: string, task: () => Promise<void>) => {
    if (busy) return
    setBusy(label)
    setProgress(0)
    try {
      await task()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
      setProgress(0)
    }
  }

  /**
   * @why 切格式时顺手把背景修好：H.264 没有 alpha，停在"透明"上导出来就是
   *      一块黑底，用户会以为是渲染坏了。
   */
  const pickFormat = (next: CaptureFormat) => {
    const target = formatMeta(next)
    setFormat(next)
    if (!target.alpha && backdrop === 'none') setBackdrop('green')
  }

  const suffix = backdrop === 'none' ? 'alpha' : backdrop

  /** 贴图按需加载一次，3D 与打包共用 */
  const collectPngs = async (texes: Iterable<string>): Promise<Map<string, Uint8Array>> => {
    const pngs = new Map<string, Uint8Array>()
    for (const tex of new Set(texes)) {
      const bytes = await fetchBytes(textureSrc(version, tex))
      if (bytes) pngs.set(tex, bytes)
    }
    return pngs
  }

  /**
   * 节点树 + 根节点平移。
   * @why 导出的模型要站在原点、脚底贴 y=0：MC 的实体原点在脚底中心，方块原点
   *      在西北下角，直接导出的话方块有一半在地下、实体偏一边。
   */
  const solidScene = () => {
    const nodes = nodesAt ? nodesAt(0) : []
    if (nodes.length === 0) return null
    const box = boundsOf(nodes)
    if (!Number.isFinite(box.min[0])) return null
    const rootTranslation: [number, number, number] = [
      -(box.min[0] + box.max[0]) / 2,
      -box.min[1],
      -(box.min[2] + box.max[2]) / 2,
    ]
    return { nodes, rootTranslation }
  }

  const exportSolid = () =>
    run('3D', async () => {
      const scene = solidScene()
      if (!scene) throw new Error('这个模型没有可导出的几何')

      const texes = new Set<string>()
      for (const node of scene.nodes) for (const group of node.groups) texes.add(group.tex)
      const pngs = await collectPngs(texes)

      const animation = sampleAnim && withAnim && canAnimate
        ? sampleAnim(duration, fps, stretch)
        : null

      if (solid === 'glb' || solid === 'gltf') {
        const built = buildGltf(scene.nodes, pngs, {
          animation,
          rootTranslation: scene.rootTranslation,
        })
        if (solid === 'glb') {
          saveBlob(new Blob([packGlb(built) as unknown as BlobPart], { type: 'model/gltf-binary' }), `${base}.glb`)
          return
        }
        const separate = asSeparateGltf(built)
        const entries: ZipEntry[] = [
          {
            name: `${base}.gltf`,
            data: new TextEncoder().encode(JSON.stringify(separate.json, null, 2)),
          },
          { name: 'model.bin', data: separate.bin },
        ]
        saveBlob(makeZip(entries), `${base}-gltf.zip`)
        return
      }

      // OBJ / STL 是摊平的世界几何，先把根节点平移补偿上
      const groups = shift(worldGroups(scene.nodes), scene.rootTranslation)
      if (groups.length === 0) throw new Error('这个模型没有可导出的几何')

      if (solid === 'obj') {
        const obj = buildObj(groups, base)
        const entries: ZipEntry[] = [
          { name: `${base}.obj`, data: new TextEncoder().encode(obj.obj) },
          { name: `${base}.mtl`, data: new TextEncoder().encode(obj.mtl) },
        ]
        for (const item of obj.textures) {
          const bytes = pngs.get(item.tex)
          if (bytes) entries.push({ name: item.name, data: bytes })
        }
        saveBlob(makeZip(entries), `${base}-obj.zip`)
        return
      }

      saveBlob(
        new Blob([buildStl(groups, base) as unknown as BlobPart], { type: 'model/stl' }),
        `${base}.stl`,
      )
    })

  const downloadTextures = () =>
    run('贴图', async () => {
      if (textures.length <= 1) {
        const bytes = await fetchBytes(textureSrc(version, textures[0] ?? ''))
        if (!bytes) throw new Error('贴图获取失败')
        saveBlob(new Blob([bytes as unknown as BlobPart], { type: 'image/png' }), `${base}.png`)
        return
      }
      const entries: ZipEntry[] = []
      for (const tex of textures) {
        const bytes = await fetchBytes(textureSrc(version, tex))
        if (bytes) entries.push({ name: `${tex.replace(/\//g, '_')}.png`, data: bytes })
      }
      if (entries.length === 0) throw new Error('贴图获取失败')
      saveBlob(makeZip(entries), `${base}-textures.zip`)
    })

  const downloadSources = () =>
    run('源文件', async () => {
      const entries: ZipEntry[] = []
      for (const source of sources) {
        const bytes = await fetchBytes(`${MC_BASE}/${version}/${source.path}`)
        if (bytes) entries.push({ name: source.path.replace(/\//g, '_'), data: bytes })
      }
      if (entries.length === 0) throw new Error('源文件获取失败')
      saveBlob(makeZip(entries), `${base}-source.zip`)
    })

  const downloadBundle = () =>
    run('打包', async () => {
      const entries: ZipEntry[] = []
      const scene = solidScene()
      if (!scene) throw new Error('这个模型没有可导出的几何')

      const texes = new Set<string>()
      for (const node of scene.nodes) for (const group of node.groups) texes.add(group.tex)
      const pngs = await collectPngs(texes)
      for (const [tex, bytes] of pngs) entries.push({ name: textureFile(tex), data: bytes })

      const built = buildGltf(scene.nodes, pngs, { rootTranslation: scene.rootTranslation })
      entries.push({ name: `${base}.glb`, data: packGlb(built) })

      for (const source of sources) {
        const bytes = await fetchBytes(`${MC_BASE}/${version}/${source.path}`)
        if (bytes) entries.push({ name: `source/${source.path}`, data: bytes })
      }
      saveBlob(makeZip(entries), `${base}.zip`)
    })

  const exportAnimation = () =>
    run(meta.label, async () => {
      const options = captureOptions(planFrames())
      if (format === 'mp4') {
        saveBlob(await captureMp4(options), `${base}-${suffix}.mp4`)
        return
      }
      if (format === 'webp') {
        saveBlob(await captureWebp(options), `${base}-${suffix}.webp`)
        return
      }
      if (format === 'apng') {
        saveBlob(await captureApng(options), `${base}-${suffix}.png`)
        return
      }
      if (format === 'gif') {
        saveBlob(await captureGif(options), `${base}-${suffix}.gif`)
        return
      }
      saveBlob(await captureSequence(options), `${base}-frames.zip`)
    })

  const exportStill = () =>
    run('PNG', async () => {
      saveBlob(await capturePng(captureOptions(planFrames()), 0.6), `${base}-still.png`)
    })

  const disabled = Boolean(busy)
  const solidHint = SOLIDS.find((item) => item.id === solid)?.hint ?? ''

  return (
    <div className="dl">
      <div className="dl__group">
        <div className="dl__title">
          3D 文件
          <span className="dl__note">{solidHint}</span>
        </div>
        <div className="dl__grid dl__grid--4">
          {SOLIDS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={solid === item.id}
              title={item.hint}
              disabled={disabled}
              onClick={() => setSolid(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <label className={`dl__check${canAnimate ? '' : ' dl__check--off'}`}>
          <input
            type="checkbox"
            checked={withAnim && canAnimate}
            disabled={disabled || !canAnimate}
            onChange={(event) => setWithAnim(event.target.checked)}
          />
          包含动作
          <span>
            {sampleAnim
              ? solid === 'obj' || solid === 'stl'
                ? 'OBJ / STL 没有动画通道，只能定格'
                : `${duration}s · ${fps}fps 骨骼关键帧`
              : '静态模型没有骨骼动画'}
          </span>
        </label>
        <button type="button" className="dl__btn dl__btn--wide" disabled={disabled} onClick={exportSolid}>
          导出 {SOLIDS.find((item) => item.id === solid)?.label}
          <span>{solid === 'glb' || solid === 'gltf' ? '骨骼 + 贴图' : '几何 + 贴图'}</span>
        </button>
        <div className="dl__row">
          <button type="button" className="dl__btn" disabled={disabled} onClick={downloadTextures}>
            贴图<span>{textures.length > 1 ? `${textures.length} 张` : '.png'}</span>
          </button>
          <button type="button" className="dl__btn" disabled={disabled} onClick={downloadSources}>
            源文件<span>{sources.length} 个</span>
          </button>
          <button type="button" className="dl__btn" disabled={disabled} onClick={downloadBundle}>
            打包<span>全部</span>
          </button>
        </div>
      </div>

      <div className="dl__group">
        <div className="dl__title">
          {animated ? (animKind === 'texture' ? '贴图动画' : '骨骼动作') : '转台'}
          <span className="dl__note">
            {animated
              ? animKind === 'texture'
                ? '.mcmeta 逐帧换图 · 相机固定'
                : 'setupAnim 逐帧摆姿势 · 相机固定'
              : '静态模型 · 360° 旋转'}
          </span>
        </div>

        <div className="dl__grid">
          {FORMATS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={format === item.id}
              title={item.hint}
              disabled={disabled || (item.id === 'mp4' && !mp4Ready)}
              onClick={() => pickFormat(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="dl__grid">
          {BACKDROPS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip chip--swatch"
              aria-pressed={backdrop === item.id}
              title={item.id === 'none' && !meta.alpha ? `${meta.label} 不支持透明通道` : undefined}
              disabled={disabled || (item.id === 'none' && !meta.alpha)}
              onClick={() => setBackdrop(item.id)}
            >
              <i style={{ background: item.color ?? 'transparent' }} />
              {item.label}
            </button>
          ))}
        </div>

        <div className="dl__grid">
          {DURATIONS.map((item) => (
            <button
              key={item}
              type="button"
              className="chip"
              aria-pressed={duration === item}
              disabled={disabled}
              onClick={() => setDuration(item)}
            >
              {item}s
            </button>
          ))}
          <button type="button" className="chip" disabled={disabled} onClick={exportStill}>
            单帧 PNG
          </button>
        </div>

        <div className="dl__grid">
          {SIZES.map((item) => (
            <button
              key={item}
              type="button"
              className="chip"
              aria-pressed={size === item}
              disabled={disabled}
              onClick={() => setSize(item)}
            >
              {item}px
            </button>
          ))}
          {RATES.map((item) => (
            <button
              key={item}
              type="button"
              className="chip"
              aria-pressed={fps === item}
              disabled={disabled}
              onClick={() => setFps(item)}
            >
              {item}fps
            </button>
          ))}
        </div>

        <button
          type="button"
          className="dl__btn dl__btn--wide dl__btn--primary"
          disabled={disabled}
          onClick={exportAnimation}
        >
          {busy ? `导出中 ${Math.round(progress * 100)}%` : `导出 ${meta.label}`}
        </button>
        {busy && (
          <div className="dl__bar">
            <i style={{ width: `${Math.max(4, progress * 100)}%` }} />
          </div>
        )}
        <p className="dl__hint">
          {meta.note}
          {!meta.alpha && backdrop === 'none' ? ' · 请选一个幕布' : ''}
        </p>
        {!mp4Ready && <p className="dl__hint">当前浏览器不支持 WebCodecs，MP4 不可用，请改用 WebP / APNG。</p>}
      </div>
    </div>
  )
}

/** 摊平之后再把根节点的平移补回去 */
function shift(groups: GeoGroup[], offset: [number, number, number]): GeoGroup[] {
  return groups.map((group) => {
    const positions = group.positions.slice()
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! + offset[0]
      positions[i + 1] = positions[i + 1]! + offset[1]
      positions[i + 2] = positions[i + 2]! + offset[2]
    }
    return { ...group, positions }
  })
}
