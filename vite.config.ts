import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // web-ifc loads its own .wasm file; pre-bundling breaks that.
  optimizeDeps: { exclude: ['web-ifc'] },
})
