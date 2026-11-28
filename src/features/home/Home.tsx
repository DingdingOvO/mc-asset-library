import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CubeIcon, ListIcon, SoundIcon } from '@/components/icons'
import { LoadingState, Page, SearchField } from '@/ui'
import { useLibrary } from '@/lib/useLibrary'
import './home.css'

interface EntryProps {
  to: string
  label: string
  count: number
  unit: string
  desc: string
  icon: React.ReactNode
}

function Entry({ to, label, count, unit, desc, icon }: EntryProps) {
  return (
    <Link to={to} className="entry">
      <span className="entry__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="entry__body">
        <span className="entry__top">
          <span className="entry__label">{label}</span>
          <span className="entry__count">
            {count.toLocaleString('zh-CN')} {unit}
          </span>
        </span>
        <span className="entry__desc">{desc}</span>
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
  /**
   * @constraint 线上部署版（CI 带 --no-sounds）没有 .ogg，写「可试听」就是骗人。
   *      标志由 pack 阶段按实际分发内容写进 registrySummary，别在前端猜。
   */
  const soundPlayable = summary.find((entry) => entry.id === 'sounds')?.audio === 1
  const guiCount = current?.groups.find((group) => group.id === 'gui')?.count ?? 0
  const textureCount = current?.counts.texture ?? 0

  const stats = [
    { value: blockCount, label: '方块' },
    { value: itemCount, label: '物品' },
    { value: entityCount, label: '生物' },
    { value: guiCount, label: '界面底图' },
    { value: textureCount, label: '贴图' },
    { value: soundCount, label: '音效' },
  ]

  return (
    <Page>
      <section className="hero">
        <div className="hero__text">
          <div className="hero__eyebrow">
            {version ? `Java ${version}` : 'Minecraft Java'}
            <span className="hero__dot" aria-hidden="true" />
            素材在浏览器里直接渲染
          </div>
          <h1 className="hero__title">Minecraft 素材库</h1>
          <p className="hero__lead">
            做视频用的。模型在站内直接渲染、动画直接播放，不用开游戏对着看。
            需要成图时，把界面摆出来、物品放进去，导出 PNG。
          </p>

          <div className="hero__search">
            <SearchField
              primary
              value={query}
              onChange={setQuery}
              placeholder="搜索方块、物品、生物…"
              onSubmit={() => {
                const keyword = query.trim()
                navigate(keyword ? `/blocks?q=${encodeURIComponent(keyword)}` : '/blocks')
              }}
            />
          </div>

          <dl className="stats">
            {stats.filter((stat) => stat.value > 0).map((stat) => (
              <div key={stat.label} className="stats__item">
                <dt>{stat.label}</dt>
                <dd>{stat.value.toLocaleString('zh-CN')}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {error && <p className="notice notice--error">素材索引加载失败：{error.message}</p>}
      {loading && <LoadingState label="正在加载素材索引…" />}

      {current && (
        <>
          <section className="entries" aria-label="素材类型">
            <Entry
              to="/blocks"
              label="方块"
              count={blockCount}
              unit="个"
              desc="按 blockstates 与模型渲染，火、水、岩浆的动画贴图按 frametime 走"
              icon={<CubeIcon />}
            />
            <Entry
              to="/items"
              label="物品"
              count={itemCount}
              unit="项"
              desc="创造模式物品栏的全部条目，含工具、盔甲、材料与刷怪蛋"
              icon={<CubeIcon />}
            />
            <Entry
              to="/entities"
              label="生物"
              count={entityCount}
              unit="个"
              desc="按游戏骨骼与步态公式实时动作，详情里持续循环播放"
              icon={<CubeIcon />}
            />
            <Entry
              to="/ui"
              label="界面工作台"
              count={guiCount}
              unit="张底图"
              desc="摆容器、放物品、导出成图——布局全部取自反编译源码"
              icon={<ListIcon />}
            />
          </section>

          <section className="clips">
            <h2 className="clips__title">素材片段</h2>
            <div className="clips__grid">
              <Link to="/particles" className="clip">
                <span className="clip__icon" aria-hidden="true">
                  <CubeIcon />
                </span>
                <span className="clip__body">
                  <span className="clip__name">粒子效果</span>
                  <span className="clip__meta">尺寸取自源码 · {pick('particles')} 种</span>
                </span>
              </Link>
              <Link to="/sounds" className="clip">
                <span className="clip__icon" aria-hidden="true">
                  <SoundIcon />
                </span>
                <span className="clip__body">
                  <span className="clip__name">音效</span>
                  <span className="clip__meta">
                    {soundCount.toLocaleString('zh-CN')} 个 · {soundPlayable ? '可试听' : '仅清单'}
                  </span>
                </span>
              </Link>
              <Link to="/browse" className="clip">
                <span className="clip__icon" aria-hidden="true">
                  <ListIcon />
                </span>
                <span className="clip__body">
                  <span className="clip__name">贴图文件</span>
                  <span className="clip__meta">{textureCount.toLocaleString('zh-CN')} 张 · 按目录浏览</span>
                </span>
              </Link>
            </div>
          </section>

          {/* @why 注册表和历史沿革相关的东西不该占首屏：做视频的人关心的是画面，
              不是 1288 条 block id 的注册表结构。收进折叠区，需要查的时候点开。 */}
          <details className="more">
            <summary className="more__summary">
              <span className="more__title">注册表与资源文件</span>
              <span className="more__note">数据总览、按目录的文件清单</span>
            </summary>
            <div className="more__body">
              {summary.map((entry) => (
                <Link key={entry.id} to={entry.route} className="more__item">
                  <span className="more__label">{entry.label}</span>
                  <span className="more__count">
                    {entry.count.toLocaleString('zh-CN')}
                    {entry.kind === 'asset' ? ' 个文件' : ' 条'}
                  </span>
                </Link>
              ))}
            </div>
          </details>
        </>
      )}
    </Page>
  )
}
