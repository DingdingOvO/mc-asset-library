import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

/**
 * 一级导航。
 * @why 抽成数据：顶栏与后续可能加的移动端菜单、页脚都需要同一份清单，
 *      写两遍必然漏一项。
 */
const NAV = [
  { to: '/items', label: '物品' },
  { to: '/blocks', label: '方块' },
  { to: '/entities', label: '生物' },
  { to: '/particles', label: '粒子' },
  { to: '/structures', label: '结构' },
  { to: '/ui', label: '界面' },
  { to: '/text3d', label: '立体字' },
  { to: '/wall', label: '背景墙' },
  { to: '/data', label: '数据' },
  { to: '/sounds', label: '音效' },
] as const

export function AppShell() {
  /**
   * @why 给 main 换 key：路由一变就重建这个容器，入场动画才会重放。
   *      只靠 CSS transition 没有可过渡的初末状态——旧页面在同一帧被卸载了。
   * @constraint key 只取 pathname，不能带上 search：搜索框每敲一个字都会改
   *      query，带上就会让整页闪一下。
   */
  const { pathname } = useLocation()

  /**
   * 工作台页面占满视口，不显示页脚。
   * @why `/ui` 的外壳高度是 `100dvh - 顶栏`，页脚再占 60px 就会多出一条滚动条。
   */
  const fullBleed = pathname === '/ui' || pathname === '/text3d'

  return (
    <div className={fullBleed ? 'shell shell--full' : 'shell'}>
      <header className="topbar">
        <Link to="/" className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true">
            M
          </span>
          MC 素材库
        </Link>

        <nav className="topbar__nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className="topbar__link">
              {item.label}
            </NavLink>
          ))}
        </nav>

        <span className="topbar__spacer" />
        <ThemeToggle />
      </header>

      <main key={pathname}>
        <Outlet />
      </main>

      <footer className="footer">
        <span>
          素材版权归 Mojang Studios 与 Microsoft 所有 · 本站是非官方站点，为视频制作与学习提供参考
        </span>
        <span className="footer__build">构建 {__BUILD_TIME__.slice(0, 16).replace('T', ' ')}</span>
      </footer>
    </div>
  )
}
