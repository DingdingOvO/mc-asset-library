/**
 * Minecraft 素材提取管线
 *
 * 数据来源全部是 Mojang 官方公开端点：
 *   - 版本清单: https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
 *   - client.jar / asset index: 版本 json 内的 downloads 字段
 *   - asset objects: https://resources.download.minecraft.net/<hash[0:2]>/<hash>
 *
 * 用法:
 *   node scripts/fetch-assets.mjs                 # 最新正式版，含音效
 *   node scripts/fetch-assets.mjs 1.21.4          # 指定版本
 *   node scripts/fetch-assets.mjs --no-sounds     # 跳过 359MB 音效
 *   node scripts/fetch-assets.mjs --cdn=https://bmclapi2.bangbang93.com/assets
 *
 * @constraint client.jar 与 assets 均为 Mojang 版权资产，仅可用于本地开发与预览，
 *             公开部署前必须替换为自己的素材或删除。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import path from 'node:path'
import yauzl from 'yauzl'

const ROOT = path.resolve(import.meta.dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const OUT_ROOT = path.join(ROOT, 'mc-assets')

const VERSION_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const OBJECT_BASE = 'https://resources.download.minecraft.net'

const args = process.argv.slice(2)
const flags = args.filter((a) => a.startsWith('--'))
const versionArg = args.find((a) => !a.startsWith('--'))
const withSounds = !flags.includes('--no-sounds')
const cdnFlag = flags.find((f) => f.startsWith('--cdn='))
const objectBase = cdnFlag ? cdnFlag.slice('--cdn='.length) : OBJECT_BASE

/**
 * 语言白名单。
 * @why 144 种语言合计 87MB，比全部纹理加起来还大 40 倍。站点只用到简体中文与
 *      英文，静态托管（GitHub Pages）根本放不下整份。指定后 jar 解包与对象库
 *      补全都只留这几种。
 */
const langFlag = flags.find((f) => f.startsWith('--lang='))
const allowLang = langFlag
  ? new Set(langFlag.slice('--lang='.length).split(',').map((s) => s.trim()).filter(Boolean))
  : null

function langAllowed(name) {
  if (!allowLang) return true
  const match = /(?:^|\/)lang\/([^/]+)\.json$/.exec(name)
  if (!match) return true
  return allowLang.has(match[1])
}

const CONCURRENCY = 12

/** jar 内保留的顶层目录，class 文件与混淆映射全部丢弃 */
const KEEP_PREFIXES = [
  'assets/minecraft/',
  'pack.mcmeta',
  'version.json',
  // 这些是 data 侧的注册表，物品/附魔/画/伤害类型等条目都靠它们
  'data/minecraft/enchantment/',
  'data/minecraft/painting_variant/',
  'data/minecraft/banner_pattern/',
  'data/minecraft/damage_type/',
  'data/minecraft/jukebox_song/',
  'data/minecraft/trim_pattern/',
  'data/minecraft/trim_material/',
  'data/minecraft/instrument/',
  'data/minecraft/worldgen/biome/',
  'data/minecraft/tags/item/',
]
const DROP_EXT = new Set(['.class', '.mf', '.sf', '.rsa', '.ds_store'])

function log(...parts) {
  console.log('[mc]', ...parts)
}

async function exists(target) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`)
  return res.json()
}

async function download(url, dest) {
  if (await exists(dest)) return false
  await mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`)
  const tmp = `${dest}.part`
  const file = createWriteStream(tmp)
  await new Promise(async (resolve, reject) => {
    file.on('error', reject)
    const body = res.body
    if (!body) return reject(new Error(`空响应 <- ${url}`))
    for await (const chunk of body) {
      if (!file.write(chunk)) await once(file, 'drain')
    }
    file.end()
    file.on('close', resolve)
  })
  await copyFile(tmp, dest)
  const { unlink } = await import('node:fs/promises')
  await unlink(tmp)
  return true
}

/** 解 jar，按 filter 落盘（strip 为需要剥离的路径前缀）；返回写出的相对路径列表 */
function unzipJar(jarPath, outDir, filter, strip = '') {
  return new Promise((resolve, reject) => {
    const written = []
    yauzl.open(jarPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('无法打开 jar'))

      zip.on('entry', (entry) => {
        const name = entry.fileName
        if (name.endsWith('/')) return zip.readEntry()

        const ext = path.extname(name).toLowerCase()
        if (DROP_EXT.has(ext)) return zip.readEntry()
        if (!filter(name)) return zip.readEntry()

        const rel = strip && name.startsWith(strip) ? name.slice(strip.length) : name
        const dest = path.join(outDir, rel)
        mkdir(path.dirname(dest), { recursive: true })
          .then(
            () =>
              new Promise((res, rej) => {
                zip.openReadStream(entry, (e, stream) => {
                  if (e || !stream) return rej(e)
                  const out = createWriteStream(dest)
                  stream.pipe(out)
                  out.on('close', () => {
                    written.push(rel)
                    res()
                  })
                  out.on('error', rej)
                })
              }),
          )
          .then(() => zip.readEntry())
          .catch(reject)
      })

      zip.on('end', () => resolve(written))
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}

async function mapLimit(items, limit, worker) {
  const queue = [...items]
  let done = 0
  const total = queue.length
  const runners = Array.from({ length: Math.min(limit, total) }, async () => {
    while (queue.length) {
      const item = queue.shift()
      if (item === undefined) break
      await worker(item)
      done += 1
      if (done % 250 === 0 || done === total) log(`  下载 ${done}/${total}`)
    }
  })
  await Promise.all(runners)
}

/** 读 PNG 头拿宽高，避免为了尺寸引入图像库 */
async function pngSize(file) {
  const handle = await readFile(file)
  if (handle.length < 24 || handle.readUInt32BE(0) !== 0x89504e47) return null
  return { width: handle.readUInt32BE(16), height: handle.readUInt32BE(20) }
}

async function walk(dir, base = dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, base)))
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

const GROUPS = [
  ['block', '方块'],
  ['item', '物品'],
  ['entity', '实体'],
  ['gui', '界面'],
  ['particle', '粒子'],
  ['environment', '环境'],
  ['mob_effect', '状态效果'],
  ['painting', '画'],
  ['map', '地图'],
  ['trims', '盔甲纹饰'],
  ['colormap', '色图'],
  ['misc', '杂项'],
  ['font', '字体'],
  ['effect', '特效'],
  ['palettes', '调色板'],
]

/** 纹理名与语言键的差异主要来自这类方位/状态后缀 */
const NAME_AFFIX = [
  '_top',
  '_bottom',
  '_side',
  '_front',
  '_back',
  '_inner',
  '_outer',
  '_on',
  '_off',
  '_stage0',
  '_stage1',
  '_stage2',
  '_stage3',
]

/**
 * 同一件东西的键可能挂在方块或物品命名空间下（门、告示牌之类本质是方块），
 * 所以按顺序试多个前缀，而不是只认一个。
 */
const PREFIX_BY_GROUP = {
  block: ['block.minecraft', 'item.minecraft'],
  item: ['item.minecraft', 'block.minecraft'],
  entity: ['entity.minecraft'],
  mob_effect: ['effect.minecraft'],
  painting: ['painting.minecraft'],
}

/** 少数键带固定后缀，例如画是 painting.minecraft.alban.title */
const KEY_SUFFIXES = ['', '.title']

async function loadLang(outDir, code) {
  try {
    return JSON.parse(await readFile(path.join(outDir, 'lang', `${code}.json`), 'utf8'))
  } catch {
    return {}
  }
}

/** @why 让站点显示「石头」而不是「stone.png」，命中率不足时回退到可读文件名 */
function resolveLabel(group, base, zh, en) {
  const prefixes = PREFIX_BY_GROUP[group]
  if (!prefixes) return null

  const candidates = [base]
  for (const affix of NAME_AFFIX) {
    if (base.endsWith(affix)) candidates.push(base.slice(0, -affix.length))
  }

  for (const prefix of prefixes) {
    for (const candidate of candidates) {
      for (const suffix of KEY_SUFFIXES) {
        const key = `${prefix}.${candidate}${suffix}`
        const zhName = zh[key]
        const enName = en[key]
        if (zhName || enName) return { zh: zhName ?? null, en: enName ?? null }
      }
    }
  }
  return null
}

function humanize(base) {
  const words = base.replace(/[_/]/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

async function buildIndex(outDir, version) {
  const files = await walk(outDir)
  const zh = await loadLang(outDir, 'zh_cn')
  const en = await loadLang(outDir, 'en_us')

  const fileSet = new Set(files)
  const items = []

  for (const rel of files) {
    const abs = path.join(outDir, rel)
    const info = await stat(abs)
    const segments = rel.split('/')

    let kind = 'other'
    let group = 'other'
    let name = path.basename(rel)

    // @constraint 只把 .png 当纹理，.png.mcmeta 是动画附注，通过 animated 标记体现
    if (segments[0] === 'textures' && rel.endsWith('.png') && segments.length >= 3) {
      kind = 'texture'
      group = segments[1]
      name = path.basename(rel, path.extname(rel))
    } else if (segments[0] === 'sounds' && rel.endsWith('.ogg')) {
      kind = 'sound'
      // @constraint 根级遗留音效（death.ogg 等）没有二级目录，归入 misc
      group = segments.length >= 3 ? segments[1] : 'misc'
      name = path.basename(rel, '.ogg')
    } else if (segments[0] === 'lang' && rel.endsWith('.json')) {
      kind = 'lang'
      group = 'lang'
      name = path.basename(rel, '.json')
    } else if (segments[0] === 'models') {
      kind = 'model'
      group = segments[1] ?? 'models'
    } else if (segments[0] === 'blockstates') {
      kind = 'blockstate'
      group = 'blockstate'
    } else if (segments[0] === 'items') {
      kind = 'item-def'
      group = 'items'
    } else if (segments[0] === 'font') {
      kind = 'font'
      group = 'font'
    } else if (segments[0] === 'shaders') {
      kind = 'shader'
      group = 'shader'
    }

    const entry = { path: rel, name, kind, group, bytes: info.size }

    if (kind === 'texture' || kind === 'sound') {
      const label = resolveLabel(kind === 'sound' ? 'sound' : group, name, zh, en)
      entry.label = label?.zh ?? humanize(name)
      if (label?.en) entry.en = label.en
      if (kind === 'texture') {
        const size = await pngSize(abs)
        if (size) Object.assign(entry, size)
        if (fileSet.has(`${rel}.mcmeta`)) entry.animated = true
      }
    }

    items.push(entry)
  }

  const counts = {}
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1

  const textureItems = items.filter((item) => item.kind === 'texture' && item.group !== 'font')

  const groups = GROUPS.map(([id, label]) => {
    const list = textureItems.filter((item) => item.group === id)
    const cover = list.find((item) => !item.animated) ?? list[0]
    return {
      id,
      label,
      count: list.length,
      cover: cover ? cover.path.replace(/^textures\//, '').replace(/\.png$/, '') : null,
    }
  }).filter((group) => group.count > 0)

  const index = {
    version,
    generatedAt: new Date().toISOString(),
    source: 'Mojang piston-meta',
    counts,
    groups,
    items,
  }
  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index))

  // @why 站点只需纹理与音效，拆成独立文件避免首屏拉 2.8MB 全量索引
  const textures = {
    version,
    groups,
    items: textureItems.map((item) => ({
      p: item.path.replace(/^textures\//, '').replace(/\.png$/, ''),
      n: item.label,
      e: item.en ?? null,
      g: item.group,
      w: item.width ?? null,
      h: item.height ?? null,
      a: item.animated ? 1 : 0,
    })),
  }
  await writeFile(path.join(outDir, 'textures.json'), JSON.stringify(textures))

  const sounds = {
    version,
    items: items
      .filter((item) => item.kind === 'sound')
      .map((item) => ({
        p: item.path.replace(/^sounds\//, '').replace(/\.ogg$/, ''),
        g: item.group,
        k: item.bytes,
      })),
  }
  await writeFile(path.join(outDir, 'sounds.json'), JSON.stringify(sounds))

  return index
}

/**
 * 建立 纹理 -> 方块/物品 的反查表。
 * @why 靠贴图名去猜 blockstate 只有四成命中（oak_planks 属于 oak_stairs/oak_slab 等一堆方块），
 *      在提取阶段把 models 里的 textures 引用全部收集一遍，命中率才能到九成以上。
 *      物品走 items/*.json 定义而不是 blockstates，必须单独扫一遍，否则钻石这类全是平面图。
 */
/** 递归收集一个模型（含 parent 链）引用的所有纹理 id */
async function collectModelTextures(modelsDir, ref, depth = 0, acc = new Set()) {
    if (depth > 6) return acc
    const modelPath = ref.replace(/^minecraft:/, '')
  let json
  try {
    json = JSON.parse(await readFile(path.join(modelsDir, `${modelPath}.json`), 'utf8'))
  } catch {
    return acc
  }

    const textures = json.textures ?? {}
    for (const value of Object.values(textures)) {
      let resolved = value
      let guard = 0
      // 纹理值可能是 "#all" 这类变量，同层找不到就放弃
      while (typeof resolved === 'string' && resolved.startsWith('#') && guard < 5) {
        resolved = textures[resolved.slice(1)]
        guard += 1
      }
      if (typeof resolved === 'string' && !resolved.startsWith('#')) {
        acc.add(resolved.replace(/^minecraft:/, ''))
      }
    }

  if (json.parent) return collectModelTextures(modelsDir, json.parent, depth + 1, acc)
  return acc
}

/** items 定义里 model 可能是 model / select / composite 等嵌套对象，递归挖出所有引用 */
function collectModelRefs(node, out = []) {
    if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const entry of node) collectModelRefs(entry, out)
    return out
  }
  if (typeof node.model === 'string') out.push(node.model)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'model') continue
    if (value && typeof value === 'object') collectModelRefs(value, out)
  }
  return out
}

async function buildBlockIndex(outDir, version) {
  const statesDir = path.join(outDir, 'blockstates')
  const itemsDir = path.join(outDir, 'items')
  const modelsDir = path.join(outDir, 'models')

  const map = new Map()

  const record = (textures, id) => {
    for (const texture of textures) {
      if (!texture.startsWith('block/') && !texture.startsWith('item/')) continue
      const list = map.get(texture) ?? []
      if (!list.includes(id)) list.push(id)
      map.set(texture, list)
    }
  }

  const readDirSafe = async (dir) => {
    try {
      return await readdir(dir)
    } catch {
      return []
    }
  }

  // 方块优先
  for (const file of await readDirSafe(statesDir)) {
    if (!file.endsWith('.json')) continue
    const block = file.slice(0, -'.json'.length)

    let state
    try {
      state = JSON.parse(await readFile(path.join(statesDir, file), 'utf8'))
    } catch {
      continue
    }

    const applies = []
    if (state.variants) {
      const first = Object.values(state.variants)[0]
      const apply = Array.isArray(first) ? first[0] : first
      if (apply?.model) applies.push(apply.model)
    } else if (state.multipart) {
      for (const part of state.multipart) {
        const apply = Array.isArray(part.apply) ? part.apply[0] : part.apply
        if (apply?.model) applies.push(apply.model)
      }
    }

    const textures = new Set()
    for (const model of applies) await collectModelTextures(modelsDir, model, 0, textures)
    record(textures, block)
  }

  // 物品兜底
  for (const file of await readDirSafe(itemsDir)) {
    if (!file.endsWith('.json')) continue
    const item = file.slice(0, -'.json'.length)

    let def
    try {
      def = JSON.parse(await readFile(path.join(itemsDir, file), 'utf8'))
    } catch {
      continue
    }

    const refs = collectModelRefs(def.model)
    if (refs.length === 0) continue

    const textures = new Set()
    for (const model of refs) await collectModelTextures(modelsDir, model, 0, textures)
    record(textures, item)
  }

  const table = {}
  for (const [texture, blocks] of [...map.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const base = texture.split('/').pop() ?? texture
    // @why 同一张图被几十个方块共用（木板还用于床、告示牌），把同名方块排最前才是用户预期的那个
    table[texture] = blocks.sort((a, b) => {
      const rank = (name) => (name === base ? 0 : name.startsWith(base) ? 1 : 2)
      return rank(a) - rank(b) || a.localeCompare(b)
    })
  }

  await writeFile(
    path.join(outDir, 'blockmaps.json'),
    JSON.stringify({ version, textures: table }),
  )
  return Object.keys(table).length
}

const ITEM_GROUPS = [
  ['building', '建筑方块'],
  ['decoration', '装饰方块'],
  ['redstone', '红石'],
  ['tool', '工具'],
  ['combat', '战斗'],
  ['food', '食物'],
  ['ingredient', '材料'],
  ['spawn_egg', '生成蛋'],
  ['misc', '其他'],
]


/** 分组封面用固定代表物，自动取「第一个」经常挑到蝾螈桶这种不具代表性的 */
const ITEM_GROUP_COVERS = {
  building: 'block/stone',
  decoration: 'block/oak_planks',
  redstone: 'item/redstone',
  tool: 'item/diamond_pickaxe',
  combat: 'item/diamond_sword',
  food: 'item/apple',
  ingredient: 'item/iron_ingot',
  spawn_egg: 'item/creeper_spawn_egg',
  misc: 'item/stick',
}

const ITEM_RULES = [
  ['spawn_egg', /_spawn_egg$/],
  // 红石排在装饰之前：按钮、压力板、铁轨在创造栏里归红石
  [
    'redstone',
    /(_button|_pressure_plate|_rail|repeater|comparator|piston|observer|hopper|dispenser|dropper|lever|_lamp|_torch|target|daylight_detector|sculk_sensor|tripwire_hook|note_block|jukebox|lectern|trapped_chest|tnt|redstone_block|redstone)$/,
  ],
  [
    'combat',
    /_(sword|helmet|chestplate|leggings|boots)$|^(bow|crossbow|arrow|spectral_arrow|tipped_arrow|trident|shield|mace|wind_charge|elytra|turtle_helmet|carved_pumpkin)$/,
  ],
  [
    'tool',
    /_(pickaxe|shovel|axe|hoe|shears)$|^(fishing_rod|flint_and_steel|brush|compass|clock|recovery_compass|spyglass|name_tag|lead|saddle|bucket|water_bucket|lava_bucket|milk_bucket|powder_snow_bucket|axolotl_bucket|cod_bucket|salmon_bucket|pufferfish_bucket|tropical_fish_bucket|tadpole_bucket)$/,
  ],
  [
    'food',
    /^(apple|golden_apple|enchanted_golden_apple|bread|cookie|cake|carrot|golden_carrot|potato|baked_potato|poisonous_potato|beetroot|melon_slice|honey_bottle|dried_kelp|pumpkin_pie|beef|cooked_beef|porkchop|cooked_porkchop|chicken|cooked_chicken|mutton|cooked_mutton|rabbit|cooked_rabbit|rabbit_stew|beetroot_soup|mushroom_stew|suspicious_stew|cod|cooked_cod|salmon|cooked_salmon|tropical_fish|pufferfish|spider_eye|fermented_spider_eye|rotten_flesh|chorus_fruit|popped_chorus_fruit)$/,
  ],
  // 装饰：有造型的方块 + 全部植物
  [
    'decoration',
    /_(stairs|slab|fence|fence_gate|door|trapdoor|sign|wall_sign|hanging_sign|wall_hanging_sign|carpet|banner|bed|glass|glass_pane|pane|wall|sapling|leaves|vine|coral|roots|sprouts|flower|tulip|orchid|allium|bluet|daisy|cornflower|lily|dandelion|poppy|rose|peony|lilac|sunflower|mushroom|fern|grass|kelp|seagrass|azalea|cushion|shelf|chain|lantern|skull|head|cluster|bud)$|^(glass|allium|azure_bluet|oxeye_daisy|blue_orchid|wither_rose|cornflower|lily_of_the_valley|torchflower|pitcher_plant|bamboo|sugar_cane|cactus|dead_bush|short_grass|tall_grass|cocoa_beans|sweet_berries|glow_berries|moss_block|moss_carpet|pale_moss_block|pale_moss_carpet|spore_blossom|big_dripleaf|small_dripleaf|hanging_roots|painting|item_frame|glow_item_frame|armor_stand|flower_pot|decorated_pot|lily_pad)$/,
  ],
  [
    'ingredient',
    /_(ingot|nugget|gem|dust|scrap|crystal|shard|fragment|dye|ball|hide|scute|shell|bone_meal)$|^(stick|string|feather|flint|coal|charcoal|diamond|emerald|lapis_lazuli|quartz|amethyst_shard|redstone|gunpowder|glowstone_dust|blaze_rod|blaze_powder|nether_star|netherite_ingot|echo_shard|brick|nether_brick|paper|book|slime_ball|leather)$/,
  ],
]

function classifyItem(id, hasBlock) {
  for (const [group, pattern] of ITEM_RULES) {
    if (pattern.test(id)) return group
  }
  // 有方块模型的归建筑，其余落杂项（原来的默认档叫 block，把 air、绊线之类
  // 全塞进去了，物品页的「方块」分组才会有 1130 项那么离谱）
  return hasBlock ? 'building' : 'misc'
}

/**
 * 物品注册表 —— 「创造背包里有的都要有」的那份清单。
 * @why 站点的浏览单位应该是物品而不是贴图文件：一张 diamond.png 对应钻石，
 *      但 oak_planks.png 对应 60 多个方块，只能靠 items/ 定义还原成条目。
 * @constraint itemGroup 分类只存在于游戏代码里，这里按 id 规则近似分组。
 */
async function buildItemRegistry(outDir, version) {
  const itemsDir = path.join(outDir, 'items')
  const statesDir = path.join(outDir, 'blockstates')
  const modelsDir = path.join(outDir, 'models')
  const zh = await loadLang(outDir, 'zh_cn')
  const en = await loadLang(outDir, 'en_us')

  let files = []
  let blockIds = new Set()
  try {
    files = await readdir(itemsDir)
    blockIds = new Set((await readdir(statesDir)).map((name) => name.replace(/\.json$/, '')))
  } catch {
    return 0
  }

  /**
   * @constraint 分类和顺序必须来自反编译出来的 CreativeModeTabs，
   *             不能用 id 正则猜：游戏里羊毛是按 白→浅灰→灰→黑… 这个顺序注册的，
   *             猜出来的字母序会把颜色打散。
   */
  const tabs = []
  const tabOf = new Map()
  const orderOf = new Map()
  try {
    const tabFile = JSON.parse(await readFile(path.join(outDir, 'creativetabs.json'), 'utf8'))
    for (const tab of tabFile.tabs ?? []) {
      tabs.push({ id: tab.id, label: tab.label })
      tab.items.forEach((itemId, index) => {
        if (!tabOf.has(itemId)) {
          tabOf.set(itemId, tab.id)
          orderOf.set(itemId, index)
        }
      })
    }
  } catch {
    // 没有 tabs 数据时退回规则分类
  }

  const items = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)

    let def
    try {
      def = JSON.parse(await readFile(path.join(itemsDir, file), 'utf8'))
    } catch {
      continue
    }

    const modelNode = def.model
    const rawType =
      modelNode && typeof modelNode === 'object' && typeof modelNode.type === 'string'
        ? modelNode.type
        : 'minecraft:model'
    const type = rawType.replace(/^minecraft:/, '')
    const refs = collectModelRefs(modelNode)

    // 图标取模型引用的贴图，但必须确认文件真的存在：
    // 门、告示牌这类物品的模型会引用 item/xxx 而实际图在 block/ 下，直接取会 404
    const candidates = []
    for (const ref of refs) {
      const textures = await collectModelTextures(modelsDir, ref)
      for (const texture of textures) {
        if (texture.startsWith('item/') || texture.startsWith('block/')) candidates.push(texture)
      }
    }

    let icon = null
    for (const candidate of candidates) {
      if (await exists(path.join(outDir, 'textures', `${candidate}.png`))) {
        icon = candidate
        break
      }
    }

    if (!icon) {
      for (const candidate of [`item/${id}`, `block/${id}`]) {
        if (await exists(path.join(outDir, 'textures', `${candidate}.png`))) {
          icon = candidate
          break
        }
      }
    }

    // @why 旗帜、箱子、床这些是 special 渲染，物品侧没有贴图，得回到方块模型里找
    if (!icon && blockIds.has(id)) {
      try {
        const state = JSON.parse(
          await readFile(path.join(statesDir, `${id}.json`), 'utf8'),
        )
        const applies = []
        if (state.variants) {
          const first = Object.values(state.variants)[0]
          const apply = Array.isArray(first) ? first[0] : first
          if (apply?.model) applies.push(apply.model)
        } else if (state.multipart) {
          for (const part of state.multipart) {
            const apply = Array.isArray(part.apply) ? part.apply[0] : part.apply
            if (apply?.model) applies.push(apply.model)
          }
        }

        for (const model of applies) {
          const textures = await collectModelTextures(modelsDir, model)
          for (const texture of textures) {
            if (await exists(path.join(outDir, 'textures', `${texture}.png`))) {
              icon = texture
              break
            }
          }
          if (icon) break
        }
      } catch {
        // 没有 blockstate 就继续走兜底
      }
    }

    if (!icon) icon = candidates[0] ?? `item/${id}`

    const zhName = zh[`item.minecraft.${id}`] ?? zh[`block.minecraft.${id}`] ?? null
    const enName = en[`item.minecraft.${id}`] ?? en[`block.minecraft.${id}`] ?? null
    const hasBlock = blockIds.has(id)

    items.push({
      id,
      n: zhName ?? humanize(id),
      e: enName,
      i: icon,
      t: type,
      g: tabOf.get(id) ?? (hasBlock ? 'building_blocks' : 'misc'),
      o: orderOf.get(id) ?? 9999,
      b: hasBlock ? 1 : 0,
    })
  }

  const tabRank = new Map(tabs.map((tab, index) => [tab.id, index]))
  items.sort((a, b) => {
    const ra = tabRank.get(a.g) ?? 99
    const rb = tabRank.get(b.g) ?? 99
    if (ra !== rb) return ra - rb
    if (a.o !== b.o) return a.o - b.o
    return a.id.localeCompare(b.id)
  })

  const counts = {}
  for (const item of items) counts[item.g] = (counts[item.g] ?? 0) + 1

  await writeFile(
    path.join(outDir, 'items.json'),
    JSON.stringify({
      version,
      groups: [
        ...tabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          count: counts[tab.id] ?? 0,
          cover:
            ITEM_GROUP_COVERS[tab.id] ??
            items.find((item) => item.g === tab.id)?.i ??
            null,
        })),
        ...(counts.misc
          ? [{
              id: 'misc',
              label: '未分类',
              count: counts.misc,
              cover: items.find((item) => item.g === 'misc')?.i ?? null,
            }]
          : []),
      ].filter((group) => group.count > 0),
      items,
    }),
  )

  return items.length
}

/** data 目录下的注册表：文件名即条目 id，中文名靠语言文件反查 */
const DATA_REGISTRIES = [
  ['enchantment', 'enchantments', '附魔', (id) => `enchantment.minecraft.${id}`],
  ['painting_variant', 'paintings', '画', (id) => `painting.minecraft.${id}.title`],
  ['banner_pattern', 'banner_patterns', '旗帜图案', () => null],
  ['damage_type', 'damage_types', '伤害类型', (id) => `death.attack.${id}`],
  ['jukebox_song', 'jukebox_songs', '唱片', (id) => `jukebox_song.minecraft.${id}`],
  ['trim_pattern', 'trim_patterns', '盔甲纹饰', (id) => `trim_pattern.minecraft.${id}`],
  ['trim_material', 'trim_materials', '纹饰材料', (id) => `trim_material.minecraft.${id}`],
  ['instrument', 'instruments', '乐器', (id) => `instrument.minecraft.${id}`],
  ['worldgen/biome', 'biomes', '生物群系', (id) => `biome.minecraft.${id}`],
]

async function readDirSafe(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * 汇总游戏里所有能拿到的注册表。
 * @why 站点只给物品入口太窄：附魔、画、旗帜图案、伤害类型、生物群系同样是注册表数据，
 *      它们没有独立页面就永远藏在 jar 里。
 */
async function buildRegistries(outDir, version) {
  const zh = await loadLang(outDir, 'zh_cn')
  const en = await loadLang(outDir, 'en_us')

  const label = (key, fallback) => ({
    n: key ? (zh[key] ?? en[key] ?? fallback) : fallback,
    e: key ? (en[key] ?? null) : null,
  })

  const exists = async (rel) => {
    try {
      await stat(path.join(outDir, rel))
      return true
    } catch {
      return false
    }
  }

  const registries = []

  // ---- 物品 ----
  let itemCount = 0
  try {
    const items = JSON.parse(await readFile(path.join(outDir, 'items.json'), 'utf8'))
    itemCount = items.items.length
    registries.push({
      id: 'items',
      label: '物品',
      kind: 'registry',
      source: 'assets/minecraft/items',
      route: '/items',
      count: itemCount,
      entries: items.items.map((item) => ({
        id: item.id,
        n: item.n,
        e: item.e,
        i: item.i,
        t: item.t,
      })),
    })
  } catch {
    // 没生成物品表就跳过
  }

  // ---- 方块 ----
  const blockIds = (await readDirSafe(path.join(outDir, 'blockstates')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()

  if (blockIds.length > 0) {
    // 反查表是 texture -> [ids]，这里要 id -> texture，取第一次出现的
    const iconById = new Map()
    try {
      const table = JSON.parse(await readFile(path.join(outDir, 'blockmaps.json'), 'utf8')).textures
      for (const [texture, ids] of Object.entries(table)) {
        for (const id of ids) if (!iconById.has(id)) iconById.set(id, texture)
      }
    } catch {
      // 没有反查表就退回 block/<id>
    }

    registries.push({
      id: 'blocks',
      label: '方块',
      kind: 'registry',
      source: 'assets/minecraft/blockstates',
      route: '/blocks',
      count: blockIds.length,
      entries: blockIds.map((id) => {
        const name = label(`block.minecraft.${id}`, id)
        return { id, n: name.n, e: name.e, i: iconById.get(id) ?? `block/${id}` }
      }),
    })
  }

  // ---- 实体 ----
  const entityEntries = Object.keys(zh)
    // @constraint 'entity.minecraft.' 是 17 个字符，写 19 会把 id 前两位吃掉
    .filter((key) => key.startsWith('entity.minecraft.') && !key.slice(17).includes('.'))
    .map((key) => key.slice(17))
    .sort()

  if (entityEntries.length > 0) {
    const entries = []
    for (const id of entityEntries) {
      let icon = null
      for (const candidate of [`entity/${id}/${id}`, `entity/${id}`]) {
        if (await exists(`textures/${candidate}.png`)) {
          icon = candidate
          break
        }
      }
      const name = label(`entity.minecraft.${id}`, id)
      entries.push({ id, n: name.n, e: name.e, ...(icon ? { i: icon } : {}) })
    }
    registries.push({
      id: 'entities',
      label: '实体',
      kind: 'registry',
      source: 'lang: entity.minecraft.*',
      route: '/entities',
      count: entries.length,
      entries,
    })
  }

  // ---- 状态效果 ----
  const effectIds = Object.keys(zh)
    .filter((key) => key.startsWith('effect.minecraft.'))
    .map((key) => key.slice(17))
    .sort()

  if (effectIds.length > 0) {
    registries.push({
      id: 'effects',
      label: '状态效果',
      kind: 'registry',
      source: 'lang: effect.minecraft.*',
      route: '/registries/effects',
      count: effectIds.length,
      entries: effectIds.map((id) => {
        const name = label(`effect.minecraft.${id}`, id)
        return { id, n: name.n, e: name.e, i: `mob_effect/${id}` }
      }),
    })
  }

  // ---- 粒子 ----
  const particleIds = (await readDirSafe(path.join(outDir, 'particles')))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()

  if (particleIds.length > 0) {
    registries.push({
      id: 'particles',
      label: '粒子',
      kind: 'registry',
      source: 'assets/minecraft/particles',
      route: '/registries/particles',
      count: particleIds.length,
      entries: particleIds.map((id) => ({ id, n: id, e: null })),
    })
  }

  // ---- data 侧注册表 ----
  for (const [dir, id, title, keyOf] of DATA_REGISTRIES) {
    const ids = (await readDirSafe(path.join(outDir, 'data', 'minecraft', dir)))
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
    if (ids.length === 0) continue

    registries.push({
      id,
      label: title,
      kind: 'registry',
      source: `data/minecraft/${dir}`,
      route: `/data/${id}`,
      dataDir: dir,
      count: ids.length,
      entries: ids.map((entryId) => {
        const name = label(keyOf(entryId), entryId)
        return { id: entryId, n: name.n, e: name.e }
      }),
    })
  }

  // ---- 模型、着色器等原始资源文件 ----
  const ASSET_REGISTRIES = [
    ['models', '模型文件', 'models'],
    ['shaders', '着色器', 'shaders'],
    ['font', '字体', 'font'],
    ['atlases', '图集', 'atlases'],
  ]

  for (const [id, title, dir] of ASSET_REGISTRIES) {
    const files = await walk(path.join(outDir, dir))
    if (files.length === 0) continue

    registries.push({
      id,
      label: title,
      kind: 'asset',
      source: `assets/minecraft/${dir}`,
      route: `/data/${id}`,
      assetDir: dir,
      count: files.length,
      entries: files.map((file) => ({ id: file, n: file.replace(/\.[a-z]+$/, ''), e: null })),
    })
  }

  // ---- 音效 ----
  let soundCount = 0
  try {
    const sounds = JSON.parse(await readFile(path.join(outDir, 'sounds.json'), 'utf8'))
    soundCount = sounds.items.length
  } catch {
    // 没有音效表就跳过
  }
  if (soundCount > 0) {
    registries.push({
      id: 'sounds',
      label: '音效',
      kind: 'asset',
      source: 'assets/minecraft/sounds',
      route: '/sounds',
      count: soundCount,
      entries: [],
    })
  }

  await writeFile(
    path.join(outDir, 'registries.json'),
    JSON.stringify({ version, registries }),
  )

  return registries.map((registry) => ({ id: registry.id, count: registry.count }))
}

/**
 * 连接类属性优先取 true（栅栏/墙显示成十字而不是一根孤立的柱子），
 * 其余属性取"关闭 / 朝北 / 下半"这类最常见状态。
 */
const LINK_PROPS = new Set(['north', 'east', 'south', 'west', 'up', 'down'])
const PREFERRED = ['north', 'bottom', 'straight', 'false', 'none', 'y', '0']

/** 把一个 blockstate 里出现过的属性值全收集起来，用于挑一组自洽的代表状态 */
function collectStateValues(state) {
  const values = new Map()
  const bump = (name, raw) => {
    const set = values.get(name) ?? new Set()
    for (const item of String(raw).split('|')) set.add(item)
    values.set(name, set)
  }
  const walk = (cond) => {
    if (!cond) return
    if (Array.isArray(cond)) {
      for (const entry of cond) walk(entry)
      return
    }
    for (const [key, value] of Object.entries(cond)) {
      if (key === 'AND' || key === 'OR') {
        walk(value)
        continue
      }
      bump(key, value)
    }
  }

  if (state.variants) {
    for (const key of Object.keys(state.variants)) {
      for (const pair of String(key).split(',')) {
        const eq = pair.indexOf('=')
        if (eq > 0) bump(pair.slice(0, eq), pair.slice(eq + 1))
      }
    }
  }
  if (state.multipart) {
    for (const part of state.multipart) walk(part.when)
  }
  return values
}

function pickState(values) {
  const state = {}
  for (const [name, set] of values) {
    if (LINK_PROPS.has(name) && set.has('true')) {
      state[name] = 'true'
      continue
    }
    state[name] = PREFERRED.find((item) => set.has(item)) ?? [...set][0]
  }
  return state
}

/** 求值 multipart 的 when / variants 的状态串 */
function whenMatches(when, state) {
  if (!when) return true
  if (Array.isArray(when)) return when.some((entry) => whenMatches(entry, state))

  for (const [key, value] of Object.entries(when)) {
    if (key === 'AND') {
      if (!value.every((entry) => whenMatches(entry, state))) return false
      continue
    }
    if (key === 'OR') {
      if (!value.some((entry) => whenMatches(entry, state))) return false
      continue
    }
    if (!String(value).split('|').includes(state[key])) return false
  }
  return true
}

function parseVariantKey(key) {
  const cond = {}
  for (const pair of String(key).split(',')) {
    const eq = pair.indexOf('=')
    if (eq > 0) cond[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  return cond
}

/** 面朝向定义：n 法线、r 面内向右、u 面内向上（模型坐标系，y 向上） */
const FACE_DIRS = {
  north: { n: [0, 0, -1], r: [-1, 0, 0], u: [0, 1, 0] },
  south: { n: [0, 0, 1], r: [1, 0, 0], u: [0, 1, 0] },
  east: { n: [1, 0, 0], r: [0, 0, 1], u: [0, 1, 0] },
  west: { n: [-1, 0, 0], r: [0, 0, -1], u: [0, 1, 0] },
  up: { n: [0, 1, 0], r: [1, 0, 0], u: [0, 0, -1] },
  down: { n: [0, -1, 0], r: [1, 0, 0], u: [0, 0, 1] },
}

/** 绕任意轴旋转任意角度，用于 element.rotation（斜面、倾角） */
function rotateAxisAngle(point, origin, axis, angleDeg) {
  if (!angleDeg) return point
  const rad = (angleDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  let x = point[0] - origin[0]
  let y = point[1] - origin[1]
  let z = point[2] - origin[2]

  if (axis === 'x') {
    const ny = y * cos - z * sin
    const nz = y * sin + z * cos
    y = ny
    z = nz
  } else if (axis === 'y') {
    const nx = x * cos + z * sin
    const nz = -x * sin + z * cos
    x = nx
    z = nz
  } else {
    const nx = x * cos - y * sin
    const ny = x * sin + y * cos
    x = nx
    y = ny
  }

  return [x + origin[0], y + origin[1], z + origin[2]]
}

/**
 * FaceInfo：每个方向的 4 个顶点，0 表示取 from 分量、1 表示取 to 分量。
 * @constraint 顺序必须与游戏一致（从外侧看逆时针），否则 UV 会整体错位、
 *             法线会反向。这张表直接抄自 net.minecraft.client.renderer.FaceInfo。
 */
const FACE_VERTEX = {
  down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
}

/**
 * FaceBakery.defaultFaceUV：面没写 uv 时，按元素尺寸投影出 UV。
 * @constraint 这不是"省略 = 0..16"。蛋糕侧面只占纹理一半、台阶只有 8 高，
 *             都靠这条规则。之前直接套 0-16 才是"纹理被拉伸"的根因。
 */
function defaultFaceUV(from, to, dir) {
  const [x1, y1, z1] = from
  const [x2, y2, z2] = to
  switch (dir) {
    case 'down':
      return [x1, 16 - z2, x2, 16 - z1]
    case 'up':
      return [x1, z1, x2, z2]
    case 'north':
      return [16 - x2, 16 - y2, 16 - x1, 16 - y1]
    case 'south':
      return [x1, 16 - y2, x2, 16 - y1]
    case 'west':
      return [z1, 16 - y2, z2, 16 - y1]
    case 'east':
      return [16 - z2, 16 - y2, 16 - z1, 16 - y1]
    default:
      return [0, 0, 16, 16]
  }
}

/** 4x3 矩阵乘法（行优先，只保留旋转部分） */
function mat3Mul(a, b) {
  const out = new Array(9)
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] =
        a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

function mat3Vec(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ]
}

const axisRotation = (axis, deg) => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c]
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c]
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

/** CuboidRotation：单轴绕轴转，三轴按 ZYX 顺序（与 joml rotationXYZ 等价） */
function elementMatrix(rotation) {
  if (!rotation || !rotation.angle) return null
  if (rotation.axis) return axisRotation(rotation.axis, rotation.angle)
  const { x = 0, y = 0, z = 0 } = rotation
  return mat3Mul(mat3Mul(axisRotation('z', z), axisRotation('y', y)), axisRotation('x', x))
}

/**
 * rescale：旋转后把形状缩回原来占的包围盒。
 * @constraint 只在 22.5°/45° 这类非 90° 角度下生效，但倾斜模型（大滴露叶、
 *             告示牌斜板）全靠它，不做就会被拉长或缩扁。
 */
function rescaleMatrix(m) {
  const factor = (col) => {
    const v = [m[col], m[3 + col], m[6 + col]]
    const max = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])) || 1
    return 1 / max
  }
  const sx = factor(0)
  const sy = factor(1)
  const sz = factor(2)
  return [m[0] * sx, m[1] * sy, m[2] * sz, m[3] * sx, m[4] * sy, m[5] * sz, m[6] * sx, m[7] * sy, m[8] * sz]
}

/** 90 度倍数的轴对齐旋转（blockstate 的 x/y），绕方块中心 */
function rotate90(point, x, y, origin) {
  let [vx, vy, vz] = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]]
  const rx = ((x % 360) + 360) % 360
  const ry = ((y % 360) + 360) % 360

  if (rx === 90) [vy, vz] = [-vz, vy]
  else if (rx === 180) [vy, vz] = [-vy, -vz]
  else if (rx === 270) [vy, vz] = [vz, -vy]

  if (ry === 90) [vx, vz] = [vz, -vx]
  else if (ry === 180) [vx, vz] = [-vx, -vz]
  else if (ry === 270) [vx, vz] = [-vz, vx]

  return [vx + origin[0], vy + origin[1], vz + origin[2]]
}

/**
 * 预烘焙所有方块与物品模型。
 *
 * @constraint 面数据格式（每面 23 个数）：
 *   [0..11]  4 个顶点 xyz（0..16）
 *   [12..19] 4 个顶点的 uv（已归一化 0..1）
 *   [20] 纹理池索引  [21] tintindex  [22] shade（0/1）
 *
 *   之所以存每顶点 uv 而不是 u1v1u2v2，是因为 face.rotation 会让 UV
 *   在四个角之间循环，矩形区间表达不了。
 */
async function buildBlockModels(outDir, version) {
  const statesDir = path.join(outDir, 'blockstates')
  const itemsDir = path.join(outDir, 'items')
  const modelsDir = path.join(outDir, 'models')

  const readDir = async (dir) => {
    try {
      return await readdir(dir)
    } catch {
      return []
    }
  }

  const modelCache = new Map()
  const readModel = async (ref) => {
    const key = ref.replace(/^minecraft:/, '')
    if (modelCache.has(key)) return modelCache.get(key)
    let json = null
    try {
      json = JSON.parse(await readFile(path.join(modelsDir, `${key}.json`), 'utf8'))
    } catch {
      json = null
    }
    modelCache.set(key, json)
    return json
  }

  /** parent 链合并，同时把 display 一起带下来 */
  const resolve = async (ref, depth = 0, seen = new Set()) => {
    if (depth > 8 || seen.has(ref)) return null
    seen.add(ref)
    const key = ref.replace(/^minecraft:/, '')

    /**
     * builtin/generated 没有 JSON，它是 ItemModelGenerator 在运行时拼出来的：
     * 16×16 的贴图挤出 1 单位（= 1/16 格）厚，前后两个面。
     *
     * @constraint 只写前后两面会让薄片在等轴测视角下"没有厚度"，看起来还是张纸。
     *      这里把四个侧面补上，UV 取贴图对应的边缘一行/一列——厚度只有 1 像素，
     *      屏幕上就是一条 1 像素宽的描边，这正是游戏里 3D 物品的观感。
     */
    if (key === 'builtin/generated') {
      return {
        textures: {},
        display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
        elements: [
          {
            from: [0, 0, 7.5],
            to: [16, 16, 8.5],
            faces: {
              north: { uv: [16, 0, 0, 16], texture: '#layer0' },
              south: { uv: [0, 0, 16, 16], texture: '#layer0' },
              west: { uv: [0, 0, 1, 16], texture: '#layer0' },
              east: { uv: [15, 0, 16, 16], texture: '#layer0' },
              up: { uv: [0, 0, 16, 1], texture: '#layer0' },
              down: { uv: [0, 15, 16, 16], texture: '#layer0' },
            },
          },
        ],
      }
    }

    const json = await readModel(ref)
    if (!json) return null

    /**
     * @why 水和岩浆在资源包里没有 elements：模型 JSON 只有一句 particle 贴图，
     *      方块本体是 LiquidRenderer 运行时画的。素材站要展示这两块最典型的
     *      动画贴图（water_still 32 帧、lava_still 20 帧），只能自己补一个满格立方体。
     * @constraint 水的贴图是灰度图，颜色靠群系 tint 乘上去；tintindex 3 对应
     *      TINTS 里的水色，不给 tint 的话水会渲染成一坨灰。
     */
    const liquid = {
      'block/water': ['block/water_still', 3],
      'block/lava': ['block/lava_still', -1],
    }[key]
    if (liquid && !json.elements) {
      const [texture, tintindex] = liquid
      const side = { texture: '#all', tintindex }
      return {
        textures: { all: texture },
        display: json.display,
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { down: side, up: side, north: side, south: side, west: side, east: side },
          },
        ],
      }
    }

    if (!json.parent) return json

    const parent = await resolve(json.parent, depth + 1, seen)
    if (!parent) return json

    return {
      elements: json.elements ?? parent.elements,
      textures: { ...(parent.textures ?? {}), ...(json.textures ?? {}) },
      display: { ...(parent.display ?? {}), ...(json.display ?? {}) },
    }
  }

  const texturePool = []
  const framePool = []
  /**
   * 稀疏动画表：纹理池索引 → [帧数, frametime, 回放序列]
   * @why 用对象而不是与 texturePool 对齐的数组：1636 个贴图只有 38 个会动，
   *      对齐数组里 1598 个 null 就是纯负担。
   */
  const animPool = {}
  const textureIndex = new Map()

  /**
   * 动画贴图的完整参数：帧数、播放节奏、回放序列。
   *
   * @why 竖条 PNG 的宽高比只能看出「有几帧」，看不出怎么播：
   *      水的 animation.frametime 是 2（每 2 tick 换一帧），火是 1，岩浆是 2 外加一条
   *      40 步的来回序列。只按帧数循环，水会快一倍，岩浆会一直往一个方向循环，
   *      看起来像贴图在跳帧。
   * @constraint 只给 n > 1 的贴图建条目。1636 个贴图里只有 38 个真带动画，
   *      给每个都写一份 {n:1,t:1} 会让 JSON 白胖一百多 KB，而首页要下这个文件。
   */
  const readAnim = async (name) => {
    let n = 1
    try {
      const buffer = await readFile(path.join(outDir, 'textures', `${name}.png`))
      if (buffer.length < 24) return null
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      if (width > 0) n = Math.max(1, Math.round(height / width))
    } catch {
      return null
    }
    if (n <= 1) return null

    let frametime = 1
    let seq = null
    try {
      const raw = await readFile(path.join(outDir, 'textures', `${name}.png.mcmeta`), 'utf8')
      const animation = JSON.parse(raw)?.animation
      if (animation) {
        /**
         * @constraint 缺省必须是 1 而不是 2：Minecraft 的默认值就是每 tick 一帧。
         *      按 2 兜底会让所有没写 frametime 的动画慢一倍，水面看着像卡住了。
         */
        const ft = Number(animation.frametime)
        if (Number.isFinite(ft) && ft > 0) frametime = ft
        if (Array.isArray(animation.frames)) {
          const out = []
          for (const item of animation.frames) {
            if (typeof item === 'number') {
              out.push(item)
              continue
            }
            if (!item || typeof item !== 'object') continue
            const index = Number(item.index)
            if (!Number.isInteger(index)) continue
            const time = Number(item.time)
            const repeat = Number.isFinite(time) && time > 1 ? Math.round(time) : 1
            for (let i = 0; i < repeat; i += 1) out.push(index)
          }
          /**
           * @constraint 越界的 index 必须剔掉：序列里的数字直接当成竖图的帧下标去算
           *      v 偏移，超出帧数就会采到相邻贴图的行，整块方块会出现一条别人的像素。
           */
          const safe = out.filter((index) => index >= 0 && index < n)
          if (safe.length > 0) seq = safe
        }
      }
    } catch {
      // 没有 mcmeta 就按纯帧数循环，这是绝大多数流动方块的情况
    }
    return [n, frametime, seq]
  }

  const texId = (name) => {
    if (textureIndex.has(name)) return textureIndex.get(name)
    textureIndex.set(name, texturePool.length)
    texturePool.push(name)
    framePool.push(1)
    return texturePool.length - 1
  }

  const fillFrames = async () => {
    for (let i = 0; i < texturePool.length; i += 1) {
      const anim = await readAnim(texturePool[i])
      if (!anim) continue
      framePool[i] = anim[0]
      animPool[i] = anim
    }
  }

  const resolveTexture = (textures, ref, depth = 0) => {
    if (typeof ref !== 'string' || ref.length === 0 || depth > 5) return null
    if (!ref.startsWith('#')) return ref.replace(/^minecraft:/, '')
    const next = textures[ref.slice(1)]
    return next ? resolveTexture(textures, next, depth + 1) : null
  }

  /**
   * 生成一个面的 4 个顶点与 4 组 uv。
   * @constraint uv 的顶点顺序：u 取 min 的是 0/1，取 max 的是 2/3；
   *             v 取 min 的是 0/3，取 max 的是 1/2。这是 CuboidFace 的定义。
   */
  const bakeFace = (element, dir, face, textures, apply, out) => {
    const geom = FACE_VERTEX[dir]
    if (!geom) return

    const texture = resolveTexture(textures, face.texture)
    if (!texture) return

    const from = element.from
    const to = element.to
    const [u1, v1, u2, v2] = face.uv ?? defaultFaceUV(from, to, dir)
    const step = ((face.rotation ?? 0) % 360 + 360) % 360

    // UV 旋转：90° 时把顶点索引往回挪一位，等价于 (u,v) → (1-v, u)
    const shift = step === 90 ? 3 : step === 180 ? 2 : step === 270 ? 1 : 0
    const uAt = (i) => (i === 0 || i === 1 ? u1 : u2)
    const vAt = (i) => (i === 0 || i === 3 ? v1 : v2)

    const rotation = element.rotation
    let matrix = elementMatrix(rotation)
    if (matrix && (rotation.rescale ?? false)) matrix = rescaleMatrix(matrix)
    const origin = rotation?.origin ?? [8, 8, 8]

    const points = []
    const uvs = []
    for (let i = 0; i < 4; i += 1) {
      const pick = geom[i]
      let point = [
        pick[0] ? to[0] : from[0],
        pick[1] ? to[1] : from[1],
        pick[2] ? to[2] : from[2],
      ]

      if (matrix) {
        const local = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]]
        const rotated = mat3Vec(matrix, local)
        point = [rotated[0] + origin[0], rotated[1] + origin[1], rotated[2] + origin[2]]
      }

      if (apply?.x || apply?.y) point = rotate90(point, apply.x ?? 0, apply.y ?? 0, [8, 8, 8])

      points.push(point)

      const src = (i + shift) % 4
      uvs.push(uAt(src) / 16, vAt(src) / 16)
    }

    out.push([
      ...points.flat().map((v) => Math.round(v * 100) / 100),
      ...uvs,
      texId(texture),
      face.tintindex ?? -1,
      face.shade === false ? 0 : 1,
    ])
  }

  const bakeModel = async (modelRef, apply, out) => {
    const model = await resolve(modelRef)
    if (!model?.elements) return null
    const textures = model.textures ?? {}

    for (const element of model.elements) {
      if (element.from?.length !== 3 || element.to?.length !== 3) continue
      for (const [dir, face] of Object.entries(element.faces ?? {})) {
        bakeFace(element, dir, face, textures, apply, out)
      }
    }

    return model
  }

  /** display.gui 是游戏里物品栏的那个视角，取不到就退回 fixed */
  const pickDisplay = (model) => {
    const entry = model?.display?.gui ?? model?.display?.fixed
    if (!entry) return null
    return {
      rotation: entry.rotation ?? [0, 0, 0],
      translation: entry.translation ?? [0, 0, 0],
      scale: entry.scale ?? [1, 1, 1],
    }
  }

  const blocks = {}
  const items = {}
  const displays = {}
  const flat = []
  /**
   * 半截方块：门只有下半扇、床只有一头、高花只有半丛。
   * 它们单独渲染出来是残缺的，默认不在列表里出现，由前端开关控制。
   */
  const hidden = []

  for (const file of await readDir(statesDir)) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)

    let state
    try {
      state = JSON.parse(await readFile(path.join(statesDir, file), 'utf8'))
    } catch {
      continue
    }

    const chosen = pickState(collectStateValues(state))

    const applies = []
    if (state.variants) {
      let best = null
      let bestHits = -1
      for (const [key, value] of Object.entries(state.variants)) {
        const cond = parseVariantKey(key)
        if (!whenMatches(cond, chosen)) continue
        const apply = Array.isArray(value) ? value[0] : value
        if (!apply) continue
        const hits = Object.keys(cond).length
        if (hits > bestHits) {
          bestHits = hits
          best = apply
        }
      }
      if (!best) {
        const first = Object.values(state.variants)[0]
        best = Array.isArray(first) ? first[0] : first
      }
      if (best) applies.push(best)
    } else if (state.multipart) {
      for (const part of state.multipart) {
        if (!whenMatches(part.when, chosen)) continue
        const list = Array.isArray(part.apply) ? part.apply : [part.apply]
        for (const apply of list) if (apply) applies.push(apply)
      }
    }

    const faces = []
    let display = null
    for (const apply of applies) {
      const model = await bakeModel(apply.model, apply, faces)
      if (!display) display = pickDisplay(model)
    }

    if (faces.length > 0) {
      blocks[id] = faces
      if (display) displays[id] = display

      // @constraint half=lower 只有门的下一半，part=head/foot 只有床的一半。
      //             这类方块单独渲染必然残缺，标记出来让前端默认收起。
      const props = collectStateValues(state)
      const halves = props.get('half')
      const parts = props.get('part')
      const isHalf =
        (halves && halves.has('lower')) ||
        (parts && (parts.has('head') || parts.has('foot')))
      if (isHalf) hidden.push(id)
    }
  }

  for (const file of await readDir(itemsDir)) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -'.json'.length)

    let def
    try {
      def = JSON.parse(await readFile(path.join(itemsDir, file), 'utf8'))
    } catch {
      continue
    }

    const refs = collectModelRefs(def.model)
    if (refs.length === 0) continue

    const faces = []
    let display = null
    for (const ref of refs) {
      const model = await bakeModel(ref, null, faces)
      if (!display) display = pickDisplay(model)
    }

    if (faces.length > 0) {
      items[id] = faces
      if (display) displays[id] = display

      /**
       * @why 平面物品（贴图挤出 1 单位厚）在 30°/225° 的等轴测视角下会被压扁、
       *      左右还镜像，因为看到的是背面。单独标出来，前端换成正对相机的角度。
       */
      let zMin = Infinity
      let zMax = -Infinity
      for (const face of faces) {
        for (let i = 0; i < 4; i += 1) {
          const z = face[i * 3 + 2]
          if (z < zMin) zMin = z
          if (z > zMax) zMax = z
        }
      }
      if (zMax - zMin <= 1.05) flat.push(id)
    }
  }

  await fillFrames()

  /**
   * 面数据分片。
   *
   * @why 1160 个方块 + 1574 个物品的面数据合起来 2.2MB，而列表页首屏只需要
   *      视口里那十几个。整包下发意味着手机上要先解析完 2.4MB JSON 才能显示
   *      第一个方块，滚动还没开始就等了一秒多。
   * @constraint 必须按 id 排序后切片：前端拿到的 blockIds 也是同一个排序，
   *      靠下标 / SHARD_SIZE 就能算出第 k 个条目属于哪一片，不用额外存映射表。
   */
  const SHARD_SIZE = 200
  const bakeShards = async (kind, table) => {
    const ids = Object.keys(table).sort()
    const dir = path.join(outDir, 'baked')
    await mkdir(dir, { recursive: true })
    const count = Math.max(1, Math.ceil(ids.length / SHARD_SIZE))
    for (let i = 0; i < count; i += 1) {
      const part = {}
      for (const id of ids.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE)) part[id] = table[id]
      await writeFile(path.join(dir, `${kind}.${i}.json`), JSON.stringify(part))
    }
    return ids
  }

  const blockIds = await bakeShards('blocks', blocks)
  const itemIds = await bakeShards('items', items)

  await writeFile(
    path.join(outDir, 'blockmodels.json'),
    JSON.stringify({
      version,
      textures: texturePool,
      frames: framePool,
      anims: animPool,
      // @constraint 索引清单必须留在 meta 里：列表页要先知道有哪些方块才能排版，
      //      面数据到滚动时再按片取。顺序就是切片顺序，前端据此算分片下标。
      blockIds,
      itemIds,
      shardSize: SHARD_SIZE,
      blocks: {},
      items: {},
      displays,
      hidden,
      flat,
    }),
  )

  return { blocks: blockIds.length, items: itemIds.length }
}


/** 汇总所有已提取版本，站点只需请求这一个文件即可知道有哪些版本 */
async function writeVersionsManifest() {
  let entries = []
  try {
    entries = await readdir(OUT_ROOT, { withFileTypes: true })
  } catch {
    return
  }

  const versions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const indexPath = path.join(OUT_ROOT, entry.name, 'index.json')
    if (!(await exists(indexPath))) continue
    const data = JSON.parse(await readFile(indexPath, 'utf8'))

    // 物品分组单独一份文件，首页要拿它做入口，不能为此拖 205KB 的全量注册表
    let itemGroups = []
    let itemCount = 0
    try {
      const items = JSON.parse(await readFile(path.join(OUT_ROOT, entry.name, 'items.json'), 'utf8'))
      itemGroups = items.groups ?? []
      itemCount = items.items?.length ?? 0
    } catch {
      // 未生成物品注册表时忽略
    }

    let blockCount = 0
    try {
      const baked = JSON.parse(
        await readFile(path.join(OUT_ROOT, entry.name, 'blockmodels.json'), 'utf8'),
      )
      // @why 面数据已经切成分片，meta 里的 blocks 是空的，数量要看索引清单
      blockCount = (baked.blockIds ?? Object.keys(baked.blocks ?? {})).length
    } catch {
      // 未生成方块模型时忽略
    }

    // 首页只显示数量，不能为此加载 330KB 的完整注册表
    let registrySummary = []
    try {
      const regs = JSON.parse(
        await readFile(path.join(OUT_ROOT, entry.name, 'registries.json'), 'utf8'),
      )
      registrySummary = regs.registries.map((registry) => ({
        id: registry.id,
        label: registry.label,
        kind: registry.kind,
        count: registry.count,
        route: registry.route,
      }))
    } catch {
      // 未生成注册表时忽略
    }

    versions.push({
      id: data.version,
      generatedAt: data.generatedAt,
      counts: data.counts,
      groups: data.groups,
      itemGroups,
      itemCount,
      blockCount,
      registrySummary,
    })
  }

  versions.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  await writeFile(
    path.join(OUT_ROOT, 'versions.json'),
    JSON.stringify({ latest: versions.at(-1)?.id ?? null, versions }),
  )
}

async function main() {
  await mkdir(CACHE, { recursive: true })

  log('拉取版本清单…')
  const manifest = await fetchJson(VERSION_MANIFEST)
  const versionId = versionArg ?? manifest.latest.release
  const entry = manifest.versions.find((v) => v.id === versionId)
  if (!entry) throw new Error(`版本不存在: ${versionId}`)
  log(`目标版本 ${versionId} (${entry.type})`)

  const versionJsonPath = path.join(CACHE, `${versionId}.json`)
  if (!(await exists(versionJsonPath))) {
    const meta = await fetchJson(entry.url)
    await writeFile(versionJsonPath, JSON.stringify(meta))
  }
  const meta = JSON.parse(await readFile(versionJsonPath, 'utf8'))

  const jarPath = path.join(CACHE, `client-${versionId}.jar`)
  if (!(await exists(jarPath))) {
    log(`下载 client.jar (${(meta.downloads.client.size / 1048576).toFixed(1)} MB)`)
    await download(meta.downloads.client.url, jarPath)
  } else {
    log('client.jar 已缓存')
  }

  const outDir = path.join(OUT_ROOT, versionId)
  const hasIndex = await exists(path.join(outDir, 'index.json'))
  // data 是后来才加入提取范围的，老输出里没有，需要重新解一次 jar
  const hasData = await exists(path.join(outDir, 'data', 'minecraft'))
  await mkdir(outDir, { recursive: true })

  let written = []
  if (hasIndex && hasData) {
    log('已有输出，跳过解压，仅补齐缺失对象')
  } else {
    log('解压 jar 内 assets…')
    written = await unzipJar(
      jarPath,
      outDir,
      (name) => KEEP_PREFIXES.some((p) => name.startsWith(p)) && langAllowed(name),
      'assets/minecraft/',
    )
    log(`  解出 ${written.length} 个文件`)
  }

  log('比对 asset index…')
  const indexPath = path.join(CACHE, `assets-${meta.assetIndex.id}.json`)
  if (!(await exists(indexPath))) await download(meta.assetIndex.url, indexPath)
  const assetIndex = JSON.parse(await readFile(indexPath, 'utf8'))

  // @why 只有 strip 后的路径才有 minecraft/ 对应关系，pack.mcmeta 等根文件不参与比对
  const jarSet = new Set(written.filter((p) => p.includes('/')).map((p) => `minecraft/${p}`))

  const missing = []
  for (const [key, value] of Object.entries(assetIndex.objects)) {
    if (!key.startsWith('minecraft/')) continue // icons / realms 由启动器使用，站点不需要
    if (jarSet.has(key)) continue
    if (!withSounds && key.startsWith('minecraft/sounds/')) continue
    if (!langAllowed(key)) continue
    const dest = path.join(outDir, key.replace(/^minecraft\//, ''))
    if (await exists(dest)) continue
    missing.push({ key, hash: value.hash, size: value.size })
  }

  const totalMb = missing.reduce((acc, m) => acc + m.size, 0) / 1048576
  log(`需从对象库补 ${missing.length} 个文件 (${totalMb.toFixed(1)} MB)`)

  await mapLimit(missing, CONCURRENCY, async ({ key, hash }) => {
    const rel = key.replace(/^minecraft\//, '')
    const dest = path.join(outDir, rel)
    const url = `${objectBase}/${hash.slice(0, 2)}/${hash}`
    await download(url, dest)
  })

  log('生成索引…')
  const index = await buildIndex(outDir, versionId)
  const mapped = await buildBlockIndex(outDir, versionId)
  log(`  纹理反查表 ${mapped} 条`)
  const itemCount = await buildItemRegistry(outDir, versionId)
  log(`  物品注册表 ${itemCount} 项`)
  const baked = await buildBlockModels(outDir, versionId)
  log(`  立体模型: 方块 ${baked.blocks} / 物品 ${baked.items}`)
  const registries = await buildRegistries(outDir, versionId)
  log(`  注册表 ${registries.length} 个: ${registries.map((r) => `${r.id}=${r.count}`).join(' ')}`)
  await writeVersionsManifest()
  log(`完成: ${path.relative(ROOT, outDir)}`)
  log(`  统计 ${JSON.stringify(index.counts)}`)
  log(`  分类 ${index.groups.map((g) => `${g.id}:${g.count}`).join(' ')}`)
}

main().catch((error) => {
  console.error('[mc] 失败:', error)
  process.exit(1)
})
