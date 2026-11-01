import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ViteDevServer, PreviewServer, Plugin } from 'vite'

/**
 * 把素材目录挂到 /mc，支持多根顺序查找。
 *
 * @why 素材分两类：`mc-assets` 是能从 Mojang 官方 jar 全量重建的 500MB 纹理/音效，
 *      不进仓库；`mc-derived` 是从反编译源码提取、无法重建的几个 JSON（模型、图层、
 *      音效字幕），必须入库。两层同一套 URL，前端才能零感知。
 * @constraint 部署时应把 mc-assets 交给对象存储或独立静态服务，而不是塞进前端构建产物。
 */
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.ogg': 'audio/ogg',
  '.json': 'application/json; charset=utf-8',
  '.mcmeta': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.fsh': 'text/plain; charset=utf-8',
  '.vsh': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.zip': 'application/zip',
}

export function mcAssetsPlugin(
  roots: string | string[],
  mount = '/mc',
): Plugin {
  // @constraint 顺序即优先级：derived 里的 sounds.json 带官方字幕中文名，
  //      必须压过 fetch 重新生成的裸版本
  const bases = (Array.isArray(roots) ? roots : [roots]).map((root) => path.resolve(root))

  const middleware = async (
    req: { url?: string; method?: string },
    res: {
      statusCode: number
      setHeader(name: string, value: string | number): void
      end(): void
    },
    next: () => void,
  ) => {
    const url = req.url ?? ''
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (!url.startsWith(`${mount}/`)) return next()

    const rel = decodeURIComponent(url.slice(mount.length).split('?')[0] ?? '')
    // @constraint 防目录穿越：先归一化再判断，`..%2f` 解码后同样会被拦下
    const safe = path.posix.normalize(rel)
    if (safe.includes('..')) {
      res.statusCode = 403
      res.end()
      return
    }

    // @constraint 必须用异步 stat：首屏上百张图同时请求时，同步 IO 会阻塞事件循环
    let target: string | null = null
    let size = 0
    for (const base of bases) {
      const candidate = path.join(base, safe)
      try {
        const info = await stat(candidate)
        if (info.isFile()) {
          target = candidate
          size = info.size
          break
        }
      } catch {
        // 这一层没有，继续下一层
      }
    }

    if (!target) {
      // @why 不回落到 SPA，否则前端拿到 index.html 再当 JSON 解析会报出无关错误
      res.statusCode = 404
      res.end()
      return
    }

    const ext = path.extname(target).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
    res.setHeader('Content-Length', size)
    // @why 索引 JSON 会随重新提取而变，必须回源校验；图片音频内容由 hash 决定，可长期缓存
    res.setHeader('Cache-Control', ext === '.json' ? 'no-cache' : 'public, max-age=86400')
    if (req.method === 'HEAD') {
      res.statusCode = 200
      res.end()
      return
    }
    createReadStream(target).pipe(res as unknown as NodeJS.WritableStream)
  }

  return {
    name: 'mc-assets',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(middleware)
    },
  }
}
