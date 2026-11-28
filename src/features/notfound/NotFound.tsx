import { Link } from 'react-router-dom'
import { Page } from '@/ui'
import './notfound.css'

export default function NotFound() {
  return (
    <Page>
      <div className="notfound">
        <p className="notfound__code">404</p>
        <h1 className="notfound__title">这页大概被苦力怕炸了</h1>
        <p className="notfound__hint">
          <span className="notfound__face">(´・ω・`)</span>
          链接可能过期，或者分类改过名字。回首页重新找一次会更快。
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
