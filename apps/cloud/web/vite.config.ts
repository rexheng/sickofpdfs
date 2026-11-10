// The web library (CL13), built into the Worker's static assets (apps/cloud/public).
//
// It is the extension's own library: the same pages, data code and components, over a copy of the library that lives in this
// browser tab and stays in step with the owner's cloud through the sync API (as the extension and the phone app do). Where the
// extension reaches for something only Chrome gives it (the service worker that brokers the store, saved PDF files, opening a
// viewer tab), the build swaps that one module for the web's own version in src/platform/ (SWAPS below). Nothing in
// apps/extension changes for the web.
//
// Three outputs: index.html (the library, a single-page app), viewer.html (CL14: the extension's PDF viewer, over the same kind
// of in-tab library, with the PDF streamed from the cloud) and pages.css (the one style sheet of the Worker's sign-in pages,
// which run no script). The PDF engine's own files (pdfium.wasm and its fonts, apps/extension/public/pdf/) are copied in as
// pdf/: the viewer loads nothing from any other site.
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));
const extensionSrc = fileURLToPath(new URL('../../extension/src/', import.meta.url));
const platform = fileURLToPath(new URL('./src/platform/', import.meta.url));
const web = fileURLToPath(new URL('./src/', import.meta.url));
const webViewer = fileURLToPath(new URL('./src/viewer/', import.meta.url));
const mobilePhone = fileURLToPath(new URL('../../mobile/src/phone/', import.meta.url));
const engineFiles = fileURLToPath(new URL('../../extension/public/pdf/', import.meta.url));
const outDir = fileURLToPath(new URL('../public/', import.meta.url));

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
  // CL14, the viewer. A saved copy is streamed from the cloud (with a progress bar, re-hashed), not read from this computer.
  'viewer/open-saved.ts': 'viewer/open-cloud.ts',
  // There is no Chrome viewer to hand a PDF to from a web page.
  'viewer/open-in-chrome.ts': 'viewer/open-in-chrome.ts',
  // On a phone the viewer is the phone app's (apps/mobile/src/phone): its header, page chip, touch selection bar and notes
  // sheet. Each of these picks the phone's or the computer's version once, when the page opens (viewer/layout.ts).
  'viewer/chrome/Header.tsx': 'viewer/phone/Header.tsx',
  'viewer/chrome/Toolbar.tsx': 'viewer/phone/Toolbar.tsx',
  'viewer/annotations/MarkupMenu.tsx': 'viewer/phone/MarkupMenu.tsx',
  'viewer/notes-panel/PanelEdge.tsx': 'viewer/phone/PanelEdge.tsx',
  // @Claude needs the API key, which only the extension keeps: the web says where to ask instead.
  'viewer/claude/entry.ts': 'viewer/claude-entry.ts',
  'viewer/claude/ui/feature.tsx': 'viewer/claude-feature.tsx',
  // No text recognition on the web (no models shipped): no "Reading text" chip either.
  'viewer/ocr/OcrChip.tsx': 'viewer/ocr-chip.tsx',
  // No MiniLM on the web (plan CL15): a "not sure" PDF stays "not sure", and the owner is asked.
  'viewer/filter/tie-breaker.ts': 'viewer/tie-breaker.ts',
};

/** The phone app's platform modules that its phone viewer files import → the web's versions (no Capacitor here). */
const PHONE_PLATFORM: Record<string, string> = {
  'platform/native.ts': 'viewer/phone/native.ts',
  'platform/app-events.ts': 'viewer/phone/app-events.ts',
  'platform/chrome-shim.ts': 'platform/chrome-shim.ts',
};
const mobileSrc = fileURLToPath(new URL('../../mobile/src/', import.meta.url));

/** Resolves an import of a swapped extension module to the web's version, unless the web's platform code is the importer. */
function webSwaps(): Plugin {
  const swaps = new Map(Object.entries(SWAPS).map(([from, to]) => [`${extensionSrc}${from}`, `${web}${to}`]));
  const phone = new Map(Object.entries(PHONE_PLATFORM).map(([from, to]) => [`${mobileSrc}${from}`, `${web}${to}`]));
  return {
    name: 'sop-web-swaps',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      // The web's own versions import the extension's originals (and the phone app's files) as they are.
      if (importer === undefined || importer.startsWith(platform) || importer.startsWith(webViewer)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) return null;
      const id = resolved.id.split('?')[0] ?? resolved.id;
      if (importer.startsWith(mobilePhone)) return phone.get(id) ?? swaps.get(id) ?? null;
      return swaps.get(id) ?? null;
    },
  };
}

/** Copies the PDF engine's files into the build as pdf/ (run `node apps/extension/scripts/copy-engine-assets.mjs` first). */
function engineAssets(): Plugin {
  return {
    name: 'sop-engine-assets',
    apply: 'build',
    closeBundle() {
      if (!existsSync(`${engineFiles}pdfium.wasm`)) throw new Error('The PDF engine files are missing: run `pnpm -C apps/extension exec node scripts/copy-engine-assets.mjs`.');
      cpSync(engineFiles, `${outDir}pdf/`, { recursive: true });
    },
  };
}

export default defineConfig({
  root: here,
  base: '/',
  // Only our own small files (_headers); the PDF engine's files come in through engineAssets().
  publicDir: fileURLToPath(new URL('./public/', import.meta.url)),
  plugins: [webSwaps(), react(), engineAssets()],
  define: { __SOP_APP_VERSION__: JSON.stringify('web') },
  resolve: {
    alias: { '@ext': extensionSrc.replace(/\/$/, ''), '@mobile': mobileSrc.replace(/\/$/, '') },
    dedupe: ['react', 'react-dom'],
  },
  worker: { format: 'es', plugins: () => [webSwaps()] },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        viewer: fileURLToPath(new URL('./viewer.html', import.meta.url)),
        pages: fileURLToPath(new URL('./src/pages/pages.css', import.meta.url)),
      },
      output: {
        // The sign-in pages link /pages.css by name; everything else is hashed.
        assetFileNames: (info) => ((info.names ?? []).includes('pages.css') ? 'pages.css' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
});
