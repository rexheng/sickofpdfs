// Gate 1, the secrets store (Task 29), on the real built extension. Written from the spec and the interface file only.
//
//   spec, Privacy and Storage: "Your API key sits in the extension's private database, which content scripts and web pages cannot read";
//     backups "never include your API key, sign-in tokens, the never-save list"; "secrets live in a separate store that backups, export and
//     sync cannot read".
//   interface file (Task 29): LOCAL_ONLY_DB = 'sop-local'; openLocalOnlyStore() with getSecret / setSecret / deleteSecret; the secrets
//     "never go into backups or the library database"; "The test hooks never reach the secrets store (ruling R19)".
//
// How the test reaches the secrets store: the viewer's test hooks do not expose it (R19) and no settings page exists yet, so the test
// bundles the real source file (apps/extension/src/local-only/secrets-store.ts) into one script and runs it inside an extension page
// over the debugging connection. The code that runs is the product's code, in the extension's own origin.
//
// What it checks: the key is kept (also after a reload); it is in no OPFS file (the library database's files included, which the test shows
// it can read by finding a title it saved there), in none of the extension's storage areas (chrome.storage), and it cannot be seen from a web
// page or from the extension's own content script running in that page.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { build } from 'vite';
import { expect, EXTENSION_ID, test } from './support/test';
import { inputFor, scanOpfs, store, waitForStore } from './support/store-probe.spec-blind';

const SOURCE = fileURLToPath(new URL('../apps/extension/src/local-only/secrets-store.ts', import.meta.url));

/** The secrets store, bundled into one script that defines `globalThis.SopLocalOnly`. */
async function bundleSecretsStore(): Promise<string> {
  const out = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false, lib: { entry: SOURCE, name: 'SopLocalOnly', formats: ['iife'] } } });
  const result = (Array.isArray(out) ? out[0] : out) as { output: { code?: string }[] };
  const code = result.output[0]?.code;
  if (!code) throw new Error('the secrets store did not bundle');
  return `${code};globalThis.SopLocalOnly = SopLocalOnly;`;
}

interface Secrets {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<void>;
}
/** The secrets store as seen from an extension page that has the bundle loaded. */
const secretsIn = (page: Page): Secrets => ({
  get: (name) =>
    page.evaluate(async (n) => (await (globalThis as unknown as { SopLocalOnly: { openLocalOnlyStore(): Promise<{ getSecret(n: string): Promise<string | null> }> } }).SopLocalOnly.openLocalOnlyStore()).getSecret(n), name),
  set: (name, value) =>
    page.evaluate(async ([n, v]) => (await (globalThis as unknown as { SopLocalOnly: { openLocalOnlyStore(): Promise<{ setSecret(n: string, v: string): Promise<void> }> } }).SopLocalOnly.openLocalOnlyStore()).setSecret(n, v), [name, value]),
  remove: (name) =>
    page.evaluate(async (n) => (await (globalThis as unknown as { SopLocalOnly: { openLocalOnlyStore(): Promise<{ deleteSecret(n: string): Promise<void> }> } }).SopLocalOnly.openLocalOnlyStore()).deleteSecret(n), name),
});

test('an API key kept by the real secrets store is in no library file and no extension storage, and a web page or content script cannot see it', async ({ context, sw, server, openViewer }, testInfo) => {
  test.setTimeout(120_000);
  const bundle = await bundleSecretsStore();
  const KEY = `sk-ant-api03-E2E-${randomUUID()}`;
  const TOKEN = `cloud-token-E2E-${randomUUID()}`;
  const CANARY = `canary-title-${randomUUID()}`;

  const page = await openViewer(server.url('/h/plain.pdf'));
  await waitForStore(page);
  await store(page).saveDocument(await inputFor(page, server.url('/h/plain.pdf'), { title: CANARY }));
  expect((await scanOpfs(page, CANARY)).length, 'control: the file scan can read the library database, where the title now is').toBeGreaterThan(0);

  await page.evaluate(bundle);
  const secrets = secretsIn(page);
  await secrets.set('anthropic_api_key', KEY);
  await secrets.set('cloud_token', TOKEN);
  expect(await secrets.get('anthropic_api_key')).toBe(KEY);
  await page.screenshot({ path: testInfo.outputPath('secrets-1-saved.png') });

  // It is not in any file of the extension's private storage: not the library, not the saved PDFs, not a temp file.
  for (const secret of [KEY, TOKEN]) expect(await scanOpfs(page, secret), `"${secret.slice(0, 18)}..." was written to a file`).toEqual([]);

  // It is not in the extension's storage areas either (chrome.storage is readable by content scripts and is copied by sync).
  const areas = await sw.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null), await chrome.storage.sync.get(null).catch(() => ({}))]));
  expect(areas.includes(KEY) || areas.includes(TOKEN), 'a secret is in chrome.storage').toBe(false);

  // A web page cannot see it, and neither can the extension's own content script running in that page.
  const web = await context.newPage();
  const cdp = await context.newCDPSession(web);
  const worlds: { id: number; origin: string }[] = [];
  cdp.on('Runtime.executionContextCreated', (e) => worlds.push({ id: e.context.id, origin: e.context.origin }));
  await cdp.send('Runtime.enable');
  await web.goto(server.url('/h/referer-page'));
  await expect.poll(() => worlds.some((w) => w.origin.startsWith(`chrome-extension://${EXTENSION_ID}`)), { message: 'the content script runs in the page', timeout: 10_000 }).toBe(true);

  const pageView = await web.evaluate(async () => ({ databases: (await indexedDB.databases()).map((d) => d.name), cookie: document.cookie }));
  expect(pageView.databases, 'the page sees its own storage only').not.toContain('sop-local');
  const contentScript = worlds.find((w) => w.origin.startsWith(`chrome-extension://${EXTENSION_ID}`))!;
  const seen = await cdp.send('Runtime.evaluate', {
    contextId: contentScript.id,
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => JSON.stringify({ databases: (await indexedDB.databases()).map((d) => d.name), local: await chrome.storage.local.get(null) }))()`,
  });
  const fromContentScript = typeof seen.result.value === 'string' ? seen.result.value : '';
  expect(fromContentScript, 'the content script ran its check').toContain('databases');
  expect(fromContentScript).not.toContain('sop-local');
  expect(fromContentScript.includes(KEY) || fromContentScript.includes(TOKEN)).toBe(false);
  await web.close();

  // It is kept: after a reload of the extension page it is still there; deleting it removes it.
  await page.reload();
  await page.evaluate(bundle);
  expect(await secretsIn(page).get('anthropic_api_key')).toBe(KEY);
  await secretsIn(page).remove('anthropic_api_key');
  expect(await secretsIn(page).get('anthropic_api_key')).toBeNull();
  expect(await secretsIn(page).get('cloud_token'), 'deleting one secret leaves the other').toBe(TOKEN);
});
