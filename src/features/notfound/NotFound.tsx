import { Link } from 'react-router-dom'
import { Page } from '@/ui'
import './notfound.css'

export default function NotFound() {
  return (
    <Page>
      <div className="notfound">
        <p className="notfound__code">404</p>
        <h1 className="notfound__title">这个页面不存在</h1>
        <p className="notfound__hint">
          链接可能过期了，或者素材分类改过名字。从首页重新找一次会更快。
        </p>
        <div className="notfound__actions">
          <Link to="/" className="btn btn--primary">
            回到首页
          </Link>
          <Link to="/blocks" className="btn">
            浏览方块
          </Link>
        </div>
      </div>
    </Page>
  )
}
