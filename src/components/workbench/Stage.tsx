import { useMemo, useRef, useState } from 'react'
import { ContainerPanel } from '@/components/ContainerPanel'
import { snapMove } from '@/lib/snap'
import type { ContainerDef } from '@/lib/containers'
import type { PlacedItem, Workspace } from '@/lib/workspace'

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

export function Stage({
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
            data-uid={node.uid}
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
