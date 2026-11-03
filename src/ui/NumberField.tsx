import { useEffect, useState } from 'react'

interface Props {
  label: string
  value: number
  unit?: string
  min?: number
  onChange(value: number): void
}

/** A number input that only reports a change when I press Enter or leave the field. */
export function NumberField({ label, value, unit = 'cm', min = 0, onChange }: Props) {
  const shown = String(Math.round(value * 10) / 10)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])

  const commit = () => {
    const v = parseFloat(text.replace(',', '.'))
    if (Number.isFinite(v) && v >= min && v !== value) onChange(v)
    else setText(shown)
  }

  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(shown)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <span className="unit">{unit}</span>
    </label>
  )
}
