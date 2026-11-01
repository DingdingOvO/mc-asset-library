import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import { SearchBox } from '@/components/SearchBox'
import { loadBlockModels } from '@/lib/blockmodels'
import { loadItems, MODEL_TYPE_LABELS, type Item } from '@/lib/items'
import { textureSrc } from '@/lib/mc'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { useVirtualGrid } from '@/lib/useVirtualGrid'

export default function Items() {
  const { group = 'all' } = useParams()
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取物品…</p>

  return <ItemBrowser version={version} group={group} />
}

function ItemBrowser({ version, group }: { version: string; group: string }) {
  const items = useAsync(`items:${version}`, () => loadItems(version))
  const models = useAsync(`blockmodels:${version}`, () => loadBlockModels(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<Item | null>(null)

  const query = params.get('q') ?? ''
  // @why air 在注册表里存在，但它没有模型也没有贴图，列出来只会是空卡片
  const list = useMemo(
    () => (items.data?.items ?? []).filter((item) => item.id !== 'air'),
    [items.data],
  )
  const groups = items.data?.groups ?? []

  const subjects = useMemo(() => {
    const baked = models.data?.items ?? {}
    const textures = models.data?.textures ?? []
    const frames = models.data?.frames ?? []
    const displays = models.data?.displays ?? {}
    const flatSet = new Set(models.data?.flat ?? [])
    const map = new Map<string, Subject>()
    for (const [id, faces] of Object.entries(baked)) {
      if (faces.length === 0) continue
      map.set(id, {
        kind: 'block',
        faces,
        textures,
        frames,
        display: displays[id],
        flat: flatSet.has(id),
      })
    }
    return map
  }, [models.data])

  const filtered = useMemo(() => {
    const scoped = group === 'all' ? list : list.filter((item) => item.g === group)
    const keyword = query.trim().toLowerCase()
    if (!keyword) return scoped
    return scoped.filter(
      (item) =>
        item.id.includes(keyword) ||
        item.n.toLowerCase().includes(keyword) ||
        (item.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [list, group, query])

  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 112,
    minColumnWidth: 104,
  })
  const total = filtered.length

  useEffect(() => {
    if (selected && !filtered.some((item) => item.id === selected.id)) setSelected(null)
  }, [filtered, selected])

  const activeLabel =
    group === 'all' ? '全部物品' : (groups.find((entry) => entry.id === group)?.label ?? group)

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

  const withQuery = (path: string) => {
    const suffix = params.toString()
    return suffix ? `${path}?${suffix}` : path
  }

  const busy = items.loading || models.loading
  const error = items.error ?? models.error
  const activeSubject = selected ? (subjects.get(selected.id) ?? null) : null

  return (
    <>
      <div className="container">
        <div className="page-head">
          <Link to="/" className="text-link">
            ← 返回首页
          </Link>
          <h1>{activeLabel}</h1>
          <p>{total} 项 · 按创造模式物品栏的原生顺序排列</p>
        </div>

        <div className="browse-bar">
          <div className="chips">
            <Link className="chip" to={withQuery('/items')} aria-pressed={group === 'all'}>
              全部
              <span className="chip__count">{list.length}</span>
            </Link>
            {groups.map((entry) => (
              <Link
                key={entry.id}
                className="chip"
                to={withQuery(`/items/${entry.id}`)}
                aria-pressed={group === entry.id}
              >
                {entry.label}
                <span className="chip__count">{entry.count}</span>
              </Link>
            ))}
          </div>
          <SearchBox
            primary
            value={query}
            onChange={updateQuery}
            placeholder={`在 ${activeLabel} 中搜索…`}
          />
        </div>

        {error && <p className="notice notice--error">加载失败：{error.message}</p>}
        {busy && <p className="empty">正在加载物品模型…</p>}
        {!busy && filtered.length === 0 && <p className="empty">没有匹配「{query}」的物品</p>}

        <div className="block-grid" ref={gridRef} style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {visible.map((item) => {
            const subject = subjects.get(item.id)
            return (
              <button
                key={item.id}
                type="button"
                className="block-cell"
                aria-pressed={selected?.id === item.id}
                title={`${item.n}\n${item.id}`}
                onClick={() => setSelected(item)}
              >
                {subject ? (
                  <ModelView subject={subject} version={version} size={64} />
                ) : (
                  // @why 箱子、床这类 special 渲染没有可解析模型，退回图标
                  <img
                    className="tex-cell__img"
                    src={textureSrc(version, item.i)}
                    alt={item.n}
                    loading="lazy"
                    decoding="async"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                )}
                <span className="block-cell__name">{item.n}</span>
              </button>
            )
          })}
        </div>
      </div>

      {selected && (
        <ModelModal
          subject={activeSubject}
          version={version}
          title={selected.n}
          subtitle={selected.e}
          hint="该物品使用特殊渲染，没有静态模型"
          rows={[
            { key: '物品 ID', value: selected.id },
            { key: '模型类型', value: MODEL_TYPE_LABELS[selected.t] ?? selected.t },
            ...(selected.b ? [{ key: '可放置', value: '是，同时是方块' }] : []),
            { key: '贴图', value: `textures/${selected.i}.png` },
          ]}
          sources={[{ label: '物品定义', path: `items/${selected.id}.json` }]}
          // @why 可放置的物品本质就是方块，它的声音是那种材质的挖掘/踩踏声，
          //      按"物品动作"去查只会得到一条通用的拾取音
          soundKind={selected.b ? 'block' : 'item'}
          soundId={selected.id}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  )
}
