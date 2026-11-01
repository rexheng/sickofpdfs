import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Builds the bench pages and workers into dist/ (scripts/copy-assets.mjs then adds the manifest, onnxruntime-web's own
// files, Tesseract.js's worker and core, and the models). Everything is local files: nothing in the bundle fetches a URL.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  publicDir: false,
  build: {
    outDir: process.env.SOP_DIST ?? 'dist',
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    assetsInlineLimit: 0,
    rollupOptions: { input: { bench: 'bench.html', offscreen: 'offscreen.html' } },
  },
  worker: { format: 'es' },
  server: { fs: { allow: ['../..'] } },
});
