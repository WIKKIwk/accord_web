import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { realpathSync } from 'node:fs'

const root = fileURLToPath(new URL('.', import.meta.url))
const dependencies = realpathSync(fileURLToPath(new URL('./node_modules', import.meta.url)))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { fs: { allow: [root, dependencies] } },
})
