import { build } from 'esbuild'
import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('dist', { recursive: true })
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.js', bundle: true, platform: 'node', external: ['electron'], format: 'cjs' })
await build({ entryPoints: ['src/renderer.tsx'], outfile: 'dist/renderer.js', bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, sourcemap: false })
copyFileSync('src/index.html', 'dist/index.html')
copyFileSync('src/app.css', 'dist/app.css')
