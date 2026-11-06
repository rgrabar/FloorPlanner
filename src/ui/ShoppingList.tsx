import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { displayName } from '../furniture/placement'
import { MODELS } from '../furniture/model'
import type { Floor } from '../store/store'

// Every IKEA article in the placed furniture, on all floors, with how many of each to buy.
// A model built from several articles (PAX frame + doors) lists each one.

export interface Article {
  item: string // IKEA article number
  name: string
  type: string
  variant: string
  quantity: number
  floors: string[] // floor names it's on
}

export function shoppingList(floors: Floor[]): { articles: Article[]; other: { name: string; quantity: number }[] } {
  const articles = new Map<string, Article>()
  const other = new Map<string, number>()
  for (const floor of floors) {
    for (const f of floor.plan.furniture) {
      const ikea = MODELS[f.model]?.ikea
      if (!ikea) {
        const name = displayName(f.model)
        other.set(name, (other.get(name) ?? 0) + 1)
        continue
      }
      for (const item of ikea.items) {
        const a = articles.get(item) ?? { item, name: ikea.name, type: ikea.type, variant: ikea.variant ?? '', quantity: 0, floors: [] }
        a.quantity++
        if (!a.floors.includes(floor.name)) a.floors.push(floor.name)
        articles.set(item, a)
      }
    }
  }
  return {
    articles: [...articles.values()].sort((a, b) => a.name.localeCompare(b.name) || a.item.localeCompare(b.item)),
    other: [...other].map(([name, quantity]) => ({ name, quantity })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export const articleLink = (item: string) => `https://www.ikea.com/ie/en/search/?q=${encodeURIComponent(item)}`

/** The list as CSV (for a spreadsheet), one row per article. */
export function shoppingCsv(articles: Article[]): string {
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = [
    ['Article number', 'Name', 'Type', 'Variant', 'Quantity', 'Floors', 'Link'],
    ...articles.map((a) => [a.item, a.name, a.type, a.variant, a.quantity, a.floors.join('; '), articleLink(a.item)]),
  ]
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function ShoppingListDialog({ floors, onClose }: { floors: Floor[]; onClose(): void }) {
  const { articles, other } = shoppingList(floors)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const download = () => {
    const blob = new Blob(['﻿' + shoppingCsv(articles)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'shopping-list.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const many = floors.length > 1
  // On the page itself, not inside the toolbar, so nothing around it can clip it.
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog shopping">
        <h2>Shopping list</h2>
        {articles.length ? (
          <table className="shopping-table">
            <thead>
              <tr>
                <th>Article</th>
                <th>Product</th>
                <th>Qty</th>
                {many && <th>Floors</th>}
              </tr>
            </thead>
            <tbody>
              {articles.map((a) => (
                <tr key={a.item}>
                  <td>
                    <a href={articleLink(a.item)} target="_blank" rel="noreferrer">
                      {a.item}
                    </a>
                  </td>
                  <td>
                    <strong>{a.name}</strong> {a.type}
                    {a.variant && <div className="muted">{a.variant}</div>}
                  </td>
                  <td>{a.quantity}</td>
                  {many && <td className="muted">{a.floors.join(', ')}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No IKEA furniture is placed yet. Add some from the catalogue in the side panel.</p>
        )}
        {other.length > 0 && (
          <p className="muted">
            Not from IKEA (not in the list): {other.map((o) => `${o.quantity} × ${o.name}`).join(', ')}.
          </p>
        )}
        <div className="dialog-buttons">
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={download} disabled={!articles.length}>
            Download CSV
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
