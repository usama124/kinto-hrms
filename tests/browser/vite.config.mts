import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import { fileURLToPath } from 'node:url'

// Test-only server. It mounts the real views without Next routes or a database.
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  resolve: { alias: { 'next/navigation': fileURLToPath(new URL('./harness/navigation.ts', import.meta.url)), '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
})
