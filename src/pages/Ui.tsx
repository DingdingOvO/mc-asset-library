import { useCallback, useMemo, useState } from 'react'
import { SearchBox } from '@/components/SearchBox'
import { McTooltip, type TipState } from '@/components/McTooltip'
import { BACKDROPS as EXPORT_BACKDROPS, type ExportBackdrop } from '@/lib/containerRender'
import { loadContainers, type ContainerDef, type EffectName } from '@/lib/containers'
import { defaultParams } from '@/lib/layerRender'
import { loadItems, type Item } from '@/lib/items'
import { useAsync } from '@/lib/useAsync'
import { useWorkspace } from '@/lib/useWorkspace'
import { ItemPalette } from '@/components/workbench/ItemPalette'
import { Stage } from '@/components/workbench/Stage'
import { StatePanel } from '@/components/workbench/StatePanel'
import { Toolbar } from '@/components/workbench/Toolbar'
import { ContainerPalette } from '@/components/workbench/ContainerPalette'
import { useLibrary } from '@/lib/useLibrary'
import { runTarget, suggestName, targetsFor, type ExportTarget } from '@/lib/export/registry'
import { saveBlob } from '@/lib/export/types'
import type { LayoutSubject } from '@/lib/export/types'
import {
  deserialize,
  freeSpot,
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

function Workshop({ version }: { version: string }) {
  const containers = useAsync(`containers:${version}`, () => loadContainers(version))
  const items = useAsync(`items:${version}`, () => loadItems(version))

  const { workspace: state, dispatch, undo, redo, canUndo, canRedo } = useWorkspace()
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
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [tip, setTip] = useState<TipState | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  /** 拖拽中的物品 id 与指针位置；两者都非空时才画跟随的幽灵块 */
  const [dragItem, setDragItem] = useState<string | null>(null)
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null)

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

  /**
   * 从物品列表拖到格子上。
   *
   * @why 两步操作（点物品拿起来、再点格子放下）在 24 个容器 + 90 个格子的画布上
   *      很容易忘掉"手上还拿着东西"，然后误把物品拍进别的格子。拖拽是直接操作，
   *      拿起来和放下是同一次手势。
   * @constraint 位移小于 5px 时不当拖拽，仍然走 onClick 的"拿在手上"：
   *      否则手抖一下就把点击吞了，用户点不出物品。
   */
  const beginItemDrag = (event: React.PointerEvent, id: string) => {
    if (event.button !== 0) return
    const from = { x: event.clientX, y: event.clientY }
    let active = false

    const move = (moveEvent: PointerEvent) => {
      if (!active) {
        if (Math.hypot(moveEvent.clientX - from.x, moveEvent.clientY - from.y) < 5) return
        active = true
        setDragItem(id)
        setTip(null)
      }
      setDragAt({ x: moveEvent.clientX, y: moveEvent.clientY })
    }

    const up = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setDragItem(null)
      setDragAt(null)
      if (!active) return
      const under = document.elementFromPoint(upEvent.clientX, upEvent.clientY)
      const slotEl = under?.closest('[data-slot]') as HTMLElement | null
      const panelEl = under?.closest('[data-uid]') as HTMLElement | null
      const slot = Number(slotEl?.dataset.slot)
      const uid = panelEl?.dataset.uid
      if (!slotEl || !uid || !Number.isInteger(slot)) return
      dispatch({ type: 'put', uid, slot, item: { id, count: stack } })
      // @why 拖完继续拿着同一物品：摆一排同类物品时不用每次回去点
      setHeld({ id, count: stack })
      setSelected(uid)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onSlotClick = (uid: string, slot: number) => {    const node = state.nodes.find((entry) => entry.uid === uid)
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

  const onSlotHover = (uid: string, slot: number | null, at: { x: number; y: number } | null) => {    if (slot === null || !at) {
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

  /**
   * 导出对象。
   * @why 把所有渲染参数收成一个 subject，导出目标只认这个对象。
   *      以前每个按钮各拼一遍 options，加一种格式就要再抄一次参数，
   *      PSD 与 PNG 的底色因此还曾经对不上（一个用 hex，一个用枚举）。
   */
  const layoutSubject = useMemo<LayoutSubject>(
    () => ({
      kind: 'layout',
      name: 'mc-ui',
      workspace: state,
      defs,
      options: { version, scale, lang, textureOf },
      backdrop: backdrop === 'transparent' ? null : EXPORT_BACKDROPS[backdrop],
    }),
    [state, defs, version, scale, lang, textureOf, backdrop],
  )

  const exportTargets = useMemo(() => targetsFor(layoutSubject), [layoutSubject])

  const runExport = async (target: ExportTarget) => {
    if (state.nodes.length === 0) {
      setNote('画布是空的，先从左边放一个容器进来')
      return
    }
    setBusy(target.id)
    setNote(null)
    try {
      const blob = await runTarget(layoutSubject, target)
      if (!blob) {
        setNote('导出失败：画布里没有可绘制的容器')
        return
      }
      saveBlob(blob, suggestName(layoutSubject, target))
    } catch (error) {
      setNote(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
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

  /**
   * 清空画布。
   * @why 两步确认而不是弹窗：清空是不可撤销的（历史栈会被一起丢掉），但弹窗
   *      打断太强。按钮文字变成"确认清空？"并 3 秒后自己退回，点两下就删，
   *      犹豫一下也不会误删。
   */
  const onClear = () => {
    if (!confirmClear) {
      setConfirmClear(true)
      window.setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    dispatch({ type: 'clear' })
    setHeld(null)
    setSelected(null)
    setNote(null)
    setConfirmClear(false)
  }

  return (
    <div className="workbench">
      <Toolbar
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        scale={scale}
        onScale={setScale}
        lang={lang}
        onLang={setLang}
        busy={busy}
        backdrop={backdrop}
        onBackdrop={setBackdrop}
        exportTargets={exportTargets}
        onExport={(target) => void runExport(target)}
        onImport={(file) => void importJson(file)}
        confirmClear={confirmClear}
        onClear={onClear}
        containerCount={state.nodes.length}
        itemCount={itemCount}
      />

      {dragItem && dragAt && (
        <div className="drag-ghost" style={{ left: dragAt.x, top: dragAt.y }} aria-hidden="true">
          <span className="drag-ghost__name">{nameOf(dragItem)}</span>
          <span className="drag-ghost__count">× {stack}</span>
        </div>
      )}

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
          <ContainerPalette defs={defs} loading={containers.loading} onAdd={addContainer} />
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
          {items.loading && <p className="empty">读取中…</p>}
          <ItemPalette
            version={version}
            items={shown}
            heldId={held?.id ?? null}
            onPick={(item) => setHeld({ id: item.id, count: stack })}
            onDragStart={(event, id) => beginItemDrag(event, id)}
            onHover={(item, at) =>
              setTip(item && at ? { x: at.x, y: at.y, title: item.n || item.id, sub: item.id } : null)
            }
            truncated={filtered.length - shown.length}
          />
        </aside>
      </div>

      <McTooltip tip={tip} version={version} />
    </div>
  )
}

