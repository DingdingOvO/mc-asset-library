import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { SearchBox } from '@/components/SearchBox'
import { ModelModal } from '@/components/ModelModal'
import { ModelView, type Subject } from '@/components/ModelView'
import { textureSrc } from '@/lib/mc'
import { loadRegistries, type RegistryEntry } from '@/lib/registries'
import { buildRig, type Rig } from '@/lib/entityRig'
import { loadEntityModels, type EntityModel } from '@/lib/entityMesh'
import { createPoser, loadAnims, type Poser } from '@/lib/anim'
import { loadRenderers, modelKeyOf } from '@/lib/entityData'
import {
  composeLayers,
  defaultChoice,
  loadLayers,
  type Axis,
} from '@/lib/entityLayers'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { usePaged } from '@/lib/usePaged'
import { tipAttrs } from '@/lib/tip'

export default function Entities() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取生物…</p>

  return <EntityBrowser version={version} />
}

interface Prepared {
  rig: Rig
  poser: Poser
  modelClass: string
  modelKey: string
  layer: string
  texture: string
  shadow: number | null
  /** 幼年形态：独立的骨架、动作类与贴图换算表 */
  baby: {
    rig: Rig
    poser: Poser
    modelClass: string
    texture: string
    tex: Record<string, string>
  } | null
}

/**
 * 没有走标准注册的实体。
 *
 * @why 杀手兔是兔子的一个变体（同一个 RabbitRenderer，只在皮肤上画成灾厄兔），
 *      嘎枝的视觉实体叫 creaking_transient，玩家模型实体叫 mannequin——
 *      这三者在 EntityRenderers 里查不到，但模型确实存在，按别名接上。
 */
const ALIAS: Record<string, { model: string; texture?: string }> = {
  killer_bunny: { model: 'rabbit', texture: 'entity/rabbit/rabbit_caerbannog' },
  creaking_transient: { model: 'creaking' },
  mannequin: { model: 'player' },
  player: { model: 'player' },
}

function EntityBrowser({ version }: { version: string }) {
  const { data, loading, error } = useAsync(`registries:${version}`, () => loadRegistries(version))
  const models = useAsync(`entitymodels:${version}`, () => loadEntityModels(version))
  const anims = useAsync(`entityanims:${version}`, () => loadAnims(version))
  const renderers = useAsync(`entityrenderers:${version}`, () => loadRenderers(version))
  const layerFile = useAsync(`entitylayers:${version}`, () => loadLayers(version))

  /**
   * @why 实体 id 与模型名不是一一对应（chicken → adult_chicken），但渲染器里
   *      写死了用哪个模型类、哪个 ModelLayers 图层。解析顺序：
   *      渲染器给的图层 → 渲染器给的模型类 → id 别名 → 名字硬凑 → 放弃。
   *      任何一层命中都能出立体模型，只有真没几何的（物品、TNT、画）掉回贴图。
   */
  const prepared = useMemo(() => {
    const pool = models.data?.models
    const byClass = models.data?.byClass ?? {}
    const byLayer = models.data?.byLayer ?? {}
    const anim = anims.data
    const table = renderers.data?.entities
    if (!pool) return new Map<string, Prepared>()

    const lookup = (id: string): { model: EntityModel; key: string; layer: string; cls: string | null } | null => {
      const info = table?.[id]
      if (info) {
        const mined = byLayer[info.l] ?? info.l
        if (pool[mined]) return { model: pool[mined], key: mined, layer: info.l, cls: info.m }
        const byCls = byClass[modelKeyOf(info.m)]
        if (byCls && pool[byCls]) return { model: pool[byCls], key: byCls, layer: info.l, cls: info.m }
      }
      const alias = ALIAS[id]?.model
      if (alias && pool[alias]) return { model: pool[alias], key: alias, layer: alias, cls: null }
      const direct = pool[id] ?? pool[`adult_${id}`]
      if (direct) return { model: direct, key: pool[id] ? id : `adult_${id}`, layer: id, cls: null }
      return null
    }

    const map = new Map<string, Prepared>()
    const ids = new Set<string>([
      ...Object.keys(table ?? {}),
      ...(data?.registries.find((registry) => registry.id === 'entities')?.entries ?? []).map(
        (entry) => entry.id,
      ),
    ])
    for (const id of ids) {
      const hit = lookup(id)
      if (!hit) continue
      const info = table?.[id]
      const rig = buildRig(hit.model)
      const poser = createPoser(hit.cls, rig, anim)
      const texture = info?.t[0] ?? ALIAS[id]?.texture ?? hit.model.texture ?? ''

      /**
       * 幼年形态。
       * @why 骨架必须在准备阶段就建好：`buildRig` 要走一遍 263 个模型的层级展开，
       *      放进 subjectOf 就是每次切体型都重建一次，弹窗会卡半秒。
       * @constraint 找不到幼年几何（驴、骡、远古守卫者）时只换贴图，
       *      不能整只退回成年——那会让人以为点了没反应。
       */
      const size = layerFile.data?.sizes?.[id]
      let baby: Prepared['baby'] = null
      if (size) {
        const babyModel = size.m ? pool[size.m] : null
        const babyRig = babyModel ? buildRig(babyModel) : rig
        baby = {
          rig: babyRig,
          poser: createPoser(size.c ?? null, babyRig, anim),
          modelClass: size.c ?? '',
          texture: size.t ?? texture,
          tex: size.tex ?? {},
        }
      }

      map.set(id, {
        rig,
        poser,
        modelClass: hit.cls ?? '',
        modelKey: hit.key,
        layer: hit.layer,
        texture,
        shadow: info?.s ?? null,
        baby,
      })
    }
    return map
  }, [models.data, anims.data, renderers.data, data, layerFile.data])

  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<RegistryEntry | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>({})

  const pool = models.data?.models ?? {}
  const byLayer = models.data?.byLayer ?? {}
  const axes: Axis[] = selected ? (layerFile.data?.axes[selected.id] ?? []) : []

  /**
   * 把「渲染器解析出来的骨骼」+「虚线框里选中的状态」拼成一个可画的对象。
   * @why 品种换的是本体贴图，染色换的是图层的乘数，斑纹换的是图层贴图——
   *      三者都只是这张表的输入，不需要三套渲染路径。
   */
  const subjectOf = useCallback(
    (hit: Prepared, id: string, pick: Record<string, string>): Subject => {
      const axis = layerFile.data?.axes[id]?.find((item) => item.k === 'base')
      const picked = pick.base
      const adultTexture =
        axis?.opts?.find((opt) => opt.k === picked && opt.t)?.t ?? hit.texture
      /**
       * @constraint 贴图换算要在品种之后：猫选了「三花」再切幼年，要的是
       *      cat_calico_baby。换算表没命中就沿用当前贴图（僵尸幼年与成年同皮）。
       */
      const baby = pick.size === 'baby' ? hit.baby : null
      const texture = baby ? (baby.tex[adultTexture] ?? baby.texture) : adultTexture
      return {
        kind: 'entity',
        rig: baby ? baby.rig : hit.rig,
        poser: baby ? baby.poser : hit.poser,
        texture,
        layers: composeLayers(id, layerFile.data ?? null, pick, pool, byLayer),
      }
    },
    [layerFile.data, pool, byLayer],
  )

  /** 默认状态：列表缩略图与弹窗初始值都用它 */
  const defaultPick = useCallback(
    (id: string, texture: string) => defaultChoice(layerFile.data ?? null, id, texture),
    [layerFile.data],
  )

  /**
   * 换一只生物：选择回到该生物自己的默认值。
   * @constraint 不能沿用上一只的选择：马选了"白色"，再点羊就会拿"白色"去当羊的贴图。
   */
  useEffect(() => {
    if (!selected) return
    const hit = prepared.get(selected.id)
    setChoice(defaultPick(selected.id, hit?.texture ?? ''))
  }, [selected, prepared, defaultPick])

  /**
   * @constraint 列表缩略图的 subject 必须按 id 缓存住对象身份：
   *      subject 是 ModelView 的 effect 依赖，每次 render 新建一个对象
   *      就等于让 96 张卡片重新光栅化一遍，滚动时整页卡死。
   */
  /**
   * 鼠标停在哪张卡片上。
   * @why 列表里九十多只生物同时按 20fps 重绘会把主线程占满。同一时刻只有一张
   *      卡片在动，代价可以忽略，而且"扫过去会动"正好能看出模型的走路姿态。
   */
  const [hovered, setHovered] = useState<string | null>(null)

  const defaultSubjects = useMemo(() => {
    const map = new Map<string, Subject>()
    for (const [id, hit] of prepared) {
      map.set(id, subjectOf(hit, id, defaultPick(id, hit.texture)))
    }
    return map
  }, [prepared, subjectOf, defaultPick])

  const query = params.get('q') ?? ''
  const entries = useMemo(
    () => data?.registries.find((registry) => registry.id === 'entities')?.entries ?? [],
    [data],
  )

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const list = keyword
      ? entries.filter(
          (entry) =>
            entry.id.includes(keyword) ||
            entry.n.toLowerCase().includes(keyword) ||
            (entry.e?.toLowerCase().includes(keyword) ?? false),
        )
      : entries
    /**
     * @why 物品、TNT、画这类实体没有骨骼模型，卡片只能给贴图。让能渲染的排前面，
     *      第一屏就不会看起来像坏了一半。
     */
    return [...list].sort((a, b) => Number(prepared.has(b.id)) - Number(prepared.has(a.id)))
  }, [entries, query, prepared])

  const { visible, sentinelRef, total, shown } = usePaged(filtered, 96)

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

  const active = selected ? (prepared.get(selected.id) ?? null) : null
  const activeSubject = useMemo(
    () => (selected && active ? subjectOf(active, selected.id, choice) : null),
    [selected, active, subjectOf, choice],
  )
  const busy = loading || models.loading || anims.loading || renderers.loading
  const solid = prepared.size

  return (
    <div className="container">
      <div className="page-head">
        <Link to="/" className="text-link">
          ← 返回首页
        </Link>
        <h1>生物</h1>
        <p>
          {total} 个实体 · {solid} 个可立体渲染 · 按游戏骨骼与动作
          {shown < total && ` · 已显示 ${shown}`}
        </p>
      </div>

      <div className="browse-bar">
        <SearchBox primary value={query} onChange={updateQuery} placeholder="搜索生物…" />
      </div>

      {(error ?? models.error) && (
        <p className="notice notice--error">加载失败：{(error ?? models.error)?.message}</p>
      )}
      {busy && <p className="empty">正在加载…</p>}
      {!busy && filtered.length === 0 && <p className="empty">没有匹配「{query}」的生物</p>}

      <div className="tex-grid">
        {visible.map((entry) => {
          const hit = prepared.get(entry.id)
          return (
            <button
              key={entry.id}
              type="button"
              className="tex-cell"
              aria-pressed={selected?.id === entry.id}
              {...tipAttrs(entry.n, undefined, entry.id)}
              onPointerEnter={() => setHovered(entry.id)}
              onPointerLeave={() => setHovered((value) => (value === entry.id ? null : value))}
              onClick={() => setSelected(entry)}
            >
              {hit && hit.texture ? (
                <ModelView
                  subject={defaultSubjects.get(entry.id)!}
                  version={version}
                  size={68}
                  speed={hovered === entry.id ? 1 : 0}
                  animated={hovered === entry.id}
                />
              ) : entry.i ? (
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
                <span className="tex-cell__img tex-cell__img--empty" aria-hidden="true" />
              )}
              <span className="tex-cell__name">{entry.n}</span>
            </button>
          )
        })}
      </div>

      <div ref={sentinelRef} className="sentinel" />

      {selected && (
        <ModelModal
          subject={activeSubject}
          version={version}
          title={selected.n}
          subtitle={selected.e}
          hint="该实体没有骨骼模型（绘制逻辑写在渲染器里，不产生 ModelPart 树），只展示贴图"
          rows={[
            { key: '实体 ID', value: selected.id },
            ...(active?.modelClass ? [{ key: '模型类', value: active.modelClass }] : []),
            ...(active?.layer ? [{ key: '模型图层', value: active.layer }] : []),
            ...(active?.texture ? [{ key: '贴图', value: `textures/${active.texture}.png` }] : []),
            ...(active?.shadow != null ? [{ key: '阴影半径', value: String(active.shadow) }] : []),
          ]}
          sources={[
            { label: '实体模型', path: `entitymodels.json` },
            { label: '动作脚本', path: `entityanims.json` },
          ]}
          soundKind="entity"
          soundId={selected.id}
          modelClass={active?.modelClass ?? null}
          animFile={anims.data ?? null}
          axes={axes}
          dyes={layerFile.data?.dyes ?? []}
          choice={choice}
          onChoice={(key, value) => setChoice((prev) => ({ ...prev, [key]: value }))}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
