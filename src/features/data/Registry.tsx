import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AssetGrid,
  AssetTile,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Page,
  PageHeader,
  SearchField,
  Toolbar,
} from '@/ui'
import { useQueryParam } from '@/hooks/useQueryParam'
import { textureSrc } from '@/lib/mc'
import {
  loadAssetText,
  loadRegistries,
  loadRegistryEntryJson,
  loadRegistrySection,
  type RegistryEntry,
} from '@/lib/registries'
import { tipAttrs } from '@/lib/tip'
import { useAsync } from '@/lib/useAsync'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { useLibrary } from '@/lib/useLibrary'
import './registry.css'

export default function Registry() {
  const { id = '' } = useParams()
  const { version, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取数据…" /></Page>

  return <RegistryBrowser version={version} registryId={id} />
}

function RegistryBrowser({ version, registryId }: { version: string; registryId: string }) {
  // 摘要（拿 label/kind/source）+ 该段条目（拿 entries）分两次取，避免拉 677KB 合并文件
  const { data, loading, error } = useAsync(`registries:${version}`, () => loadRegistries(version))
  const section = useAsync(`registry:${version}:${registryId}`, () =>
    loadRegistrySection(version, registryId),
  )
  const { value: query, setValue: setQuery } = useQueryParam()
  const [selected, setSelected] = useState<RegistryEntry | null>(null)
  const [json, setJson] = useState<string | null>(null)

  const registry = data?.registries.find((entry) => entry.id === registryId)
  const entries = useMemo(() => section.data?.entries ?? [], [section.data])

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
  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 170,
    minColumnWidth: 132,
    resetKey: `${registryId}|${query}`,
  })

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

  if (error || section.error) {
    const reason = error ?? section.error
    return (
      <Page>
        <ErrorState title="读取失败" detail={reason?.message} />
      </Page>
    )
  }
  if (loading || section.loading) return <Page><LoadingState /></Page>

  if (!registry) {
    return (
      <Page>
        <EmptyState
          title="没有这条数据"
          /* @why 用 Link 而不是 history.back()：从站外直接打开这个 URL 时
             历史里没有上一页，按钮点下去什么都不会发生。 */
          hint={
            <Link className="btn btn--ghost" to="/data">
              返回游戏数据
            </Link>
          }
        />
      </Page>
    )
  }

  const total = filtered.length

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/data', label: '游戏数据' }}
        title={registry.label}
        lead={
          <>
            <span className="num">{total}</span> 条 · <span className="mono">{registry.source}</span>
          </>
        }
      />

      <Toolbar meta={`${total} / ${entries.length}`}>
        <SearchField
          primary
          value={query}
          onChange={setQuery}
          placeholder={`在 ${registry.label} 中搜索…`}
        />
      </Toolbar>

      {filtered.length === 0 && <EmptyState title={`没有匹配「${query}」的条目`} />}

      {hasIcons ? (
        <AssetGrid gridRef={gridRef} padTop={padTop} padBottom={padBottom} minWidth={132}>
          {visible.map((entry) => (
            <AssetTile
              key={entry.id}
              name={entry.n}
              meta={entry.id}
              pressed={selected?.id === entry.id}
              hint={tipAttrs(entry.n, undefined, entry.id).title}
              onClick={() => void open(entry)}
            >
              {entry.i ? (
                <img
                  src={textureSrc(version, entry.i)}
                  alt={entry.n}
                  loading="lazy"
                  decoding="async"
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden'
                  }}
                />
              ) : (
                <span className="tile__none" aria-hidden="true" />
              )}
            </AssetTile>
          ))}
        </AssetGrid>
      ) : (
        <div className="registry-list">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="registry-row"
              onClick={() => void open(entry)}
            >
              <span className="registry-row__name">{entry.n}</span>
              {/* @why 没有中文名的注册表（粒子）里 n 就是 id，画两遍像渲染重复 */}
              {entry.n.trim().toLowerCase() !== entry.id.trim().toLowerCase() && (
                <span className="registry-row__id">{entry.id}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <Dialog open onClose={() => setSelected(null)} label={selected.n} className="modal--narrow">
          <div className="modal__view">
            {selected.i ? (
              <div className="modal__stage modal__stage--checker">
                <img
                  className="modal__flat"
                  src={textureSrc(version, selected.i)}
                  alt={selected.n}
                  onError={(event) => {
                    event.currentTarget.style.visibility = 'hidden'
                  }}
                />
              </div>
            ) : (
              <div className="modal__stage registry-modal__code">
                <pre className="code-block">{json ?? '（没有可预览的图或文件内容）'}</pre>
              </div>
            )}
          </div>

          <div className="modal__side">
            <div className="modal__head">
              <div className="modal__title">{selected.n}</div>
              {selected.e && <div className="modal__subtitle">{selected.e}</div>}
            </div>

            <div className="modal__body">
              <div className="kv-list">
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
              </div>

              {selected.i && json && (
                <div className="section">
                  <div className="section__head">
                    <span className="section__title">源文件</span>
                  </div>
                  <pre className="code-block">{json}</pre>
                </div>
              )}

              {(registry.dataDir || registry.assetDir) && !json && (
                <p className="notice">未能读取该条目的源文件。</p>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </Page>
  )
}
