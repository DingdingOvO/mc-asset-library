#!/usr/bin/env node
/**
 * 素材管线统一入口。
 *
 * @why 仓库里不放 MC 素材：515MB 里 369MB 是音效、88MB 是语言文件，全部能从
 *      Mojang 官方端点重建，塞进 git 只会让 clone 变成几十分钟。真正不可再生的
 *      只有 7 个从反编译源码提取的小 JSON，它们放在 mc-derived/ 里入库。
 *      这个脚本负责把「可再生」那半边补齐，并校验两边版本是否对得上。
 *
 * 命令：
 *   node scripts/assets.mjs sync [--lite] [--cdn=URL]   下载并生成 mc-assets
 *   node scripts/assets.mjs ensure [--strict] [--auto]  只检查，缺了给指引
 *   node scripts/assets.mjs verify                      对照 lock 校验
 *   node scripts/assets.mjs lock                        重算 mc-assets.lock.json
 *   node scripts/assets.mjs stats                       打印体积构成
 *   node scripts/assets.mjs clean [--yes]               删除 mc-assets
 *
 * @side-effect sync 会往 mc-assets/ 与 .cache/ 写文件（合计 500MB 量级）
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeItemGroups } from './items-group.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const ASSETS_ROOT = path.join(ROOT, 'mc-assets')
const DERIVED_ROOT = path.join(ROOT, 'mc-derived')
const LOCK_FILE = path.join(ROOT, 'mc-assets.lock.json')

/**
 * 站点的一级路由（与 src/App.tsx 的 <Route path> 对齐）。
 * @constraint 只列静态段；`items/:group` 这类带参路由靠 404.html 兜住即可，
 *     把每个物品组都落一份 index.html 会让 _site 里多出几百份 800KB 的副本。
 */
const ROUTES = ['blocks', 'items', 'entities', 'particles', 'ui', 'data', 'browse', 'sounds', 'structures']

/**
 * 由数据推导出的二级路由。
 *
 * @why GitHub Pages 对没有实体文件的路径一律回 404.html，状态码也跟着 404。
 *      一级路由靠 ROUTES 各落一份 index.html 拿到了 200，但 `/data/items`、
 *      `/sounds/mob`、`/browse/block` 这些带参数的路径没有对应文件，线上看起来
 *      就是「页面在但状态码 404」——贴到聊天软件里会显示成坏链。
 * @constraint 必须从实际数据推导而不是写死清单：注册表、音效分组、纹理分组
 *      都随版本变化，写死的那份迟早和 UI 对不上。
 * @constraint 必须在**打包后的**目录上推导。源目录的 items.json 可能是旧版
 *      fetch 留下的，分组被 normalizeItemGroups 修过之后两边就不一致了：
 *      页面按新分组渲染，路由却按旧分组落盘，新分类点开是 404。
 */
async function secondaryRoutes(dir) {
  const read = async (name) => {
    try {
      return JSON.parse(await readFile(path.join(dir, name), 'utf8'))
    } catch {
      return null
    }
  }
  const out = new Set()
  const registries = await read('registries.json')
  for (const registry of registries?.registries ?? []) {
    if (registry.id) out.add(`data/${registry.id}`)
  }
  const sounds = await read('sounds.json')
  for (const item of sounds?.items ?? []) if (item.g) out.add(`sounds/${item.g}`)
  const textures = await read('textures.json')
  for (const group of textures?.groups ?? []) if (group.id) out.add(`browse/${group.id}`)
  const items = await read('items.json')
  for (const group of items?.groups ?? []) if (group.id) out.add(`items/${group.id}`)
  return [...out]
}

/** 派生数据：从反编译源码提取，无法由官方 jar 重建，必须入库 */
const DERIVED_FILES = [
  'entitymodels.json',
  'entityanims.json',
  'entitylayers.json',
  'entityrenderers.json',
  'particledata.json',
  'creativetabs.json',
  'sounds.json',
  // @constraint 结构索引必须登记：它缺失时结构页只会显示空列表，不报任何错，
  //      和「素材没下完」的表象完全一样，不点名就无从排查
  'structures.json',
]

/**
 * 素材就绪的最小判据。
 * @constraint 只查入口文件不够：fetch 中断过一次后 index.json 可能已写而
 *      textures/ 是空的，站点会呈现一片空白且没有任何报错。这里逐目录点名。
 */
const REQUIRED = [
  'version.json',
  'index.json',
  'textures.json',
  'blockmaps.json',
  'textures/block',
  'textures/item',
  'textures/entity',
  'models/block',
  'models/item',
  'blockstates',
  'items',
  // @why 结构是唯一被改写路径的提取范围（jar 的 data/ 下剥进 structures/）。
  //      不点名的话，老素材目录会一直判定"已就绪"，结构页静默空掉。
  'structures',
  'lang/zh_cn.json',
  'lang/en_us.json',
]

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) ?? 'ensure'
const flag = (name) => args.includes(`--${name}`)
const opt = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : null
}

const log = (...parts) => console.log('[assets]', ...parts)
const fail = (...parts) => {
  // @why 提示里带换行排版（命令清单），用空格 join 会把它们挤成一坨
  console.error('[assets]', parts.join('\n'))
  process.exitCode = 1
}

function human(bytes) {
  if (bytes < 1024) return `${bytes}B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[i]}`
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'))
}

async function sha256(file) {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/** 递归统计文件数与字节数 */
async function measure(dir) {
  let files = 0
  let bytes = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { files, bytes }
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await measure(full)
      files += sub.files
      bytes += sub.bytes
    } else {
      files += 1
      try {
        bytes += (await stat(full)).size
      } catch {
        // 统计期间被删掉的临时文件，忽略
      }
    }
  }
  return { files, bytes }
}

/** 当前应该用哪个版本目录：优先 versions.json 的 latest */
async function currentVersion() {
  const pinned = opt('version')
  if (pinned) return pinned
  try {
    const versions = await readJson(path.join(ASSETS_ROOT, 'versions.json'))
    if (versions.latest) return versions.latest
  } catch {
    // 素材还没下载过
  }
  const derived = await readdir(DERIVED_ROOT).catch(() => [])
  return derived.sort().pop() ?? null
}

async function checkState() {
  const version = await currentVersion()
  if (!version) {
    return { version: null, assets: { ok: false, missing: ['（整个目录不存在）'] }, derived: { ok: false, missing: DERIVED_FILES } }
  }

  const assetDir = path.join(ASSETS_ROOT, version)
  const missingAssets = []
  for (const rel of REQUIRED) {
    if (!(await exists(path.join(assetDir, rel)))) missingAssets.push(rel)
  }

  const derivedDir = path.join(DERIVED_ROOT, version)
  const missingDerived = []
  for (const file of DERIVED_FILES) {
    const full = path.join(derivedDir, file)
    try {
      const info = await stat(full)
      if (info.size < 64) missingDerived.push(`${file}（空文件）`)
    } catch {
      missingDerived.push(file)
    }
  }

  return {
    version,
    assets: { ok: missingAssets.length === 0, missing: missingAssets, dir: assetDir },
    derived: { ok: missingDerived.length === 0, missing: missingDerived, dir: derivedDir },
  }
}

async function runFetch({ lite, cdn }) {
  const fetchArgs = [path.join(ROOT, 'scripts', 'fetch-assets.mjs')]
  if (lite) fetchArgs.push('--no-sounds')
  if (cdn) fetchArgs.push(`--cdn=${cdn}`)
  const lang = opt('lang')
  if (lang) fetchArgs.push(`--lang=${lang}`)
  const version = opt('version')
  if (version) fetchArgs.push(version)

  const scope = [lite ? '跳过音效' : '含音效', lang ? `只留 ${lang}` : '全部语言'].join('，')
  log(`开始下载素材（${scope}）…`)
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, fetchArgs, { cwd: ROOT, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fetch-assets 退出码 ${code}`))))
  })
}

async function cmdSync() {
  const lite = flag('lite')
  const cdn = opt('cdn')
  const before = await checkState()

  if (before.assets.ok) {
    log(`素材已就绪：mc-assets/${before.version}`)
  } else {
    if (before.assets.missing.length) log('缺少：', before.assets.missing.slice(0, 6).join('、'), before.assets.missing.length > 6 ? '…' : '')
    await runFetch({ lite, cdn })
  }

  const after = await checkState()
  if (!after.assets.ok) {
    fail('素材仍不完整，缺：', after.assets.missing.join('、'))
  } else {
    const { files, bytes } = await measure(after.assets.dir)
    log(`素材就绪：${files} 个文件 / ${human(bytes)}`)
  }

  if (!after.derived.ok) {
    // @constraint 派生数据无法自动重建：提取脚本读的是反编译出来的 Java 源码，
    //      既不在仓库里也不在发行版里。这里只能如实说明，不能假装修复。
    fail(
      `派生数据缺失：${after.derived.missing.join('、')}`,
      '\n  这些文件由 scripts/extract-*.py 从反编译源码生成，无法自动下载。',
      '\n  正常情况下它们随仓库一起分发，缺失说明 mc-derived/ 被破坏，请从 git 恢复。',
    )
  } else {
    log(`派生数据就绪：mc-derived/${after.version}（${DERIVED_FILES.length} 个文件）`)
  }

  await cmdLock()
}

async function cmdEnsure() {
  if (process.env.MC_SKIP_ASSETS === '1') {
    log('MC_SKIP_ASSETS=1，跳过素材检查')
    return
  }

  const state = await checkState()
  if (state.assets.ok && state.derived.ok) {
    log(`素材就绪（${state.version}）`)
    return
  }

  if (state.assets.ok === false) {
    const lines = [
      `素材未就绪，缺少 ${state.assets.missing.length} 项：${state.assets.missing.slice(0, 5).join('、')}${state.assets.missing.length > 5 ? ' …' : ''}`,
      '',
      '  完整下载（含音效，约 500MB）：  pnpm run setup',
      '  只要图片不要音效（约 130MB）：  pnpm run setup:lite',
      '  国内网络建议走镜像：            pnpm run setup -- --cdn=https://bmclapi2.bangbang93.com/assets',
    ]
    if (flag('auto')) {
      log(lines[0], '\n--auto：自动开始下载')
      await cmdSync()
      return
    }
    if (flag('strict')) {
      fail(...lines)
      return
    }
    log(lines.join('\n'))
    return
  }

  fail(`派生数据缺失：${state.derived.missing.join('、')}（请从 git 恢复 mc-derived/）`)
}

async function cmdVerify() {
  let lock
  try {
    lock = await readJson(LOCK_FILE)
  } catch {
    fail(`没有 ${path.basename(LOCK_FILE)}，先跑 node scripts/assets.mjs lock`)
    return
  }

  const state = await checkState()
  const problems = []
  const warnings = []

  if (state.version !== lock.version) {
    warnings.push(`素材版本 ${state.version ?? '（无）'} 与 lock 记录 ${lock.version} 不一致`)
  }

  for (const file of DERIVED_FILES) {
    const full = path.join(DERIVED_ROOT, lock.version, file)
    const expected = lock.derived?.[file]
    if (!expected) {
      warnings.push(`lock 里没有 ${file} 的记录`)
      continue
    }
    try {
      const digest = await sha256(full)
      if (digest !== expected.sha256) problems.push(`${file} 内容与 lock 不符（被改动或替换过）`)
    } catch {
      problems.push(`${file} 缺失`)
    }
  }

  if (state.assets.ok) {
    const { files } = await measure(state.assets.dir)
    const expect = lock.assets
    if (expect) {
      // @why --lite 安装天生比 lock 少掉全部音效文件，那不是漂移，
      //      分开判断否则每次都会刷一条假的 28% 偏差
      const lite = expect.withSounds && !(await exists(path.join(state.assets.dir, 'sounds')))
      if (lite) {
        warnings.push('lock 记录含音效，但 sounds/ 目录不存在（--lite 安装，可忽略）')
      } else {
        // @why 只做量级比对：重下素材会因为字典序变化带来个别文件增删，
        //      严格相等会把正常情况也判成失败
        const drift = Math.abs(files - expect.files) / Math.max(1, expect.files)
        if (drift > 0.02) warnings.push(`素材文件数 ${files} 与 lock 记录 ${expect.files} 偏差 ${(drift * 100).toFixed(1)}%`)
      }
    }
  } else {
    warnings.push(`素材不完整：缺 ${state.assets.missing.length} 项（跑 pnpm run setup 补齐）`)
  }

  // @why 音效字幕名是派生数据里最容易过期的一份：换了游戏版本后
  //      fetch 重新生成裸 sounds.json，派生那份还留着旧版本的条目
  try {
    const derivedSounds = await readJson(path.join(DERIVED_ROOT, lock.version, 'sounds.json'))
    const rawSounds = await readJson(path.join(state.assets.dir, 'sounds.json'))
    const a = derivedSounds.items?.length ?? 0
    const b = rawSounds.items?.length ?? 0
    // @constraint b 为 0 说明是 --lite 装（没音效文件就没有条目），此时无从比对
    if (b > 0 && a !== b) {
      warnings.push(`sounds.json 条目数 ${a} 与素材侧 ${b} 不一致，需重跑 extract-sound-names.py`)
    }
  } catch {
    // 素材没下载时无从比对
  }

  for (const line of warnings) log('警告：', line)
  if (problems.length) {
    for (const line of problems) fail('错误：', line)
    return
  }
  log(`校验通过（${DERIVED_FILES.length} 个派生文件，版本 ${lock.version}）`)
}

async function cmdLock() {
  const state = await checkState()
  if (!state.version) {
    fail('无法确定版本：mc-assets 与 mc-derived 都是空的')
    return
  }

  const derived = {}
  for (const file of DERIVED_FILES) {
    const full = path.join(DERIVED_ROOT, state.version, file)
    try {
      derived[file] = {
        bytes: (await stat(full)).size,
        sha256: await sha256(full),
      }
    } catch {
      // 缺文件时 verify 会报，这里不重复
    }
  }

  let assets = null
  if (state.assets.ok) {
    const { files, bytes } = await measure(state.assets.dir)
    assets = {
      files,
      bytes,
      withSounds: await exists(path.join(state.assets.dir, 'sounds')),
    }
  }

  const lock = {
    version: state.version,
    generatedAt: new Date().toISOString(),
    // @why 素材可再生，所以只记体量与开关；派生数据不可再生，逐个记 sha256
    assets,
    derived,
  }
  await writeFile(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`)
  log(`已写入 ${path.basename(LOCK_FILE)}：${Object.keys(derived).length} 个派生文件${assets ? `，素材 ${assets.files} 个文件 / ${human(assets.bytes)}` : ''}`)
}

async function cmdStats() {
  const version = await currentVersion()
  if (!version) {
    fail('还没有任何素材，先跑 pnpm run setup')
    return
  }

  const rows = []
  let total = 0
  const assetDir = path.join(ASSETS_ROOT, version)
  const entries = await readdir(assetDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const full = path.join(assetDir, entry.name)
    const info = entry.isDirectory() ? await measure(full) : { files: 1, bytes: (await stat(full)).size }
    rows.push({ name: entry.name + (entry.isDirectory() ? '/' : ''), ...info })
    total += info.bytes
  }
  rows.sort((a, b) => b.bytes - a.bytes)

  const derived = await measure(path.join(DERIVED_ROOT, version))
  const width = Math.max(...rows.map((r) => r.name.length), 10)
  console.log(`\n  mc-assets/${version}   可重建，不入库`)
  for (const row of rows.slice(0, 16)) {
    const share = total > 0 ? ((row.bytes / total) * 100).toFixed(1) : '0.0'
    console.log(`  ${row.name.padEnd(width)}  ${human(row.bytes).padStart(8)}  ${String(row.files).padStart(7)} 文件  ${share.padStart(5)}%`)
  }
  if (rows.length > 16) console.log(`  …另有 ${rows.length - 16} 项`)
  console.log(`  ${''.padEnd(width)}  ${human(total).padStart(8)}  合计\n`)
  console.log(`  mc-derived/${version}  不可重建，入库中：${human(derived.bytes)} / ${derived.files} 个文件\n`)
}

async function cmdPack() {
  const version = await currentVersion()
  if (!version) {
    fail('还没有素材，先跑 pnpm run setup -- --lite --lang=zh_cn,en_us')
    return
  }

  const dist = path.join(ROOT, 'dist')
  if (!(await exists(path.join(dist, 'index.html')))) {
    fail('dist/index.html 不存在，先跑 pnpm build')
    return
  }

  const outDir = path.resolve(opt('out') ?? path.join(ROOT, 'dist-site'))
  await rm(outDir, { recursive: true, force: true })
  await cp(dist, outDir, { recursive: true })

  // @constraint 顺序不能反：derived 里的 sounds.json 带官方字幕中文名，
  //      必须在 mc-assets 之后覆盖，否则静态站上音效只剩文件名
  const mcDir = path.join(outDir, 'mc', version)
  const assetDir = path.join(ASSETS_ROOT, version)
  const derivedDir = path.join(DERIVED_ROOT, version)
  if (await exists(assetDir)) await cp(assetDir, mcDir, { recursive: true })
  // @constraint 版本清单在 mc-assets 根层，不在版本目录内；漏了它首页会直接
  //      "素材索引加载失败"，而且只看目录结构很难发现
  const versionsFile = path.join(ASSETS_ROOT, 'versions.json')
  if (await exists(versionsFile)) await copyFile(versionsFile, path.join(outDir, 'mc', 'versions.json'))
  await mkdir(mcDir, { recursive: true })
  await cp(derivedDir, mcDir, { recursive: true, force: true })

  /**
   * @constraint 必须在 `secondaryRoutes` 之前跑。二级路由是从 items.json 的
   *      groups 推导的，分组没修正时会按旧的 building_blocks 落一份 index.html，
   *      而新分类全是 404——页面能开、链接贴出去是坏链。
   */
  await normalizeItemGroups(mcDir)

  /**
   * 音效计数以实际分发的清单为准。
   *
   * @why CI 用 `--no-sounds` 提取素材，.ogg 不落盘，fetch-assets 是按磁盘文件
   *      统计音效数的，于是 versions.json 里 soundCount 成了 0。而 derived 的
   *      sounds.json 是入库清单，条目数照旧打进站点。结果是首页写「音效 0 个」、
   *      音效页却列着 4961 条，同一份数据两个数。
   * @constraint 不能改成让首页去读 sounds.json 自己数：那是 515KB，首页只需要
   *      一个数字，registrySummary 存在的意义就是别为计数拉整份清单。
   */
  const versionsOut = path.join(outDir, 'mc', 'versions.json')
  const soundsList = path.join(mcDir, 'sounds.json')
  if ((await exists(versionsOut)) && (await exists(soundsList))) {
    try {
      const manifest = JSON.parse(await readFile(soundsList, 'utf8'))
      const total = Array.isArray(manifest.items) ? manifest.items.length : 0
      // 音频是否真的随包分发：决定首页敢不敢写「可试听」
      const audio = await readdir(path.join(mcDir, 'sounds')).then(
        (names) => (names.length > 0 ? 1 : 0),
        () => 0,
      )
      if (total > 0) {
        const all = JSON.parse(await readFile(versionsOut, 'utf8'))
        const entry = (all.versions ?? []).find((item) => item.id === version)
        if (entry) {
          const summary = entry.registrySummary ?? []
          const row = summary.find((item) => item.id === 'sounds')
          if (row) {
            row.count = total
            row.audio = audio
          } else {
            summary.push({ id: 'sounds', label: '音效', kind: 'asset', count: total, route: '/sounds', audio })
          }
          entry.registrySummary = summary
          await writeFile(versionsOut, JSON.stringify(all))
        }
      }
    } catch {
      // @why 清单结构异常时保持原样。首页少一个数字可以接受，为此中断部署不行
    }
  }

  // @why 构建插件已经生成过；这里兜底，避免旧 dist 没有 404.html 时静态托管深链接直接断
  const notFound = path.join(outDir, '404.html')
  if (!(await exists(notFound))) await copyFile(path.join(outDir, 'index.html'), notFound)

  // @why Pages 对任何未知路径都回 404.html，状态码也就跟着是 404。SPA 照样渲染，
  //      但线上 `/ui` 在 devtools 里是一条红色的 404，任何存活检测/企业代理都会
  //      把它当成页面挂了。一级路由各落一份 index.html，深链接才是 200。
  //      二级路由（/data/items、/sounds/mob…）同理，从数据推导后一并落地。
  const deepRoutes = [...ROUTES, ...(await secondaryRoutes(mcDir))]
  for (const route of deepRoutes) {
    const dir = path.join(outDir, route)
    await mkdir(dir, { recursive: true })
    await copyFile(path.join(outDir, 'index.html'), path.join(dir, 'index.html'))
  }

  const { files, bytes } = await measure(outDir)
  log(`已生成 ${path.relative(ROOT, outDir)}：${files} 个文件 / ${human(bytes)}`)
  if (bytes > 900 * 1024 * 1024) {
    fail('超过 900MB，GitHub Pages 站点上限是 1GB，请裁剪（--no-sounds / --lang）')
  }
}

async function cmdClean() {
  if (!flag('yes')) {
    fail('这会删除 mc-assets（可重新下载，但要花流量和时间）。确认请加 --yes')
    return
  }
  await rm(ASSETS_ROOT, { recursive: true, force: true })
  log('已删除 mc-assets，可用 pnpm run setup 重新生成')
}

const commands = {
  sync: cmdSync,
  pack: cmdPack,
  ensure: cmdEnsure,
  verify: cmdVerify,
  lock: cmdLock,
  stats: cmdStats,
  clean: cmdClean,
}

const run = commands[command]
if (!run) {
  fail(`未知命令 ${command}，可用：${Object.keys(commands).join(' / ')}`)
} else {
  await run()
}
