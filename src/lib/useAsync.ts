import { useEffect, useRef, useState } from 'react'

export interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
}

/**
 * @why key 变化才重新请求，loader 用 ref 保存避免每次渲染都触发 effect
 */
export function useAsync<T>(key: string, load: () => Promise<T>): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true })
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    let alive = true
    setState({ data: null, error: null, loading: true })
    loadRef.current().then(
      (data) => {
        if (alive) setState({ data, error: null, loading: false })
      },
      (error: unknown) => {
        if (alive) {
          setState({
            data: null,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          })
        }
      },
    )
    return () => {
      alive = false
    }
  }, [key])

  return state
}
