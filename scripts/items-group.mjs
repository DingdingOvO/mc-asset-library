/**
 * 用创造栏数据回填物品分组与顺序。
 *
 * @why `items.json` 由 fetch-assets 生成，而那张表只有在**跑过完整素材提取**时
 *      才读得到 creativetabs.json。CI 复用已入库的 `items.json`，于是里面的
 *      `g` 只剩 `building_blocks` / `misc` 两个值、`groups` 只剩 misc 一项：
 *      物品页顶部只有「全部 / 未分类」，而「未分类」写着 527 项——实际有 1658 项，
 *      剩下的 1130 项被标成 building_blocks 却没有任何入口能筛到它们。
 *      点 `/items/colored_blocks` 这类链接也只会看到一个筛空的页面。
 *
 * @constraint 必须幂等。每次部署都从 creativetabs.json 重算，不依赖
 *      `items.json` 上一轮是什么状态——否则修好一次、下次又被 stale 数据覆盖。
 *
 * @constraint 排序只能在**同一条目集合内**重排，不能丢条目。注册表里有几十
 *      个条目根本不在创造栏：`air`、只靠命令拿到的隐藏方块、以及同一个物品
 *      的不同数据组件形态（药水、附魔书、带宝藏地图的 `filled_map`）。
 *      它们集中放最后一组并如实标成「创造栏外」，而不是含糊的「未分类」——
 *      后者让人以为分类没做完。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 分组封面。
 * @why 分类 chip 上要有一张小图标；按 tab id 点名比取"该分类第一个物品"稳定，
 *      后者会随版本变化在钻石剑和木剑之间跳。
 */
const GROUP_COVERS = {
  building_blocks: 'block/stone',
  colored_blocks: 'block/white_wool',
  natural_blocks: 'block/oak_log',
  functional_blocks: 'block/crafting_table',
  redstone_blocks: 'item/redstone',
  tools_and_utilities: 'item/diamond_pickaxe',
  combat: 'item/diamond_sword',
  food_and_drinks: 'item/apple',
  ingredients: 'item/iron_ingot',
  spawn_eggs: 'item/creeper_spawn_egg',
  op_blocks: 'block/command_block',
  misc: 'item/stick',
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 少数物品的图标不是「一张静态图」。
 *
 * @why 罗盘、时钟是 32 帧动画，`item/compass.png` 根本不存在，只有
 *      `compass_00.png` 起的一串；盾牌走特殊渲染，图标用的是
 *      `entity/shield/base`。不修的话这几种物品在列表里是**空白卡片**——
 *      图片 404 后 onError 把 img 隐藏，卡片只剩名字。
 *      优先取动画首帧，其次特例表，都不中就把 `i` 清空，
 *      让页面干脆不请求，而不是每个页面刷一条 404。
 */
const ICON_FALLBACKS = {
  shield: 'entity/shield/base',
}

/**
 * 原地修正所有带图标的表的路径。`.png` 是否真的存在由分发目录决定。
 *
 * @why 同一份数据被物品页、方块页、注册表页共用，修一处不修另一处会出现
 *      「物品页好了、数据页还在刷 404」。`items.json` 与
 *      `registries/*.json` 的条目结构一致（都有 id/n/i），走同一条修复。
 *
 * @return 修掉的条数
 */
export async function normalizeIcons(mcDir) {
  const texRoot = path.join(mcDir, 'textures')
  if (!existsSync(texRoot)) return 0

  const has = (name) => name && existsSync(path.join(texRoot, `${name}.png`))
  const fix = (entry) => {
    if (entry.i === undefined || has(entry.i)) return false
    const candidates = [`${entry.i}_00`, `item/${entry.id}`, `block/${entry.id}`, ICON_FALLBACKS[entry.id]]
    entry.i = candidates.find(has) ?? ''
    return true
  }

  let fixed = 0
  const itemFile = path.join(mcDir, 'items.json')
  const items = await readJson(itemFile)
  if (items?.items) {
    let touched = 0
    for (const entry of items.items) if (fix(entry)) touched += 1
    if (touched > 0) {
      await writeFile(itemFile, JSON.stringify(items))
      fixed += touched
    }
  }

  const regDir = path.join(mcDir, 'registries')
  if (existsSync(regDir)) {
    const { readdir } = await import('node:fs/promises')
    for (const name of await readdir(regDir)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(regDir, name)
      const table = await readJson(file)
      if (!table?.entries) continue
      let touched = 0
      for (const entry of table.entries) if (fix(entry)) touched += 1
      if (touched > 0) {
        await writeFile(file, JSON.stringify(table))
        fixed += touched
      }
    }
  }
  return fixed
}

/**
 * 原地修正 `items.json`。
 *
 * @return 是否真的改写过；没有创造栏数据时保持原样，让部署继续。
 */
export async function normalizeItemGroups(mcDir) {
  const tabsFile = path.join(mcDir, 'creativetabs.json')
  const itemsFile = path.join(mcDir, 'items.json')
  const tabData = await readJson(tabsFile)
  const data = await readJson(itemsFile)
  const tabs = tabData?.tabs ?? []
  const items = data?.items ?? []
  if (tabs.length === 0 || items.length === 0) return false

  const tabOf = new Map()
  const orderOf = new Map()
  const rankOf = new Map()
  for (const [rank, tab] of tabs.entries()) {
    rankOf.set(tab.id, rank)
    const ids = tab.items ?? []
    ids.forEach((id, index) => {
      // @why 同一物品会出现在多页（木板既在建筑也在自然）。取第一次出现，
      //      这样列表里只有一条，不会在切换分类时看到重复项。
      if (tabOf.has(id)) return
      tabOf.set(id, tab.id)
      orderOf.set(id, index)
    })
  }

  for (const item of items) {
    const tab = tabOf.get(item.id)
    item.g = tab ?? 'misc'
    item.o = orderOf.get(item.id) ?? 9999
  }

  items.sort((a, b) => {
    const ra = rankOf.get(a.g) ?? 99
    const rb = rankOf.get(b.g) ?? 99
    if (ra !== rb) return ra - rb
    if (a.o !== b.o) return a.o - b.o
    return a.id.localeCompare(b.id)
  })

  const counts = {}
  for (const item of items) counts[item.g] = (counts[item.g] ?? 0) + 1

  const groups = tabs
    .map((tab) => ({
      id: tab.id,
      label: tab.label,
      count: counts[tab.id] ?? 0,
      cover: GROUP_COVERS[tab.id] ?? items.find((item) => item.g === tab.id)?.i ?? null,
    }))
    .filter((group) => group.count > 0)

  if (counts.misc) {
    groups.push({
      id: 'misc',
      label: '创造栏外',
      count: counts.misc,
      cover: GROUP_COVERS.misc,
    })
  }

  await writeFile(itemsFile, JSON.stringify({ ...data, groups, items }))
  return true
}
