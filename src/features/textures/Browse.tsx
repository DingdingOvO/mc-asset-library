import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { TextureDetail } from '@/components/TextureDetail'
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
import { loadTextures, textureSrc, type Texture } from '@/lib/mc'
import { tipAttrs } from '@/lib/tip'
import { useAsync } from '@/lib/useAsync'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { useLibrary } from '@/lib/useLibrary'
import './textures.css'

export default function Browse() {
  const { group = 'all' } = useParams()
  const { version, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取素材索引…" /></Page>

  return <TextureBrowser version={version} group={group} />
}

function TextureBrowser({ version, group }: { version: string; group: string }) {
  const { data, loading, error } = useAsync(`textures:${version}`, () => loadTextures(version))
  const { value: query, setValue: setQuery, withQuery } = useQueryParam()
  const [selected, setSelected] = useState<Texture | null>(null)

  const items = useMemo(() => data?.items ?? [], [data])
  const groups = data?.groups ?? []

  const filtered = useMemo(() => {
    const scoped = group === 'all' ? items : items.filter((item) => item.g === group)
    const keyword = query.trim().toLowerCase()
    if (!keyword) return scoped
    // @why 同时匹配中文名、英文名与路径，贴文件名的用户也能命中
    return scoped.filter(
      (item) =>
        item.p.toLowerCase().includes(keyword) ||
        item.n.toLowerCase().includes(keyword) ||
        (item.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [items, group, query])

  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 170,
    minColumnWidth: 132,
    resetKey: `${group}|${query}`,
  })

  // @why 搜索或切分类后，原选中项可能已不在结果里，抽屉不能留着过期内容
  useEffect(() => {
    if (selected && !filtered.some((item) => item.p === selected.p)) setSelected(null)
  }, [filtered, selected])

  const activeLabel =
    group === 'all' ? '全部纹理' : (groups.find((entry) => entry.id === group)?.label ?? group)

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title={activeLabel}
        lead={
          <>
            <span className="num">{filtered.length}</span> 张纹理，原图直出 · 不缩不压，拿去就用
          </>
        }
      />

      <Toolbar
        meta={`${filtered.length} / ${items.length}`}
        filters={
          <FilterChips
            allLabel="全部"
            allCount={items.length}
            active={group}
            href={(id) => withQuery(id === 'all' ? '/browse/all' : `/browse/${id}`)}
            items={groups.map((entry) => ({ id: entry.id, label: entry.label, count: entry.count }))}
            ariaLabel="纹理分类"
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

      {error && <ErrorState title="索引加载失败" detail={error.message} />}
      {loading && <LoadingState label="正在加载纹理…" />}
      {!loading && filtered.length === 0 && (
        <EmptyState
          title={`没找到「${query}」这张纹理`}
          hint="纹理按文件名找，试试 stone、wool、gui 这种。"
        />
      )}

      <AssetGrid gridRef={gridRef} padTop={padTop} padBottom={padBottom} minWidth={132} label="纹理列表">
        {visible.map((texture) => (
          <AssetTile
            key={texture.p}
            name={texture.n}
            meta={texture.w && texture.h ? `${texture.w}×${texture.h}` : undefined}
            pressed={selected?.p === texture.p}
            checker
            hint={tipAttrs(texture.n, undefined, `textures/${texture.p}.png`).title}
            onClick={() => setSelected(texture)}
          >
            <img
              src={textureSrc(version, texture.p)}
              alt={texture.n}
              loading="lazy"
              decoding="async"
              onError={(event) => {
                const image = event.currentTarget
                // @why 线上网关在首屏并发过高时会丢请求；加一次性参数重取，
                // 用 getAttribute 而不是 img.src，避免把绝对 URL 越拼越长
                if (image.dataset.retried === '1') {
                  image.style.visibility = 'hidden'
                  return
                }
                const raw = image.getAttribute('src')
                if (!raw) return
                image.dataset.retried = '1'
                image.src = `${raw}${raw.includes('?') ? '&' : '?'}retry=1`
              }}
            />
          </AssetTile>
        ))}
      </AssetGrid>

      {selected && (
        <TextureDetail texture={selected} version={version} onClose={() => setSelected(null)} />
      )}
    </Page>
  )
}
