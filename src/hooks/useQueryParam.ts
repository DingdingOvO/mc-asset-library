import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * 把「?q=」这一件事收成一处。
 *
 * @why 之前 Blocks / Items / Browse / Sounds / Particles / Registry 各抄了一份
 *      updateQuery + withQuery，六份实现里有两份忘了 replace、一份拼 query 时
 *      把已有参数丢掉。搜索词属于 URL，页面只应该关心「值是什么、怎么改」。
 *
 * @constraint 写入必须 replace：每敲一个字都往历史里塞一条记录，按返回键
 *      要按十几次才能退出页面。
 */
export function useQueryParam(key = 'q') {
  const [params, setParams] = useSearchParams()
  const value = params.get(key) ?? ''

  const setValue = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev)
          if (next) copy.set(key, next)
          else copy.delete(key)
          return copy
        },
        { replace: true },
      )
    },
    [key, setParams],
  )

  const withQuery = useCallback(
    (path: string) => {
      const suffix = params.toString()
      return suffix ? `${path}?${suffix}` : path
    },
    [params],
  )

  return useMemo(
    () => ({ value, setValue, withQuery, params }),
    [value, setValue, withQuery, params],
  )
}
