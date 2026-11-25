import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Сборка — в dist/, её раздаёт server.mjs. В разработке (npm run dev) /api идёт на запущенный bot ui.
export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4545' } },
  build: { outDir: 'dist', emptyOutDir: true },
})
