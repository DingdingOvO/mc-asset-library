import { useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import { SearchBox } from '@/components/SearchBox'
import { loadBlockModels } from '@/lib/blockmodels'
import { loadRegistrySection } from '@/lib/registries'
import { useAsync } from '@/lib/useAsync'
import { useShardFaces } from '@/lib/useShardFaces'
import { useLibrary } from '@/lib/useLibrary'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { tipAttrs } from '@/lib/tip'

interface BlockEntry {
  id: string
  n: string
  e: string | null
}

export default function Blocks() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取方块数据…</p>

  return <BlockBrowser version={version} />
}

function BlockBrowser({ version }: { version: string }) {
  const models = useAsync(`blockmodels:${version}`, () => loadBlockModels(version))
  const registries = useAsync(`registry-blocks:${version}`, () => loadRegistrySection(version, 'blocks'))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  // @why 半截方块（门/床/高花）单独渲染必然残缺，默认收起，需要时再放开
  const [showHidden, setShowHidden] = useState(false)

  const names = useMemo(() => {
    const map = new Map<string, { n: string; e: string | null }>()
    // @constraint 只取 blocks 段。合并版 registries.json 有 677KB，其中 350KB 是
    //      给 /data/models 用的文件清单，方块页一个字段都用不上。
    for (const entry of registries.data?.entries ?? []) {
      map.set(entry.id, { n: entry.n, e: entry.e })
    }
    return map
  }, [registries.data])

  const hiddenSet = useMemo(() => new Set(models.data?.hidden ?? []), [models.data])

  /**
   * 索引清单 → 列表条目。
   * @constraint 每个条目的 subject 必须缓存：ModelView 的渲染 effect 依赖它，
   *             每次渲染都新建对象会让滚动时所有卡片重新加载纹理。
   */
  const all = useMemo<BlockEntry[]>(() => {
    const meta = models.data
    if (!meta) return []
    const out: BlockEntry[] = []
    for (const id of meta.blockIds) {
      if (!showHidden && hiddenSet.has(id)) continue
      const label = names.get(id)
      out.push({ id, n: label?.n ?? id, e: label?.e ?? null })
    }
    return out
  }, [models.data, names, showHidden, hiddenSet])

  /**
   * 方块 id → 分片下标。
   * @why 注册表顺序与面数据的字母序切片不同，只能靠这张表对照；
   *      同时它也是 `useShardFaces` 的唯一输入。
   */
  const shardOf = useMemo(() => {
    const meta = models.data
    const map = new Map<string, number>()
    if (!meta) return map
    const size = meta.shardSize > 0 ? meta.shardSize : 200
    meta.blockIds.forEach((id, index) => map.set(id, Math.floor(index / size)))
    return map
  }, [models.data])

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

  // 分片按可见项与当前详情项取回，见 useShardFaces
  const faceParts = useShardFaces(version, 'blocks', shardOf, visible, selected)

  const subjects = useMemo(() => {
    const meta = models.data
    const map = new Map<string, Subject>()
    if (!meta) return map
    for (const [id, faces] of Object.entries(faceParts.faces)) {
      map.set(id, {
        kind: 'block',
        faces,
        textures: meta.textures,
        anims: meta.anims,
        display: meta.displays[id],
        flat: false,
      })
    }
    return map
    // revision 变化代表有新的一片面数据落地
  }, [models.data, faceParts.revision])

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
                {...tipAttrs(block.n, undefined, block.id)}
                onClick={() => setSelected(block.id)}
              >
                {subject ? (
                  <ModelView subject={subject} version={version} size={76} />
                ) : (
                  // 占位保持尺寸，否则分片到位时整列卡片会跳一下
                  <span className="block-cell__pending" aria-hidden="true" />
                )}
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
