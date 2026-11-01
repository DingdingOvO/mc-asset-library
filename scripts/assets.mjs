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
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ASSETS_ROOT = path.join(ROOT, 'mc-assets')
const DERIVED_ROOT = path.join(ROOT, 'mc-derived')
const LOCK_FILE = path.join(ROOT, 'mc-assets.lock.json')

/** 派生数据：从反编译源码提取，无法由官方 jar 重建，必须入库 */
const DERIVED_FILES = [
  'entitymodels.json',
  'entityanims.json',
  'entitylayers.json',
  'entityrenderers.json',
  'particledata.json',
  'creativetabs.json',
  'sounds.json',
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
  const version = opt('version')
  if (version) fetchArgs.push(version)

  log(`开始下载素材${lite ? '（跳过音效）' : '（含音效，约 500MB）'}…`)
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
    const { files, bytes } = await measure(state.assets.dir)
    const expect = lock.assets
    if (expect) {
      // @why 只做量级比对：重下素材会因为字典序变化带来个别文件增删，
      //      严格相等会把正常情况也判成失败
      const drift = Math.abs(files - expect.files) / Math.max(1, expect.files)
      if (drift > 0.02) warnings.push(`素材文件数 ${files} 与 lock 记录 ${expect.files} 偏差 ${(drift * 100).toFixed(1)}%`)
      if (expect.withSounds && !(await exists(path.join(state.assets.dir, 'sounds')))) {
        warnings.push('lock 记录含音效，但 sounds/ 目录不存在（可能是 --lite 安装）')
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
    if (a !== b) warnings.push(`sounds.json 条目数 ${a} 与素材侧 ${b} 不一致，需重跑 extract-sound-names.py`)
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
