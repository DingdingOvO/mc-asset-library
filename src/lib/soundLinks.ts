/**
 * 关联音效：一个方块/物品/生物在游戏里到底发出什么声音。
 *
 * @why 素材站只给贴图和模型是不够的——把猪放进项目里，接着要的就是它的叫声。
 *      游戏里这层关系不在任何 json 里：方块的声音由代码里的 SoundType 决定，
 *      生物的叫声按 mob/<目录> 放，物品则常常根本没有自己的音效、
 *      只有"用它做某个动作"时的声音（挥剑、进食、装备）。
 *      所以这里不是拼字符串，而是三层解析：专用目录 → 通用材质 → 用途分类。
 *
 * @constraint 资源包里同时存在两套命名：新的 `block/<材质>/break1` 与
 *      遗留的扁平 `dig/<材质>N`、`step/<材质>N`。只按目录前缀匹配会漏掉后者，
 *      这是"橡木木板一个音效都没有"的根因。
 */
import type { Sound } from './mc'

export interface RelatedSound {
  /** 相对 sounds/ 的路径，不含 .ogg */
  path: string
  /** 声音名（末段） */
  name: string
  /** 用途标签：破坏 / 踩踏 / 叫声…… */
  label: string
  /**
   * 官方字幕中文名（subtitles.* 的中文翻译）。
   * @why 站点原来只显示 say1、step3 这种文件名，用户根本不知道听到的是什么。
   *      游戏自己的字幕就是最准确的说明，直接取用。
   */
  zh?: string
  /** 字幕对应的事件 id，如 entity.zombie.ambient */
  event?: string
}

type Kind = 'block' | 'item' | 'entity'

const normalize = (text: string) =>
  text
    .replace(/^minecraft:/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

/** 去过复数的 token：tentacles → tentacle，bodies → body */
const tokensOf = (text: string) =>
  normalize(text)
    .split('_')
    .filter(Boolean)
    .map((token) => (token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token))

/** `dig/stone3` → `stone`：文件名去掉结尾序号就是材质名 */
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\d+$/, '')

/* ------------------------------------------------------------------ 索引 */

interface Index {
  /** 目录 → 该目录下所有路径 */
  dirs: Map<string, string[]>
  /** block/ 下的目录名（可能带子级，如 creaking_heart/break） */
  blockDirs: string[]
  /** 路径 → 条目本身，取字幕名用 */
  byPath: Map<string, Sound>
}

const indexCache = new WeakMap<Sound[], Index>()

function indexOf(items: Sound[]): Index {
  const cached = indexCache.get(items)
  if (cached) return cached
  const dirs = new Map<string, string[]>()
  const blockDirs: string[] = []
  for (const item of items) {
    const cut = item.p.lastIndexOf('/')
    const dir = cut < 0 ? '' : item.p.slice(0, cut)
    const list = dirs.get(dir)
    if (list) list.push(item.p)
    else dirs.set(dir, [item.p])
    if (dir.startsWith('block/')) blockDirs.push(dir.slice(6))
  }
  const byPath = new Map<string, Sound>()
  for (const item of items) byPath.set(item.p, item)
  const index: Index = { dirs, blockDirs, byPath }
  indexCache.set(items, index)
  return index
}

/* -------------------------------------------------------------- 材质映射 */

/**
 * 方块 id → 通用材质音效。
 *
 * @why 方块 json 里没有 SoundType，那是 Java 侧写死的；只能按名字归类。
 *      顺序有意义：先匹配到的赢，`stone` 兜底必须放最后。
 */
const BLOCK_MATERIAL: [RegExp, string][] = [
  [/wool|carpet/, 'cloth'],
  [/coral/, 'coral'],
  [/gravel|ancient_debris/, 'gravel'],
  [/snow/, 'snow'],
  [
    /grass|leave|sapling|flower|bush|fern|petal|wheat|crop|carrot|potato|beetroot|melon|pumpkin|azalea|moss|root|mushroom|kelp|seagrass|lily|berry|cactus|sugar_cane|vine|nether_sprout|fungus|twisting|weeping|dripleaf|chorus/,
    'grass',
  ],
  [/dirt|mud|clay|farmland|path|mycelium|podzol|soul_soil|soul_sand|nylium/, 'wet_grass'],
  [
    /plank|log|wood|fence|gate|button|pressure_plate|door|trapdoor|sign|barrel|chest|table|bookshelf|shelf|scaffold|ladder|bamboo|campfire|lectern|composter|loom|cartography|fletching|smithing|grindstone|jukebox|beehive|hive|note_block|crafting|bed|banner/,
    'wood',
  ],
  [/sand|concrete_powder|suspicious/, 'sand'],
  [/.*/, 'stone'],
]

/**
 * 材质名与专用目录对不上时的显式修正。
 *
 * @why 丛林/绯红这类木板、门、栅栏的声音压在 nether_wood_* 里，
 *      末段 token 匹配命中不到；活塞放在 tile/piston（老路径，不在 block/ 下）。
 */
const BLOCK_ALIAS: [RegExp, string[]][] = [
  [/^(crimson|warped)_(button|door|fence|fence_gate|hanging_sign|sign|trapdoor)/, ['block/nether_wood_$2']],
  [/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo)_(button|door|fence|fence_gate|hanging_sign|sign|trapdoor)/, ['block/wooden_$2']],
  [/sticky_piston|^piston$/, ['tile/piston']],
  [/ender_chest/, ['block/enderchest']],
  [/^end_portal/, ['block/end_portal']],
  [/respawn_anchor/, ['block/respawn_anchor']],
]

/**
 * 没有 `block/` 目录、声音放在别处的方块。
 *
 * @why 玻璃的破碎声是 random/glass（和挖掘材质无关），音符盒是 note/*，
 *      史莱姆块的弹跳在 mob/slime 里——按名字怎么都推不出来。
 */
const BLOCK_SPECIAL: [RegExp, string[]][] = [
  [/glass|^beacon$/, ['random/glass', 'dig/stone']],
  [/^note_block$/, ['note/harp', 'note/bass', 'note/chime', 'note/bell']],
  [/slime_block/, ['mob/slime']],
  [/honey_block/, ['block/honeyblock']],
  [/^tnt$|^tnt_/, ['random/fuse']],
  [/anvil/, ['random/anvil_use', 'random/anvil_land']],
]

/** 太长会命中无意义的词：`grass_block` 的 block、`iron_ore` 的 ore */
const STOP_SUFFIX = new Set(['block', 'ore', 'stone', 'item', 'bricks'])

/* -------------------------------------------------------------- 物品分类 */

/**
 * 物品 id → 用它时听到的声音目录。
 *
 * @why 剑、镐、苹果在资源包里没有 `item/<名字>` 目录，它们的声音属于"动作"：
 *      挥砍走 entity/player/attack，采矿就是敲方块时那个材质声，进食走 random/eat。
 *      按用途归类比按名字匹配命中率高一个量级。
 */
const ITEM_RULES: [RegExp, string[]][] = [
  [/_(sword|swords)$/, ['entity/player/attack']],
  [/_(pickaxe)$/, ['dig/stone']],
  [/_axe$/, ['item/axe']],
  [/_shovel$/, ['item/shovel']],
  [/_hoe$/, ['item/hoe']],
  [/^(bow|arrow|spectral_arrow|tipped_arrow)$|_arrow$/, ['random/bow', 'random/bowhit']],
  [/crossbow/, ['item/crossbow']],
  [/trident/, ['item/trident']],
  [/mace/, ['item/mace']],
  [/shield/, ['item/shield']],
  [/bucket/, ['item/bucket']],
  [/potion|bottle/, ['item/bottle']],
  [/elytra/, ['item/elytra']],
  [/spyglass/, ['item/spyglass']],
  [/goat_horn/, ['item/goat_horn']],
  [/brush/, ['item/brush']],
  [/bundle/, ['item/bundle']],
  [/honeycomb/, ['item/honeycomb']],
  [/(glow_)?ink_sac/, ['item/ink_sac']],
  [/totem/, ['item/totem']],
  [/^bone_meal$/, ['item/bonemeal']],
  [/^(book|writable_book|written_book|knowledge_book|enchanted_book)$/, ['item/book']],
  [/_dye$/, ['item/dye']],
  [/sweet_berries|glow_berries/, ['item/sweet_berries']],
  [/spear/, ['item/spear']],
  // 实体形态的物品（矿车、盔甲架、画）声音在实体目录里
  [/cushion/, ['entity/cushion']],
  [/armor_stand/, ['entity/armorstand']],
  [/painting/, ['entity/painting']],
  [/ender_eye/, ['entity/endereye']],
  [/minecart/, ['minecart']],
  [/fishing_rod/, ['entity/bobber']],
  [/item_frame/, ['entity/itemframe']],
  [/^lead$/, ['entity/leashknot']],
  [/firework/, ['fireworks']],
  [/^end_crystal$/, ['random/explode']],
  [/^music_disc_/, ['records']],
  [/^wind_charge$/, ['entity/wind_charge']],
  [/^ender_pearl$/, ['random/bow']],
  [/cocoa_beans|pitcher_pod|^sugar$/, ['item/plant', 'random/pop']],
  [/_helmet$|_chestplate$|_leggings$|_boots$|^turtle_helmet$|^elytra$/, ['item/armor/equip']],
  [/_boat$|_raft$|^boat$/, ['entity/boat']],
  [/seed|sapling|^fern$|_flower$|^vine$|^lily_pad$|^cactus$|^bamboo$/, ['item/plant']],
  [
    /apple|bread|cooked_|raw_|_beef$|_porkchop$|_mutton$|_chicken$|_rabbit$|_cod$|_salmon$|_fish$|carrot|potato|beetroot|cookie|cake|pie|stew|soup|melon_slice|_berries$|^chorus_fruit$|^honey_bottle$|^dried_kelp$|^pumpkin_pie$|^mushroom_stew$|^golden_apple$/,
    ['random/eat', 'random/burp'],
  ],
]

/** 兜底：拿起来/放置的通用声，比什么都不显示强 */
const ITEM_FALLBACK = ['random/pop']

/* -------------------------------------------------------------- 生物别名 */
/**
 * 生物 id → 声音目录。
 *
 * @why 猪、牛、羊这些 id 和目录同名，但雪傀儡是 mob/snowman、岩浆怪是 mob/magmacube、
 *      恶魂的 shriek 在 mob/ghastling，光靠 token 匹配会错配到 mob/cow/moody 这类子目录。
 */
const ENTITY_ALIAS: Record<string, string[]> = {
  snow_golem: ['mob/snowman', 'entity/snowman'],
  iron_golem: ['mob/irongolem'],
  magma_cube: ['mob/magmacube'],
  ender_dragon: ['mob/enderdragon'],
  enderman: ['mob/endermen'],
  evoker: ['mob/evocation_illager'],
  vindicator: ['mob/vindication_illager'],
  illusioner: ['mob/illusion_illager'],
  elder_guardian: ['mob/guardian'],
  wandering_trader: ['mob/wandering_trader'],
  trader_llama: ['mob/llama'],
  zombified_piglin: ['mob/zombified_piglin'],
  glow_squid: ['mob/glow_squid'],
  skeleton_horse: ['mob/horse/skeleton'],
  zombie_horse: ['mob/horse/zombie'],
  donkey: ['mob/horse/donkey'],
  mule: ['mob/horse/donkey'],
  mooshroom: ['mob/mooshroom', 'mob/cow'],
  minecart: ['minecart'],
  painting: ['entity/painting'],
  item_frame: ['entity/itemframe'],
  glow_item_frame: ['entity/itemframe'],
  armor_stand: ['entity/armorstand', 'entity/armor_stand'],
  leash_knot: ['entity/leashknot'],
  eye_of_ender: ['entity/endereye'],
  wind_charge: ['entity/wind_charge'],
  shulker_bullet: ['entity/shulker_bullet'],
  fishing_bobber: ['entity/bobber'],
  experience_orb: ['random/orb'],
  item: ['random/pop'],
  tnt: ['random/fuse'],
  firework_rocket: ['fireworks'],
  arrow: ['random/bowhit'],
  copper_golem: ['mob/coppergolem'],
}

/**
 * 按后缀归类：船/矿车/箭这些实体 id 有几十个变体，逐个写死不如认后缀。
 */
const ENTITY_PATTERN: [RegExp, string[]][] = [
  [/_minecart$/, ['minecart']],
  [/_boat$|_raft$|^boat$/, ['entity/boat']],
  [/^(cod|salmon|tropical_fish|pufferfish|tadpole)$/, ['entity/fish']],
  [/^arrow$|_arrow$/, ['random/bowhit']],
  [/^experience_orb$/, ['random/orb']],
  [/^item$/i, ['random/pop']],
  [/^end_crystal$/, ['random/explode']],
  [/^music_disc_/, ['records']],
  [/^wind_charge$/, ['entity/wind_charge']],
  [/^ender_pearl$/, ['random/bow']],
  [/^ender_pearl$|^snowball$/, ['random/bow']],
  [/^polar_bear$|_bear$/, ['mob/polarbear', 'mob/polarbear_baby']],
  [/^giant$/, ['mob/zombie']],
  [/^killer_bunny$/, ['mob/rabbit']],
  [/potion|experience_bottle/, ['item/bottle']],
  [/^lightning_bolt$/, ['ambient/weather']],
  [/^falling_block/, ['dig/stone']],
  [/^evoker_fangs$/, ['mob/evocation_illager']],
]

/* ---------------------------------------------------------------- 解析 */

function pushUnique(out: string[], seen: Set<string>, path: string) {
  if (seen.has(path)) return
  seen.add(path)
  out.push(path)
}

function pushAll(out: string[], seen: Set<string>, paths: string[] | undefined) {
  if (!paths) return
  for (const path of paths) pushUnique(out, seen, path)
}

/**
 * 按 spec 收文件。spec 有两种形态：
 * - `block/chest`  —— 整个目录都在里面
 * - `dig/wood`、`random/eat` —— 目录是 `dig`、`random`，只取文件名去序号后等于/前缀为 `wood`、`eat` 的
 *
 * @why 资源包把 `dig/wood1`、`random/eat1` 这种老式扁平文件和新式
 *      `block/chest/open.ogg` 混在一起放，不统一寻址就会出现"木板零个音效"。
 */
function pushSpec(index: Index, out: string[], seen: Set<string>, spec: string) {
  const whole = index.dirs.get(spec)
  if (whole) {
    pushAll(out, seen, whole)
    return
  }
  const cut = spec.lastIndexOf('/')
  if (cut < 0) return
  const dir = spec.slice(0, cut)
  const name = spec.slice(cut + 1)
  for (const path of index.dirs.get(dir) ?? []) {
    const base = baseOf(path)
    if (base === name || base.startsWith(`${name}_`)) pushUnique(out, seen, path)
  }
}

function blockSound(index: Index, id: string, out: string[], seen: Set<string>) {
  // ① 显式修正
  for (const [pattern, specs] of BLOCK_ALIAS) {
    const hit = pattern.exec(id)
    if (!hit) continue
    for (const raw of specs) pushSpec(index, out, seen, raw.replace('$2', hit[2] ?? ''))
    if (out.length) return
  }

  // ② 没有 block/ 目录、声音藏在别的树里（玻璃在 random/glass、音符盒在 note/）
  for (const [pattern, specs] of BLOCK_SPECIAL) {
    if (!pattern.test(id)) continue
    for (const spec of specs) pushSpec(index, out, seen, spec)
    if (out.length) return
  }

  // ③ 最长后缀命中专用目录：waxed_copper_grate → copper_grate
  const parts = tokensOf(id)
  for (let start = 0; start < parts.length; start += 1) {
    const key = parts.slice(start).join('_')
    if (key.length < 3 || STOP_SUFFIX.has(key)) continue
    if (index.dirs.has(`block/${key}`)) {
      pushSpec(index, out, seen, `block/${key}`)
      return
    }
  }

  // ④ 材质词在前面：amethyst_block → amethyst、copper_grate → copper
  for (const token of parts) {
    if (token.length < 4) continue
    if (index.dirs.has(`block/${token}`)) {
      pushSpec(index, out, seen, `block/${token}`)
      return
    }
  }

  // ⑤ 通用材质：dig 是破坏/放置，step 是踩踏
  const material = BLOCK_MATERIAL.find(([pattern]) => pattern.test(id))?.[1] ?? 'stone'
  pushSpec(index, out, seen, `dig/${material}`)
  pushSpec(index, out, seen, `step/${material}`)
}

function itemSound(index: Index, id: string, out: string[], seen: Set<string>) {
  for (const [pattern, specs] of ITEM_RULES) {
    if (!pattern.test(id)) continue
    for (const spec of specs) pushSpec(index, out, seen, spec)
    if (out.length) return
  }
  // 放不了、也没有专用动作声的物品（纸、木棍、红石粉……）退回通用拾取声
  for (const spec of ITEM_FALLBACK) pushSpec(index, out, seen, spec)
}

function entitySound(index: Index, id: string, out: string[], seen: Set<string>) {
  const patterns = ENTITY_PATTERN.filter(([pattern]) => pattern.test(id)).flatMap(([, specs]) => specs)
  const direct = [`mob/${id}`, `entity/${id}`, ...(ENTITY_ALIAS[id] ?? []), ...patterns]
  for (const spec of direct) pushSpec(index, out, seen, spec)
  // 叫声压在子目录里（mob/wolf/angry、mob/cat/ocelot）：同名录下的全部收下
  for (const dir of direct) {
    const prefix = `${dir}/`
    for (const [key, paths] of index.dirs) {
      if (key.startsWith(prefix)) pushAll(out, seen, paths)
    }
  }
  if (out.length) return
  // 最后按 token 碰一碰：mob/zombie_villager 之类的复合名
  const want = new Set(tokensOf(id))
  for (const [key, paths] of index.dirs) {
    if (!key.startsWith('mob/') && !key.startsWith('entity/')) continue
    const dirTokens = new Set(tokensOf(key.split('/').pop() ?? ''))
    if (![...want].some((token) => dirTokens.has(token))) continue
    pushAll(out, seen, paths)
    if (out.length > 8) return
  }
}

/* ---------------------------------------------------------------- 标签 */

/** `random/` 与 `note/` 里的文件名本身就是用途，单独认一下 */
const RANDOM_LABEL: [RegExp, string][] = [
  [/^glass/, '破碎'],
  [/^bow/, '射击'],
  [/^eat|^burp|^drink/, '进食 / 饮用'],
  [/^pop/, '拾取'],
  [/^click/, '点击'],
  [/^anvil/, '铁砧'],
  [/^break/, '破坏'],
  [/^explode/, '爆炸'],
  [/^fuse/, '点燃'],
  [/^orb/, '经验球'],
]

const labelOf = (path: string): string => {
  const dir = path.slice(0, path.lastIndexOf('/'))
  const name = baseOf(path)
  if (dir === 'dig') return '破坏 / 放置'
  if (dir === 'step') return '踩踏'
  if (dir === 'random') return RANDOM_LABEL.find(([pattern]) => pattern.test(name))?.[1] ?? '通用'
  if (dir === 'note') return '音符'
  if (dir === 'tile/piston') return '伸缩'
  if (dir.startsWith('block/')) {
    if (/break|dig/.test(name)) return '破坏'
    if (/place/.test(name)) return '放置'
    if (/step/.test(name)) return '踩踏'
    if (/hit/.test(name)) return '敲击'
    if (/fall|land/.test(name)) return '落地'
    if (/open|close|fence/.test(name)) return '开合'
    if (/chime|resonate/.test(name)) return '共鸣'
    if (name === dir.slice(6).split('/').pop()) return '材质音效'
    return '方块'
  }
  if (/^(say|ambient|idle|call|voice)/.test(name)) return '叫声'
  if (/^step|^walk/.test(name)) return '脚步'
  if (/^hurt|^death/.test(name)) return '受伤 / 死亡'
  if (/^attack|^bite/.test(name)) return '攻击'
  if (dir.startsWith('entity/player/attack')) return '挥砍'
  if (dir.startsWith('item/armor')) return '穿戴'
  if (dir.startsWith('item/')) return '使用'
  return '音效'
}

/**
 * 与某个对象关联的音效。
 * @param id 注册 id，带不带命名空间都行
 */
export function relatedSounds(items: Sound[], kind: Kind, id: string): RelatedSound[] {
  const index = indexOf(items)
  const key = normalize(id)
  const paths: string[] = []
  const seen = new Set<string>()
  if (kind === 'block') blockSound(index, key, paths, seen)
  else if (kind === 'item') itemSound(index, key, paths, seen)
  else entitySound(index, key, paths, seen)

  /**
   * @why 一个目录里三十多个文件，字母序第一个常常是 hurt 或 death——
   *      用户点开一只僵尸，最想听的是它"叫一声"，不是它怎么死。
   */
  const weight = (sound: RelatedSound) => {
    if (kind === 'entity') {
      if (/^(say|ambient|idle|call)/.test(sound.name)) return 0
      if (/^hurt/.test(sound.name)) return 2
      if (/^(death|attack|hit)/.test(sound.name)) return 3
      return 1
    }
    if (kind === 'block') return /^step/.test(sound.name) ? 1 : 0
    return 0
  }
  /**
   * @constraint 不在这里截断：查看全部要能真的看到全部。
   *      折叠交给界面做，数据层截断等于把「全部」变成一句空话。
   */
  return paths
    .map((path) => {
      const meta = index.byPath.get(path)
      return {
        path,
        name: path.slice(path.lastIndexOf('/') + 1),
        label: labelOf(path),
        zh: meta?.s,
        event: meta?.e,
      }
    })
    .map((sound, order) => ({ sound, order }))
    .sort((a, b) => weight(a.sound) - weight(b.sound) || a.order - b.order)
    .map((entry) => entry.sound)
}
