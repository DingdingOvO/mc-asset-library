import { useCallback, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ContainerPanel } from '@/components/ContainerPanel'
import { SearchBox } from '@/components/SearchBox'
import { Tooltip, type TipState } from '@/components/Tooltip'
import { exportWorkspacePng, type ExportBackdrop } from '@/lib/containerRender'
import { loadContainers, type ContainerControl, type ContainerDef, type EffectName } from '@/lib/containers'
import { defaultParams } from '@/lib/layerRender'
import { exportWorkspacePsd } from '@/lib/psd'
import { snapMove } from '@/lib/snap'
import { loadItems, type Item } from '@/lib/items'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import {
  deserialize,
  emptyWorkspace,
  freeSpot,
  serialize,
  workspaceReducer,
  type ContainerNode,
  type PlacedItem,
  type Workspace,
} from '@/lib/workspace'

/**
 * 界面页 = 容器工作台。
 *
 * @why 之前这页是 GUI 贴图墙：一格一张 img，能看不能动。而做视频真正要的是
 *      「摆一个箱子、把物品排进去、把熔炉调成在烧、导出成图」。所以页面主体
 *      是画布，容器尺寸、槽位坐标、背景切片、动态层坐标全部来自反编译源码的
 *      提取结果，不是照图估的。
 */
export default function Ui() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取容器布局…</p>

  return <Workshop version={version} />
}

const SCALES = [1, 2, 3, 4] as const

/**
 * 容器分组。
 * @why 二十多个容器平铺一列，找熔炉要扫过整个列表。按使用场景分组之后，
 *      常用的组在首屏，「玩家与交易」这种偶尔用的沉到最后。
 */
const GROUPS: { label: string; ids: string[] }[] = [
  { label: '快捷栏', ids: ['hotbar'] },
  { label: '储存', ids: ['chest_1', 'chest_2', 'chest_3', 'chest_6', 'shulker_box', 'hopper', 'dispenser'] },
  {
    label: '工作站',
    ids: [
      'crafting',
      'crafter',
      'furnace',
      'smoker',
      'blast_furnace',
      'anvil',
      'smithing',
      'grindstone',
      'loom',
      'cartography',
      'stonecutter',
      'enchanting',
      'brewing',
    ],
  },
  { label: '玩家与交易', ids: ['inventory', 'villager', 'beacon'] },
]

function Workshop({ version }: { version: string }) {
  const containers = useAsync(`containers:${version}`, () => loadContainers(version))
  const items = useAsync(`items:${version}`, () => loadItems(version))

  const [state, dispatch] = useReducer(workspaceReducer, undefined, emptyWorkspace)
  // @why 手机上 3 倍放大的容器比屏幕宽得多，默认降到 2 倍，少滚一点
  // @why 默认 2 倍：3 倍下三行箱子是 504×528，常见笔记本的可视画布只有 420 高，
  //      一放进来就要滚动，看起来像"面板被切了"。需要看清细节时手动切 3/4。
  const [scale, setScale] = useState<number>(2)
  const [held, setHeld] = useState<PlacedItem | null>(null)
  /** 输入框里的原始字符串：允许中途为空，提交时才钳到 1..99 */
  const [stackText, setStackText] = useState('64')
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [backdrop, setBackdrop] = useState<ExportBackdrop>('transparent')
  // @why 默认中文：站点是给中文用户做视频用的。做官方截图还原时切回英文原版
  const [lang, setLang] = useState<'zh' | 'en'>('zh')
  const [busy, setBusy] = useState<'png' | 'psd' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)

  const defs = useMemo(() => {
    const map = new Map<string, ContainerDef>()
    for (const def of containers.data?.containers ?? []) map.set(def.id, def)
    return map
  }, [containers.data])

  const effects = useMemo(() => {
    const map = new Map<string, EffectName>()
    for (const effect of containers.data?.effects ?? []) map.set(effect.id, effect)
    return map
  }, [containers.data])

  const boxes = useMemo(() => {
    const record: Record<string, { width: number; height: number }> = {}
    for (const def of containers.data?.containers ?? []) {
      record[def.id] = { width: def.width, height: def.height }
    }
    return record
  }, [containers.data])

  const itemMap = useMemo(() => {
    const map = new Map<string, Item>()
    for (const item of items.data?.items ?? []) map.set(item.id, item)
    return map
  }, [items.data])

  const textureOf = useCallback((id: string) => itemMap.get(id)?.i, [itemMap])
  const nameOf = useCallback((id: string) => itemMap.get(id)?.n ?? id, [itemMap])
  const nextUid = useCallback(() => `n${Math.random().toString(36).slice(2, 9)}`, [])

  /** 输入框的当前值，钳到 1..99；空串或非数字回落到 1 */
  const stack = useMemo(() => {
    const value = Math.round(Number(stackText))
    if (!Number.isFinite(value) || value < 1) return 1
    return Math.min(99, value)
  }, [stackText])

  const selectedNode = state.nodes.find((node) => node.uid === selected) ?? null
  const selectedDef = selectedNode ? defs.get(selectedNode.container) : undefined

  const addContainer = (id: string) => {
    const def = defs.get(id)
    if (!def) return
    const spot = freeSpot(state, { width: def.width, height: def.height }, boxes)
    const uid = nextUid()
    dispatch({ type: 'add', container: id, x: spot.x, y: spot.y, uid, params: defaultParams(def) })
    setSelected(uid)
  }

  const onSlotClick = (uid: string, slot: number) => {
    const node = state.nodes.find((entry) => entry.uid === uid)
    if (!node) return
    const existing = node.items[slot]
    if (held) {
      // @why 同种物品继续点就是叠加，不同物品是替换 —— 与游戏里左键的行为一致
      const merged: PlacedItem =
        existing && existing.id === held.id
          ? { id: held.id, count: Math.min(99, existing.count + held.count) }
          : held
      dispatch({ type: 'put', uid, slot, item: merged })
      return
    }
    if (existing) {
      dispatch({ type: 'take', uid, slot })
      setHeld(existing)
    }
  }

  const onSlotHover = (uid: string, slot: number | null, at: { x: number; y: number } | null) => {
    if (slot === null || !at) {
      setTip(null)
      return
    }
    const node = state.nodes.find((entry) => entry.uid === uid)
    const item = node?.items[slot]
    if (!item) {
      setTip(null)
      return
    }
    setTip({
      x: at.x,
      y: at.y,
      title: nameOf(item.id),
      note: item.count > 1 ? `× ${item.count}` : undefined,
      sub: item.id,
    })
  }

  const runExport = async (kind: 'png' | 'psd') => {
    if (state.nodes.length === 0) {
      setNote('画布是空的，先从左边放一个容器进来')
      return
    }
    setBusy(kind)
    setNote(null)
    try {
      const options = { version, scale, lang, textureOf }
      if (kind === 'png') {
        const blob = await exportWorkspacePng(state, defs, { ...options, backdrop })
        if (!blob) {
          setNote('导出失败：画布里没有可绘制的容器')
          return
        }
        download(blob, `mc-ui-${stamp()}.png`)
      } else {
        const blob = await exportWorkspacePsd(state, defs, {
          ...options,
          backdrop: backdrop === 'transparent' ? null : backdrop === 'dark' ? '#1b1b1f' : '#f2f2f4',
        })
        if (!blob) {
          setNote('导出失败：画布里没有可绘制的容器')
          return
        }
        download(blob, `mc-ui-${stamp()}.psd`)
      }
    } catch (error) {
      setNote(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  const exportJson = () => {
    if (state.nodes.length === 0) {
      setNote('画布是空的，没有可导出的布局')
      return
    }
    const payload = serialize(state, version)
    download(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `mc-ui-${stamp()}.json`,
    )
  }

  const importJson = async (file: File) => {
    try {
      const parsed = deserialize(JSON.parse(await file.text()), nextUid)
      if (!parsed) {
        setNote('导入失败：这不是工作区布局文件')
        return
      }
      // @constraint 旧文件没有 params。不补默认值的话信标会是全灰、熔炉不燃烧，
      //      看起来像布局丢了状态。
      const filled: Workspace = {
        nodes: parsed.nodes.map((node) => {
          const def = defs.get(node.container)
          const defaults = def ? defaultParams(def) : {}
          return { ...node, params: { ...defaults, ...node.params } }
        }),
      }
      dispatch({ type: 'load', workspace: filled })
      setNote(`已导入 ${filled.nodes.length} 个容器`)
    } catch {
      setNote('导入失败：JSON 解析出错')
    }
  }

  const filtered = useMemo(() => {
    const list = (items.data?.items ?? []).filter((item) => item.id !== 'air')
    const keyword = query.trim().toLowerCase()
    if (!keyword) return list
    return list.filter(
      (item) =>
        item.id.includes(keyword) ||
        item.n.toLowerCase().includes(keyword) ||
        (item.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [items.data, query])

  const shown = filtered.slice(0, 120)

  if (containers.error) {
    return <p className="notice notice--error container">容器布局加载失败：{containers.error.message}</p>
  }

  const itemCount = state.nodes.reduce((sum, node) => sum + Object.keys(node.items).length, 0)

  return (
    <div className="workbench">
      <header className="workbench__bar">
        <Link to="/" className="text-link workbench__back">
          ← 首页
        </Link>
        <h1 className="workbench__title">界面工作台</h1>
        <span className="workbench__meta">
          {state.nodes.length} 容器 · {itemCount} 物品
        </span>
        <span className="workbench__spacer" />

        <div className="workbench__group" role="group" aria-label="缩放">
          {SCALES.map((value) => (
            <button
              key={value}
              type="button"
              className={`chip${scale === value ? ' chip--on' : ''}`}
              onClick={() => setScale(value)}
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
              onClick={() => setLang(value)}
            >
              {value === 'zh' ? '中文' : 'EN'}
            </button>
          ))}
        </div>
        <details className="menu">
          <summary className="btn">{busy ? '导出中…' : '导出'}</summary>
          <div className="menu__list">
            <button type="button" onClick={() => void runExport('png')} disabled={!!busy}>
              PNG 图片
              <span>扁平图，直接发出去</span>
            </button>
            <button type="button" onClick={() => void runExport('psd')} disabled={!!busy}>
              PSD 分层
              <span>背景 / 状态 / 物品 / 文字各一层</span>
            </button>
            <button type="button" onClick={exportJson}>
              布局 JSON
              <span>可以再导回来继续改</span>
            </button>
            <div className="menu__split">
              {/* @why 底色只影响导出，不影响画布。放在顶栏白占三个位置，
                  手机上正是这三个把「导入/清空」挤到第三行去的。 */}
              <span className="menu__label">底色</span>
              {(['transparent', 'dark', 'light'] as ExportBackdrop[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`chip${backdrop === value ? ' chip--on' : ''}`}
                  onClick={() => setBackdrop(value)}
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
              if (file) void importJson(file)
              event.target.value = ''
            }}
          />
        </label>
        <button
          type="button"
          className={`btn btn--ghost${confirmClear ? ' btn--danger' : ''}`}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true)
              // @why 二次确认要能自己退回去：点了又不删是常见的，一直杵着很碍事
              window.setTimeout(() => setConfirmClear(false), 3000)
              return
            }
            dispatch({ type: 'clear' })
            setHeld(null)
            setSelected(null)
            setNote(null)
            setConfirmClear(false)
          }}
        >
          {confirmClear ? '确认清空？' : '清空'}
        </button>
      </header>

      {note && (
        <p className="workbench__note" role="status">
          <span>{note}</span>
          <button type="button" className="workbench__note-close" onClick={() => setNote(null)}>
            ×
          </button>
        </p>
      )}

      <div className="workbench__body">
        <aside className="workbench__side workbench__side--left">
          {containers.loading && <p className="empty">读取中…</p>}
          {GROUPS.map((group) => {
            const list = group.ids.map((id) => defs.get(id)).filter((def): def is ContainerDef => !!def)
            if (!list.length) return null
            return (
              <section key={group.label} className="palette">
                <h2 className="workbench__section">{group.label}</h2>
                {list.map((def) => (
                  <button
                    key={def.id}
                    type="button"
                    className={`palette__item${def.id === 'hotbar' ? ' palette__item--hero' : ''}`}
                    onClick={() => addContainer(def.id)}
                    title={`${def.screen} · ${def.width}×${def.height} · ${def.slots.length} 槽`}
                  >
                    <span className="palette__name">{def.name}</span>
                    <span className="palette__meta">
                      {def.width}×{def.height}
                    </span>
                  </button>
                ))}
              </section>
            )
          })}
          <Link className="workbench__link" to="/browse/gui">
            GUI 贴图原图 →
          </Link>
        </aside>

        <div className="workbench__center">
          {selectedNode && selectedDef && (
            <StatePanel
              node={selectedNode}
              def={selectedDef}
              effects={effects}
              lang={lang}
              onChange={(key, value) => dispatch({ type: 'param', uid: selectedNode.uid, key, value })}
              onClose={() => setSelected(null)}
            />
          )}

          <div className="workbench__stage">
          <Stage
            workspace={state}
            defs={defs}
            version={version}
            scale={scale}
            held={held}
            textureOf={textureOf}
            lang={lang}
            selected={selected}
            onSelect={setSelected}
            onSlotClick={onSlotClick}
            onSlotContext={(uid, slot) => dispatch({ type: 'take', uid, slot })}
            onSlotHover={onSlotHover}
            onMove={(uid, x, y) => dispatch({ type: 'move', uid, x, y })}
            onFront={(uid) => dispatch({ type: 'front', uid })}
            onRemove={(uid) => {
              dispatch({ type: 'remove', uid })
              setSelected(null)
            }}
            onClone={(uid) => dispatch({ type: 'clone', uid, nextUid: nextUid() })}
          />
          </div>
        </div>

        <aside className="workbench__side workbench__side--right">
          <h2 className="workbench__section">物品</h2>
          <SearchBox value={query} onChange={setQuery} placeholder="搜索物品…" />
          <label className="stack">
            <span className="stack__label">数量</span>
            <input
              className="stack__input"
              type="number"
              min={1}
              max={99}
              inputMode="numeric"
              value={stackText}
              onChange={(event) => setStackText(event.target.value)}
              onBlur={() => setStackText(String(stack))}
            />
            <span className="stack__hint">1–99</span>
          </label>
          <p className="workbench__hint workbench__hint--held">
            {held
              ? `${nameOf(held.id)} × ${held.count} · 点格子放下，右键清空`
              : '① 点物品拿在手上　② 点格子放下'}
          </p>
          <div className="item-grid">
            {items.loading && <p className="empty">读取中…</p>}
            {shown.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`item-chip${held?.id === item.id ? ' item-chip--on' : ''}`}
                onClick={() => setHeld({ id: item.id, count: stack })}
                onPointerEnter={(event) => {
                  const box = event.currentTarget.getBoundingClientRect()
                  setTip({ x: box.left, y: box.top, title: item.n || item.id, sub: item.id })
                }}
                onPointerLeave={() => setTip(null)}
              >
                {item.n || item.id}
              </button>
            ))}
            {filtered.length > shown.length && (
              <p className="workbench__hint workbench__hint--wide">
                还有 {filtered.length - shown.length} 件，缩小搜索范围
              </p>
            )}
          </div>
        </aside>
      </div>

      <Tooltip tip={tip} version={version} />
    </div>
  )
}

/**
 * 选中容器的状态面板。
 *
 * @why 控件由 def.controls 生成，不是为每个容器手写一份表单。数据层已经声明了
 *      这个容器有哪些可变项（熔炉的燃烧进度、信标的等级与主副效果），界面照着
 *      渲染即可；新增容器时不用再改前端。
 */
function StatePanel({
  node,
  def,
  effects,
  lang,
  onChange,
  onClose,
}: {
  node: ContainerNode
  def: ContainerDef
  effects: Map<string, EffectName>
  lang: 'zh' | 'en'
  onChange: (key: string, value: number | boolean | string) => void
  onClose: () => void
}) {
  const value = (control: ContainerControl) => node.params[control.key] ?? control.default
  /**
   * @why 手机上默认收起：展开后控件占掉 280px，物品区直接被挤到屏幕外，
   *      选个东西要滚半天。桌面上画布够高，默认展开省一次点击。
   */
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 900)

  return (
    <div className="state" onPointerDown={(event) => event.stopPropagation()}>
      <div className="state__head">
        <button
          type="button"
          className="state__toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="state__title">{def.name} · 状态</span>
          <span className="state__chevron">{open ? '收起' : `${def.controls.length} 项`}</span>
        </button>
        <button type="button" className="state__close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      {open && def.controls.length === 0 && <p className="state__hint">这个容器没有可调状态</p>}
      {!open && null}
      {open && def.controls.map((control) => {
        if (control.type === 'bool') {
          const on = Boolean(value(control))
          return (
            <label key={control.key} className="state__row state__row--check">
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => onChange(control.key, event.target.checked)}
              />
              <span>{control.label}</span>
            </label>
          )
        }
        if (control.type === 'effect') {
          const current = String(value(control))
          return (
            <label key={control.key} className="state__row">
              <span className="state__label">{control.label}</span>
              <select
                className="state__select"
                value={current}
                onChange={(event) => onChange(control.key, event.target.value)}
              >
                {[...effects.values()].map((effect) => (
                  <option key={effect.id} value={effect.id}>
                    {lang === 'zh' ? effect.zh : effect.en}
                  </option>
                ))}
              </select>
            </label>
          )
        }
        if (control.type === 'int') {
          const current = Number(value(control))
          return (
            <label key={control.key} className="state__row">
              <span className="state__label">{control.label}</span>
              <input
                className="state__range"
                type="range"
                min={control.min}
                max={control.max}
                step={1}
                value={current}
                onChange={(event) => onChange(control.key, Number(event.target.value))}
              />
              <span className="state__value">{current}</span>
            </label>
          )
        }
        const current = Number(value(control))
        return (
          <label key={control.key} className="state__row">
            <span className="state__label">{control.label}</span>
            <input
              className="state__range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={current}
              onChange={(event) => onChange(control.key, Number(event.target.value))}
            />
            <span className="state__value">{Math.round(current * 100)}%</span>
          </label>
        )
      })}
    </div>
  )
}

interface StageProps {
  workspace: Workspace
  defs: Map<string, ContainerDef>
  version: string
  scale: number
  held: PlacedItem | null
  textureOf: (id: string) => string | undefined
  /** 容器标题语言，面板与导出一致 */
  lang: 'zh' | 'en'
  selected: string | null
  onSelect: (uid: string | null) => void
  onSlotClick: (uid: string, slot: number) => void
  onSlotContext: (uid: string, slot: number) => void
  onSlotHover: (uid: string, slot: number | null, at: { x: number; y: number } | null) => void
  onMove: (uid: string, x: number, y: number) => void
  onFront: (uid: string) => void
  onRemove: (uid: string) => void
  onClone: (uid: string) => void
}

function Stage({
  workspace,
  defs,
  version,
  scale,
  held,
  textureOf,
  lang,
  selected,
  onSelect,
  onSlotClick,
  onSlotContext,
  onSlotHover,
  onMove,
  onFront,
  onRemove,
  onClone,
}: StageProps) {
  const drag = useRef<{ uid: string; px: number; py: number; nx: number; ny: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null })

  const canvasSize = useMemo(() => {
    let width = 640
    let height = 420
    for (const node of workspace.nodes) {
      const def = defs.get(node.container)
      if (!def) continue
      width = Math.max(width, node.x + def.width + 120)
      height = Math.max(height, node.y + def.height + 120)
    }
    return { width, height }
  }, [workspace.nodes, defs])

  // @constraint 空画布不能套 canvasSize：手机默认 2 倍，minWidth 会是
  //     640*2=1280，而 `.stage__empty` 用 left/right 定位，提示文字就居中到
  //     屏幕外 500px 处，首次打开只看到一片空白网格（实测 rect.right=1266）。
  return (
    <div
      className={`stage${dragging ? ' stage--dragging' : ''}`}
      style={
        workspace.nodes.length === 0
          ? undefined
          : { minWidth: canvasSize.width * scale, minHeight: canvasSize.height * scale }
      }
      onPointerDown={() => onSelect(null)}
    >
      {workspace.nodes.length === 0 && (
        <div className="stage__empty">
          <p className="stage__empty-title">画布是空的</p>
          <p>先选一个容器放进来</p>
          <p>点格子摆物品，右上角导出</p>
        </div>
      )}

      {workspace.nodes.map((node) => {
        const def = defs.get(node.container)
        if (!def) return null
        const active = selected === node.uid
        return (
          <div
            key={node.uid}
            className={`stage__node${active ? ' stage__node--active' : ''}`}
            style={{ left: node.x * scale, top: node.y * scale }}
            onPointerDown={(event) => {
              // @why 槽位是按钮，按住它是在放物品不是挪容器；只从面板空白处起拖
              if ((event.target as HTMLElement).closest('.mc-slot')) return
              event.stopPropagation()
              event.currentTarget.setPointerCapture(event.pointerId)
              drag.current = { uid: node.uid, px: event.clientX, py: event.clientY, nx: node.x, ny: node.y }
              setDragging(true)
              onSelect(node.uid)
              onFront(node.uid)
            }}
            onPointerMove={(event) => {
              const current = drag.current
              if (!current || current.uid !== node.uid) return
              const dx = (event.clientX - current.px) / scale
              const dy = (event.clientY - current.py) / scale
              // @constraint 传的是未乘 scale 的 GUI 坐标：吸附容差按 GUI 像素算，
              //      乘过 scale 之后 3 倍缩放下容差只剩 1.3 像素，会吸不住。
              const others = workspace.nodes
                .filter((other) => other.uid !== node.uid)
                .map((other) => {
                  const otherDef = defs.get(other.container)
                  return otherDef
                    ? { x: other.x, y: other.y, w: otherDef.width, h: otherDef.height }
                    : null
                })
                .filter((rect): rect is NonNullable<typeof rect> => rect !== null)
              const snapped = snapMove(
                { x: current.nx + dx, y: current.ny + dy, w: def.width, h: def.height },
                others,
              )
              onMove(node.uid, snapped.x, snapped.y)
              setGuides({ x: snapped.gx, y: snapped.gy })
            }}
            onPointerUp={(event) => {
              if (drag.current) {
                event.currentTarget.releasePointerCapture(event.pointerId)
                drag.current = null
                setDragging(false)
                setGuides({ x: null, y: null })
              }
            }}
            onPointerCancel={() => {
              drag.current = null
              setDragging(false)
              setGuides({ x: null, y: null })
            }}
          >
            <ContainerPanel
              def={def}
              version={version}
              scale={scale}
              items={node.items}
              params={node.params}
              held={held}
              textureOf={textureOf}
              selected={active}
              onSlotClick={(slot) => onSlotClick(node.uid, slot)}
              onSlotContext={(slot) => onSlotContext(node.uid, slot)}
              onSlotHover={(slot, at) => onSlotHover(node.uid, slot, at)}
              lang={lang}
            />
            {active && (
              <div className="stage__tools" onPointerDown={(event) => event.stopPropagation()}>
                <span className="stage__label">{def.name}</span>
                <button type="button" onClick={() => onClone(node.uid)}>
                  复制
                </button>
                <button type="button" onClick={() => onRemove(node.uid)}>
                  删除
                </button>
              </div>
            )}
          </div>
        )
      })}

      {guides.x !== null && (
        <i className="stage__guide stage__guide--v" style={{ left: guides.x * scale }} />
      )}
      {guides.y !== null && (
        <i className="stage__guide stage__guide--h" style={{ top: guides.y * scale }} />
      )}
    </div>
  )
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  // @why 立刻回收会让部分浏览器在下载启动前就把 URL 释放掉
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
