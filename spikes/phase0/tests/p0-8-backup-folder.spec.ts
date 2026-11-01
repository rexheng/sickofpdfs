import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { test } from './fixtures';
import { record, RESULTS_DIR } from './record';

// The brief's P0-8a–c, with their assertions unchanged, where the browser allows them.
// - 8a needs the directory picker. Headless Playwright Chromium cannot drive it (see 8a), so 8a records BLOCKED,
//   with the exact events and error, and 8b records BLOCKED too: the picker stored no handle to restart with.
// - 8c needs a handle whose readwrite permission is 'prompt'. The picker's handle is one after a restart. Without
//   it, 8c takes a folder dropped on the page with CDP Input.dispatchDragEvent: a real FileSystemDirectoryHandle
//   with read granted and readwrite 'prompt'. 8c says which one it used.
// The profile p08 (results/profiles/p08, inside this checkout) is shared by the three tests, one browser process each.
const PROFILE = 'p08';
const PROBE_TEXT = 'sickofpdfs backup probe';

const tempDirs: string[] = [];
/** A fresh empty folder to pick or drop; removed after the last test. */
async function tempFolder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sop-backup-'));
  tempDirs.push(dir);
  return dir;
}
test.afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

async function chromeVersion(context: BrowserContext, page: Page): Promise<string> {
  const cdp = await context.newCDPSession(page);
  const { product } = await cdp.send('Browser.getVersion');
  await cdp.detach();
  return product;
}

/** Drops the folder `dir` on the page as the OS would (CDP Input.dispatchDragEvent) and returns what the page made of it. */
async function dropFolder(context: BrowserContext, page: Page, dir: string) {
  const cdp = await context.newCDPSession(page);
  const data = { items: [], files: [dir], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: 100, y: 100, data });
  await cdp.detach();
  await page.waitForFunction(() => (window as any).__backupDropped !== undefined, undefined, { timeout: 10_000 });
  return page.evaluate(() => (window as any).__backupDropped);
}

test('P0-8a: showDirectoryPicker in an extension tab yields a writable handle (picker intercepted)', async ({ launchSpike }) => {
  // 8b and 8c must see only what this run stored.
  await rm(join(RESULTS_DIR, 'profiles', PROFILE), { recursive: true, force: true });
  const { context, page } = await launchSpike({ profile: PROFILE, check: 'backup-folder' });
  const dir = await tempFolder();
  // What Chromium itself reports about the picker, next to what Playwright makes of it.
  const cdp = await context.newCDPSession(page);
  const cdpChoosers: { mode?: string; backendNodeId?: number }[] = [];
  cdp.on('Page.fileChooserOpened', (e) => cdpChoosers.push(e));
  await cdp.send('Page.enable');
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });

  const chooser = page.waitForEvent('filechooser', { timeout: 5000 }).then((fc) => fc.setFiles(dir)).catch(() => 'no-chooser');
  const r = await page.evaluate(() => (window as any).spikeBackupPick()); // click-initiated pick, writes backup-probe.txt, stores the handle in IndexedDB
  if ((await chooser) === 'no-chooser') {
    const version = await chromeVersion(context, page);
    await record('P0-8', {
      pass: 'blocked',
      measured:
        `8a: the directory picker cannot be driven. showDirectoryPicker() rejected at once with ${JSON.stringify(r.error)}; ` +
        `Playwright's filechooser event did not fire in 5 s; CDP Page.fileChooserOpened fired ${cdpChoosers.length}× ` +
        `(${cdpChoosers.map((c) => `mode ${c.mode}, backendNodeId ${c.backendNodeId ?? 'none'}`).join('; ') || 'no event'}); ` +
        `${version} (HeadlessChrome, Playwright 1.63.0)`,
      note:
        "Playwright's crPage ignores Page.fileChooserOpened without a backendNodeId, which a File System Access picker never has, and CDP has no command that answers one. " +
        'Picking is left to the Windows run: W-B1..W-B3',
    });
    // The block is the harness's, not a mistake in the page function: the browser was asked and aborted the picker.
    expect(r.error).toMatch(/^AbortError: .*showDirectoryPicker/);
    expect(cdpChoosers.length).toBeGreaterThan(0);
    return;
  }
  expect(await readFile(join(dir, 'backup-probe.txt'), 'utf8')).toBe(PROBE_TEXT);
  expect(r.permission).toBe('granted');
  await record('P0-8', { pass: true, measured: `8a: picker intercepted with filechooser; backup-probe.txt written (${PROBE_TEXT.length} bytes), permission ${r.permission}, handle stored` });
});

test('P0-8b: after a browser restart the stored handle reports granted or prompt', async ({ launchSpike }) => {
  const first = await launchSpike({ profile: PROFILE, check: 'backup-folder' }); // same user-data dir, new browser process
  const state = await first.page.evaluate(() => (window as any).spikeBackupQuery());
  if (state === 'no-handle') {
    // 8a stored no handle, so there is nothing of the picker's to restart with. What a folder dropped with CDP
    // does across a restart is measured in its place and reported as such; it is not an 8b result.
    let dropped: string;
    try {
      const stored = await dropFolder(first.context, first.page, await tempFolder());
      expect(stored).toMatchObject({ stored: true });
      await first.context.close();
      const second = await launchSpike({ profile: PROFILE, check: 'backup-folder' });
      const after = await second.page.evaluate(() => (window as any).spikeBackupInspect('dropped'));
      dropped = after.present ? `after a restart read ${after.read}, readwrite ${after.readwrite}` : 'not found after a restart';
      dropped = `read ${stored.read}, readwrite ${stored.readwrite} when dropped; ${dropped}`;
    } catch (e) {
      dropped = `the drop route failed: ${String(e).split('\n')[0]}`;
    }
    await record('P0-8', {
      pass: 'blocked',
      measured: `8b: no handle to restart with, because 8a's picker cannot be driven. Not an 8b result: a folder dropped with CDP and stored in IndexedDB: ${dropped}`,
      note: 'Whether the picker\'s handle reports granted or prompt after a restart, and whether the "Allow on every visit" prompt appears, is left to W-B1',
    });
    return;
  }
  await record('P0-8', { pass: ['granted', 'prompt'].includes(state), measured: `8b: after restart: ${state}` });
  expect(['granted', 'prompt']).toContain(state);
});

test('P0-8c: requestPermission without a user gesture is refused', async ({ launchSpike }) => {
  const { context, page } = await launchSpike({ profile: PROFILE, check: 'backup-folder' });
  let source: 'picked' | 'dropped' = 'picked';
  let handle = 'the handle 8a stored from the picker, after a restart';
  if ((await page.evaluate(() => (window as any).spikeBackupQuery())) === 'no-handle') {
    const stored = await dropFolder(context, page, await tempFolder());
    expect(stored).toMatchObject({ stored: true });
    source = 'dropped';
    handle = `a folder dropped with CDP (read ${stored.read}, readwrite ${stored.readwrite}), the picker being undrivable`;
  }
  // The page waits for the activation of this very evaluate to lapse (about 5 s) before it calls requestPermission.
  const result: string = await page.evaluate((s) => (window as any).spikeBackupRequestNoGesture(s), source);
  const call = await page.evaluate(() => (window as any).__backupRequest);
  // Control: the same call with a user gesture (page.evaluate has one) is not refused. Headless Chromium cannot show
  // or answer the permission prompt, so it stays pending. It shows the refusal above is about the gesture.
  const control = await page.evaluate((s) => (window as any).spikeBackupRequest(s), source);
  const refused = /SecurityError|NotAllowedError|prompt/.test(result) && call.activeAtCall === false && call.before === 'prompt';
  await record('P0-8', {
    pass: refused,
    measured:
      `8c: handle: ${handle}. requestPermission({mode:'readwrite'}) with no user activation (userActivation.isActive ${call.activeAtCall}, ` +
      `handle was ${call.before}) -> ${JSON.stringify(result)}; after: ${call.after}. ` +
      `Control with a user gesture (userActivation.isActive ${control.activeAtCall}) -> ${JSON.stringify(control.result)} after ${control.ms} ms`,
  });
  expect(result).toMatch(/SecurityError|NotAllowedError|prompt/);
  expect(call.activeAtCall).toBe(false);
  expect(call.before).toBe('prompt');
  expect(control.result).not.toMatch(/SecurityError/); // so the refusal above is about the missing gesture
});
