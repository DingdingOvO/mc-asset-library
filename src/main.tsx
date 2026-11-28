import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * @constraint 样式必须按 legacy → App → index 的顺序引入。
 *      - legacy：尚未迁移的旧规则（工作台画布等）
 *      - App：页面与组件自己的样式（跟着模块图加载）
 *      - index：tokens / base / layout / ui 基元，必须最后，才能压过 legacy
 *      把 index 提到 App 之前，旧的 .hero / .modal 就会盖掉新组件。
 */
import './styles/legacy.css'
import App from './App'
import './styles/index.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('找不到 #root 挂载点')

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
