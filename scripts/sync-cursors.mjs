#!/usr/bin/env node
/**
 * 从矢量仓库拉鼠标指针，生成 public/cursors/*.svg 与 src/lib/cursorTable.ts。
 *
 * @why 之前那套是从 `android-cursors` 的 .cur 转 PNG。.cur 本身就是 32px 位图，
 *      HiDPI 屏上等于被放大两倍，边缘糊成一片。AOSP 那套是 24dp 的
 *      VectorDrawable 导出的 SVG，等比缩放到 32 后在任何 DPR 下都是锐的。
 *
 * @side-effect 会写 public/cursors/（14 个 SVG）和 src/lib/cursorTable.ts
 *
 * @constraint 热点表必须由 cursors.json 的 dp 值换算，不能照抄像素：
 *      AOSP 的 24dp 画布按 32/24 缩放后，arrow 的 4.5dp,3.5dp 才是 6,5。
 *      手写这套数字时错一位，点按钮会整体偏一格。
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const REPO = 'DingdingOvO/aosp-cursors-temp'
const CACHE = path.join(ROOT, '.cache', 'aosp-cursors')
/** 目标边长：Chrome 在 Windows 上把光标位图钳到 32，再大没意义 */
const SIZE = 32
/** AOSP 的 VectorDrawable 画布是 24dp */
const GRID = 24

/**
 * 站点用到的指针 → 仓库里的文件 id。
 * @why 只映射实际用到的 7 个：把 25 个全搬进来，打包体积翻三倍，而且
 *      没人会给「手写笔」「放大镜」绑 cursor。
 */
const MAP = {
  arrow: 'pointer_arrow',
  hand: 'pointer_hand',
  grab: 'pointer_grab',
  grabbing: 'pointer_grabbing',
  text: 'pointer_text',
  crosshair: 'pointer_crosshair',
  nodrop: 'pointer_nodrop',
}

async function main() {
  await mkdir(CACHE, { recursive: true })
  const tarball = path.join(CACHE, 'repo.tgz')
  try {
    await readFile(tarball)
    console.log('[cursors] 用缓存里的压缩包')
  } catch {
    const url = `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`
    console.log(`[cursors] 下载 ${url}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`下载失败：${response.status}`)
    await writeFile(tarball, Buffer.from(await response.arrayBuffer()))
  }

  const unpacked = path.join(CACHE, 'src')
  await mkdir(unpacked, { recursive: true })
  const tar = spawnSync('tar', ['-xzf', tarball, '-C', unpacked, '--strip-components=1'], {
    stdio: 'inherit',
  })
  if (tar.status !== 0) throw new Error('解包失败')

  const meta = JSON.parse(await readFile(path.join(unpacked, 'web', 'cursors.json'), 'utf8'))
  const byId = new Map(meta.map((item) => [item.id, item]))
  const outDir = path.join(ROOT, 'public', 'cursors')
  await mkdir(outDir, { recursive: true })

  const rows = []
  for (const [key, id] of Object.entries(MAP)) {
    const item = byId.get(id)
    if (!item) throw new Error(`cursors.json 里没有 ${id}`)
    const [dx, dy] = item.hotspot.split(',').map((part) => Number.parseFloat(part))
    const x = Math.round((dx * SIZE) / GRID)
    const y = Math.round((dy * SIZE) / GRID)
    if (x >= SIZE || y >= SIZE) throw new Error(`${id} 的热点 ${x},${y} 超出 ${SIZE}px 画布`)
    rows.push({ key, x, y })

    for (const theme of ['dark', 'light']) {
      const source = path.join(unpacked, 'svg', theme, `${id}.svg`)
      const svg = await readFile(source, 'utf8')
      // @constraint 只改根节点宽高，不能动 viewBox：改 viewBox 等于把图形裁掉一半，
      //      生成的指针会缺一块，而 CSS 那边看不出任何异常。
      const scaled = svg.replace(`width="${GRID}"`, `width="${SIZE}"`).replace(`height="${GRID}"`, `height="${SIZE}"`)
      if (!scaled.includes(`width="${SIZE}"`)) throw new Error(`${id} 的 SVG 里没有 width="${GRID}"`)
      await writeFile(path.join(outDir, `${theme}-${key}.svg`), scaled)
    }
  }

  const lines = rows
    .map(({ key, x, y }) => `  ${key}: { x: ${x}, y: ${y} },`)
    .join('\n')

  const table = `// 由 scripts/sync-cursors.mjs 生成，不要手改
//
// @why 指针是矢量仓库 ${REPO} 的 SVG，等比缩放到 ${SIZE}px。
//      热点来自 cursors.json 的 dp 值：round(dp * ${SIZE} / ${GRID})。
// @constraint 文件名里的 dark/light 是 AOSP 的「主题」命名，跟站点主题是反的：
//      AOSP 深色主题画黑指针（给深色底用），本站浅色主题才需要黑指针。

export interface CursorHotspot {
  x: number
  y: number
}

export const CURSOR_HOTSPOTS: Record<string, CursorHotspot> = {
${lines}
}
`
  await writeFile(path.join(ROOT, 'src', 'lib', 'cursorTable.ts'), table)
  console.log(`[cursors] 已生成 ${rows.length * 2} 个 SVG + cursorTable.ts`)
}

main().catch((error) => {
  console.error(`[cursors] ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
})
