import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import { SearchBox } from '@/components/SearchBox'
import { loadBakeShard, loadBlockModels, type BakedFace } from '@/lib/blockmodels'
import { loadRegistries } from '@/lib/registries'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { useVirtualGrid } from '@/lib/useVirtualGrid'

interface BlockEntry {
  id: string
  /** 面数据所在的分片下标 */
  shard: number
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
  const registries = useAsync(`registries:${version}`, () => loadRegistries(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string | null>(null)
  // @why 半截方块（门/床/高花）单独渲染必然残缺，默认收起，需要时再放开
  const [showHidden, setShowHidden] = useState(false)

  /**
   * 已取回的面数据。
   * @why 放 ref 而不是 state：滚动时一帧可能同时回来三片、每片两百个条目，
   *      逐片 setState 会触发三次整页重渲染。统一在全部落地后 +1 一次。
   */
  const facesRef = useRef<Record<string, BakedFace[]>>({})
  const doneShards = useRef(new Set<number>())
  const loadingShards = useRef(new Set<number>())
  const [revision, setRevision] = useState(0)

  // 换版本等于换一整套数据，旧分片的 key 全部失效
  useEffect(() => {
    facesRef.current = {}
    doneShards.current = new Set()
    loadingShards.current = new Set()
    setRevision((value) => value + 1)
  }, [version])

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
   * 索引清单 → 列表条目。
   * @constraint 每个条目的 subject 必须缓存：ModelView 的渲染 effect 依赖它，
   *             每次渲染都新建对象会让滚动时所有卡片重新加载纹理。
   */
  const all = useMemo<BlockEntry[]>(() => {
    const meta = models.data
    if (!meta) return []
    const size = meta.shardSize > 0 ? meta.shardSize : 200
    const out: BlockEntry[] = []
    meta.blockIds.forEach((id, index) => {
      if (!showHidden && hiddenSet.has(id)) return
      const label = names.get(id)
      out.push({ id, shard: Math.floor(index / size), n: label?.n ?? id, e: label?.e ?? null })
    })
    return out
  }, [models.data, names, showHidden, hiddenSet])

  const subjects = useMemo(() => {
    const meta = models.data
    const map = new Map<string, Subject>()
    if (!meta) return map
    for (const [id, faces] of Object.entries(facesRef.current)) {
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
  }, [models.data, revision])

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

  /**
   * 滚动到哪一片就取哪一片。
   * @why 面数据 1136KB，首屏只看得到十几张卡片。整包下发等于让用户先等一兆多 JSON。
   * @constraint 依赖必须是 visible 而不是 wanted：拖动滚动条会瞬间跳过几十行，
   *      按可见项算才能只请求"真正要画的"那几片。
   */
  useEffect(() => {
    const meta = models.data
    if (!meta) return
    const want: number[] = []
    for (const entry of visible) {
      if (doneShards.current.has(entry.shard) || loadingShards.current.has(entry.shard)) continue
      loadingShards.current.add(entry.shard)
      want.push(entry.shard)
    }
    if (want.length === 0) return

    let alive = true
    void Promise.all(
      want.map(async (shard) => {
        try {
          const part = await loadBakeShard(version, 'blocks', shard)
          if (!alive) return
          Object.assign(facesRef.current, part)
          doneShards.current.add(shard)
        } catch {
          // 失败的片允许下次滚动时重试，不要标记成已完成
        } finally {
          loadingShards.current.delete(shard)
        }
      }),
    ).then(() => {
      if (alive) setRevision((value) => value + 1)
    })
    return () => {
      alive = false
    }
  }, [visible, models.data, version])

  /**
   * 点开了还没取回面数据的方块（可见性判定与点击之间有几帧的窗口）。
   * @why 没有这一步，用户在分片还在路上时点开头一张卡片，弹窗会显示"没有可用的立体模型"。
   */
  useEffect(() => {
    const meta = models.data
    if (!selected || !meta) return
    if (facesRef.current[selected]) return
    const index = meta.blockIds.indexOf(selected)
    if (index < 0) return
    const shard = Math.floor(index / (meta.shardSize > 0 ? meta.shardSize : 200))
    void loadBakeShard(version, 'blocks', shard).then((part) => {
      Object.assign(facesRef.current, part)
      doneShards.current.add(shard)
      setRevision((value) => value + 1)
    })
  }, [selected, models.data, version])

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
