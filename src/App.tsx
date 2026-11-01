import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import Browse from '@/pages/Browse'
import Home from '@/pages/Home'
import Blocks from '@/pages/Blocks'
import Entities from '@/pages/Entities'
import Ui from '@/pages/Ui'
import Items from '@/pages/Items'
import Data from '@/pages/Data'
import Registry from '@/pages/Registry'
import NotFound from '@/pages/NotFound'
import Sounds from '@/pages/Sounds'
import Particles from '@/pages/Particles'

export default function App() {
  // @constraint React Router 的 basename 不能带结尾斜杠，__SITE_BASE__ 一定带
  const basename = __SITE_BASE__.replace(/\/$/, '') || '/'

  return (
    <BrowserRouter basename={basename}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Home />} />
          <Route path="blocks" element={<Blocks />} />
          <Route path="items" element={<Items />} />
          <Route path="items/:group" element={<Items />} />
          <Route path="entities" element={<Entities />} />
          <Route path="particles" element={<Particles />} />
          <Route path="ui" element={<Ui />} />
          <Route path="data" element={<Data />} />
          <Route path="data/:id" element={<Registry />} />
          {/* @why 旧链接可能在别处贴过，别让它们 404 */}
          <Route path="registries" element={<Navigate to="/data" replace />} />
          <Route path="registries/:id" element={<Navigate to="/data" replace />} />
          <Route path="browse" element={<Browse />} />
          <Route path="browse/:group" element={<Browse />} />
          <Route path="sounds" element={<Sounds />} />
          <Route path="sounds/:group" element={<Sounds />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
