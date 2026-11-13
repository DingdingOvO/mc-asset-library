import { Link } from 'react-router-dom'
import { RedoIcon, UndoIcon } from '@/components/icons'
import type { ExportBackdrop } from '@/lib/containerRender'

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
  onExportPng: () => void
  onExportPsd: () => void
  onExportJson: () => void
  onImport: (file: File) => void
  confirmClear: boolean
  onClear: () => void
  containerCount: number
  itemCount: number
}

export function Toolbar(props: ToolbarProps) {
  const {
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
    onExportPng,
    onExportPsd,
    onExportJson,
    onImport,
    confirmClear,
    onClear,
    containerCount,
    itemCount,
  } = props

  return (
    <header className="workbench__bar">
      <Link to="/" className="text-link workbench__back">
        ← 首页
      </Link>
      <h1 className="workbench__title">界面工作台</h1>
      <span className="workbench__meta">
        {containerCount} 容器 · {itemCount} 物品
      </span>
      <span className="workbench__spacer" />

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

        <div className="workbench__group" role="group" aria-label="缩放">
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

        <div className="workbench__group" role="group" aria-label="标题语言">
          {(['zh', 'en'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`chip${lang === value ? ' chip--on' : ''}`}
              onClick={() => onLang(value)}
            >
              {value === 'zh' ? '中文' : 'EN'}
            </button>
          ))}
        </div>
      </div>

      <div className="workbench__actions">
        <details className="menu">
          <summary className="btn">{busy ? '导出中…' : '导出'}</summary>
          <div className="menu__list">
            <button type="button" onClick={onExportPng} disabled={!!busy}>
              PNG 图片
              <span>扁平图，直接发出去</span>
            </button>
            <button type="button" onClick={onExportPsd} disabled={!!busy}>
              PSD 分层
              <span>背景 / 状态 / 物品 / 文字各一层</span>
            </button>
            <button type="button" onClick={onExportJson}>
              布局 JSON
              <span>可以再导回来继续改</span>
            </button>
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
