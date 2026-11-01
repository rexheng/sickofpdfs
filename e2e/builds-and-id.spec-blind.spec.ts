// User tests and build checks for the extension's identity and its two builds.
//   - The owner can move the unpacked folder without losing the extension's data: the id comes from the key, not the path.
//   - The test build (what every spec loads) and the production build have the same id and the same key.
//   - Test hooks exist only in the test build: no `__sopTest` in the production files, none at run time.
//   - The manifest asks for what the spec needs and for nothing that lets code in from outside.
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { EXTENSION_ID } from '../apps/extension/scripts/extension-id.mjs';
import { VIEWER_PATH, buildViewerUrl } from '../apps/extension/src/shared/viewer-url';
import { PROD_BUILD_DIR, TEST_BUILD_DIR } from './support/launch';
import { ensureBuilt, launchRaw, type RawRun } from './support/raw-launch.spec-blind';
import { REPO_ROOT } from './support/sample-pdf.spec-blind';

const BASE = `chrome-extension://${EXTENSION_ID}/${VIEWER_PATH}`;
const BUILDS = [
  ['test', TEST_BUILD_DIR, 'build:e2e'],
  ['production', PROD_BUILD_DIR, 'build'],
] as const;

test.beforeAll(() => {
  test.setTimeout(10 * 60_000);
  for (const [, dir, script] of BUILDS) ensureBuilt(dir, script);
});

interface Manifest {
  manifest_version: number;
  key?: string;
  minimum_chrome_version?: string;
  permissions?: string[];
  icons?: Record<string, string>;
  content_security_policy?: { extension_pages?: string };
}
const readManifest = async (dir: string) => JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as Manifest;
const committedKey = async () => (await readFile(join(REPO_ROOT, 'apps/extension/extension-key.pub.txt'), 'utf8')).replace(/\s+/g, '');

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

test('moving the unpacked folder keeps the extension id (and so its stored data)', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'sop-moved-'));
  const moved = join(parent, 'Documents', 'sickofpdfs moved');
  await cp(TEST_BUILD_DIR, moved, { recursive: true });
  let run: RawRun | undefined;
  try {
    run = await launchRaw(moved);
    expect(run.extensionId).toBe(EXTENSION_ID);
  } finally {
    await run?.dispose();
    await rm(parent, { recursive: true, force: true });
  }
});

// eslint-disable-next-line no-empty-pattern -- Playwright needs the destructuring pattern to see which fixtures are wanted
test('the production build has the same id, and has no test hooks; the test build has them', async ({}, testInfo) => {
  const hooksType = async (dir: string, wait: boolean) => {
    const run = await launchRaw(dir);
    try {
      expect(run.extensionId).toBe(EXTENSION_ID);
      const page = await run.context.newPage();
      await page.goto(buildViewerUrl({ source: 'http://127.0.0.1:9/f/t12-sample.pdf', back: null, page: null }, BASE));
      await page.waitForLoadState('load');
      if (wait) await page.waitForFunction(() => typeof (globalThis as { __sopTest?: unknown }).__sopTest !== 'undefined', undefined, { timeout: 15_000 });
      else await page.waitForTimeout(2000);
      await page.screenshot({ path: testInfo.outputPath(`t12-viewer-${wait ? 'test' : 'production'}-build.png`) });
      return await page.evaluate(() => typeof (globalThis as { __sopTest?: unknown }).__sopTest);
    } finally {
      await run.dispose();
    }
  };
  // The test build is the positive control: the same probe must find the hooks there, or "absent" would prove nothing.
  expect(await hooksType(TEST_BUILD_DIR, true)).toBe('object');
  expect(await hooksType(PROD_BUILD_DIR, false)).toBe('undefined');
});

test('no file of the production build mentions the test hooks; the test build does', async () => {
  const mentions = async (dir: string) => {
    const hits: string[] = [];
    for (const file of await filesUnder(dir)) {
      if ((await stat(file)).size > 50_000_000) continue;
      if ((await readFile(file)).includes('__sopTest')) hits.push(file.slice(dir.length));
    }
    return hits;
  };
  expect((await mentions(TEST_BUILD_DIR)).length, 'the test build must contain the hooks').toBeGreaterThan(0);
  expect(await mentions(PROD_BUILD_DIR)).toEqual([]);
});

test('both builds carry the committed public key, so both get the one id', async () => {
  const key = await committedKey();
  for (const [name, dir] of BUILDS) {
    const manifest = await readManifest(dir);
    expect(manifest.manifest_version, name).toBe(3);
    expect(manifest.key, `${name} build key`).toBe(key);
  }
});

test('the manifest sets Chrome 128 or newer, and a policy that cannot load code from outside', async () => {
  for (const [name, dir] of BUILDS) {
    const manifest = await readManifest(dir);
    expect(parseInt(manifest.minimum_chrome_version ?? '0', 10), `${name} minimum_chrome_version`).toBeGreaterThanOrEqual(128);
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    const scriptSrc = /(?:^|;)\s*script-src\s+([^;]*)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc, `${name} script-src`).toContain("'self'");
    expect(scriptSrc, `${name} script-src lets wasm run (PDFium)`).toContain("'wasm-unsafe-eval'");
    // nothing that runs text as code, and no way to name an outside host, blob or data URL as a script source
    expect(scriptSrc, `${name} script-src`).not.toMatch(/(?<!wasm-)unsafe-eval|unsafe-inline|https?:|\*|blob:|data:|filesystem:/);
  }
});

test('every icon size the manifest names exists in the build and is a PNG of that size', async () => {
  for (const [name, dir] of BUILDS) {
    const { icons } = await readManifest(dir);
    expect(Object.keys(icons ?? {}), `${name} icon sizes`).toEqual(expect.arrayContaining(['16', '32', '48', '128']));
    for (const [size, file] of Object.entries(icons ?? {})) {
      const bytes = await readFile(join(dir, file));
      expect(bytes.subarray(0, 8).toString('hex'), `${name} ${file} is a PNG`).toBe('89504e470d0a1a0a');
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], `${name} ${file} pixels`).toEqual([Number(size), Number(size)]);
    }
  }
});

test('the manifest asks for the permissions the spec relies on (unlimited storage, the hidden offscreen page)', async () => {
  for (const [name, dir] of BUILDS) {
    const { permissions = [] } = await readManifest(dir);
    expect(permissions, `${name} permissions`).toEqual(expect.arrayContaining(['unlimitedStorage', 'offscreen']));
  }
});
