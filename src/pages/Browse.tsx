import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { SearchBox } from '@/components/SearchBox'
import { TextureDetail } from '@/components/TextureDetail'
import { loadTextures, textureSrc, type Texture } from '@/lib/mc'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { usePaged } from '@/lib/usePaged'
import { tipAttrs } from '@/lib/tip'

export default function Browse() {
  const { group = 'all' } = useParams()
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取素材索引…</p>

  return <TextureBrowser version={version} group={group} />
}

function TextureBrowser({ version, group }: { version: string; group: string }) {
  const { data, loading, error } = useAsync(`textures:${version}`, () => loadTextures(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<Texture | null>(null)

  const query = params.get('q') ?? ''
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

  const { visible, sentinelRef, total, shown } = usePaged(filtered)

  // @why 搜索或切分类后，原选中项可能已不在结果里，抽屉不能留着过期内容
  useEffect(() => {
    if (selected && !filtered.some((item) => item.p === selected.p)) setSelected(null)
  }, [filtered, selected])

  const activeLabel = group === 'all' ? '全部纹理' : (groups.find((g) => g.id === group)?.label ?? group)

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

  return (
    <>
      <div className="container">
        <div className="page-head">
          <Link to="/" className="text-link">
            ← 返回首页
          </Link>
          <h1>{activeLabel}</h1>
          <p>
            {total} 张纹理
            {shown < total && ` · 已显示 ${shown}`}
          </p>
        </div>

        <div className="browse-bar">
          <div className="chips">
            <Link className="chip" to={withQuery('/browse/all')} aria-pressed={group === 'all'}>
              全部
              <span className="chip__count">{items.length}</span>
            </Link>
            {groups.map((item) => (
              <Link
                key={item.id}
                className="chip"
                to={withQuery(`/browse/${item.id}`)}
                aria-pressed={group === item.id}
              >
                {item.label}
                <span className="chip__count">{item.count}</span>
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

        {error && <p className="notice notice--error">索引加载失败：{error.message}</p>}
        {loading && <p className="empty">正在加载纹理…</p>}

        {!loading && filtered.length === 0 && (
          <p className="empty">没有匹配「{query}」的纹理</p>
        )}

        <div className="tex-grid">
          {visible.map((texture) => (
            <button
              key={texture.p}
              type="button"
              className="tex-cell"
              aria-pressed={selected?.p === texture.p}
              {...tipAttrs(texture.n, undefined, `textures/${texture.p}.png`)}
              onClick={() => setSelected(texture)}
            >
              <img
                className="tex-cell__img"
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
              <span className="tex-cell__name">{texture.n}</span>
            </button>
          ))}
        </div>

        <div ref={sentinelRef} className="sentinel" />
      </div>

      {selected && (
        <TextureDetail texture={selected} version={version} onClose={() => setSelected(null)} />
      )}
    </>
  )
}
