import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { mcAssetsPlugin } from './vite.mc-assets.ts'

export default defineConfig({
  // @why 线上网关偶发丢请求，CSS/JS 分开加载时只要丢一个页面就裸奔；
  // 内联成单文件后整站只有一个 HTML 请求，素材图片再按需加载
  plugins: [
    react(),
    // @why derived 在前：sounds.json 的中文字幕名只在 derived 里，
    //      mc-assets 那份是 fetch 重新生成的裸版本
    mcAssetsPlugin(['./mc-derived', './mc-assets']),
    viteSingleFile(),
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
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
})
