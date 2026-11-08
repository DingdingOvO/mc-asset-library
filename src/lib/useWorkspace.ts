import { useCallback, useEffect, useReducer } from 'react'
import { emptyWorkspace, workspaceReducer, type Workspace, type WorkspaceAction } from './workspace'

/**
 * 工作区的撤销 / 重做。
 *
 * @why 摆一个界面是几百次「点物品、点格子」，误删一个容器就得从头再摆。游戏里
 *      开箱子没有撤销，但编辑器没有撤销就是不能用。
 *
 * @constraint `move` 和 `param` 必须合并：拖一次鼠标会产生上百个 move，滑块从
 *      0 拖到 100 也会产生上百个 param。每个都进历史的话，按一次 Ctrl+Z 只会
 *      退回 1 像素，用户会以为撤销坏了。
 */

export type HistoryAction = WorkspaceAction | { type: 'undo' } | { type: 'redo' }

export interface HistoryState {
  past: Workspace[]
  present: Workspace
  future: Workspace[]
  /** 上一步的签名，用来判断要不要合并 */
  last: { key: string; at: number } | null
}

const LIMIT = 80
/** 同一类操作在这个时间内连续发生，认为是一次（毫秒） */
const COALESCE_MS = 700

const keyOf = (action: WorkspaceAction): string => {
  if (action.type === 'move') return `move:${action.uid}`
  if (action.type === 'param') return `param:${action.uid}`
  return action.type
}

/**
 * @constraint 只有 move / param 允许合并。曾经把 add 也算进去，结果连点两个容器
 *      后按一次撤销，两个一起消失——因为两次 add 的 key 都是 `add`，命中了合并窗口。
 */
const MERGEABLE = new Set(['move', 'param'])

export function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past[state.past.length - 1]
    if (!previous) return state
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, LIMIT),
      // @constraint 撤销后要清掉合并签名：否则下一次 move 会试图合并到
      //      「已经被撤销掉的那一步」上，历史栈里出现重复帧。
      last: null,
    }
  }
  if (action.type === 'redo') {
    const next = state.future[0]
    if (!next) return state
    return {
      past: [...state.past, state.present].slice(-LIMIT),
      present: next,
      future: state.future.slice(1),
      last: null,
    }
  }

  const present = workspaceReducer(state.present, action)
  if (present === state.present) return state

  const key = keyOf(action)
  const now = Date.now()
  const merge =
    MERGEABLE.has(action.type) &&
    state.last !== null &&
    state.last.key === key &&
    now - state.last.at < COALESCE_MS

  return {
    past: merge ? state.past : [...state.past, state.present].slice(-LIMIT),
    present,
    future: [],
    last: { key, at: now },
  }
}

export interface WorkspaceApi {
  workspace: Workspace
  dispatch: (action: HistoryAction) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
}

export function useWorkspace(): WorkspaceApi {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: emptyWorkspace(),
    future: [],
    last: null,
  }))

  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      // @why 输入框里的 Ctrl+Z 是文本框自己的撤销，抢过来会把用户刚输入的数量吞掉
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        if (event.shiftKey) redo()
        else undo()
      } else if (key === 'y') {
        event.preventDefault()
        redo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  return {
    workspace: history.present,
    dispatch,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  }
}
