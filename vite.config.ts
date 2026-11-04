/// <reference types="node" />
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Dev only: lets the ?bench page save its overlay pictures and scores to bench/out/. */
function benchWriter(): Plugin {
  return {
    name: 'bench-writer',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__bench/save', (req, res) => {
        const name = basename(new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '')
        if (req.method !== 'POST' || !/^[\w.-]+\.(png|json)$/.test(name)) {
          res.statusCode = 400
          res.end('bad request')
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const dir = join(server.config.root, 'bench', 'out')
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, name), Buffer.concat(chunks))
          res.end('ok')
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), benchWriter()],
  // web-ifc loads its own .wasm file; pre-bundling breaks that.
  optimizeDeps: { exclude: ['web-ifc'] },
})
