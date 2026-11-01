import { loadManifest, type McVersion } from './mc'
import { useAsync } from './useAsync'

export interface LibraryState {
  version: string | null
  current: McVersion | null
  loading: boolean
  error: Error | null
}

/** @why 版本清单是全局唯一入口，多个页面共用一次请求 */
export function useLibrary(): LibraryState {
  const { data, error, loading } = useAsync('manifest', loadManifest)
  const version = data?.latest ?? null
  const current = data?.versions.find((item) => item.id === version) ?? null

  return {
    version,
    current,
    loading: loading || (!data && !error),
    error,
  }
}
