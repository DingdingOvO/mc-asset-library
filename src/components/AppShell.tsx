import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

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
   * @why `/ui` 的外壳高度是 `100dvh - 顶栏`，页脚再占 60px 就会多出一条滚动条：
   *      整块画布永远露出半截页脚，看起来像布局没对齐。
   */
  const fullBleed = pathname === '/ui'

  return (
    <div className={fullBleed ? 'shell shell--full' : 'shell'}>

      <header className="topbar">
        <Link to="/" className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true">
            M
          </span>
          MC 素材库
        </Link>

        <nav className="topbar__nav">
          <NavLink to="/items" className="topbar__link">
            物品
          </NavLink>
          <NavLink to="/blocks" className="topbar__link">
            方块
          </NavLink>
          <NavLink to="/entities" className="topbar__link">
            生物
          </NavLink>
          <NavLink to="/particles" className="topbar__link">
            粒子
          </NavLink>
          <NavLink to="/structures" className="topbar__link">
            结构
          </NavLink>
          <NavLink to="/ui" className="topbar__link">
            界面
          </NavLink>
          <NavLink to="/data" className="topbar__link">
            数据
          </NavLink>
          <NavLink to="/sounds" className="topbar__link">
            音效
          </NavLink>
        </nav>

        <span className="topbar__spacer" />
        <ThemeToggle />
      </header>
      <main key={pathname}>
        <Outlet />
      </main>
      <footer className="footer">
        <span>
          素材版权归 Mojang Studios 与 Microsoft 所有，本站为视频制作与学习提供素材参考，非官方站点。
        </span>
        <span className="footer__build">构建 {__BUILD_TIME__.slice(0, 16).replace('T', ' ')}</span>
      </footer>
    </div>
  )
}
