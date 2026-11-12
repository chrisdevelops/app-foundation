import { defineConfig } from 'vite'

// Native add-ons cannot be bundled. They stay as runtime require() calls and forge.config.ts copies them.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['better-sqlite3', 'sharp', 'node-pty'],
    },
  },
})
