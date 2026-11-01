import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { loadRegistries, type Registry } from '@/lib/registries'
import { useAsync } from '@/lib/useAsync'
import { useLibrary } from '@/lib/useLibrary'

/**
 * 游戏数据总览。
 *
 * @why 这里以前叫「注册表」，把 models / shaders / font 也塞进了同一张表。
 *      那些是资源包里的文件，不是注册表——混在一起会让人以为 Minecraft 有
 *      一个叫 models 的注册表。现在按「游戏内容」和「资源文件」两类分开放，
 *      并且只在有意义的层级上用"注册表"这个词。
 */
export default function Data() {
  const { version, loading, error } = useLibrary()

  if (error) return <p className="notice notice--error container">版本清单加载失败：{error.message}</p>
  if (loading || !version) return <p className="empty">正在读取游戏数据…</p>

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
    <div className="container">
      <div className="page-head">
        <Link to="/" className="text-link">
          ← 返回首页
        </Link>
        <h1>游戏数据</h1>
        <p>
          注册表 {groups.registry.length} 个 · 资源文件 {groups.asset.length} 类
        </p>
      </div>

      {error && <p className="notice notice--error">读取失败：{error.message}</p>}
      {loading && <p className="empty">正在加载…</p>}

      <div className="section-title">
        注册表
        <span className="section-note">游戏启动时登记的 id 清单 · {total(groups.registry)} 条</span>
      </div>
      <div className="reg-list">
        {groups.registry.map((entry) => (
          <Link key={entry.id} to={entry.route} className="reg-row">
            <span className="reg-row__label">{entry.label}</span>
            <span className="reg-row__count">{entry.count}</span>
            <span className="reg-row__source">{entry.source}</span>
          </Link>
        ))}
      </div>

      <div className="section-title">
        资源文件
        <span className="section-note">资源包里按目录存放的文件 · 不是注册表</span>
      </div>
      <div className="reg-list">
        {groups.asset.map((entry) => (
          <Link key={entry.id} to={entry.route} className="reg-row">
            <span className="reg-row__label">{entry.label}</span>
            <span className="reg-row__count">{entry.count}</span>
            <span className="reg-row__source">{entry.source}</span>
          </Link>
        ))}
      </div>

      <p className="notice" style={{ marginTop: 16 }}>
        注册表数据来自 client.jar：物品、方块、实体按模型与语言文件整理，附魔、画、伤害类型、生物群系等按
        data 侧 JSON 整理。代码里写死的分组（创造模式物品栏的标签页）无法从资源中还原，因此不在此列。
      </p>
    </div>
  )
}
