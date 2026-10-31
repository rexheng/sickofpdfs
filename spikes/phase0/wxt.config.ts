import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'wxt';

// Engine files and fallback fonts that must ship inside the extension (nothing is downloaded).
// Source paths are relative to node_modules; every file lands in the extension's `pdf/` folder.
const PDF_ASSETS: [string, string][] = [
  ['@embedpdf/pdfium/dist/pdfium.wasm', 'pdfium.wasm'],
  ...(['Regular', 'Italic', 'Bold', 'BoldItalic'] as const).map(
    (v): [string, string] => [`@embedpdf/fonts-latin/fonts/NotoSans-${v}.ttf`, `NotoSans-${v}.ttf`],
  ),
  ['@embedpdf/fonts-sc/fonts/NotoSansHans-Regular.otf', 'NotoSansHans-Regular.otf'],
];

export default defineConfig({
  manifest: {
    name: 'sickofpdfs Phase 0 spike',
    description: 'Throwaway engine proof: EmbedPDF (PDFium) inside an MV3 extension.',
    minimum_chrome_version: '128',
    permissions: ['offscreen'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  // Module workers (`new Worker(new URL(...), { type: 'module' })`) are emitted as their own files.
  vite: () => ({ worker: { format: 'es' } }),
  hooks: {
    'build:publicAssets': (wxt, files) => {
      for (const [src, name] of PDF_ASSETS) {
        const absoluteSrc = resolve(wxt.config.root, 'node_modules', src);
        if (!existsSync(absoluteSrc)) throw new Error(`missing engine asset ${absoluteSrc}`);
        files.push({ absoluteSrc, relativeDest: `pdf/${name}` });
      }
    },
  },
});
