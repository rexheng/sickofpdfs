import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

// The fixed key gives the extension the same id on every machine and build (see scripts/gen-key.mjs).
const key = readFileSync(new URL('./extension-key.pub.txt', import.meta.url), 'utf8').trim();

/**
 * Test builds only: adds the test hooks to the viewer entry, and the Claude base-URL hook (contract addition A7) to the
 * entries that may call Anthropic: the viewer, and the Settings page once it exists. These are the only ways
 * `src/testing/*.ts` enters a build, so production modules never reference them and a production build never contains them.
 */
function sopTestHooks() {
  const entry = (id: string, name: string) => (id.split('?')[0] ?? id).replaceAll('\\', '/').endsWith(`/src/entrypoints/${name}/main.tsx`);
  return {
    name: 'sop-test-hooks',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const imports: string[] = [];
      if (entry(id, 'viewer')) imports.push("import '@/testing/test-hooks';");
      if (entry(id, 'viewer') || entry(id, 'settings')) imports.push("import '@/testing/claude-base-url';");
      if (imports.length === 0) return null;
      return { code: `${imports.join('\n')}\n${code}`, map: null };
    },
  };
}

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  // `wxt build` writes .output/chrome-mv3 and `wxt build --mode test` writes .output/chrome-mv3-test: the two never share a folder.
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}',
  manifest: {
    name: 'sickofpdfs',
    // What this build does, in plain words (Help → About shows it too); say more as more ships.
    description: 'A PDF reader that replaces Chrome’s, with highlights and comments.',
    key,
    minimum_chrome_version: '128',
    incognito: 'split',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    // The toolbar icon opens the library (background/open-library.ts).
    action: { default_title: 'Open your library' },
    // Least privilege: each entry is used by the takeover, the store or the viewer. No tabs, downloads, scripting,
    // activeTab, history, clipboard, nativeMessaging or identity. (tabs.update, tabs.create and tabs.onRemoved need no
    // permission, and Chrome fills a sender's tab.url from the host permission for that page.)
    permissions: ['declarativeNetRequestWithHostAccess', 'webRequest', 'webNavigation', 'storage', 'unlimitedStorage', 'offscreen'],
    // The schemes PDFs and the pages that show them come from: the redirect and header rules, the request log and
    // the content script need no other (no ws, wss or ftp).
    host_permissions: ['http://*/*', 'https://*/*', 'file:///*'],
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
    web_accessible_resources: [{ resources: ['viewer.html'], matches: ['<all_urls>'] }],
  },
  // WXT bakes the build mode into `process.env.NODE_ENV`, which would give the test build React's development build.
  // e2e (and its speed smoke) should run what ships, so test builds pin NODE_ENV to production, both for the bundled
  // code (`define`) and for the JSX transform (which reads the variable while Vite resolves its config, after this runs).
  vite: (env) => {
    if (env.mode !== 'test') return {};
    process.env.NODE_ENV = 'production';
    return { plugins: [sopTestHooks()], define: { 'process.env.NODE_ENV': '"production"' } };
  },
});
