import { useState } from 'react'
import { formatLength, parseLength } from '../model/geometry'

interface Props {
  measured: number // current length of the clicked line, in cm
  scaleKnown: boolean
  onSubmit(realCm: number): void
  onCancel(): void
}

export function CalibrateDialog({ measured, scaleKnown, onSubmit, onCancel }: Props) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const cm = parseLength(text)
    if (!cm) {
      setError('Type a length, like 350, 350 cm, 3.5 m or 3500 mm.')
      return
    }
    onSubmit(cm)
  }

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form className="dialog" onSubmit={submit}>
        <h2>How long is this line in reality?</h2>
        <p className="muted">
          {scaleKnown ? `Right now it measures ${formatLength(measured)}.` : 'The scale is not set yet.'} Numbers without a
          unit are centimetres.
        </p>
        <input
          autoFocus
          value={text}
          placeholder="e.g. 350 cm or 3.5 m"
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        />
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-buttons">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Set scale
          </button>
        </div>
      </form>
    </div>
  )
}
