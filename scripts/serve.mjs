/**
 * 线上部署用的常驻服务。
 *
 * @why 部署平台只注入 PORT 环境变量，而 `vite preview --port $PORT` 在不同
 *      启动方式下 $PORT 常常拿不到（命令被重写时变量丢失，vite 直接报
 *      "option --port value is missing"）。这里改成进程内读 env 再调 API，
 *      绕开命令行参数展开。
 *
 * @constraint 必须用 preview 而不是自己的静态服务：/mc 素材由 vite.mc-assets.ts
 *      中间件提供，绕开 vite 会让所有模型贴图 404。
 */
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { preview } from 'vite'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'
const root = path.resolve(import.meta.dirname, '..')

/**
 * 启动前点一次素材。
 * @why 换机器部署时最容易出的岔子就是素材目录没跟着走：服务照常起来、
 *      HTML 照常 200，只是整站没有一张图，而且日志里一个字都没有。
 *      这里只警告不阻塞——派生数据还在的话至少能打开页面看结构。
 */
async function probeAssets() {
  for (const dir of ['mc-assets', 'mc-derived']) {
    try {
      await stat(path.join(root, dir))
    } catch {
      console.warn(`[serve] 警告：${dir}/ 不存在，/mc 下的请求会 404`)
      if (dir === 'mc-assets') {
        console.warn('[serve] 补齐方式：pnpm run setup，或把已有的 mc-assets 目录放到项目根')
      }
    }
  }
}

await probeAssets()

const server = await preview({
  preview: { host, port, strictPort: true, allowedHosts: true },
})

server.printUrls()
