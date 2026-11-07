import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'wxt';

// The fixed key gives the extension the same id on every machine and build (see scripts/gen-key.mjs).
const key = readFileSync(new URL('./extension-key.pub.txt', import.meta.url), 'utf8').trim();

/**
 * Test builds only: adds the test hooks to the viewer entry, and the Claude base-URL hook (contract addition A7) to the
 * entries that may call Anthropic: the viewer, and the library page, which holds Settings → Claude. These are the only ways
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
      if (entry(id, 'viewer') || entry(id, 'library')) imports.push("import '@/testing/claude-base-url';");
      if (imports.length === 0) return null;
      return { code: `${imports.join('\n')}\n${code}`, map: null };
    },
  };
}

/**
 * The test build number, set by the release script (`pnpm test-build <N>`, scripts/dev/make-test-build.mjs) through SOP_BUILD_NUMBER.
 * It becomes `version_name` ("Test build 6", shown in chrome://extensions and Help → About) and the last part of `version` (0.1.6).
 * The library compares `version_name` with the one it last saw to say "Updated to test build N" (R104). Without it (a dev build)
 * the manifest keeps the version of apps/extension/package.json and has no `version_name`, so no "Updated" note is ever shown.
 */
const buildNumber = process.env.SOP_BUILD_NUMBER;
if (buildNumber !== undefined && !/^[1-9]\d{0,4}$/.test(buildNumber)) throw new Error(`SOP_BUILD_NUMBER must be a whole number such as 6, not "${buildNumber}"`);

/**
 * The release name, set by `pnpm release:zip` (scripts/release/package.mjs) through SOP_VERSION_NAME. The manifest's `version`
 * then stays the one in apps/extension/package.json (1.0.0) and `version_name` becomes "Release 1". A test build never has both.
 */
const versionName = process.env.SOP_VERSION_NAME;
const packageVersion = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }).version;
if (versionName !== undefined && buildNumber !== undefined) throw new Error('SOP_VERSION_NAME and SOP_BUILD_NUMBER cannot both be set: a build is a release or a test build');

export default defineConfig({
  srcDir: 'src',
  // R104: every build, test builds included, carries the update instructions in its root, so they land in every zip.
  hooks: {
    'build:done': (wxt) => {
      copyFileSync(new URL('./HOW-TO-UPDATE.txt', import.meta.url), join(wxt.config.outDir, 'HOW-TO-UPDATE.txt'));
    },
  },
  modules: ['@wxt-dev/module-react'],
  // `wxt build` writes .output/chrome-mv3 and `wxt build --mode test` writes .output/chrome-mv3-test: the two never share a folder.
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}',
  manifest: {
    name: 'sickofpdfs',
    // What this build does, in plain words (Help → About shows it too); say more as more ships.
    ...(buildNumber !== undefined ? { version: `0.1.${buildNumber}`, version_name: `Test build ${buildNumber}` } : {}),
    // WXT takes `version` from version_name when only that is set, so the package version is named here.
    ...(versionName !== undefined ? { version: packageVersion, version_name: versionName } : {}),
    description: 'A PDF reader that replaces Chrome’s, with highlights and comments.',
    key,
    minimum_chrome_version: '128',
    incognito: 'split',
    icons: { 16: 'icon/16.png', 32: 'icon/32.png', 48: 'icon/48.png', 128: 'icon/128.png' },
    // The toolbar icon opens its menu (entrypoints/popup, spec R103): "Save this page to library" and "Open library". WXT adds
    // the popup (action.default_popup) and takes the tooltip from the popup's <title>; this one says the same.
    action: { default_title: 'sickofpdfs: save this page or open your library' },
    // Least privilege: each entry is used by the takeover, the store, the viewer or "Save this page to library". No tabs,
    // downloads, history, clipboard, nativeMessaging or identity. (tabs.update, tabs.create and tabs.onRemoved need no
    // permission, and Chrome fills a sender's tab.url from the host permission for that page.)
    // R103: activeTab and scripting put the page reader (entrypoints/page-reader.ts) into the current tab, and only when the
    // owner clicks "Save this page to library" in the menu. Nothing reads a page on its own.
    permissions: ['declarativeNetRequestWithHostAccess', 'webRequest', 'webNavigation', 'storage', 'unlimitedStorage', 'offscreen', 'activeTab', 'scripting'],
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
