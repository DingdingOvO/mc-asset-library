import { Link } from 'react-router-dom'

export default function NotFound() {
  return (
    <div className="container">
      <p className="empty">
        页面不存在 · <Link className="text-link" to="/">回到首页</Link>
      </p>
    </div>
  )
}
