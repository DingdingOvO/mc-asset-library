import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ModelView, subjectPivot, type Subject, type ViewState } from './ModelView'
import { ExportPanel } from './ExportPanel'
import { SoundLinks } from './SoundLinks'
import { CloseIcon } from './icons'
import type { AnimFile } from '@/lib/anim'
import type { Axis, DyeColor } from '@/lib/entityLayers'
import { motionOf, type Motion } from '@/lib/motion'
import { blockAnimOf, blockFaces } from '@/lib/faceBuild'
import { entityFaces } from '@/lib/entityRig'
import { nodesFromFaces, nodesFromRig, sampleAnimation } from '@/lib/gltf'
import { DEFAULT_ROTATION, ENTITY_ROTATION, FLAT_ROTATION, type Face3D } from '@/lib/scene'

interface ModelModalProps {
  subject: Subject | null
  version: string
  title: string
  subtitle?: string | null
  rows: { key: string; value: string }[]
  /** 关联音效：给注册 id 就能列出它在游戏里的声音 */
  soundKind?: 'block' | 'item' | 'entity'
  soundId?: string
  /** 动作分类要用的模型类名（实体才有） */
  modelClass?: string | null
  /** 动作数据，用来判断驱动量与测周期；实体才有 */
  animFile?: AnimFile | null
  /** 可变状态：品种、斑纹、染色…… 来自源码里的变体表 */
  axes?: Axis[]
  dyes?: DyeColor[]
  choice?: Record<string, string>
  onChoice?: (key: string, value: string) => void
  /** 可下载的源文件，path 相对资源根（如 blockstates/stone.json） */
  sources?: { label: string; path: string }[]
  hint?: string
  onClose: () => void
}



/**
 * 详情弹窗：左边是可拖动旋转的立体模型，右边是属性、视角控制与下载。
 */
export function ModelModal({
  subject,
  version,
  title,
  subtitle,
  rows,
  sources = [],
  soundKind,
  soundId,
  modelClass,
  animFile,
  axes = [],
  dyes = [],
  choice = {},
  onChoice,
  hint,
  onClose,
}: ModelModalProps) {
  const [speed, setSpeed] = useState(1)

  /**
   * 动作分类：这只生物到底在走、在飞、在游，还是在划桨。
   * @why 档位不能一律给「站立 / 走动 / 行走 / 奔跑」——船没有腿，鱿鱼也不跑。
   */
  const motion = useMemo<Motion>(
    () =>
      motionOf(
        modelClass ?? null,
        animFile ?? null,
        subject?.kind === 'entity',
        subject?.kind === 'entity' ? subject.poser : null,
      ),
    [modelClass, animFile, subject],
  )

  // 换对象时档位回到该动作的默认值（走=1，飞=0.6，划=0.6…）
  useEffect(() => {
    setSpeed(motion.initial)
  }, [motion.initial, subject])

  const flat = subject?.kind === 'block' && Boolean(subject.flat)
  const isEntity = subject?.kind === 'entity'
  const baseRot = flat ? FLAT_ROTATION : isEntity ? ENTITY_ROTATION : DEFAULT_ROTATION
  const [view, setView] = useState<ViewState>({
    rotX: baseRot[0],
    rotY: baseRot[1],
    zoom: 1,
    light: 1,
    blur: 0,
    outline: 0,
  })

  // 换一个模型就回到默认机位，否则上一个方块的俯角会带到下一只生物上
  useEffect(() => {
    setView({ rotX: baseRot[0], rotY: baseRot[1], zoom: 1, light: 1, blur: 0, outline: 0 })
  }, [subject, baseRot])

  /**
   * 方块自己会动的只有 .mcmeta 动画贴图（水、岩浆、火、海带…）。
   * @constraint 不能对整个纹理池取最大值：池子里只要有水，所有方块都会
   *      被标成「32 帧动画」。必须只看这个方块真正用到的那些贴图。
   */
  const blockAnim = useMemo(
    () => (subject?.kind === 'block' ? blockAnimOf(subject.faces, subject.anims) : null),
    [subject],
  )
  const blockAnimated = blockAnim !== null

  const firstFaces = useMemo(
    () => (subject?.kind === 'block' ? blockFaces(subject.faces, subject.textures, subject.anims, 0) : null),
    [subject],
  )

  /**
   * @constraint 导出的每一帧都要现算：实体姿势随 t 变化，缓存一帧会让视频卡住不动；
   *              方块的 uv 也要按 t 换帧，否则导出来是张静止图。
   */
  const facesAt = useCallback(
    (t: number): Face3D[] => {
      if (!subject) return []
      if (subject.kind === 'entity') {
        const poses = subject.poser.pose({ t, speed, pitch: 3, yaw: 0 })
        return entityFaces(subject.rig, poses, subject.texture, subject.layers)
      }
      /**
       * @constraint 帧号要按 frametime 折算：水是每 2 tick 一帧，直接按 20fps 取帧
       *      导出的水会比游戏里快一倍，而且和屏幕上的预览对不上。
       */
      const frame = blockAnim
        ? Math.floor(Math.floor(t * 20) / blockAnim.frametime) % blockAnim.steps
        : 0
      return blockFaces(subject.faces, subject.textures, subject.anims, frame)
    },
    [subject, speed, blockAnim],
  )

  /**
   * 3D 导出的节点树。
   * @why 实体走骨架节点，方块只有一个节点——方块没有可以摆姿势的部件，
   *      它的"动画"是贴图 uv 在动，导出时按时刻取对应帧即可。
   */
  const nodesAt = useCallback(
    (t: number) => {
      if (!subject) return []
      if (subject.kind === 'entity') {
        const poses = subject.poser.pose({ t, speed, pitch: 3, yaw: 0 })
        return nodesFromRig(subject.rig, subject.texture, poses)
      }
      return nodesFromFaces(facesAt(t))
    },
    [subject, speed, facesAt],
  )

  /** 只有骨骼能变成 glTF 动画通道；方块和贴图动画没有节点可动 */
  const sampleAnim = useMemo(() => {
    if (!subject || subject.kind !== 'entity') return null
    return (duration: number, fps: number, stretch: number) =>
      sampleAnimation(
        subject.rig,
        (t) => subject.poser.pose({ t, speed, pitch: 3, yaw: 0 }),
        { duration, fps, stretch, name: `${title} action` },
      )
  }, [subject, speed, title])

  const textures = useMemo(() => {
    if (!subject) return []
    if (subject.kind === 'entity') {
      return [subject.texture, ...(subject.layers ?? []).map((layer) => layer.texture)]
    }
    return [...new Set((firstFaces ?? []).map((face) => face.tex))]
  }, [subject, firstFaces])

  const pivot = useMemo(() => (subject ? subjectPivot(subject, firstFaces) : null), [subject, firstFaces])

  const animated = subject?.kind === 'entity'
  const empty = subject === null || (subject.kind === 'block' && subject.faces.length === 0)

  /**
   * 内容自身多久循环一次，交给导出面板去对齐时长。
   * @why 实体是行走步态（左右腿各迈一次），贴图动画是整条帧序列跑完一遍。
   *      两者都不是"想多长就多长"，不告诉导出器，末帧就会停在半个动作上。
   */
  const cycle = animated
    ? motion.cycle != null
      ? motion.cycle * (speed / motion.initial || 1)
      : null
    : blockAnim
      ? (blockAnim.steps * blockAnim.frametime) / 20
      : null

  /**
   * @constraint 必须挂到 body 上：顶栏是 sticky + backdrop-filter，会把弹窗
   *      顶部几十像素压住（标题正好在那一段）。fixed + z-index 在 main 内部
   *      压不过它，只有脱离这棵子树才行。
   */
  return createPortal(
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal modal--block"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="modal__close" onClick={onClose} aria-label="关闭">
          <CloseIcon />
        </button>

        <div className="modal__view">
          {empty ? (
            <span className="entry-fallback">{hint ?? '没有可用的立体模型'}</span>
          ) : (
            <ModelView
              subject={subject}
              version={version}
              size={320}
              interactive
              animated
              speed={speed}
              view={view}
              pivot={pivot ?? undefined}
              onViewChange={setView}
            />
          )}

          {!empty && (
            <div className="modal__ctl">
              {animated ? (
                <>
                  <span className="modal__kind">{motion.label}</span>
                  {motion.stops.length > 1 &&
                    motion.stops.map((item) => (
                      <button
                        key={item.label}
                        type="button"
                        className="chip chip--ghost"
                        aria-pressed={speed === item.value}
                        onClick={() => setSpeed(item.value)}
                      >
                        {item.label}
                      </button>
                    ))}
                </>
              ) : blockAnimated ? (
                <span className="modal__kind">
                  贴图动画 · {blockAnim!.steps} 步 · {blockAnim!.frametime} tick/帧
                </span>
              ) : (
                <span className="modal__kind">静态模型 · 转台预览</span>
              )}
            </div>
          )}

          {!empty && <span className="modal__hint">拖动旋转 · 滚轮缩放</span>}
        </div>

        <div className="modal__side">
          <div className="modal__head">
            <div className="detail__name">{title}</div>
            {subtitle && <div className="detail__en">{subtitle}</div>}
          </div>
          <div className="modal__body">
            <div className="kv-list">
              {rows.map((row) => (
                <div className="kv" key={row.key}>
                  <span className="kv__key">{row.key}</span>
                  <span className="kv__val">{row.value}</span>
                </div>
              ))}
            </div>

            {axes.length > 0 && onChoice && (
              <div className="viewctl">
                <div className="dl__title">
                  状态
                  <span className="dl__note">源码里的可变参数，换一个就换一张皮</span>
                </div>
                {axes.map((axis) => (
                  <label className="viewctl__row viewctl__row--select" key={axis.k}>
                    <span>{axis.zh}</span>
                    <select
                      value={choice[axis.k] ?? (axis.dye ? (axis.default ?? 'none') : 'none')}
                      onChange={(event) => onChoice(axis.k, event.target.value)}
                    >
                      {axis.dye
                        ? [
                            <option value="none" key="none">
                              无
                            </option>,
                            ...dyes.map((dye) => (
                              <option value={dye.k} key={dye.k}>
                                {dye.zh}
                              </option>
                            )),
                          ]
                        : (axis.opts ?? []).map((opt) => (
                            <option value={opt.k} key={opt.k}>
                              {opt.zh}
                            </option>
                          ))}
                    </select>
                  </label>
                ))}
              </div>
            )}

            {!empty && (
              <div className="viewctl">
                <div className="dl__title">
                  视角
                  <span className="dl__note">调好之后导出就按这个来</span>
                </div>
                <label className="viewctl__row">
                  <span>俯仰</span>
                  <input
                    type="range"
                    min={-89}
                    max={89}
                    step={1}
                    value={Math.round(view.rotX)}
                    onChange={(event) => setView({ ...view, rotX: Number(event.target.value) })}
                  />
                  <b>{Math.round(view.rotX)}°</b>
                </label>
                <label className="viewctl__row">
                  <span>水平</span>
                  <input
                    type="range"
                    min={-180}
                    max={180}
                    step={1}
                    value={Math.round(((view.rotY + 180) % 360 + 360) % 360 - 180)}
                    onChange={(event) => setView({ ...view, rotY: Number(event.target.value) })}
                  />
                  <b>{Math.round(((view.rotY + 180) % 360 + 360) % 360 - 180)}°</b>
                </label>
                <label className="viewctl__row">
                  <span>缩放</span>
                  <input
                    type="range"
                    min={55}
                    max={220}
                    step={5}
                    value={Math.round(view.zoom * 100)}
                    onChange={(event) => setView({ ...view, zoom: Number(event.target.value) / 100 })}
                  />
                  <b>{Math.round(view.zoom * 100)}%</b>
                </label>
                <label className="viewctl__row">
                  <span>光照</span>
                  <input
                    type="range"
                    min={60}
                    max={145}
                    step={5}
                    value={Math.round(view.light * 100)}
                    onChange={(event) => setView({ ...view, light: Number(event.target.value) / 100 })}
                  />
                  <b>{Math.round(view.light * 100)}%</b>
                </label>
                {/**
                  * @why 质感和机位分开放：视角决定导出构图，质感是观感修饰，
                  *      共用一组滑杆会让人以为描边会影响导出尺寸。
                  */}
                <label className="viewctl__row">
                  <span>动态模糊</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(view.blur * 100)}
                    onChange={(event) => setView({ ...view, blur: Number(event.target.value) / 100 })}
                  />
                  <b>{Math.round(view.blur * 100)}%</b>
                </label>
                <label className="viewctl__row">
                  <span>描边</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(view.outline * 100)}
                    onChange={(event) => setView({ ...view, outline: Number(event.target.value) / 100 })}
                  />
                  <b>{Math.round(view.outline * 100)}%</b>
                </label>
                <button
                  type="button"
                  className="chip chip--ghost"
                  onClick={() => setView({ rotX: baseRot[0], rotY: baseRot[1], zoom: 1, light: 1, blur: 0, outline: 0 })}
                >
                  重置视角
                </button>
              </div>
            )}

            {soundKind && soundId && (
              <div className="dl">
                <div className="dl__title">
                  关联音效
                  <span className="dl__note">游戏里它自己的声音</span>
                </div>
                <SoundLinks version={version} kind={soundKind} id={soundId} />
              </div>
            )}

            <ExportPanel
              id={title}
              version={version}
              facesAt={facesAt}
              nodesAt={nodesAt}
              sampleAnim={sampleAnim}
              textures={textures}
              sources={sources}
              rotX={view.rotX}
              rotY={view.rotY}
              zoom={view.zoom}
              light={view.light}
              motionBlur={view.blur}
              outline={view.outline}
              pivot={pivot ?? undefined}
              fit={subject?.kind === 'entity' ? 'auto' : 'block'}
              display={subject?.kind === 'block' ? (subject.display ?? null) : null}
              shadow={subject?.kind === 'entity' ? 1 : 0.55}
              animated={Boolean(animated) || blockAnimated}
              animKind={animated ? 'entity' : blockAnimated ? 'texture' : 'spin'}
              cycle={cycle}
            />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
