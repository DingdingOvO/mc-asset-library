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
 * @constraint 排序只能在**同一条目集合内**重排，不能丢条目。创造栏表是早于
 *      当前版本反编译出来的，会有几十个新物品不在任何一页里；把它们塞进
 *      「未分类」而不是丢弃，页面至少能看到全量。
 */
import { readFile, writeFile } from 'node:fs/promises'
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
      label: '未分类',
      count: counts.misc,
      cover: GROUP_COVERS.misc,
    })
  }

  await writeFile(itemsFile, JSON.stringify({ ...data, groups, items }))
  return true
}
