import { Link } from 'react-router-dom'
import type { ContainerDef } from '@/lib/containers'

/**
 * 容器选择区。
 *
 * @why 二十多个容器平铺一列，找熔炉要扫过整个列表。按使用场景分组之后，
 *      常用的组在首屏，「玩家与交易」这种偶尔用的沉到最后。分组只是列表的
 *      组织方式，不影响画布与导出——组内顺序就是视觉顺序。
 *
 * @constraint ids 必须是 containers.json 里真实存在的 id。拼错的项会被静默
 *      跳过（下面的 filter），表现出来就是"某个容器突然不见了"。
 */
const GROUPS: { label: string; ids: string[] }[] = [
  { label: '快捷栏', ids: ['hotbar'] },
  { label: '储存', ids: ['chest_1', 'chest_2', 'chest_3', 'chest_6', 'shulker_box', 'hopper', 'dispenser'] },
  {
    label: '工作站',
    ids: [
      'crafting',
      'crafter',
      'furnace',
      'smoker',
      'blast_furnace',
      'anvil',
      'smithing',
      'grindstone',
      'loom',
      'cartography',
      'stonecutter',
      'enchanting',
      'brewing',
    ],
  },
  { label: '玩家与交易', ids: ['inventory', 'villager', 'beacon'] },
]

export interface ContainerPaletteProps {
  defs: Map<string, ContainerDef>
  loading: boolean
  onAdd: (id: string) => void
}

export function ContainerPalette({ defs, loading, onAdd }: ContainerPaletteProps) {
  return (
    <>
      {loading && <p className="empty">读取中…</p>}
      {GROUPS.map((group) => {
        const list = group.ids.map((id) => defs.get(id)).filter((def): def is ContainerDef => !!def)
        if (!list.length) return null
        return (
          <section key={group.label} className="palette">
            <h2 className="workbench__section">{group.label}</h2>
            {list.map((def) => (
              <button
                key={def.id}
                type="button"
                className={`palette__item${def.id === 'hotbar' ? ' palette__item--hero' : ''}`}
                onClick={() => onAdd(def.id)}
                title={`${def.screen} · ${def.width}×${def.height} · ${def.slots.length} 槽`}
              >
                <span className="palette__name">{def.name}</span>
                <span className="palette__meta">
                  {def.width}×{def.height}
                </span>
              </button>
            ))}
          </section>
        )
      })}
      <Link className="workbench__link" to="/browse/gui">
        GUI 贴图原图 →
      </Link>
    </>
  )
}
