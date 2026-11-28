import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { CubeIcon, ListIcon, SoundIcon, TextIcon, WallIcon } from '@/components/icons'
import { LoadingState, Page, SearchField } from '@/ui'
import { useLibrary } from '@/lib/useLibrary'
import { textureSrc } from '@/lib/mc'
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
          {/* @why 立体字和背景墙没有"条目数量"，写个 0 会让人以为坏了 */}
          {count > 0 && (
            <span className="entry__count">
              {count.toLocaleString('zh-CN')} {unit}
            </span>
          )}
        </span>
        <span className="entry__desc">{desc}</span>
      </span>
    </Link>
  )
}

/**
 * 首屏右侧的方块拼贴。
 *
 * @why 固定挑九个对比度大的贴图：随机挑会抽到一堆灰石头，一整块糊在一起。
 *      每格用 CSS 的 image-rendering: pixelated，16×16 的贴图放大也不糊。
 */
const COLLAGE = [
  'block/oak_planks',
  'block/stone_bricks',
  'block/gold_block',
  'block/diamond_block',
  'block/bricks',
  'block/emerald_block',
  'block/prismarine_bricks',
  'block/nether_bricks',
  'block/quartz_block_side',
]

function HeroCollage({ version }: { version: string }) {
  return (
    <div className="hero__collage" aria-hidden="true">
      {COLLAGE.map((id) => (
        <img key={id} src={textureSrc(version, id)} alt="" loading="lazy" />
      ))}
    </div>
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
            做视频、画封面、搭直播间的时候，总得先看清素材长什么样。
            这里把方块、物品、生物、界面都搬进了浏览器——能转、能播、能导出，省得为了截一张图去开游戏。
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
        {version && <HeroCollage version={version} />}
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
              desc="连半截的门和床都在，火与岩浆按原版帧序动"
              icon={<CubeIcon />}
            />
            <Entry
              to="/items"
              label="物品"
              count={itemCount}
              unit="项"
              desc="创造栏里的全部条目，顺序也照着游戏来"
              icon={<CubeIcon />}
            />
            <Entry
              to="/entities"
              label="生物"
              count={entityCount}
              unit="个"
              desc="按骨骼和步态公式走，点开能拆开图层看"
              icon={<CubeIcon />}
            />
            <Entry
              to="/ui"
              label="界面工作台"
              count={guiCount}
              unit="张底图"
              desc="摆容器、放物品、导出成图，布局取自反编译源码"
              icon={<ListIcon />}
            />
            <Entry
              to="/text3d"
              label="立体字"
              count={0}
              unit=""
              desc="给标题挤出厚度，透明底 PNG 直接压在背景墙上"
              icon={<TextIcon />}
            />
            <Entry
              to="/wall"
              label="背景墙"
              count={0}
              unit=""
              desc="方块纹理铺一面墙，比例和密度随手调"
              icon={<WallIcon />}
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
