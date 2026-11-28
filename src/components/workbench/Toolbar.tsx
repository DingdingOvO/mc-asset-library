import type { ReactNode } from 'react'
import { RedoIcon, UndoIcon } from '@/components/icons'
import type { ExportBackdrop } from '@/lib/containerRender'
import type { PinnedTip } from '@/lib/exportLayers'
import {
  MODERN_DEFAULT,
  PANEL_RADII,
  TIP_OPACITIES,
  TIP_RADII,
  TIP_SHADOWS,
  toggleModern,
  type ModernUi,
} from '@/lib/modern'
import type { ExportTarget } from '@/lib/export/registry'

/**
 * 工作台顶栏。
 *
 * @why 这里只放"随时要按"的东西：撤销、缩放、语言、导出、导入、清空。
 *      底色（导出用）收进导出下拉——它不改画布，却占掉手机上整整一格，
 *      正是这一格把「导入 / 清空」挤到了第三行。
 *
 * @constraint 分两个容器 `workbench__tools` / `workbench__actions`，
 *      窄屏靠 `display:contents` 拆开重排：短屏时上面一组、下面一组各占一行。
 *      合并成一个容器的话手机顶栏会变成三行。
 */

const SCALES = [1, 2, 3, 4] as const

export interface ToolbarProps {
  /** 页签（容器工作台 / 告示牌 / 书 / 地图），与工具同处一行 */
  tabs?: ReactNode
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  scale: number
  onScale: (value: number) => void
  lang: 'zh' | 'en'
  onLang: (value: 'zh' | 'en') => void
  busy: string | null
  backdrop: ExportBackdrop
  onBackdrop: (value: ExportBackdrop) => void
  /** 当前画布能导出的全部格式，来自导出注册表 */
  exportTargets: ExportTarget[]
  onExport: (target: ExportTarget) => void
  onImport: (file: File) => void
  confirmClear: boolean
  onClear: () => void
  containerCount: number
  itemCount: number
  /** 现代化 UI 开关：屏幕与导出共用 */
  modern: ModernUi
  /**
   * @constraint 必须收 updater 而不是新对象：三个开关是三个按钮，用户连点时
   *      三次 onClick 会落在同一批更新里，各自基于同一个旧 state 算新值，
   *      结果只有最后那次生效（点「圆角+投影」变成只有投影）。
   */
  onModern: (updater: (prev: ModernUi) => ModernUi) => void
  /** 已锁定的提示（槽位维度） */
  pins: PinnedTip[]
  /** 悬停中的槽位；为 null 时不能锁定 */
  hoverSlot: PinnedTip | null
  onPin: (pin: PinnedTip) => void
  onUnpin: (pin: PinnedTip) => void
  /** 锁定的提示里有几件物品已从画布上删掉 */
  staleCount: number
}

export function Toolbar(props: ToolbarProps) {
  const {
    tabs,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    scale,
    onScale,
    lang,
    onLang,
    busy,
    backdrop,
    onBackdrop,
    exportTargets,
    onExport,
    onImport,
    confirmClear,
    onClear,
    containerCount,
    itemCount,
    modern,
    onModern,
    pins,
    hoverSlot,
    onPin,
    onUnpin,
    staleCount,
  } = props

  const shadowLabels = ['关', '弱', '中', '强'] as const
  // @why 只认 enabled：总开关关掉时参数仍在，但页面已经退回原版，
  //      这时候还亮着「已改动」点会让人以为样式没关干净。
  const modernTouched = modern.enabled
  return (
    <header className="workbench__bar">
      {tabs}
      <span className="workbench__spacer" />
      <span className="workbench__meta">
        {containerCount} 容器 · {itemCount} 物品
      </span>

      <div className="workbench__tools">
        <div className="workbench__group" role="group" aria-label="撤销与重做">
          <button
            type="button"
            className="chip chip--icon"
            onClick={onUndo}
            disabled={!canUndo}
            title="撤销（Ctrl+Z）"
            aria-label="撤销"
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="chip chip--icon"
            onClick={onRedo}
            disabled={!canRedo}
            title="重做（Ctrl+Shift+Z）"
            aria-label="重做"
          >
            <RedoIcon />
          </button>
        </div>

        <div className="workbench__group workbench__group--zoom" role="group" aria-label="缩放">
          {SCALES.map((value) => (
            <button
              key={value}
              type="button"
              className={`chip${scale === value ? ' chip--on' : ''}`}
              onClick={() => onScale(value)}
            >
              {value}×
            </button>
          ))}
        </div>

        {/* @why 一个按钮循环切换，而不是两个按钮并排：窄屏上「中文 / EN」占两格，
            换来的只是省一次点击，却把「导出」挤到下一行去。 */}
        <button
          type="button"
          className="chip"
          onClick={() => onLang(lang === 'zh' ? 'en' : 'zh')}
          title="切换容器标题语言"
        >
          {lang === 'zh' ? '中文' : 'EN'}
        </button>
      </div>

      <div className="workbench__actions">
        {/* @why 视觉参数收进「样式」而不是摊在顶栏：三个开关 + 提示锁定是 5 个格子，
            桌面还能塞，手机上一放就把导出挤到第三行。 */}
        <details className="menu">
          <summary className="btn btn--ghost">
            样式
            {modernTouched && <span className="menu__badge menu__badge--dot" aria-label="已改动" />}
            {pins.length > 0 && <span className="menu__badge">{pins.length}</span>}
          </summary>
          <div className="menu__list">
            {/*
              @why 参数照 Modern UI 的 Action Center 排，而不是自创三项：
                    它的视觉区就是「提示框的圆角 / 阴影半径 / 阴影强度 / 边框样式 /
                    标题分隔线 / 标题居中 / 背景不透明度」，顺序也大致如此。
                    自创一套的结果是用户拿真 mod 截图来对，一项都对不上。
              @constraint 提示框是主战场，容器面板放在最后且默认直角：
                    原版物品栏底板在 MUI 下本来就不圆角，默认开就会歪。
            */}
            <p className="menu__note">现代化 UI（参照 Modern UI 模组）</p>

            <div className="menu__split">
              <span className="menu__label">现代化 UI</span>
              {/*
                @why 做成一个总开关，而不是让用户把每项调回原版值：MUI 本身
                      就是一个可禁用的模组，禁用即整套退回原版、参数保留。
                      没有这一层，「想看一眼原版长什么样」要逐项调 7 次再调回来。
              */}
              <button
                type="button"
                className={`chip${modern.enabled ? ' chip--on' : ''}`}
                title={modern.enabled ? '关闭后与游戏原版完全一致，参数会保留' : '参照 Modern UI 模组，启用后下方可逐项调节'}
                aria-pressed={modern.enabled}
                onClick={() => onModern((prev) => toggleModern(prev, !prev.enabled))}
              >
                {modern.enabled ? '开' : '关'}
              </button>
              {modern.enabled && (
                <button
                  type="button"
                  className="chip"
                  title="回到推荐的一套（与刚装上 mod 时一致）"
                  onClick={() => onModern(() => ({ ...MODERN_DEFAULT }))}
                >
                  推荐
                </button>
              )}
            </div>

            {!modern.enabled && (
              <p className="menu__note">
                关闭时与游戏原版完全一致。参数会保留，重新打开还是这一套。
              </p>
            )}

            {modern.enabled && (
              <>
                <div className="menu__split">
                  <span className="menu__label">提示圆角</span>
                  {TIP_RADII.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip${modern.tipRadius === value ? ' chip--on' : ''}`}
                      title={value === 0 ? '原版直角' : `${value} GUI 像素圆角`}
                      aria-pressed={modern.tipRadius === value}
                      onClick={() => onModern((prev) => ({ ...prev, tipRadius: value }))}
                    >
                      {value === 0 ? '关' : value}
                    </button>
                  ))}
                </div>

                <div className="menu__split">
                  <span className="menu__label">阴影</span>
                  {TIP_SHADOWS.map((step, index) => {
                    const on = modern.tipShadowRadius === step.radius
                    return (
                      <button
                        key={step.radius}
                        type="button"
                        className={`chip${on ? ' chip--on' : ''}`}
                        title={
                          step.radius === 0
                            ? '无阴影'
                            : `扩散 ${step.radius} 像素，强度 ${Math.round(step.alpha * 100)}%`
                        }
                        aria-pressed={on}
                        onClick={() =>
                          onModern((prev) => ({
                            ...prev,
                            tipShadowRadius: step.radius,
                            tipShadowAlpha: step.alpha,
                          }))
                        }
                      >
                        {shadowLabels[index]}
                      </button>
                    )
                  })}
                </div>

                <div className="menu__split">
                  <span className="menu__label">边框</span>
                  <button
                    type="button"
                    className={`chip${modern.tipBorder === 'vanilla' ? ' chip--on' : ''}`}
                    title="原版九宫格：直角紫框，与贴图一致"
                    aria-pressed={modern.tipBorder === 'vanilla'}
                    onClick={() => onModern((prev) => ({ ...prev, tipBorder: 'vanilla' }))}
                  >
                    原版
                  </button>
                  <button
                    type="button"
                    className={`chip${modern.tipBorder === 'round' ? ' chip--on' : ''}`}
                    title="圆角平滑边框：底板改填色，描边压成 1 像素"
                    aria-pressed={modern.tipBorder === 'round'}
                    onClick={() => onModern((prev) => ({ ...prev, tipBorder: 'round' }))}
                  >
                    圆角
                  </button>
                </div>

                <div className="menu__split">
                  <span className="menu__label">标题</span>
                  <button
                    type="button"
                    className={`chip${modern.tipTitleRule ? ' chip--on' : ''}`}
                    title="标题下方一条分隔线，多行提示才有意义"
                    aria-pressed={modern.tipTitleRule}
                    onClick={() => onModern((prev) => ({ ...prev, tipTitleRule: !prev.tipTitleRule }))}
                  >
                    分隔线
                  </button>
                  <button
                    type="button"
                    className={`chip${modern.tipCenterTitle ? ' chip--on' : ''}`}
                    title="标题行居中，正文仍左对齐"
                    aria-pressed={modern.tipCenterTitle}
                    onClick={() => onModern((prev) => ({ ...prev, tipCenterTitle: !prev.tipCenterTitle }))}
                  >
                    居中
                  </button>
                </div>

                <div className="menu__split">
                  <span className="menu__label">底板</span>
                  {TIP_OPACITIES.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip${modern.tipOpacity === value ? ' chip--on' : ''}`}
                      title={value === 1 ? '不透明，与原版一致' : `透出 ${Math.round((1 - value) * 100)}% 底色`}
                      aria-pressed={modern.tipOpacity === value}
                      onClick={() => onModern((prev) => ({ ...prev, tipOpacity: value }))}
                    >
                      {Math.round(value * 100)}%
                    </button>
                  ))}
                </div>

                <div className="menu__split">
                  <span className="menu__label">容器面板</span>
                  {PANEL_RADII.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`chip${modern.panelRadius === value ? ' chip--on' : ''}`}
                      title={value === 0 ? '原版直角底板' : `${value} GUI 像素圆角`}
                      aria-pressed={modern.panelRadius === value}
                      onClick={() => onModern((prev) => ({ ...prev, panelRadius: value }))}
                    >
                      {value === 0 ? '直角' : value}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`chip${modern.panelShadow ? ' chip--on' : ''}`}
                    title="底板下方一层模糊投影"
                    aria-pressed={modern.panelShadow}
                    onClick={() => onModern((prev) => ({ ...prev, panelShadow: !prev.panelShadow }))}
                  >
                    投影
                  </button>
                </div>
              </>
            )}

            <p className="menu__note">画布提示</p>

            <div className="menu__split">
              <span className="menu__label">悬停</span>
              <button
                type="button"
                className="chip"
                disabled={!hoverSlot || pins.some((pin) => pin.uid === hoverSlot.uid && pin.slot === hoverSlot.slot)}
                title={hoverSlot ? '把这个格子的提示固定到画布上，导出时一起画出来' : '先悬停一个放着物品的格子'}
                onClick={() => hoverSlot && onPin(hoverSlot)}
              >
                {hoverSlot ? `锁定 #${hoverSlot.slot + 1}` : '先悬停格子'}
              </button>
            </div>
            {pins.length > 0 && (
              <div className="menu__split menu__split--wrap">
                {pins.map((pin) => (
                  <button
                    key={`${pin.uid}-${pin.slot}`}
                    type="button"
                    className="chip"
                    title="取消这个提示"
                    onClick={() => onUnpin(pin)}
                  >
                    槽位 {pin.slot + 1} ×
                  </button>
                ))}
              </div>
            )}
            {staleCount > 0 && (
              <p className="menu__note">
                有 {staleCount} 个锁定提示指向的格子已经空了，导出时会自动跳过
              </p>
            )}
          </div>
        </details>

        <details className="menu">
          <summary className="btn">{busy ? '导出中…' : '导出'}</summary>
          <div className="menu__list">
            {exportTargets.map((target) => (
              <button
                key={target.id}
                type="button"
                onClick={() => onExport(target)}
                disabled={!!busy}
                title={target.hint}
              >
                {target.label}
                <span>{target.hint}</span>
              </button>
            ))}
            <div className="menu__split">
              <span className="menu__label">底色</span>
              {(['transparent', 'dark', 'light'] as ExportBackdrop[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`chip${backdrop === value ? ' chip--on' : ''}`}
                  onClick={() => onBackdrop(value)}
                >
                  {value === 'transparent' ? '透明' : value === 'dark' ? '深色' : '浅色'}
                </button>
              ))}
            </div>
          </div>
        </details>

        <label className="btn btn--ghost">
          导入
          <input
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) onImport(file)
              event.target.value = ''
            }}
          />
        </label>

        <button
          type="button"
          className={`btn btn--ghost${confirmClear ? ' btn--danger' : ''}`}
          onClick={onClear}
        >
          {confirmClear ? '确认清空？' : '清空'}
        </button>
      </div>
    </header>
  )
}
