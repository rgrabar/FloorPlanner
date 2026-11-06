import { useEffect, useState } from 'react'

/** A list of numbers typed with commas (shelf heights), reported on Enter or leaving the field. */
export function ListField({ label, value, onChange }: { label: string; value: number[]; onChange(v: number[]): void }) {
  const [text, setText] = useState(value.join(', '))
  const shown = value.join(', ')
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    const list = text.split(/[,;\s]+/).filter(Boolean).map(Number)
    if (list.every(Number.isFinite)) onChange(list)
    else setText(value.join(', '))
  }
  return (
    <label className="field" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      {label} (comma separated)
      <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
    </label>
  )
}
