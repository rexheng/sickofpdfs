// The web library (CL13), built into the Worker's static assets (apps/cloud/public).
//
// It is the extension's own library: the same pages, data code and components, over a copy of the library that lives in this
// browser tab and stays in step with the owner's cloud through the sync API (as the extension and the phone app do). Where the
// extension reaches for something only Chrome gives it (the service worker that brokers the store, saved PDF files, opening a
// viewer tab), the build swaps that one module for the web's own version in src/platform/ (SWAPS below). Nothing in
// apps/extension changes for the web.
//
// Two outputs: index.html (the library, a single-page app) and pages.css (the one style sheet of the Worker's sign-in pages,
// which run no script).
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const extensionSrc = fileURLToPath(new URL('../../extension/src/', import.meta.url));
const platform = fileURLToPath(new URL('./src/platform/', import.meta.url));
const web = fileURLToPath(new URL('./src/', import.meta.url));

/** Extension module (from apps/extension/src) → the web's version (from src/). Each keeps the module's exports and names. */
const SWAPS: Record<string, string> = {
  // The store is this tab's own store worker, holding the library in memory (filled from the cloud).
  'store/transport.ts': 'platform/store-transport.ts',
  // The web keeps no PDF files: a saved copy is in the cloud.
  'store/blob-store.ts': 'platform/blob-store.ts',
  // The library's frame: Drive's on a computer, a phone frame on a narrow screen, and the sync status in both.
  'library/shell/Shell.tsx': 'platform/Shell.tsx',
  // Thumbnails come from the cloud (the extension uploads them), not from a PDF on this computer.
  'library/data/thumbnails.ts': 'platform/thumbnails.ts',
  // Opening a reading goes to its page in the web library.
  'library/components/reading-actions.ts': 'platform/reading-actions.ts',
  'shared/palette/open-hit.ts': 'platform/open-hit.ts',
  // Settings on the web: connections, Claude, usage and devices.
  'library/pages/Settings/index.ts': 'settings/index.ts',
};

/** Resolves an import of a swapped extension module to the web's version, unless the web's platform code is the importer. */
function webSwaps(): Plugin {
  const swaps = new Map(Object.entries(SWAPS).map(([from, to]) => [`${extensionSrc}${from}`, `${web}${to}`]));
  return {
    name: 'sop-web-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined || importer.startsWith(platform)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) return null;
      return swaps.get(resolved.id.split('?')[0] ?? resolved.id) ?? null;
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  // Only our own small files (_headers): the PDF engine's files are not needed, the web library draws no PDF yet.
  publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
  plugins: [webSwaps(), react()],
  define: { __SOP_APP_VERSION__: JSON.stringify('web') },
  resolve: {
    alias: { '@ext': extensionSrc.replace(/\/$/, '') },
    dedupe: ['react', 'react-dom'],
  },
  worker: { format: 'es', plugins: () => [webSwaps()] },
  build: {
    outDir: fileURLToPath(new URL('../public/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        pages: fileURLToPath(new URL('./src/pages/pages.css', import.meta.url)),
      },
      output: {
        // The sign-in pages link /pages.css by name; everything else is hashed.
        assetFileNames: (info) => ((info.names ?? []).includes('pages.css') ? 'pages.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
