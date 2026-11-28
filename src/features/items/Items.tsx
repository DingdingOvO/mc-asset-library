import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import {
  AssetGrid,
  AssetTile,
  EmptyState,
  ErrorState,
  FilterChips,
  LoadingState,
  Page,
  PageHeader,
  SearchField,
  Toolbar,
} from '@/ui'
import { useQueryParam } from '@/hooks/useQueryParam'
import { loadBlockModels } from '@/lib/blockmodels'
import { loadItems, MODEL_TYPE_LABELS, type Item } from '@/lib/items'
import { textureSrc } from '@/lib/mc'
import { tipAttrs } from '@/lib/tip'
import { useAsync } from '@/lib/useAsync'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { useShardFaces } from '@/lib/useShardFaces'
import { useLibrary } from '@/lib/useLibrary'
import './items.css'

export default function Items() {
  const { group = 'all' } = useParams()
  const { version, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取物品…" /></Page>

  return <ItemBrowser version={version} group={group} />
}

function ItemBrowser({ version, group }: { version: string; group: string }) {
  const items = useAsync(`items:${version}`, () => loadItems(version))
  const models = useAsync(`blockmodels:${version}`, () => loadBlockModels(version))
  const { value: query, setValue: setQuery, withQuery } = useQueryParam()
  const [selected, setSelected] = useState<Item | null>(null)

  // @why air 在注册表里存在，但它没有模型也没有贴图，列出来只会是空卡片
  const list = useMemo(
    () => (items.data?.items ?? []).filter((item) => item.id !== 'air'),
    [items.data],
  )
  const groups = items.data?.groups ?? []

  /**
   * 物品 id → 分片下标。
   * @why 列表按创造模式顺序排（registry 给的），面数据按 id 字母序切片，
   *      两套顺序不一样，只能靠这张表对照。
   */
  const shardOf = useMemo(() => {
    const meta = models.data
    const map = new Map<string, number>()
    if (!meta) return map
    const size = meta.shardSize > 0 ? meta.shardSize : 200
    meta.itemIds.forEach((id, index) => map.set(id, Math.floor(index / size)))
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
    rowHeight: 170,
    minColumnWidth: 132,
    resetKey: `${group}|${query}`,
  })

  /**
   * chip 上的计数按**当前列表**重算，不用 `groups[].count`。
   * @why 数据里的计数含 `air`（注册表里有、列表里被隐藏），
   *      直接显示会出现「创造栏外 33」点进去只有 32 项。
   */
  const groupCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of list) counts.set(item.g, (counts.get(item.g) ?? 0) + 1)
    return counts
  }, [list])

  // 分片按可见项与当前详情项取回，见 useShardFaces
  const faceParts = useShardFaces(version, 'items', shardOf, visible, selected?.id ?? null)

  const subjects = useMemo(() => {
    const meta = models.data
    const map = new Map<string, Subject>()
    if (!meta) return map
    const flatSet = new Set(meta.flat ?? [])
    for (const [id, faces] of Object.entries(faceParts.faces)) {
      if (faces.length === 0) continue
      map.set(id, {
        kind: 'block',
        faces,
        textures: meta.textures,
        alpha: meta.alpha,
        anims: meta.anims,
        display: meta.displays[id],
        flat: flatSet.has(id),
      })
    }
    return map
    // revision 变化代表有新的一片面数据落地
  }, [models.data, faceParts.revision])

  useEffect(() => {
    if (selected && !filtered.some((item) => item.id === selected.id)) setSelected(null)
  }, [filtered, selected])

  const activeLabel =
    group === 'all' ? '全部物品' : (groups.find((entry) => entry.id === group)?.label ?? group)

  const busy = items.loading || models.loading
  const error = items.error ?? models.error
  const activeSubject = selected ? (subjects.get(selected.id) ?? null) : null

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title={activeLabel}
        lead={
          <>
            <span className="num">{filtered.length}</span> 项
            {group === 'misc' ? ' · 注册表里有、创造模式物品栏没有的条目' : ' · 按创造模式物品栏的原生顺序排列'}
          </>
        }
      />

      <Toolbar
        meta={busy ? '加载模型…' : `${filtered.length} / ${list.length}`}
        filters={
          <FilterChips
            allLabel="全部"
            allCount={list.length}
            active={group}
            href={(id) => withQuery(id === 'all' ? '/items' : `/items/${id}`)}
            items={groups.map((entry) => ({
              id: entry.id,
              label: entry.label,
              count: groupCounts.get(entry.id) ?? entry.count,
            }))}
            ariaLabel="物品分类"
          />
        }
      >
        <SearchField
          primary
          value={query}
          onChange={setQuery}
          placeholder={`在 ${activeLabel} 中搜索…`}
        />
      </Toolbar>

      {error && <ErrorState title="加载失败" detail={error.message} />}
      {busy && <LoadingState label="正在加载物品模型…" />}
      {!busy && filtered.length === 0 && (
        <EmptyState
          title={`没有匹配「${query}」的物品`}
          hint="试试只输入英文 id 的一部分，例如 stone 或 sword。"
        />
      )}

      <AssetGrid gridRef={gridRef} padTop={padTop} padBottom={padBottom} minWidth={132} label="物品列表">
        {visible.map((item) => {
          const subject = subjects.get(item.id)
          return (
            <AssetTile
              key={item.id}
              name={item.n}
              pressed={selected?.id === item.id}
              onClick={() => setSelected(item)}
              hint={tipAttrs(item.n, undefined, item.id).title}
            >
              {subject ? (
                <ModelView subject={subject} version={version} size={92} />
              ) : item.i ? (
                // @why 箱子、床这类 special 渲染没有可解析模型，退回图标
                <img
                  src={textureSrc(version, item.i)}
                  alt={item.n}
                  loading="lazy"
                  decoding="async"
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden'
                  }}
                />
              ) : (
                // @why 打包阶段把找不到贴图的条目清成了空串（空气之类），
                //      这里不再请求，避免每张卡片刷一条 404
                <span className="tile__none" aria-hidden="true" />
              )}
            </AssetTile>
          )
        })}
      </AssetGrid>

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
    </Page>
  )
}
