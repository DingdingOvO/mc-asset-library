/**
 * 发布用的静态服务：目录直出 + SPA 回退。
 *
 * @why 直接用 `python3 -m http.server` 时，/ui、/blocks 这类深链接会拿到
 *      服务器自己的 404 页，React Router 根本没机会接管——用户看到的是
 *      白底黑字的 "Error response"，而不是站内的 404 页。任何不是真实文件的
 *      路径都要回落到 index.html。
 *
 * @constraint 只有「不像静态资源」的路径才回落。带扩展名的（.png/.json/.js）
 *      一律 404，否则素材缺失时返回一张 HTML，前端会把它当图片解析，
 *      报错信息完全看不出真正原因。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'
const root = path.resolve(process.env.SITE_ROOT || '_site')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
}

async function isFile(target) {
  try {
    const info = await stat(target)
    return info.isFile()
  } catch {
    return false
  }
}

async function send(response, file, status = 200) {
  const body = await readFile(file)
  response.writeHead(status, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // @constraint 素材按版本目录冻结，长缓存；HTML 必须每次回源，否则更新推不出去
    'cache-control': file.endsWith('.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
  })
  response.end(body)
}

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  let pathname = decodeURIComponent(url.pathname)

  const direct = path.join(root, pathname)
  if (pathname !== '/' && (await isFile(direct))) {
    await send(response, direct)
    return
  }
  if (pathname.endsWith('/') && (await isFile(path.join(direct, 'index.html')))) {
    await send(response, path.join(direct, 'index.html'))
    return
  }
  // 带扩展名却不是文件的 → 真 404，别把 HTML 喂给 <img>
  if (path.extname(pathname) !== '') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('404')
    return
  }
  const fallback = path.join(root, 'index.html')
  if (await isFile(fallback)) {
    await send(response, fallback)
    return
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('404')
}).listen(port, host, () => {
  console.log(`[serve-site] ${root} → http://${host}:${port}`)
})
