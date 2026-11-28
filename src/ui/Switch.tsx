import type { InputHTMLAttributes, ReactNode } from 'react'

interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  children: ReactNode
}

/** 开关：用原生 checkbox，键盘与读屏都能用，视觉换成滑块 */
export function Switch({ children, className, ...rest }: SwitchProps) {
  return (
    <label className={`switch${className ? ` ${className}` : ''}`}>
      <input type="checkbox" {...rest} />
      <span className="switch__track" aria-hidden="true" />
      <span>{children}</span>
    </label>
  )
}
