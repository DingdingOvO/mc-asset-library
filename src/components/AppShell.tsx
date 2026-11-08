import { Link, NavLink, Outlet } from 'react-router-dom'
import { ThemeToggle } from './ThemeToggle'

export function AppShell() {
  return (
    <div className="shell">

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
      <main>
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
