import { Suspense, lazy, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { LoadingState } from '@/ui'
import Home from '@/features/home/Home'
import { useCursors } from '@/lib/useCursors'

/**
 * @constraint 首页必须同步引入，其余页面一律懒加载。
 *
 * 这里原本每个页面都是同步 import，再用 vite-plugin-singlefile 打成单文件，
 * 首屏 920KB，慢网络下 35 秒看不到任何东西。拆成路由级 chunk 之后首页只带
 * vendor + 首页自己的代码，点进方块页才去下渲染层。
 */
const Blocks = lazy(() => import('@/features/blocks/Blocks'))
const Items = lazy(() => import('@/features/items/Items'))
const Entities = lazy(() => import('@/features/entities/Entities'))
const Particles = lazy(() => import('@/features/particles/Particles'))
const Structures = lazy(() => import('@/features/structures/Structures'))
const Sounds = lazy(() => import('@/features/sounds/Sounds'))
const Browse = lazy(() => import('@/features/textures/Browse'))
const Data = lazy(() => import('@/features/data/Data'))
const Registry = lazy(() => import('@/features/data/Registry'))
const Ui = lazy(() => import('@/features/workbench/Ui'))
const Text3D = lazy(() => import('@/features/text3d/Text3D'))
const NotFound = lazy(() => import('@/features/notfound/NotFound'))

/**
 * @constraint Suspense 要逐个路由包，不能包在 `<Routes>` 外面。
 *      包在外层时，任何一个页面 chunk 还在下载，整个外壳（导航栏）都会被
 *      fallback 顶掉，切换页面闪过一整屏空白；包在单个路由里只影响内容区。
 */
function page(node: ReactNode) {
  return (
    <Suspense
      fallback={
        <div className="page">
          <LoadingState />
        </div>
      }
    >
      {node}
    </Suspense>
  )
}

export default function App() {
  // @constraint React Router 的 basename 不能带结尾斜杠，__SITE_BASE__ 一定带
  const basename = __SITE_BASE__.replace(/\/$/, '') || '/'
  useCursors()

  return (
    <BrowserRouter basename={basename}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="blocks" element={page(<Blocks />)} />
          <Route path="items" element={page(<Items />)} />
          <Route path="items/:group" element={page(<Items />)} />
          <Route path="entities" element={page(<Entities />)} />
          <Route path="structures" element={page(<Structures />)} />
          <Route path="particles" element={page(<Particles />)} />
          <Route path="ui" element={page(<Ui />)} />
          <Route path="text3d" element={page(<Text3D />)} />
          <Route path="data" element={page(<Data />)} />
          <Route path="data/:id" element={page(<Registry />)} />
          {/* @why 旧链接可能在别处贴过，别让它们 404 */}
          <Route path="registries" element={<Navigate to="/data" replace />} />
          <Route path="registries/:id" element={<Navigate to="/data" replace />} />
          <Route path="browse" element={page(<Browse />)} />
          <Route path="browse/:group" element={page(<Browse />)} />
          <Route path="sounds" element={page(<Sounds />)} />
          <Route path="sounds/:group" element={page(<Sounds />)} />
          <Route path="*" element={page(<NotFound />)} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
