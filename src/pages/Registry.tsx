import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CloseIcon } from '@/components/icons'
import { SearchBox } from '@/components/SearchBox'
import { textureSrc } from '@/lib/mc'
import {
  loadAssetText,
  loadRegistries,
  loadRegistryEntryJson,
  type RegistryEntry,
} from '@/lib/registries'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { usePaged } from '@/lib/usePaged'
import { tipAttrs } from '@/lib/tip'

export default function Registry() {
  const { id = '' } = useParams()
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取数据…</p>

  return <RegistryBrowser version={version} registryId={id} />
}

function RegistryBrowser({ version, registryId }: { version: string; registryId: string }) {
  const { data, loading, error } = useAsync(`registries:${version}`, () => loadRegistries(version))
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<RegistryEntry | null>(null)
  const [json, setJson] = useState<string | null>(null)

  const registry = data?.registries.find((entry) => entry.id === registryId)
  const query = params.get('q') ?? ''
  const entries = useMemo(() => registry?.entries ?? [], [registry])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return entries
    return entries.filter(
      (entry) =>
        entry.id.includes(keyword) ||
        entry.n.toLowerCase().includes(keyword) ||
        (entry.e?.toLowerCase().includes(keyword) ?? false),
    )
  }, [entries, query])

  const hasIcons = entries.some((entry) => entry.i)
  const { visible, sentinelRef, total, shown } = usePaged(filtered, 120)

  useEffect(() => {
    setSelected(null)
    setJson(null)
  }, [registryId])

  const open = async (entry: RegistryEntry) => {
    setSelected(entry)
    setJson(null)
    if (registry?.dataDir) {
      setJson(await loadRegistryEntryJson(version, registry.dataDir, entry.id))
    } else if (registry?.assetDir) {
      setJson(await loadAssetText(version, registry.assetDir, entry.id))
    }
  }

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

  if (error) return <p className="notice notice--error container">读取失败：{error.message}</p>
  if (loading) return <p className="empty">正在加载…</p>
  if (!registry) {
    return (
      <div className="container">
        <p className="empty">
          没有这条数据 · <Link className="text-link" to="/data">返回数据页</Link>
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="container">
        <div className="page-head">
          <Link to="/data" className="text-link">
            ← 游戏数据
          </Link>
          <h1>{registry.label}</h1>
          <p>
            {total} 条 · <span className="mono">{registry.source}</span>
            {shown < total && ` · 已显示 ${shown}`}
          </p>
        </div>

        <div className="browse-bar">
          <SearchBox
            primary
            value={query}
            onChange={updateQuery}
            placeholder={`在 ${registry.label} 中搜索…`}
          />
        </div>

        {filtered.length === 0 && <p className="empty">没有匹配「{query}」的条目</p>}

        {hasIcons ? (
          <div className="tex-grid">
            {visible.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="tex-cell"
                aria-pressed={selected?.id === entry.id}
                {...tipAttrs(entry.n, undefined, entry.id)}
                onClick={() => void open(entry)}
              >
                {entry.i ? (
                  <img
                    className="tex-cell__img"
                    src={textureSrc(version, entry.i)}
                    alt={entry.n}
                    loading="lazy"
                    decoding="async"
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                ) : (
                  <span className="tex-cell__img tex-cell__img--empty" />
                )}
                <span className="tex-cell__name">{entry.n}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="reg-list">
            {visible.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="reg-row reg-row--button"
                onClick={() => void open(entry)}
              >
                <span className="reg-row__label">{entry.n}</span>
                <span className="reg-row__source">{entry.id}</span>
              </button>
            ))}
          </div>
        )}

        <div ref={sentinelRef} className="sentinel" />
      </div>

      {selected &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setSelected(null)} role="presentation">
          <div
            className={`modal${selected.i ? '' : ' modal--nofigure'}`}
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal__close"
              onClick={() => setSelected(null)}
              aria-label="关闭"
            >
              <CloseIcon />
            </button>

            {selected.i && (
              <div className="modal__view">
                <img
                  className="modal__flat"
                  src={textureSrc(version, selected.i)}
                  alt={selected.n}
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden'
                  }}
                />
              </div>
            )}

            <div className="modal__side">
              <div className="modal__head">
                <div className="detail__name">{selected.n}</div>
                {selected.e && <div className="detail__en">{selected.e}</div>}
              </div>

              <div className="modal__body">
                <div className="kv">
                  <span className="kv__key">ID</span>
                  <span className="kv__val">{selected.id}</span>
                </div>

                {registry.dataDir && (
                  <div className="kv">
                    <span className="kv__key">源文件</span>
                    <span className="kv__val">
                      data/minecraft/{registry.dataDir}/{selected.id}.json
                    </span>
                  </div>
                )}

                {registry.assetDir && (
                  <div className="kv">
                    <span className="kv__key">源文件</span>
                    <span className="kv__val">
                      assets/minecraft/{registry.assetDir}/{selected.id}
                    </span>
                  </div>
                )}

                {selected.i && (
                  <div className="kv">
                    <span className="kv__key">贴图</span>
                    <span className="kv__val">textures/{selected.i}.png</span>
                  </div>
                )}

                {json && (
                  <div className="kv">
                    <span className="kv__key">JSON</span>
                    <pre className="code-block">{json}</pre>
                  </div>
                )}

                {(registry.dataDir || registry.assetDir) && !json && (
                  <p className="notice">未能读取该条目的源文件。</p>
                )}
              </div>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </>
  )
}
