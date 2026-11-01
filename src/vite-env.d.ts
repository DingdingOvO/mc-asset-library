/// <reference types="vite/client" />

/** 构建时间戳，注入自 vite.config.ts，用于确认线上是不是最新版本 */
declare const __BUILD_TIME__: string
