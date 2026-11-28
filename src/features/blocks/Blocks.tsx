import { useMemo, useState } from 'react'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import { AssetGrid, AssetTile, EmptyState, ErrorState, LoadingState, Page, PageHeader, SearchField, Switch, Toolbar } from '@/ui'
import { useQueryParam } from '@/hooks/useQueryParam'
import { loadBlockModels } from '@/lib/blockmodels'
import { loadRegistrySection } from '@/lib/registries'
import { tipAttrs } from '@/lib/tip'
import { useAsync } from '@/lib/useAsync'
import { useVirtualGrid } from '@/lib/useVirtualGrid'
import { useShardFaces } from '@/lib/useShardFaces'
import { useLibrary } from '@/lib/useLibrary'
import './blocks.css'

interface BlockEntry {
  id: string
  n: string
  e: string | null
}

export default function Blocks() {
  const { version, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取方块数据…" /></Page>

  return <BlockBrowser version={version} />
}

function BlockBrowser({ version }: { version: string }) {
  const models = useAsync(`blockmodels:${version}`, () => loadBlockModels(version))
  const registries = useAsync(`registry-blocks:${version}`, () => loadRegistrySection(version, 'blocks'))
  const { value: query, setValue: setQuery } = useQueryParam()
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

  const { ref: gridRef, visible, padTop, padBottom } = useVirtualGrid(filtered, {
    rowHeight: 170,
    minColumnWidth: 132,
    resetKey: `${query}|${showHidden}`,
  })

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
        alpha: meta.alpha,
        anims: meta.anims,
        display: meta.displays[id],
        flat: false,
      })
    }
    return map
    // revision 变化代表有新的一片面数据落地
  }, [models.data, faceParts.revision])

  const error = models.error ?? registries.error
  const busy = models.loading || registries.loading
  const activeBlock = selected ? all.find((block) => block.id === selected) : undefined
  const activeSubject = selected ? (subjects.get(selected) ?? null) : null

  return (
    <Page wide>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title="方块"
        lead={
          <>
            <span className="num">{filtered.length}</span> 个方块，连半截的门和床都在 · 点一张能转着看
            {showHidden && <span className="muted"> · 含半截方块</span>}
          </>
        }
      />

      <Toolbar meta={busy ? '加载模型…' : `${filtered.length} / ${all.length}`}>
        <SearchField primary value={query} onChange={setQuery} placeholder="搜索方块…" />
        <Switch checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)}>
          显示半截方块
        </Switch>
      </Toolbar>

      {error && <ErrorState title="加载失败" detail={error.message} />}
      {busy && <LoadingState label="正在加载方块模型…" />}

      {!busy && filtered.length === 0 && (
        <EmptyState
          title={`没找到「${query}」这块方块`}
          hint={showHidden === false ? '换个英文 id 试试？半截方块默认藏着，把上面的开关打开也能看到。' : '用英文 id 的一部分就行，比如 stone、plank。'}
        />
      )}

      <AssetGrid
        gridRef={gridRef}
        padTop={padTop}
        padBottom={padBottom}
        minWidth={132}
        label="方块列表"
      >
        {visible.map((block) => {
          const subject = subjects.get(block.id)
          return (
            <AssetTile
              key={block.id}
              name={block.n}
              pressed={selected === block.id}
              onClick={() => setSelected(block.id)}
              hint={tipAttrs(block.n, undefined, block.id).title}
            >
              {subject ? (
                <ModelView subject={subject} version={version} size={92} />
              ) : (
                // 占位保持尺寸，否则分片到位时整列卡片会跳一下
                <span className="tile__pending" aria-hidden="true" />
              )}
            </AssetTile>
          )
        })}
      </AssetGrid>

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
    </Page>
  )
}
