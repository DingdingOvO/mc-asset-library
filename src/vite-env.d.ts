/// <reference types="vite/client" />

/** 构建时间戳，注入自 vite.config.ts，用于确认线上是不是最新版本 */
declare const __BUILD_TIME__: string

/**
 * 站点前缀，总带结尾斜杠：根部署是 `/`，GitHub Pages 是 `/<repo>/`。
 * @why 不能用 import.meta.env.BASE_URL —— 单文件插件会把它强制成 './'
 */
declare const __SITE_BASE__: string
declare const __BUILD_ID__: string
