import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { mcAssetsPlugin } from './vite.mc-assets.ts'

/**
 * GitHub Pages 没有 rewrite 能力，深链接（/entities/xxx）会被当成文件找不到。
 * @why 复制一份 404.html 就能让 Pages 把任意未知路径交回 SPA；但产物是
 *      单文件 HTML，React Router 又会按 BASE_URL 剥掉前缀，所以直接复制即可。
 */
function pagesFallback(): Plugin {
  return {
    name: 'pages-fallback',
    apply: 'build',
    closeBundle() {
      const dist = path.resolve(import.meta.dirname, 'dist')
      copyFileSync(path.join(dist, 'index.html'), path.join(dist, '404.html'))
    },
  }
}

/**
 * @constraint 不能用 Vite 的 `base` / `import.meta.env.BASE_URL`：vite-plugin-singlefile
 *      在 config 钩子里把 base 强制改成 './'（为了产物能直接 file:// 打开），
 *      BASE_URL 永远是 './'，路由 basename 会变成 "."，整站渲染不出东西。
 *      这里自己算一份绝对前缀注入成常量，与插件解耦。
 */
const siteBase = (() => {
  const raw = process.env.VITE_BASE ?? '/'
  return raw.endsWith('/') ? raw : `${raw}/`
})()

export default defineConfig({
  // @why 线上网关偶发丢请求，CSS/JS 分开加载时只要丢一个页面就裸奔；
  // 内联成单文件后整站只有一个 HTML 请求，素材图片再按需加载
  plugins: [
    react(),
    // @why derived 在前：sounds.json 的中文字幕名只在 derived 里，
    //      mc-assets 那份是 fetch 重新生成的裸版本
    mcAssetsPlugin(['./mc-derived', './mc-assets']),
    viteSingleFile(),
    pagesFallback(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    // @constraint 部署在反代域名后，Host 头与本地不一致，必须放行否则 Vite 直接 403
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  define: {
    // @why 用户无法判断线上是否已更新，页脚直接显示构建时间
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    // @why 站点可能挂在子路径下（GitHub Pages 是 /<repo>/），路由与素材地址都要带前缀
    __SITE_BASE__: JSON.stringify(siteBase),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
})
