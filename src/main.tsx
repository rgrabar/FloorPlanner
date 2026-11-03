import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

// ?preview=<model> opens the furniture model preview instead of the planner.
const ModelPreview = lazy(() => import('./furniture/ModelPreview'))
const isPreview = new URLSearchParams(location.search).has('preview')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPreview ? (
      <Suspense fallback={null}>
        <ModelPreview />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
