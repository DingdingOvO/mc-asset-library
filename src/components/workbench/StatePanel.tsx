import { useState } from 'react'
import type { ContainerControl, ContainerDef, EffectName } from '@/lib/containers'
import type { ContainerNode } from '@/lib/workspace'

/**
 * 选中容器的状态面板。
 *
 * @why 控件由 def.controls 生成，不是为每个容器手写一份表单。数据层已经声明了
 *      这个容器有哪些可变项（熔炉的燃烧进度、信标的等级与主副效果），界面照着
 *      渲染即可；新增容器时不用再改前端。
 */
export function StatePanel({
  node,
  def,
  effects,
  lang,
  onChange,
  onClose,
}: {
  node: ContainerNode
  def: ContainerDef
  effects: Map<string, EffectName>
  lang: 'zh' | 'en'
  onChange: (key: string, value: number | boolean | string) => void
  onClose: () => void
}) {
  const value = (control: ContainerControl) => node.params[control.key] ?? control.default
  /**
   * @why 手机上默认收起：展开后控件占掉 280px，物品区直接被挤到屏幕外，
   *      选个东西要滚半天。桌面上画布够高，默认展开省一次点击。
   */
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 900)

  return (
    <div className="state" onPointerDown={(event) => event.stopPropagation()}>
      <div className="state__head">
        <button
          type="button"
          className="state__toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span className="state__title">{def.name} · 状态</span>
          <span className="state__chevron">{open ? '收起' : `${def.controls.length} 项`}</span>
        </button>
        <button type="button" className="state__close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>
      {open && def.controls.length === 0 && <p className="state__hint">这个容器没有可调状态</p>}
      {!open && null}
      {open && def.controls.map((control) => {
        if (control.type === 'bool') {
          const on = Boolean(value(control))
          return (
            <label key={control.key} className="state__row state__row--check">
              <input
                type="checkbox"
                checked={on}
                onChange={(event) => onChange(control.key, event.target.checked)}
              />
              <span>{control.label}</span>
            </label>
          )
        }
        if (control.type === 'effect') {
          const current = String(value(control))
          return (
            <label key={control.key} className="state__row">
              <span className="state__label">{control.label}</span>
              <select
                className="state__select"
                value={current}
                onChange={(event) => onChange(control.key, event.target.value)}
              >
                {[...effects.values()].map((effect) => (
                  <option key={effect.id} value={effect.id}>
                    {lang === 'zh' ? effect.zh : effect.en}
                  </option>
                ))}
              </select>
            </label>
          )
        }
        if (control.type === 'int') {
          const current = Number(value(control))
          return (
            <label key={control.key} className="state__row">
              <span className="state__label">{control.label}</span>
              <input
                className="state__range"
                type="range"
                min={control.min}
                max={control.max}
                step={1}
                value={current}
                onChange={(event) => onChange(control.key, Number(event.target.value))}
              />
              <span className="state__value">{current}</span>
            </label>
          )
        }
        const current = Number(value(control))
        return (
          <label key={control.key} className="state__row">
            <span className="state__label">{control.label}</span>
            <input
              className="state__range"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={current}
              onChange={(event) => onChange(control.key, Number(event.target.value))}
            />
            <span className="state__value">{Math.round(current * 100)}%</span>
          </label>
        )
      })}
    </div>
  )
}
