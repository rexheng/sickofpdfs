// The phone app's web layer: the extension's viewer and library, built as plain web pages for the app's WebView.
//
// The extension's code is used as it is. Where it reaches for something only Chrome gives an extension (the service worker that
// brokers the store, the offscreen document, a file picked into a blob: link another tab keeps alive), the build swaps that one
// module for the app's own version in src/platform/ or src/phone/ (PLATFORM_SWAPS below).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const extensionSrc = fileURLToPath(new URL('../extension/src/', import.meta.url));
const appSrc = fileURLToPath(new URL('./src/', import.meta.url));
const appVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * Extension modules the app replaces: the extension file (from apps/extension/src) → the app's file (from src/).
 * Each replacement keeps the module's exports and names, so every importer works unchanged.
 */
const PLATFORM_SWAPS: Record<string, string> = {
  // The store is reached through the page's own store worker, not through the service worker and the offscreen document.
  'store/transport.ts': 'platform/store-transport.ts',
  // Saved copies: the extension's OPFS files, with an IndexedDB fallback for a WebView without OPFS writes.
  'store/blob-store.ts': 'platform/blob-store.ts',
  // The library's frame on a phone: a top bar, a bottom bar and "Open a PDF".
  'library/shell/Shell.tsx': 'platform/Shell.tsx',
  // There is no Chrome viewer to hand a PDF to on the phone.
  'viewer/open-in-chrome.ts': 'platform/open-in-chrome.ts',
  // The viewer on a phone (round 2): a compact header with a ⋮ menu, a page chip instead of the toolbar pill, touch selection
  // with an action bar instead of the right-click menu, and the notes panel as a bottom sheet (its grip instead of the
  // panel's resize edge).
  'viewer/chrome/Header.tsx': 'phone/PhoneHeader.tsx',
  'viewer/chrome/Toolbar.tsx': 'phone/PhoneToolbar.tsx',
  'viewer/annotations/MarkupMenu.tsx': 'phone/SelectionBar.tsx',
  'viewer/notes-panel/PanelEdge.tsx': 'phone/SheetGrip.tsx',
  // Settings on a phone (round 3): the phone's own Cloud section (sync sign-in through a Custom Tab), and no keyboard Shortcuts.
  'library/settings/sections.ts': 'phone/settings-sections.ts',
};

/**
 * The servers the app may sync with (R109): the owner's own, unless a build names others in SOP_SYNC_ORIGINS (space separated;
 * a test build adds a local server). The pages' Content-Security-Policy allows these in connect-src and no other host, and
 * Settings → Cloud connects only to these.
 */
const OWNER_SYNC_ORIGIN = 'https://sickofpdfs.rexheng-policy.workers.dev';
const syncOrigins = (process.env.SOP_SYNC_ORIGINS ?? OWNER_SYNC_ORIGIN)
  .split(/\s+/)
  .filter(Boolean)
  .map((o) => {
    const u = new URL(o);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`SOP_SYNC_ORIGINS: ${o} must be https (or http on this computer)`);
    return u.origin;
  });

/** Writes the sync servers into the pages' Content-Security-Policy (the %SOP_SYNC_ORIGINS% mark in connect-src). */
function syncCsp(): Plugin {
  return {
    name: 'sop-sync-csp',
    transformIndexHtml: (html) => html.replaceAll('%SOP_SYNC_ORIGINS%', syncOrigins.join(' ')),
  };
}

/** Resolves an import of a swapped extension module to the app's version, unless the app's own code is the importer. */
function platformSwaps(): Plugin {
  const swaps = new Map(Object.entries(PLATFORM_SWAPS).map(([from, to]) => [`${extensionSrc}${from}`, `${appSrc}${to}`]));
  return {
    name: 'sop-platform-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined || importer.startsWith(appSrc)) return null;
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
  plugins: [platformSwaps(), syncCsp(), react()],
  define: { __SOP_APP_VERSION__: JSON.stringify(appVersion), __SOP_SYNC_ORIGINS__: JSON.stringify(syncOrigins) },
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
