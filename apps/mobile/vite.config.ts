// The phone app's web layer: the extension's viewer and library, built as plain web pages for the app's WebView.
//
// The extension's code is used as it is. Where it reaches for something only Chrome gives an extension (the service worker that
// brokers the store, the offscreen document, a file picked into a blob: link another tab keeps alive), the build swaps that one
// module for the app's own version in src/platform/ (PLATFORM_SWAPS below). Nothing in apps/extension changes for the app.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const extensionSrc = fileURLToPath(new URL('../extension/src/', import.meta.url));
const platform = fileURLToPath(new URL('./src/platform/', import.meta.url));
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Extension modules the app replaces: the extension file (from apps/extension/src) → the app's file (from src/platform).
 * Each replacement keeps the module's exports and names, so every importer works unchanged.
 */
const PLATFORM_SWAPS: Record<string, string> = {
  // The store is reached through the page's own store worker, not through the service worker and the offscreen document.
  'store/transport.ts': 'store-transport.ts',
  // Saved copies: the extension's OPFS files, with an IndexedDB fallback for a WebView without OPFS writes.
  'store/blob-store.ts': 'blob-store.ts',
  // The library's frame on a phone: a top bar, a bottom bar and "Open a PDF".
  'library/shell/Shell.tsx': 'Shell.tsx',
  // There is no Chrome viewer to hand a PDF to on the phone.
  'viewer/open-in-chrome.ts': 'open-in-chrome.ts',
};

/** Resolves an import of a swapped extension module to the app's version, unless the app's version is the importer. */
function platformSwaps(): Plugin {
  const swaps = new Map(Object.entries(PLATFORM_SWAPS).map(([from, to]) => [`${extensionSrc}${from}`, `${platform}${to}`]));
  return {
    name: 'sop-platform-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined || importer.startsWith(platform)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) return null;
      const swap = swaps.get(resolved.id.split('?')[0] ?? resolved.id);
      return swap === undefined ? null : swap;
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  // The engine (pdf/), the text recognition runtime (ort/) and models (models/), the icons and the notices: the extension's own files.
  publicDir: fileURLToPath(new URL('../extension/public/', import.meta.url)),
  plugins: [platformSwaps(), react()],
  define: { __SOP_APP_VERSION__: JSON.stringify(appVersion) },
  resolve: {
    alias: { '@ext': extensionSrc.replace(/\/$/, '') },
    dedupe: ['react', 'react-dom'],
  },
  worker: { format: 'es', plugins: () => [platformSwaps()] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Android System WebView updates through the Play Store; OPFS and module workers need 109 or later.
    target: 'chrome109',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        library: fileURLToPath(new URL('./library.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
      },
    },
  },
});
