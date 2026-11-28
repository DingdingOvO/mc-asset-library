import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ErrorState, LoadingState, Page, PageHeader, Section } from '@/ui'
import { loadRegistries, type Registry } from '@/lib/registries'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'
import { ChevronIcon } from '@/components/icons'
import './data.css'

/**
 * 游戏数据总览。
 *
 * @why 这里以前叫「注册表」，把 models / shaders / font 也塞进了同一张表。
 *      那些是资源包里的文件，不是注册表——混在一起会让人以为 Minecraft 有
 *      一个叫 models 的注册表。现在按「游戏内容」和「资源文件」两类分开放。
 */
export default function Data() {
  const { version, loading, error } = useLibrary()

  if (error) {
    return (
      <Page>
        <ErrorState title="版本清单加载失败" detail={error.message} />
      </Page>
    )
  }
  if (loading || !version) return <Page><LoadingState label="正在读取游戏数据…" /></Page>

  return <DataBrowser version={version} />
}

function DataBrowser({ version }: { version: string }) {
  const { data, loading, error } = useAsync(`registries:${version}`, () => loadRegistries(version))

  const groups = useMemo(() => {
    const registries = data?.registries ?? []
    return {
      registry: registries.filter((entry) => entry.kind !== 'asset'),
      asset: registries.filter((entry) => entry.kind === 'asset'),
    }
  }, [data])

  const total = (list: Registry[]) => list.reduce((sum, entry) => sum + entry.count, 0)

  return (
    <Page>
      <PageHeader
        back={{ to: '/', label: '首页' }}
        title="游戏数据"
        lead={
          <>
            <span className="num">{groups.registry.length}</span> 个注册表、{' '}
            <span className="num">{groups.asset.length}</span> 类资源文件 · 想扒原始 JSON 来这儿
          </>
        }
      />

      {error && <ErrorState title="读取失败" detail={error.message} />}
      {loading && <LoadingState />}

      <div className="data-sections">
        <Section
          title="注册表"
          note={`游戏启动时登记的 id 清单 · ${total(groups.registry).toLocaleString('zh-CN')} 条`}
        >
          <div className="table">
            <div className="table__head" aria-hidden="true">
              <span>名称</span>
              <span className="table__num">条目</span>
              <span>来源</span>
              <span />
            </div>
            {groups.registry.map((entry) => (
              <Link key={entry.id} to={entry.route} className="table__row">
                <span className="table__label">{entry.label}</span>
                <span className="table__num">{entry.count.toLocaleString('zh-CN')}</span>
                <span className="table__meta">{entry.source}</span>
                <span className="table__chevron">
                  <ChevronIcon />
                </span>
              </Link>
            ))}
          </div>
        </Section>

        <Section title="资源文件" note="资源包里按目录存放的文件 · 不是注册表">
          <div className="table">
            <div className="table__head" aria-hidden="true">
              <span>名称</span>
              <span className="table__num">文件</span>
              <span>来源</span>
              <span />
            </div>
            {groups.asset.map((entry) => (
              <Link key={entry.id} to={entry.route} className="table__row">
                <span className="table__label">{entry.label}</span>
                <span className="table__num">{entry.count.toLocaleString('zh-CN')}</span>
                <span className="table__meta">{entry.source}</span>
                <span className="table__chevron">
                  <ChevronIcon />
                </span>
              </Link>
            ))}
          </div>
        </Section>
      </div>

      <p className="notice data-note">
        注册表数据来自 client.jar：物品、方块、实体按模型与语言文件整理，附魔、画、伤害类型、生物群系等按
        data 侧 JSON 整理。代码里写死的分组（创造模式物品栏的标签页）无法从资源中还原，因此不在此列。
      </p>
    </Page>
  )
}
