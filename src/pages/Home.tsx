import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CubeIcon, ListIcon, SoundIcon } from '@/components/icons'
import { SearchBox } from '@/components/SearchBox'
import { useLibrary } from '@/lib/useLibrary'

interface EntryProps {
  to: string
  label: string
  count: number
  unit: string
  desc: string
  icon?: React.ReactNode
}

function Entry({ to, label, count, unit, desc, icon }: EntryProps) {
  return (
    <Link to={to} className="entry-card">
      <span className="entry-card__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="entry-card__body">
        <span className="entry-card__label">{label}</span>
        <span className="entry-card__count">
          {count} {unit}
        </span>
        <span className="entry-card__desc">{desc}</span>
      </span>
    </Link>
  )
}

export default function Home() {
  const { version, current, loading, error } = useLibrary()
  const [query, setQuery] = useState('')
  const navigate = useNavigate()

  const itemCount = current?.itemCount ?? 0
  const blockCount = current?.blockCount ?? 0
  const summary = current?.registrySummary ?? []
  const pick = (id: string) => summary.find((entry) => entry.id === id)?.count ?? 0

  const entityCount = pick('entities')
  const soundCount = pick('sounds')
  const guiCount = current?.groups.find((group) => group.id === 'gui')?.count ?? 0

  return (
    <div className="container">
      <div className="hero">
        <div>
          <h1 className="hero__title">Minecraft 素材库</h1>
          <div className="hero__meta">
            {version && <span className="badge">Java {version}</span>}
            <span className="stat">
              <b>{blockCount}</b> 方块
            </span>
            <span className="stat">
              <b>{itemCount}</b> 物品
            </span>
            <span className="stat">
              <b>{entityCount}</b> 生物
            </span>
            <span className="stat">
              <b>{guiCount}</b> 界面
            </span>
          </div>
        </div>
      </div>

      <SearchBox
        primary
        value={query}
        onChange={setQuery}
        placeholder="搜索方块、物品、生物…"
        onSubmit={() => {
          const keyword = query.trim()
          navigate(keyword ? `/blocks?q=${encodeURIComponent(keyword)}` : '/blocks')
        }}
      />

      {error && <p className="notice notice--error">素材索引加载失败：{error.message}</p>}
      {loading && <p className="empty">正在加载素材索引…</p>}

      {current && (
        <>
          <div className="entry-grid">
            <Entry
              to="/blocks"
              label="方块"
              count={blockCount}
              unit="个"
              desc="按 blockstates 与模型 JSON 渲染的立体形态"
              icon={<CubeIcon />}
            />
            <Entry
              to="/items"
              label="物品"
              count={itemCount}
              unit="项"
              desc="全部物品，含工具、盔甲、材料与刷怪蛋"
              icon={<CubeIcon />}
            />
            <Entry
              to="/entities"
              label="生物"
              count={entityCount}
              unit="个"
              desc="按游戏骨骼与 setupAnim 实时摆姿势"
              icon={<CubeIcon />}
            />
            <Entry
              to="/ui"
              label="界面"
              count={guiCount}
              unit="张"
              desc="GUI 贴图：容器、按钮、图标"
              icon={<ListIcon />}
            />
          </div>

          <div className="section-title">
            注册表
            <Link to="/data" className="section-link">
              数据总览 →
            </Link>
          </div>
          <div className="cat-grid">
            {summary
              .filter(
                (entry) =>
                  entry.kind !== 'asset' && !['items', 'blocks', 'entities'].includes(entry.id),
              )
              .map((entry) => (
                <Link key={entry.id} to={entry.route} className="cat-card">
                  <span className="cat-card__text">
                    <span className="cat-card__name">{entry.label}</span>
                    <span className="cat-card__count">{entry.count} 条</span>
                  </span>
                </Link>
              ))}
          </div>

          <div className="section-title">
            资源文件
            <span className="section-note">资源包里的目录 · 不是注册表</span>
          </div>
          <div className="cat-grid">
            {summary
              .filter((entry) => entry.kind === 'asset' && entry.id !== 'sounds')
              .map((entry) => (
                <Link key={entry.id} to={entry.route} className="cat-card">
                  <span className="cat-card__text">
                    <span className="cat-card__name">{entry.label}</span>
                    <span className="cat-card__count">{entry.count} 个文件</span>
                  </span>
                </Link>
              ))}
          </div>

          <div className="section-title">其他</div>
          <div className="cat-grid">
            <Link to="/particles" className="cat-card">
              <span className="cat-card__thumb cat-card__thumb--icon" aria-hidden="true">
                <CubeIcon />
              </span>
              <span className="cat-card__text">
                <span className="cat-card__name">粒子效果</span>
                <span className="cat-card__count">115 个 · 尺寸取自源码</span>
              </span>
            </Link>
            <Link to="/sounds" className="cat-card">
              <span className="cat-card__thumb cat-card__thumb--icon" aria-hidden="true">
                <SoundIcon />
              </span>
              <span className="cat-card__text">
                <span className="cat-card__name">音效库</span>
                <span className="cat-card__count">{soundCount} 个 · 可试听</span>
              </span>
            </Link>
            <Link to="/browse" className="cat-card">
              <span className="cat-card__thumb cat-card__thumb--icon" aria-hidden="true">
                <ListIcon />
              </span>
              <span className="cat-card__text">
                <span className="cat-card__name">贴图文件</span>
                <span className="cat-card__count">{current.counts.texture} 张 · 按目录浏览</span>
              </span>
            </Link>
          </div>
        </>
      )}
    </div>
  )
}
