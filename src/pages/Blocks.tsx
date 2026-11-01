import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import { SearchBox } from '@/components/SearchBox'
import { loadBlockModels } from '@/lib/blockmodels'
import { loadRegistries } from '@/lib/registries'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { useVirtualGrid } from '@/lib/useVirtualGrid'

export default function Blocks() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取方块数据…</p>

  return <BlockBrowser version={version} />
}

function BlockBrowser({ version }: { version: string }) {
  const models = useAsync(`blockmodels:${version}`, () => loadBlockModels(version))
  const registries = useAsync(`registries:${version}`, () => loadRegistries(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  // @why 半截方块（门/床/高花）单独渲染必然残缺，默认收起，需要时再放开
  const [showHidden, setShowHidden] = useState(false)

  const names = useMemo(() => {
    const map = new Map<string, { n: string; e: string | null }>()
    for (const registry of registries.data?.registries ?? []) {
      if (registry.id !== 'blocks') continue
      for (const entry of registry.entries) map.set(entry.id, { n: entry.n, e: entry.e })
    }
    return map
  }, [registries.data])

  const hiddenSet = useMemo(() => new Set(models.data?.hidden ?? []), [models.data])

  /**
   * @constraint 每个条目的 subject 必须缓存：ModelView 的渲染 effect 依赖它，
   *             每次渲染都新建对象会让滚动时所有卡片重新加载纹理。
   */
  const subjects = useMemo(() => {
    const textures = models.data?.textures ?? []
    const frames = models.data?.frames ?? []
    const displays = models.data?.displays ?? {}
    const map = new Map<string, Subject>()
    for (const [id, faces] of Object.entries(models.data?.blocks ?? {})) {
      map.set(id, { kind: 'block', faces, textures, frames, display: displays[id], flat: false })
    }
    return map
  }, [models.data])

  const all = useMemo(
    () =>
      [...subjects.keys()]
        .filter((id) => showHidden || !hiddenSet.has(id))
        .sort()
        .map((id) => ({ id, n: names.get(id)?.n ?? id, e: names.get(id)?.e ?? null })),
    [subjects, names, showHidden, hiddenSet],
  )

  const query = params.get('q') ?? ''

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return all
    return all.filter(
      (block) =>
        block.id.includes(keyword) ||
        block.n.toLowerCase().includes(keyword) ||
        (block.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [all, query])

  // @why 卡片是 Canvas 软件光栅化，全量铺开必卡；虚拟滚动只渲染视口附近
  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 120,
    minColumnWidth: 104,
  })
  const total = filtered.length

  const updateQuery = (value: string) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set('q', value)
        else next.delete('q')
        return next
      },
      { replace: true },
    )
  }

  const error = models.error ?? registries.error
  const busy = models.loading || registries.loading
  const activeBlock = selected ? all.find((block) => block.id === selected) : undefined
  const activeSubject = selected ? (subjects.get(selected) ?? null) : null

  return (
    <>
      <div className="container">
        <div className="page-head">
          <Link to="/" className="text-link">
            ← 返回首页
          </Link>
          <h1>方块</h1>
          <p>{total} 个方块 · 按 blockstates 与模型 JSON 渲染的立体形态</p>
        </div>

        <div className="browse-bar">
          <SearchBox primary value={query} onChange={updateQuery} placeholder="搜索方块…" />
          <label className="toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            显示半截方块
          </label>
        </div>

        {error && <p className="notice notice--error">加载失败：{error.message}</p>}
        {busy && <p className="empty">正在加载方块模型…</p>}
        {!busy && filtered.length === 0 && <p className="empty">没有匹配「{query}」的方块</p>}

        <div className="block-grid" ref={gridRef} style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {visible.map((block) => {
            const subject = subjects.get(block.id)
            return (
              <button
                key={block.id}
                type="button"
                className="block-cell"
                aria-pressed={selected === block.id}
                title={`${block.n}\n${block.id}`}
                onClick={() => setSelected(block.id)}
              >
                {subject && <ModelView subject={subject} version={version} size={76} />}
                <span className="block-cell__name">{block.n}</span>
              </button>
            )
          })}
        </div>
      </div>

      {activeBlock && (
        <ModelModal
          subject={activeSubject}
          version={version}
          title={activeBlock.n}
          subtitle={activeBlock.e}
          rows={[
            { key: '方块 ID', value: activeBlock.id },
            { key: '源文件', value: `blockstates/${activeBlock.id}.json` },
          ]}
          sources={[{ label: '方块状态', path: `blockstates/${activeBlock.id}.json` }]}
          soundKind="block"
          soundId={activeBlock.id}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}
