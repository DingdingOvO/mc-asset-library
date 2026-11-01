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
import { preview } from 'vite'

const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'

const server = await preview({
  preview: { host, port, strictPort: true, allowedHosts: true },
})

server.printUrls()
