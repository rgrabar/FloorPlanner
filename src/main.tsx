import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// ?preview=<model> opens the furniture model preview instead of the planner.
const ModelPreview = lazy(() => import('./furniture/ModelPreview'))
const Gallery = lazy(() => import('./furniture/ModelPreview').then((m) => ({ default: m.Gallery })))
// ?bench runs the wall detection test bench (see src/bench/Bench.tsx).
const Bench = lazy(() => import('./bench/Bench'))
const query = new URLSearchParams(location.search)
const page = query.has('bench') ? <Bench /> : query.has('gallery') ? <Gallery /> : query.has('preview') ? <ModelPreview /> : null

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {page ? (
      <Suspense fallback={null}>{page}</Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
