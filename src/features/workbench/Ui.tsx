import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ErrorState, LoadingState, SearchField } from '@/ui'
import { McTooltip, type TipState } from '@/components/McTooltip'
import { SiteTip, type SiteTipState } from '@/components/SiteTip'
import { ICON_PIXELS, ensureIcon, iconKey, iconUrl } from '@/lib/itemIcon'
import { BACKDROPS as EXPORT_BACKDROPS, type ExportBackdrop } from '@/lib/containerRender'
import type { PinnedTip } from '@/lib/exportLayers'
import { activeModern, normalizeModern, readModernCache, writeModernCache, type ModernUi } from '@/lib/modern'
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
import { ScreenStudio } from '@/components/workbench/ScreenStudio'
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

  if (error) {
    return (
      <div className="ui-boot">
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </div>
    )
  }
  if (loading || !version) {
    return (
      <div className="ui-boot">
        <LoadingState label="正在读取容器布局…" />
      </div>
    )
  }

  return <UiBody version={version} />
}

/**
 * 页签：容器工作台 + 三种非容器界面。
 *
 * @why 告示牌 / 书 / 地图没有槽位和物品，数据模型与容器完全不同，硬塞进同一个
 *      工作台会让 `Workspace` 里长出一半用不到的字段。放在同一页的不同页签里，
 *      共用的只有字体、缩放与导出。
 */
const TABS = [
  { id: 'workbench', zh: '容器工作台' },
  { id: 'sign', zh: '告示牌' },
  { id: 'book', zh: '书与笔' },
  { id: 'map', zh: '地图' },
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * 手持条上的小图标。
 *
 * @why 复用物品栏的同一份图标缓存（`ICON_PIXELS` 键），不另开一张位图：
 *      浮条和格子里显示的必须是同一张图，否则同一件物品在两处颜色会差一点
 *      （两次渲染的缩放取整不同）。
 */
function HeldIcon({ version, id, texture }: { version: string; id: string; texture?: string }) {
  const key = iconKey(version, id, ICON_PIXELS)
  const [url, setUrl] = useState<string | null>(() => iconUrl(key))

  useEffect(() => {
    const hit = iconUrl(key)
    if (hit) {
      setUrl(hit)
      return
    }
    let alive = true
    void ensureIcon(version, id, texture ?? '', ICON_PIXELS).then(() => {
      if (alive) setUrl(iconUrl(key))
    })
    return () => {
      alive = false
    }
  }, [key, version, id, texture])

  return url ? <img className="held-bar__icon" src={url} alt="" draggable={false} /> : null
}

function UiBody({ version }: { version: string }) {
  const [params, setParams] = useSearchParams()
  const raw = params.get('view')
  const tab: TabId = TABS.some((item) => item.id === raw) ? (raw as TabId) : 'workbench'

  const pick = (id: TabId) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id === 'workbench') next.delete('view')
        else next.set('view', id)
        return next
      },
      { replace: true },
    )
  }

  /**
   * 页签与工具同处一行。
   * @why 之前是三条横栏：顶栏 / 页签 / 工具栏。手机上三条就吃掉了 200px，
   *      画布只剩不到 400px 高。页签本质上是「换了哪张画布」，和工具栏是同一层
   *      级的上下文切换，合并成一条之后省下整整一行。
   */
  const tabs = (
    <nav className="ui-tabs" aria-label="界面类型">
      {TABS.map((item) => (
        <button
          key={item.id}
          type="button"
          className="ui-tabs__item"
          aria-pressed={item.id === tab}
          onClick={() => pick(item.id)}
        >
          {item.zh}
        </button>
      ))}
    </nav>
  )

  return (
    <div className="ui-shell">
      {tab === 'workbench' ? (
        <Workshop version={version} tabs={tabs} />
      ) : (
        <ScreenStudio version={version} kind={tab} tabs={tabs} />
      )}
    </div>
  )
}

/**
 * 锁定的提示在画布上的样子。
 *
 * @why 锁定的意义是「所见即导出」：如果只在导出时画出提示框，用户在画布上
 *      看不到它压在哪一格、会不会盖住隔壁的格子。这里复用同一个 McTooltip，
 *      屏幕和导出走同一份几何。
 *
 * @constraint 位置必须实时测量，不能只在锁定那一下算一次：画布可以滚、可以换
 *      缩放倍率、容器可以被拖动，任何一个动了，提示框留在原地就成了错位的贴纸。
 *      用 rAF 合并，滚动时不会每一帧重排整棵 React 树。
 */
function PinnedTips({
  pins,
  workspace,
  version,
  nameOf,
  modern,
}: {
  pins: PinnedTip[]
  workspace: Workspace
  version: string
  nameOf: (id: string) => string
  modern?: ModernUi
}) {
  const [spots, setSpots] = useState<{ key: string; x: number; y: number; title: string; note?: string }[]>([])

  useLayoutEffect(() => {
    if (!pins.length) {
      setSpots([])
      return
    }
    let frame = 0
    const measure = () => {
      frame = 0
      const stage = document.querySelector('.workbench__stage')
      const next: typeof spots = []
      for (const pin of pins) {
        const node = workspace.nodes.find((entry) => entry.uid === pin.uid)
        const item = node?.items[pin.slot]
        if (!item) continue
        const el = stage?.querySelector(
          `[data-uid="${pin.uid}"] [data-slot="${pin.slot}"]`,
        ) as HTMLElement | null
        if (!el) continue
        const rect = el.getBoundingClientRect()
        next.push({
          key: `${pin.uid}-${pin.slot}`,
          x: rect.right,
          y: rect.top + rect.height / 2,
          title: nameOf(item.id),
          note: item.count > 1 ? String(item.count) : undefined,
        })
      }
      setSpots(next)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    measure()
    // @constraint capture 必须开：画布的滚动发生在内层元素上，scroll 不冒泡，
    //      只有捕获阶段才能在 window 上收到。
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    const stage = document.querySelector('.workbench__stage')
    const observer = stage ? new ResizeObserver(schedule) : null
    if (stage && observer) observer.observe(stage)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
    }
  }, [pins, workspace, nameOf])

  return (
    <>
      {spots.map((spot) => (
        <McTooltip
          key={spot.key}
          version={version}
          modern={modern}
          tip={{ x: spot.x, y: spot.y, title: spot.title, note: spot.note }}
        />
      ))}
    </>
  )
}

function Workshop({ version, tabs }: { version: string; tabs: React.ReactNode }) {
  const containers = useAsync(`containers:${version}`, () => loadContainers(version))
  const items = useAsync(`items:${version}`, () => loadItems(version))

  const { workspace: state, dispatch, undo, redo, canUndo, canRedo } = useWorkspace()
  /**
   * 容器缩放倍率。
   * @why 默认值按视口宽度分档：宽屏画布高 700+，3 倍下三行箱子 528 高正好装得下，
   *      2 倍反而显得画面缩在角落；窄屏只有 2 倍才放得下 176 宽的容器。
   *      取一次初始值即可，之后由用户点角上的倍率按钮决定。
   */
  const [scale, setScale] = useState<number>(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1200 ? 3 : 2,
  )
  const [held, setHeld] = useState<PlacedItem | null>(null)
  /**
   * 手机上物品区是底部抽屉。
   * @why 默认收起：一打开页面时用户的第一件事是摆容器，不是挑物品；抽屉收起
   *      状态仍然露出把手和一行物品，随时能拉开。桌面上这个 state 不影响布局。
   */
  const [trayOpen, setTrayOpen] = useState(false)
  /** 输入框里的原始字符串：允许中途为空，提交时才钳到 1..99 */
  const [stackText, setStackText] = useState('64')
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [backdrop, setBackdrop] = useState<ExportBackdrop>('transparent')
  // @why 默认中文：站点是给中文用户做视频用的。做官方截图还原时切回英文原版
  const [lang, setLang] = useState<'zh' | 'en'>('zh')
  const [busy, setBusy] = useState<string | null>(null)
  /** 画布滚动容器：新增容器后用它把新节点滚进视野 */
  const stageRef = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<string | null>(null)
  /**
   * 两种悬停提示分开存：`slotTip` 画在容器里（原版九宫格），
   * `paletteTip` 是物品栏那个网页控件（站点浮层）。混用一个状态就会出现
   * 「在物品栏上悬停，弹出的却是游戏提示框」。
   */
  const [slotTip, setSlotTip] = useState<TipState | null>(null)
  const [paletteTip, setPaletteTip] = useState<SiteTipState | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  /**
   * 锁定的悬停提示。
   * @why 提示框只在指针悬停时存在，一移动就没了，做视频截不到。
   *      锁定之后它成为一个可导出元素：屏幕上跟着槽位走，导出时按同一份几何
   *      画进图里。
   */
  const [pins, setPins] = useState<PinnedTip[]>([])
  /** 当前悬停的槽位，锁定时用它作为目标 */
  const [hoverSlot, setHoverSlot] = useState<PinnedTip | null>(null)
  /**
   * 现代化 UI 参数组（含总开关），导出与屏幕共用同一份。
   * @why 存的是「用户调出来的一整套」，不是「当前生效的」——总开关关掉时
   *      参数要留着，重新打开还原。生效值一律过 `activeModern`。
   */
  const [modern, setModern] = useState<ModernUi>(() => normalizeModern(readModernCache()))
  /** 真正拿去渲染的那一份：总开关关掉时等于原版 */
  const appliedModern = useMemo(() => activeModern(modern), [modern])
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

  /**
   * 键盘退出路径。
   * @why 「手上拿着东西」是个隐形状态：没有 Esc 时，桌面用户唯一的退出方式是
   *      精确点到那条浮条上的「放下」，或者去右侧把数量改成 0。Delete 同理——
   *      选中容器后除了画布上方那两粒小按钮没有别的删除入口。
   * @constraint 输入框内一律不接管：数字框里按 Esc 应该只退出输入焦点。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const el = event.target as HTMLElement | null
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      if (event.key === 'Escape') {
        if (held) {
          setHeld(null)
          event.preventDefault()
        } else if (selected) {
          setSelected(null)
          event.preventDefault()
        }
        return
      }
      if (event.key === 'Delete' && selected) {
        dispatch({ type: 'remove', uid: selected })
        setSelected(null)
        event.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [held, selected, dispatch])

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
    /**
     * @why 空位是从左上角往后排的，第五个容器可能落在可视区之外——点一下列表
     *      什么都没出现，看起来像坏了。新容器只要不在视野内就把它滚进来。
     * @constraint 用 rAF 等一次提交：dispatch 之后 DOM 还是旧的，这时候量
     *      scrollWidth 拿不到新节点的尺寸。
     */
    requestAnimationFrame(() => {
      const el = stageRef.current
      if (!el) return
      const left = spot.x * scale
      const top = spot.y * scale
      const right = left + def.width * scale
      const bottom = top + def.height * scale
      if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) {
        el.scrollLeft = Math.max(0, left - 16)
      }
      if (top < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = Math.max(0, top - 16)
      }
    })
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
        setSlotTip(null)
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

  const onSlotHover = (uid: string, slot: number | null, at: { x: number; y: number } | null) => {
    if (slot === null || !at) {
      setSlotTip(null)
      /**
       * @why 这里**不清** hoverSlot：锁定的动作是「悬停槽位 → 移鼠标到顶栏的
       *      样式菜单 → 点锁定」，鼠标一离开槽位就清空的话，点下去之前目标
       *      就没了，按钮永远停在「先悬停格子」。这里记住的是「最近一次悬停
       *      过的格子」，指哪锁哪。
       */
      return
    }
    setHoverSlot({ uid, slot })
    const node = state.nodes.find((entry) => entry.uid === uid)
    const item = node?.items[slot]
    if (!item) {
      setSlotTip(null)
      return
    }
    setSlotTip({
      x: at.x,
      y: at.y,
      title: nameOf(item.id),
      note: item.count > 1 ? String(item.count) : undefined,
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
      options: { version, scale, lang, textureOf, tips: pins, modern: appliedModern, nameOf },
      backdrop: backdrop === 'transparent' ? null : EXPORT_BACKDROPS[backdrop],
    }),
    [state, defs, version, scale, lang, textureOf, backdrop, pins, appliedModern, nameOf],
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
    return (
      <div className="ui-boot">
        <ErrorState title="容器布局加载失败" detail={containers.error.message} />
      </div>
    )
  }

  const itemCount = state.nodes.reduce((sum, node) => sum + Object.keys(node.items).length, 0)

  /**
   * 指向空格子的锁定提示。
   * @why 物品被拿走或容器被删之后，锁定项不会自动消失（用户可能只是临时清空，
   *      还想再放回来）。但导出时它画不出内容，得提前说清楚，否则用户会以为
   *      导出丢了东西。
   */
  const stalePins = pins.filter((pin) => {
    const node = state.nodes.find((entry) => entry.uid === pin.uid)
    return !node || !node.items[pin.slot]
  }).length

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
        tabs={tabs}
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
        modern={modern}
        onModern={(updater) =>
          setModern((prev) => {
            const next = updater(prev)
            writeModernCache(next)
            return next
          })
        }
        pins={pins}
        hoverSlot={hoverSlot}
        onPin={(pin) =>
          setPins((prev) =>
            prev.some((entry) => entry.uid === pin.uid && entry.slot === pin.slot) ? prev : [...prev, pin],
          )
        }
        onUnpin={(pin) =>
          setPins((prev) => prev.filter((entry) => !(entry.uid === pin.uid && entry.slot === pin.slot)))
        }
        staleCount={stalePins}
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
          <ContainerPalette
            defs={defs}
            loading={containers.loading}
            onAdd={addContainer}
            onHover={(text, at) => setPaletteTip(text && at ? { ...text, ...at } : null)}
          />
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
              onClone={() => dispatch({ type: 'clone', uid: selectedNode.uid, nextUid: nextUid() })}
              onRemove={() => {
                dispatch({ type: 'remove', uid: selectedNode.uid })
                setSelected(null)
              }}
            />
          )}

          <div className="workbench__canvas">
          <div className="workbench__stage" ref={stageRef}>
          <Stage
            workspace={state}
            defs={defs}
            version={version}
            scale={scale}
            held={held}
            textureOf={textureOf}
            lang={lang}
            modern={appliedModern}
            selected={selected}
            onSelect={setSelected}
            onSeed={addContainer}
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

          {/* 手上拿着东西时才出现：它是「第二步还没有反馈」这个问题的唯一答案 */}
          {held && (
            <div className="held-bar" role="status">
              <HeldIcon version={version} id={held.id} texture={textureOf(held.id)} />
              <span className="held-bar__name">{nameOf(held.id)}</span>
              <span className="held-bar__count">×{held.count}</span>
              <span className="held-bar__hint">点格子放下</span>
              <button type="button" className="held-bar__drop" onClick={() => setHeld(null)}>
                放下
              </button>
            </div>
          )}
          {/* 手机上缩放挪到画布角上；桌面上这两条都 display:none，用顶栏那一组 */}
          <div className="stage__zoom" role="group" aria-label="缩放">
            {[1, 2, 3, 4].map((value) => (
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
          {/* @why 窄屏用单键循环而不是四个倍率并排：四个按钮要 130px 宽，
              390px 的画布上会盖掉容器右上角一整格。缩放不是高频操作，
              点两下能到目标倍率就够了。 */}
          <button
            type="button"
            className="stage__zoom-btn"
            onClick={() => setScale(scale >= 4 ? 1 : scale + 1)}
            title="切换容器缩放倍率"
          >
            {scale}×
          </button>
          </div>
          <PinnedTips pins={pins} workspace={state} version={version} nameOf={nameOf} modern={appliedModern} />
        </div>

        <aside className={`workbench__side workbench__side--right${trayOpen ? ' is-open' : ''}`}>
          {/* 手机上物品区是抽屉，把手必须在收起时也可见；桌面上这一条 display:none */}
          <button
            type="button"
            className="workbench__tray-toggle"
            aria-expanded={trayOpen}
            onClick={() => setTrayOpen((value) => !value)}
          >
            <b>物品</b>
            {/* @why 报全量匹配数而不是 shown.length：后者是 120 的截断上限，
                搜索"石"时明明有 40 件也显示 120。 */}
            <em>{filtered.length} 件</em>
            {held && <em>· 手上 ×{held.count}</em>}
            <i aria-hidden="true">{trayOpen ? '▾' : '▴'}</i>
          </button>

          <div className="workbench__tray">
            <h2 className="workbench__section">物品</h2>
            <SearchField value={query} onChange={setQuery} placeholder="搜索物品…" />
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
              {held ? '点格子放下 · 右键清空格子' : '点物品拿在手上，再点格子放下'}
            </p>
            {items.loading && <p className="workbench__hint">读取物品中…</p>}
            <div className="workbench__tray-scroll">
              <ItemPalette
                version={version}
                items={shown}
                heldId={held?.id ?? null}
                onPick={(item) => {
                  setHeld({ id: item.id, count: stack })
                  /**
                   * @why 手机上选完物品就收起抽屉：这是"选物品 → 放格子"里最关键
                   *      的一步。抽屉展开时画布只剩 220px，3 行箱子都装不下，
                   *      用户拿到物品却看不见要放的地方。收起后画布翻倍。
                   */
                  if (window.matchMedia('(max-width: 900px)').matches) setTrayOpen(false)
                }}
                onDragStart={(event, id) => beginItemDrag(event, id)}
                onHover={(item, at) =>
                  setPaletteTip(item && at ? { x: at.x, y: at.y, title: item.n || item.id, sub: item.id } : null)
                }
                truncated={filtered.length - shown.length}
              />
            </div>
          </div>
        </aside>
      </div>

      <McTooltip tip={slotTip} version={version} modern={appliedModern} />
      <SiteTip tip={paletteTip} />
    </div>
  )
}

