import { copyFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { mcAssetsPlugin } from './vite.mc-assets.ts'

/**
 * GitHub Pages 没有 rewrite 能力，深链接（/entities/xxx）会被当成文件找不到。
 * @why 复制一份 404.html 就能让 Pages 把任意未知路径交回 SPA。产物已改为
 *      code splitting，404.html 里的资源用绝对 base 引用，所以在深路径下
 *      被加载也不会去错地方（相对路径会解析成 /repo/sounds/assets/…）。
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
 * 站点前缀。
 *
 * @constraint 必须自己算一份绝对前缀，不能只依赖 `import.meta.env.BASE_URL`
 *      给路由当 basename：Pages 部署在 `/repo/` 下，任何以 `./` 开头的相对
 *      解析都会在深路径（`/repo/sounds/mob`）里指错目录。
 */
const siteBase = (() => {
  const raw = process.env.VITE_BASE ?? '/'
  return raw.endsWith('/') ? raw : `${raw}/`
})()

export default defineConfig({
  /**
   * @constraint 必须是绝对前缀。产物不再是单文件，404.html 会落在
   *      `/repo/sounds/mob` 这种深路径下被加载，相对路径 `./assets/x.js`
   *      会被解析成 `/repo/sounds/assets/x.js`，整页白屏。
   */
  base: siteBase,
  /**
   * @why 这里曾经用 vite-plugin-singlefile 把所有 JS/CSS 内联进一个 HTML，
   *      理由是「线上网关偶发丢请求」。代价是首屏必须下完整个 920KB 才能
   *      出现任何东西：慢网络下实测 35 秒白屏，用户以为站点挂了。
   *      拆回路由级 code splitting + 绝对 base 后首屏只剩几十 KB，
   *      丢单个资源请求的概率远低于「用户等不到 35 秒就关掉」。
   */
  plugins: [
    react(),
    // @why derived 在前：sounds.json 的中文字幕名只在 derived 里，
    //      mc-assets 那份是 fetch 重新生成的裸版本
    mcAssetsPlugin(['./mc-derived', './mc-assets']),
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
    /** 每次构建唯一。派生 JSON 的 URL 带上它，改动后不会被浏览器缓存钉住 */
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    /**
     * @constraint cssCodeSplit 必须开。关掉时整站 CSS 会合并成一个大文件，
     *      首页也要等它下完才能画第一帧。
     */
    cssCodeSplit: true,
    /**
     * @constraint 不能再用巨大的 assetsInlineLimit。之前设成 1e8 会把所有
     *      图片、字体都 base64 进 HTML，单文件体积就是这么涨到 920KB 的。
     */
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        /**
         * @constraint 用函数形式，不要用对象形式。对象形式要求每个 chunk 的
         *      依赖都显式列出，漏了 react-is / scheduler 就会在运行时报
         *      "Cannot access before initialization"（跨 chunk 循环引用）。
         */
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (id.includes('node_modules/react-router')) return 'react'
          return undefined
        },
      },
    },
  },
})
