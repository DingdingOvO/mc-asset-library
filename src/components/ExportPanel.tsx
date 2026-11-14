import { useMemo, useState } from 'react'
import type { Face3D, DisplayTransform } from '@/lib/scene'
import type { GltfAnimation, GltfNode } from '@/lib/gltf'
import { BACKDROPS, type Backdrop } from '@/lib/capture'
import {
  MODEL_DURATIONS,
  MODEL_RATES,
  MODEL_SIZES,
  type ModelSubject,
} from '@/lib/export/model'
import { runTarget, suggestName, targetsFor, type ExportTarget } from '@/lib/export/registry'
import { saveBlob } from '@/lib/export/types'

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
   *      让整数个周期刚好铺满 duration。
   */
  cycle?: number | null
}

/**
 * 详情页的下载区。
 *
 * @why 把「3D 文件 / 贴图 / 源文件 / 视频」放在一起，而不是给单个下载按钮：
 *      素材站真正被用到的场景是"我要把这个方块放进我的项目"，
 *      光有 PNG 没有几何体和 JSON 定义是拼不回去的。
 *
 * @constraint 格式清单全部来自 src/lib/export/registry.ts，这个组件不再自带
 *      任何 SOLIDS / FORMATS 常量。以前两处各写一份，结果工作台只有 3 种格式、
 *      模型页有 11 种，同一站里能力对不齐。
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
  const [solidId, setSolidId] = useState('glb')
  const [videoId, setVideoId] = useState('mp4')
  const [withAnim, setWithAnim] = useState(true)
  const [backdrop, setBackdrop] = useState<Backdrop>('green')
  const [duration, setDuration] = useState(3)
  const [size, setSize] = useState(640)
  const [fps, setFps] = useState(24)

  const subject = useMemo<ModelSubject>(
    () => ({
      kind: 'model',
      id,
      version,
      facesAt,
      nodesAt,
      sampleAnim,
      textures,
      sources,
      rotX,
      rotY,
      zoom,
      light,
      motionBlur,
      outline,
      fit,
      display: display ?? null,
      pivot,
      shadow,
      animated,
      animKind,
      cycle,
      size,
      fps,
      duration,
      backdrop,
      solid: 'glb',
      withAnim,
      onProgress: setProgress,
    }),
    [
      id, version, facesAt, nodesAt, sampleAnim, textures, sources,
      rotX, rotY, zoom, light, motionBlur, outline, fit, display, pivot,
      shadow, animated, animKind, cycle, size, fps, duration, backdrop, withAnim,
    ],
  )

  const targets = useMemo(() => targetsFor(subject), [subject])
  const solids = targets.filter((item) => item.group === '3d')
  const videos = targets.filter((item) => item.group === 'video')
  const stills = targets.filter((item) => item.group === 'raster')
  const data = targets.filter((item) => item.group === 'data')

  const solid = solids.find((item) => item.id === solidId) ?? solids[0] ?? null
  const video = videos.find((item) => item.id === videoId) ?? videos[0] ?? null
  /** 只有 GLB / glTF 有动画通道；OBJ / STL 只能定格 */
  const canAnimate = Boolean(sampleAnim) && (solid?.id === 'glb' || solid?.id === 'gltf')
  /** H.264 没有 alpha，选透明导出就是一块黑底 */
  const videoAlpha = video?.id !== 'mp4'

  const run = async (target: ExportTarget) => {
    if (busy) return
    setBusy(target.label)
    setProgress(0)
    try {
      const blob = await runTarget(subject, target)
      if (!blob) {
        window.alert('没有可导出的内容')
        return
      }
      saveBlob(blob, suggestName(subject, target))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
      setProgress(0)
    }
  }

  /**
   * @why 切到不支持透明的格式时顺手把背景修好：停在"透明"上导出来就是
   *      一块黑底，用户会以为是渲染坏了。
   */
  const pickVideo = (target: ExportTarget) => {
    setVideoId(target.id)
    if (target.id === 'mp4' && backdrop === 'none') setBackdrop('green')
  }

  const disabled = Boolean(busy)
  const durationLabel = sampleAnim ? `${duration}s · ${fps}fps` : '静态模型没有骨骼动画'

  return (
    <div className="dl">
      <div className="dl__group">
        <div className="dl__title">
          3D 文件
          <span className="dl__note">{solid?.hint ?? '这个对象没有可导出的几何'}</span>
        </div>
        <div className="dl__grid dl__grid--4">
          {solids.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={solid?.id === item.id}
              title={item.hint}
              disabled={disabled}
              onClick={() => setSolidId(item.id)}
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
          <span>{canAnimate ? `${durationLabel} 骨骼关键帧` : solid?.id === 'obj' || solid?.id === 'stl' ? 'OBJ / STL 没有动画通道，只能定格' : durationLabel}</span>
        </label>
        <button
          type="button"
          className="dl__btn dl__btn--wide"
          disabled={disabled || !solid}
          onClick={() => solid && void run(solid)}
        >
          导出 {solid?.label ?? '3D'}
          <span>{canAnimate ? '骨骼 + 贴图' : '几何 + 贴图'}</span>
        </button>
        {data.length > 0 && (
          <div className="dl__row">
            {data.map((item) => (
              <button
                key={item.id}
                type="button"
                className="dl__btn"
                title={item.hint}
                disabled={disabled}
                onClick={() => void run(item)}
              >
                {item.label}
                <span>{item.hint.split('，')[0]}</span>
              </button>
            ))}
          </div>
        )}
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
          {videos.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={video?.id === item.id}
              title={item.hint}
              disabled={disabled}
              onClick={() => pickVideo(item)}
            >
              {item.label}
            </button>
          ))}
          {stills.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              title={item.hint}
              disabled={disabled}
              onClick={() => void run(item)}
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
              title={item.id === 'none' && !videoAlpha ? `${video?.label ?? 'MP4'} 不支持透明通道` : undefined}
              disabled={disabled || (item.id === 'none' && !videoAlpha)}
              onClick={() => setBackdrop(item.id)}
            >
              <i style={{ background: item.color ?? 'transparent' }} />
              {item.label}
            </button>
          ))}
        </div>

        <div className="dl__grid">
          {MODEL_DURATIONS.map((item) => (
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
          {MODEL_SIZES.map((item) => (
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
        </div>

        <div className="dl__grid">
          {MODEL_RATES.map((item) => (
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
          disabled={disabled || !video}
          onClick={() => video && void run(video)}
        >
          {busy ? `导出中 ${Math.round(progress * 100)}%` : `导出 ${video?.label ?? '视频'}`}
        </button>
        {busy && (
          <div className="dl__bar">
            <i style={{ width: `${Math.max(4, progress * 100)}%` }} />
          </div>
        )}
        <p className="dl__hint">
          {video?.hint}
          {!videoAlpha && backdrop === 'none' ? ' · 请选一个幕布' : ''}
        </p>
        {!videos.some((item) => item.id === 'mp4') && (
          <p className="dl__hint">当前浏览器不支持 WebCodecs，MP4 不可用，请改用 WebP / APNG。</p>
        )}
      </div>
    </div>
  )
}
