import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SearchBox } from '@/components/SearchBox'
import { TextureDetail } from '@/components/TextureDetail'
import { loadTextures, textureSrc, type Texture } from '@/lib/mc'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { usePaged } from '@/lib/usePaged'

/**
 * 界面素材单独成页。
 * @why GUI 贴图本身就是二维图（按钮、容器、图标），塞进方块/物品列表里只会干扰，
 *      但它又是资源包作者最常改的东西，需要独立入口。
 */
export default function Ui() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取界面素材…</p>

  return <UiBrowser version={version} />
}

function UiBrowser({ version }: { version: string }) {
  const { data, loading, error } = useAsync(`textures:${version}`, () => loadTextures(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<Texture | null>(null)

  const query = params.get('q') ?? ''
  const items = useMemo(() => (data?.items ?? []).filter((item) => item.g === 'gui'), [data])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return items
    return items.filter(
      (item) =>
        item.p.toLowerCase().includes(keyword) ||
        item.n.toLowerCase().includes(keyword) ||
        (item.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [items, query])

  const { visible, sentinelRef, total, shown } = usePaged(filtered, 96)

  useEffect(() => {
    if (selected && !filtered.some((item) => item.p === selected.p)) setSelected(null)
  }, [filtered, selected])

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

  return (
    <>
      <div className="container">
        <div className="page-head">
          <Link to="/" className="text-link">
            ← 返回首页
          </Link>
          <h1>界面</h1>
          <p>
            {total} 张 GUI 贴图
            {shown < total && ` · 已显示 ${shown}`}
          </p>
        </div>

        <div className="browse-bar">
          <SearchBox primary value={query} onChange={updateQuery} placeholder="搜索界面贴图…" />
        </div>

        {error && <p className="notice notice--error">加载失败：{error.message}</p>}
        {loading && <p className="empty">正在加载…</p>}
        {!loading && filtered.length === 0 && <p className="empty">没有匹配「{query}」的贴图</p>}

        <div className="tex-grid">
          {visible.map((texture) => (
            <button
              key={texture.p}
              type="button"
              className="tex-cell"
              aria-pressed={selected?.p === texture.p}
              title={`${texture.n}\ntextures/${texture.p}.png`}
              onClick={() => setSelected(texture)}
            >
              <img
                className="tex-cell__img"
                src={textureSrc(version, texture.p)}
                alt={texture.n}
                loading="lazy"
                decoding="async"
                onError={(event) => {
                  event.currentTarget.style.visibility = 'hidden'
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
