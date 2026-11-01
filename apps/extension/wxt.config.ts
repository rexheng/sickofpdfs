import { readFileSync } from 'node:fs';
import { defineConfig } from 'wxt';

// The fixed key gives the extension the same id on every machine and build (see scripts/gen-key.mjs).
const key = readFileSync(new URL('./extension-key.pub.txt', import.meta.url), 'utf8').trim();

/**
 * Test builds only: adds the test hooks to the viewer entry. This is the single way `src/testing/test-hooks.ts`
 * enters a build, so production modules never reference it and a production build never contains it.
 */
function sopTestHooks() {
  return {
    name: 'sop-test-hooks',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!id.split('?')[0]!.replaceAll('\\', '/').endsWith('/src/entrypoints/viewer/main.tsx')) return null;
      return { code: `import '@/testing/test-hooks';\n${code}`, map: null };
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
    description: 'Opens every PDF in a calm reader of its own, with highlights, comments and a library.',
    key,
    minimum_chrome_version: '128',
    incognito: 'split',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    // Least privilege: each entry is used by the takeover, the store or the viewer. No downloads, scripting,
    // activeTab, history, clipboard, nativeMessaging or identity.
    permissions: ['declarativeNetRequestWithHostAccess', 'webRequest', 'webNavigation', 'tabs', 'storage', 'unlimitedStorage', 'offscreen'],
    host_permissions: ['<all_urls>'],
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
