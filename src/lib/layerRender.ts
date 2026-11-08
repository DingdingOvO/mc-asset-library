import type { ContainerDef, ContainerLayer, ParamValue } from './containers'
import { drawText, textWidth, type GlyphFont } from './font'

/**
 * 动态层绘制：容器界面上随状态变化的部分。
 *
 * @why 显示与导出必须共用这一份。之前熔炉的火焰只在游戏里有，站点上是静止的
 *      背景图；做视频的人截出来的熔炉永远在烧一半，跟自己搭的场景对不上。
 *      两处各写一遍必然漂移，所以只留一个入口。
 */

export interface LayerDeps {
  font: GlyphFont | null
  lang: 'zh' | 'en'
  /** 节点参数，缺省时回落到 def.controls 的 default */
  params: Record<string, ParamValue>
  /** 同步取已加载的 sprite；未加载时返回 null，该层跳过 */
  getSprite: (name: string) => HTMLImageElement | null
}

/** 容器声明过的全部 sprite，供预载 */
export function layerSprites(def: ContainerDef): string[] {
  const out: string[] = []
  for (const layer of def.layers) {
    if (layer.kind === 'progress' || layer.kind === 'sprite' || layer.kind === 'select') {
      out.push(layer.sprite)
      if (layer.kind === 'sprite' && layer.unset) out.push(layer.unset)
    }
    if (layer.kind === 'effect-button') {
      out.push(
        'container/beacon/button',
        'container/beacon/button_disabled',
        'container/beacon/button_selected',
        `mob_effect/${layer.effect}`,
      )
    }
    if (layer.kind === 'enchant-row') {
      const n = layer.row + 1
      out.push(
        'container/enchanting_table/enchantment_slot',
        'container/enchanting_table/enchantment_slot_disabled',
        `container/enchanting_table/level_${n}`,
        `container/enchanting_table/level_${n}_disabled`,
      )
    }
  }
  return out
}

/** 参数解析：节点值优先，缺失回落到控件默认值 */
export function paramOf(def: ContainerDef, params: Record<string, ParamValue>, key: string): ParamValue {
  const own = params[key]
  if (own !== undefined) return own
  const control = def.controls.find((item) => item.key === key)
  return control ? control.default : 0
}

const num = (value: ParamValue) => (typeof value === 'number' ? value : Number(value) || 0)
const bool = (value: ParamValue) => (typeof value === 'boolean' ? value : num(value) !== 0)

/**
 * 进度条的像素长度。
 *
 * @constraint 不能用 `value * scale` 直接取整。原版是 `Mth.ceil(v*13)+1`：
 *      ceil 让进度刚过 0 就出现 1 像素，+1 是火焰根部那一行。用 round 会让
 *      刚开始烧的熔炉看起来完全没亮，用 floor 会永远少一像素。
 */
function progressLength(layer: Extract<ContainerLayer, { kind: 'progress' }>, value: ParamValue): number {
  const limit = layer.max ?? (layer.axis === 'x' ? layer.w : layer.h)
  if (layer.table) {
    const index = Math.max(0, Math.min(layer.table.length - 1, Math.round(num(value) * (layer.table.length - 1))))
    return Math.max(0, Math.min(limit, layer.table[index] ?? 0))
  }
  const raw = Math.ceil(num(value) * (layer.scale ?? limit)) + (layer.offset ?? 0)
  return Math.max(0, Math.min(limit, raw))
}

export function paintLayers(
  ctx: CanvasRenderingContext2D,
  def: ContainerDef,
  deps: LayerDeps,
): void {
  for (const layer of def.layers) {
    switch (layer.kind) {
      case 'progress': {
        if (layer.when && !bool(paramOf(def, deps.params, layer.when))) break
        const image = deps.getSprite(layer.sprite)
        if (!image) break
        const length = progressLength(layer, paramOf(def, deps.params, layer.value))
        if (length <= 0) break
        if (layer.axis === 'x') {
          // 横向：从左侧裁，align=end 时贴右边
          const sx = layer.align === 'end' ? layer.w - length : 0
          const dx = layer.align === 'end' ? layer.x + layer.w - length : layer.x
          ctx.drawImage(image, sx, 0, length, layer.h, dx, layer.y, length, layer.h)
        } else {
          // 纵向：从底部裁（火焰、气泡都是往上长的），align=end 时贴下边
          const sy = layer.align === 'end' ? layer.h - length : 0
          const dy = layer.align === 'end' ? layer.y + layer.h - length : layer.y
          ctx.drawImage(image, 0, sy, layer.w, length, layer.x, dy, layer.w, length)
        }
        break
      }

      case 'sprite': {
        if (layer.when && !bool(paramOf(def, deps.params, layer.when))) break
        if (layer.value !== undefined && layer.unset) {
          const on = bool(paramOf(def, deps.params, layer.value))
          const image = deps.getSprite(on ? layer.sprite : layer.unset)
          if (image) ctx.drawImage(image, layer.x, layer.y, layer.w, layer.h)
          break
        }
        const image = deps.getSprite(layer.sprite)
        if (image) ctx.drawImage(image, layer.x, layer.y, layer.w, layer.h)
        break
      }

      case 'effect-button': {
        const levels = num(paramOf(def, deps.params, 'levels'))
        // @constraint 按钮可用的条件是 tier < levels，不是 <=：信标 2 级
        //      （levels=2）时第 3 排（tier=2）仍然是灰的，这是源码里的严格小于。
        const active = layer.tier < levels
        const selected = paramOf(def, deps.params, layer.slot) === layer.effect
        const name = !active
          ? 'container/beacon/button_disabled'
          : selected
            ? 'container/beacon/button_selected'
            : 'container/beacon/button'
        const frame = deps.getSprite(name)
        if (frame) ctx.drawImage(frame, layer.x, layer.y, 22, 22)
        // extractIcon 无条件画图标，灰按钮上也有，只是底色不同
        const icon = deps.getSprite(`mob_effect/${layer.effect}`)
        if (icon) ctx.drawImage(icon, layer.x + 2, layer.y + 2, 18, 18)
        break
      }

      case 'enchant-row': {
        const levels = num(paramOf(def, deps.params, 'levels'))
        const usable = layer.row < levels
        const slot = deps.getSprite(
          usable
            ? 'container/enchanting_table/enchantment_slot'
            : 'container/enchanting_table/enchantment_slot_disabled',
        )
        if (slot) ctx.drawImage(slot, layer.x, layer.y, layer.w, layer.h)
        const n = layer.row + 1
        const badge = deps.getSprite(`container/enchanting_table/level_${n}${usable ? '' : '_disabled'}`)
        if (badge) ctx.drawImage(badge, layer.x + 1, layer.y + 1, 16, 16)
        break
      }

      case 'text': {
        if (!deps.font) break
        const text = deps.lang === 'zh' ? (layer.textZh ?? layer.text) : (layer.textEn ?? layer.text)
        const width = textWidth(deps.font, stripCodes(text))
        // centeredText 是「以 cx 为中心」，不是起点
        drawText(ctx, deps.font, stripCodes(text), layer.cx - width / 2, layer.y, '#e0e0e0', true)
        break
      }

      case 'cost': {
        if (!deps.font) break
        const cost = num(paramOf(def, deps.params, layer.value))
        if (cost <= 0) break
        const expensive = cost >= 40
        const template = deps.lang === 'zh'
          ? (expensive ? layer.expensiveZh : layer.costZh)
          : (expensive ? layer.expensiveEn : layer.costEn)
        // 原版是 Component.translatable("container.repair.cost", cost)，%1$s 是占位
        const text = stripCodes(String(template).replace('%1$s', String(cost)))
        const width = textWidth(deps.font, text)
        const left = layer.right - 2 - width
        ctx.fillStyle = 'rgba(0, 0, 0, 0.31)'
        ctx.fillRect(left - 2, layer.y - 2, layer.right - left + 2, 12)
        drawText(ctx, deps.font, text, left, layer.y, expensive ? '#ff6060' : '#80ff20', true)
        break
      }

      case 'select': {
        const image = deps.getSprite(layer.sprite)
        if (!image) break
        const slot = num(paramOf(def, deps.params, layer.value))
        ctx.drawImage(image, layer.x + slot * layer.step, layer.y, layer.w, layer.h)
        break
      }
    }
  }
}

/**
 * 去掉 § 格式码。
 * @why 本地化文本里带 `§a` 这类颜色码，位图字体没有对应字形，会画成 '?'
 *      或者干脆错位。颜色由层自己决定，格式码在这里没有意义。
 */
export function stripCodes(text: string): string {
  return text.replace(/§./g, '')
}

/** 节点的默认参数，用于新建容器 */
export function defaultParams(def: ContainerDef): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {}
  for (const control of def.controls) out[control.key] = control.default
  return out
}


/**
 * 画标题、"物品栏"、村民的 "Trades"。
 *
 * @why 显示与导出共用这一份，而且逐条按 def.labelSpec 画——不同屏幕画的
 *      行数不一样，靠一个布尔量区分「有没有标签」是不够的。
 */
export function paintLabels(
  ctx: CanvasRenderingContext2D,
  def: ContainerDef,
  font: GlyphFont | null,
  lang: 'zh' | 'en',
): void {
  if (!font) return
  for (const spec of def.labelSpec) {
    const raw =
      spec.src === 'title'
        ? lang === 'zh'
          ? def.titleTextZh || def.titleText
          : def.titleText
        : spec.src === 'label'
          ? lang === 'zh'
            ? def.labelTextZh || def.labelText
            : def.labelText
          : lang === 'zh'
            ? def.tradesTextZh || def.tradesText
            : def.tradesText
    const text = stripCodes(raw ?? '')
    if (!text) continue
    const x = spec.align === 'center' ? (spec.cx ?? 0) - textWidth(font, text) / 2 : (spec.x ?? 0)
    drawText(ctx, font, text, x, spec.y ?? 0, '#404040')
  }
}
