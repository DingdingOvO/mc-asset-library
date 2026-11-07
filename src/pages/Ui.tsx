import { useCallback, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ContainerPanel } from '@/components/ContainerPanel'
import { SearchBox } from '@/components/SearchBox'
import { exportWorkspacePng, type ExportBackdrop } from '@/lib/containerRender'
import { loadContainers, type ContainerDef } from '@/lib/containers'
import { loadItems, type Item } from '@/lib/items'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import {
  deserialize,
  emptyWorkspace,
  freeSpot,
  serialize,
  workspaceReducer,
  type PlacedItem,
  type Workspace,
} from '@/lib/workspace'

/**
 * 界面页 = 容器工作台。
 *
 * @why 之前这页是 GUI 贴图墙：一格一张 img，能看不能动。而资源包作者真正要的是
 *      「摆一个箱子、把物品排进去、导出一张像截图的预览图」。所以页面主体换成
 *      画布：左边选容器丢进来，槽位可直接放物品，最后整体导出。容器尺寸、槽位
 *      坐标、背景切片全部来自反编译源码的提取结果，不是照图估的。
 */
export default function Ui() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取容器布局…</p>

  return <Workshop version={version} />
}

const SCALES = [2, 3, 4] as const
const STACKS = [1, 8, 16, 32, 64] as const

function Workshop({ version }: { version: string }) {
  const containers = useAsync(`containers:${version}`, () => loadContainers(version))
  const items = useAsync(`items:${version}`, () => loadItems(version))

  const [state, dispatch] = useReducer(workspaceReducer, undefined, emptyWorkspace)
  // @why 手机上 3 倍放大的容器比屏幕宽得多，默认降到 2 倍，少滚一点
  const [scale, setScale] = useState<number>(() =>
    typeof window !== 'undefined' && window.innerWidth < 720 ? 2 : 3,
  )
  const [held, setHeld] = useState<PlacedItem | null>(null)
  const [stack, setStack] = useState<number>(64)
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [backdrop, setBackdrop] = useState<ExportBackdrop>('transparent')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const defs = useMemo(() => {
    const map = new Map<string, ContainerDef>()
    for (const def of containers.data?.containers ?? []) map.set(def.id, def)
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
  const nextUid = useCallback(() => `n${Math.random().toString(36).slice(2, 9)}`, [])

  const addContainer = (id: string) => {
    const def = defs.get(id)
    if (!def) return
    const spot = freeSpot(state, { width: def.width, height: def.height }, boxes)
    dispatch({ type: 'add', container: id, x: spot.x, y: spot.y, uid: nextUid() })
    setSelected(null)
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

  const exportPng = async () => {
    if (state.nodes.length === 0) {
      setNote('画布是空的，先从左边放一个容器进来')
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const blob = await exportWorkspacePng(state, defs, version, scale, backdrop, textureOf)
      if (!blob) {
        setNote('导出失败：画布里没有可绘制的容器')
        return
      }
      download(blob, `mc-ui-${stamp()}.png`)
    } finally {
      setBusy(false)
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
      dispatch({ type: 'load', workspace: parsed })
      setNote(`已导入 ${parsed.nodes.length} 个容器`)
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

  const shown = filtered.slice(0, 96)

  if (containers.error) {
    return <p className="notice notice--error container">容器布局加载失败：{containers.error.message}</p>
  }

  return (
    <div className="workbench">
      <header className="workbench__bar">
        <Link to="/" className="text-link workbench__back">
          ← 首页
        </Link>
        <h1 className="workbench__title">界面工作台</h1>
        <span className="workbench__meta">
          {state.nodes.length} 容器 ·{' '}
          {state.nodes.reduce((sum, node) => sum + Object.keys(node.items).length, 0)} 物品
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
        <div className="workbench__group" role="group" aria-label="导出底色">
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
        <button type="button" className="btn" onClick={exportPng} disabled={busy}>
          {busy ? '导出中…' : '导出 PNG'}
        </button>
        <button type="button" className="btn btn--ghost" onClick={exportJson}>
          导出布局
        </button>
        <label className="btn btn--ghost">
          导入布局
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
          className="btn btn--ghost"
          onClick={() => {
            dispatch({ type: 'clear' })
            setHeld(null)
            setSelected(null)
            setNote(null)
          }}
        >
          清空
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
        <aside className="workbench__side">
          <h2 className="workbench__section">容器</h2>
          <p className="workbench__hint">点一下放进画布</p>
          {/* @why 这一页以前就是 GUI 贴图墙，改成工作台后贴图不能凭空消失：
              资源包作者改按钮底图时还要按原图逐个看 */}
          <Link className="workbench__link" to="/browse/gui">
            GUI 贴图原图 →
          </Link>
          <div className="palette">
            {containers.loading && <p className="empty">读取中…</p>}
            {(containers.data?.containers ?? []).map((def) => (
              <button
                key={def.id}
                type="button"
                className="palette__item"
                onClick={() => addContainer(def.id)}
                title={`${def.screen} · ${def.width}×${def.height} · ${def.slots.length} 槽`}
              >
                <span className="palette__name">{def.name}</span>
                <span className="palette__meta">
                  {def.width}×{def.height} · {def.slots.length}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <div className="workbench__stage">
          <Stage
            workspace={state}
            defs={defs}
            version={version}
            scale={scale}
            held={held}
            textureOf={textureOf}
            selected={selected}
            onSelect={setSelected}
            onSlotClick={onSlotClick}
            onSlotContext={(uid, slot) => dispatch({ type: 'take', uid, slot })}
            onMove={(uid, x, y) => dispatch({ type: 'move', uid, x, y })}
            onFront={(uid) => dispatch({ type: 'front', uid })}
            onRemove={(uid) => {
              dispatch({ type: 'remove', uid })
              setSelected(null)
            }}
            onClone={(uid) => dispatch({ type: 'clone', uid, nextUid: nextUid() })}
          />
        </div>

        <aside className="workbench__side workbench__side--right">
          <h2 className="workbench__section">物品</h2>
          <SearchBox value={query} onChange={setQuery} placeholder="搜索物品…" />
          <div className="workbench__group" role="group" aria-label="堆叠数量">
            {STACKS.map((value) => (
              <button
                key={value}
                type="button"
                className={`chip${stack === value ? ' chip--on' : ''}`}
                onClick={() => {
                  setStack(value)
                  setHeld((current) => (current ? { ...current, count: value } : current))
                }}
              >
                ×{value}
              </button>
            ))}
          </div>
          <p className="workbench__hint workbench__hint--held">
            {held ? `手上：${held.id} × ${held.count}` : '点物品拿在手上，再点槽位放下'}
          </p>
          <div className="item-grid">
            {items.loading && <p className="empty">读取中…</p>}
            {shown.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`item-chip${held?.id === item.id ? ' item-chip--on' : ''}`}
                onClick={() => setHeld({ id: item.id, count: stack })}
                title={`${item.n}\n${item.id}`}
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
  selected: string | null
  onSelect: (uid: string | null) => void
  onSlotClick: (uid: string, slot: number) => void
  onSlotContext: (uid: string, slot: number) => void
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
  selected,
  onSelect,
  onSlotClick,
  onSlotContext,
  onMove,
  onFront,
  onRemove,
  onClone,
}: StageProps) {
  const drag = useRef<{ uid: string; px: number; py: number; nx: number; ny: number } | null>(null)

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

  return (
    <div
      className="stage"
      style={{ minWidth: canvasSize.width * scale, minHeight: canvasSize.height * scale }}
      onPointerDown={() => onSelect(null)}
    >
      {workspace.nodes.length === 0 && (
        <div className="stage__empty">
          <p>画布是空的</p>
          <p>从左边点一个容器放进来，再把右边的物品点进槽位</p>
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
              onSelect(node.uid)
              onFront(node.uid)
            }}
            onPointerMove={(event) => {
              const current = drag.current
              if (!current || current.uid !== node.uid) return
              const dx = (event.clientX - current.px) / scale
              const dy = (event.clientY - current.py) / scale
              onMove(node.uid, Math.round(current.nx + dx), Math.round(current.ny + dy))
            }}
            onPointerUp={(event) => {
              if (drag.current) {
                event.currentTarget.releasePointerCapture(event.pointerId)
                drag.current = null
              }
            }}
            onPointerCancel={() => {
              drag.current = null
            }}
          >
            <ContainerPanel
              def={def}
              version={version}
              scale={scale}
              items={node.items}
              held={held}
              textureOf={textureOf}
              selected={active}
              onSlotClick={(slot) => onSlotClick(node.uid, slot)}
              onSlotContext={(slot) => onSlotContext(node.uid, slot)}
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
