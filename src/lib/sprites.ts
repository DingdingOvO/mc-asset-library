import { textureSrc } from './mc'

/**
 * GUI sprite 加载与缓存。
 *
 * @why 原版 26.3 把界面拆成了一张张小图（`textures/gui/sprites/**`），
 *      `blitSprite` 按名字取。容器里的火焰、气泡、信标按钮都是这种 sprite，
 *      尺寸各不相同，只能按需加载，不能像背景那样一次贴一整张。
 */

const images = new Map<string, HTMLImageElement>()
const pending = new Map<string, Promise<HTMLImageElement | null>>()

/**
 * sprite 名 → 站点资源路径。
 * @constraint `mob_effect/` 是例外：它不在 gui/sprites 下，而是顶层
 *      textures/mob_effect/。信标按钮的效果图标走这条。
 */
export function spritePath(version: string, name: string): string {
  if (name.startsWith('mob_effect/')) {
    return textureSrc(version, name)
  }
  return textureSrc(version, `gui/sprites/${name}`)
}

export function loadSprite(version: string, name: string): Promise<HTMLImageElement | null> {
  const key = `${version}|${name}`
  const hit = images.get(key)
  if (hit) return Promise.resolve(hit)
  const running = pending.get(key)
  if (running) return running

  const task = new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image()
    image.onload = () => {
      images.set(key, image)
      pending.delete(key)
      resolve(image)
    }
    image.onerror = () => {
      // @constraint 失败也要落缓存：否则每次重绘都重发一次 404 请求，
      //      一个缺图就能把网络面板刷满。
      pending.delete(key)
      resolve(null)
    }
    image.src = spritePath(version, name)
  })
  pending.set(key, task)
  return task
}

/** 已经加载好的 sprite；没有就返回 null，调用方跳过这一层 */
export function spriteOf(version: string, name: string): HTMLImageElement | null {
  return images.get(`${version}|${name}`) ?? null
}

/**
 * 批量预载，返回缺少的名单。
 * @why 动态层是同步绘制的（一帧内要画完），必须先攒齐再画，否则第一帧
 *      火焰会缺一块，要等下次参数变化才补上。
 */
export async function preloadSprites(version: string, names: string[]): Promise<string[]> {
  const unique = [...new Set(names)]
  const results = await Promise.all(unique.map((name) => loadSprite(version, name).then((img) => ({ name, ok: !!img }))))
  return results.filter((item) => !item.ok).map((item) => item.name)
}
