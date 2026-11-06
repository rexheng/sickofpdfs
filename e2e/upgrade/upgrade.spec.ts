// R104: the upgrade check. Installs the PREVIOUS test build (unpacked), makes a small library with the real interface, replaces the
// build's files in the same folder, presses Reload on chrome://extensions as the owner does, and checks nothing is lost.
//   UPGRADE_PREVIOUS_DIR  the previous test build, unpacked (required; `pnpm upgrade:check -- <dir>`)
//   UPGRADE_NEW_DIR       the new build (default: apps/extension/.output/chrome-mv3, from `pnpm build`)
// It does not use the test hooks: the previous build is a production build, so everything is driven through the page like a person.
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { EXTENSION_ID } from '../../apps/extension/scripts/extension-id.mjs';
import { buildViewerUrl } from '../../apps/extension/src/shared/viewer-url';
import { SCHEMA_VERSION } from '../../apps/extension/src/store/schema-v2';
import { launchExtension, PROD_BUILD_DIR, waitForExtensionWorker } from '../support/launch';
import { startFixtureServer, type FixtureServer } from '../support/server';

const PREVIOUS = process.env.UPGRADE_PREVIOUS_DIR;
const NEW = process.env.UPGRADE_NEW_DIR ?? PROD_BUILD_DIR;
const ORIGIN = `chrome-extension://${EXTENSION_ID}`;

interface Paper {
  file: string;
  title: RegExp;
}
const A: Paper = { file: 'classifier/learning/arxiv-1706.03762-attention.pdf', title: /Attention Is All You Need/ };
const B: Paper = { file: 'classifier/learning/arxiv-1512.03385-resnet.pdf', title: /Deep Residual Learning/ };
const C: Paper = { file: 'classifier/learning/arxiv-1603.02754-xgboost.pdf', title: /XGBoost/ };

const TAG = 'upgrade-check-tag';
const CONTEXT = 'Why I read this: the upgrade check, written before the update.';
const COMMENT_A = 'Comment on paper A before the update';
const COMMENT_B = 'Comment on paper B before the update';
const UNSENT = 'Unsent words left in the box before the update';
const RULE_SITE = 'upgrade-check.example.org';

// ---------------------------------------------------------------------------------------------------------------- helpers

async function viewerFor(context: BrowserContext, server: FixtureServer, paper: Paper): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.goto(buildViewerUrl({ source: server.url(`/f/${paper.file}`), back: null, page: null }, `${ORIGIN}/viewer.html`));
  await page.waitForSelector('[data-page-index="0"] span[data-start]', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Saved to library/ })).toBeVisible({ timeout: 30_000 });
  return page;
}

/** Drags over the `n`th line of body text on page 1 (words 1 to 6 of it): a real mouse drag, then waits for the selection. */
async function selectLine(page: Page, n: number): Promise<string> {
  const box = await page.evaluate((line) => {
    const spans = [...document.querySelectorAll<HTMLElement>('[data-page-index="0"] span[data-start]')]
      .map((s) => ({ s, r: s.getBoundingClientRect() }))
      .filter(({ r }) => r.top > 360 && r.bottom < 900 && r.width > 0);
    const lines: (typeof spans)[] = [];
    for (const x of spans) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last[0].r.top - x.r.top) < 4) last.push(x);
      else lines.push([x]);
    }
    const words = (lines.filter((l) => l.length >= 8)[line] ?? []).slice(0, 6);
    if (words.length === 0) return null;
    const a = words[0].r;
    const b = words[words.length - 1].r;
    return { ax: a.left + 2, ay: a.top + a.height / 2, bx: b.right - 2, by: b.top + b.height / 2 };
  }, n);
  if (!box) throw new Error(`no line ${n} to select`);
  await page.mouse.move(box.ax, box.ay);
  await page.mouse.down();
  await page.mouse.move(box.bx, box.by, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => String(getSelection()).trim().length)).toBeGreaterThan(4);
  return page.evaluate(() => String(getSelection()).trim());
}

const marksOf = (page: Page) => page.evaluate(() => document.querySelector('svg.sop-marks')?.children.length ?? 0);
const noteBox = (page: Page) => page.getByRole('textbox', { name: /^(?!.*\b(?:reply|edit)\b).*\b(?:note|comment)\b/i });
const card = (page: Page, text: string) => page.getByRole('article', { name: /^(note by|new note)/i }).filter({ hasText: text });

async function addNote(page: Page, line: number, text: string): Promise<void> {
  await selectLine(page, line);
  await page.keyboard.press('Control+Alt+m');
  await expect(noteBox(page)).toBeVisible({ timeout: 5000 });
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press('Enter');
  await expect(card(page, text)).toBeVisible({ timeout: 10_000 });
}

/** Three marks (highlight, underline, strikethrough) on three lines. Returns how many mark shapes page 1 now draws. */
async function addMarks(page: Page): Promise<number> {
  await selectLine(page, 0);
  await page.keyboard.press('h');
  await selectLine(page, 2);
  await page.keyboard.press('Control+u');
  await selectLine(page, 4);
  await page.keyboard.press('Alt+Shift+5');
  await expect.poll(() => marksOf(page), { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(500);
  return marksOf(page);
}

/** Library, About panel of the open PDF: tag and context. */
async function addTagAndContext(page: Page): Promise<void> {
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /About this PDF/ }).click();
  const tag = page.getByPlaceholder('Add a tag');
  await tag.fill(TAG);
  await tag.press('Enter');
  await expect(page.getByRole('list', { name: /Tags on this reading/ })).toContainText(TAG, { timeout: 10_000 });
  const context = page.getByRole('textbox', { name: 'Your context' });
  await context.fill(CONTEXT);
  await page.waitForTimeout(1500); // "Saved as you type"
  await context.blur();
  await page.waitForTimeout(800);
}

async function readAbout(page: Page): Promise<{ tags: string; context: string }> {
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /About this PDF/ }).click();
  const context = page.getByRole('textbox', { name: 'Your context' });
  await expect(context).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('list', { name: /Tags on this reading/ })).toContainText(TAG, { timeout: 10_000 });
  return { tags: (await page.getByRole('list', { name: /Tags on this reading/ }).innerText()).trim(), context: await context.inputValue() };
}

async function libraryPage(context: BrowserContext, route: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${ORIGIN}/library.html#/${route}`);
  return page;
}

async function setSettings(context: BrowserContext): Promise<void> {
  const page = await libraryPage(context, 'settings');
  await page.getByRole('textbox', { name: /Add to/ }).first().fill(RULE_SITE);
  await page.getByRole('button', { name: /^Add to/ }).first().click();
  await expect(page.getByText(RULE_SITE)).toBeVisible({ timeout: 10_000 });
  const sw = page.getByRole('switch', { name: 'Bold word starts' });
  await sw.click();
  await expect(sw).toBeChecked();
  await page.close();
}

async function readSettings(context: BrowserContext): Promise<{ rule: boolean; boldWordStarts: boolean }> {
  const page = await libraryPage(context, 'settings');
  const rule = await page.getByText(RULE_SITE).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  const bold = page.getByRole('switch', { name: 'Bold word starts' });
  const boldWordStarts = await expect.poll(() => bold.isChecked().catch(() => false), { timeout: 10_000 }).toBe(true).then(() => true, () => false);
  const stored = await page.evaluate(async () => (await chrome.storage.local.get('view.boldWordStarts'))['view.boldWordStarts']);
  await page.close();
  return { rule, boldWordStarts: boldWordStarts && stored === true };
}

/** The library's rows (titles), the tag list in the left column, and Home's "Updated" note, as the owner sees them. */
async function readLibrary(context: BrowserContext): Promise<{ titles: string[]; tagCount: string; updatedNote: string | null }> {
  const home = await libraryPage(context, 'home');
  await home.waitForLoadState('domcontentloaded');
  const note = home.getByText(/^Updated to /);
  const updatedNote = await note.first().innerText({ timeout: 8000 }).catch(() => null);
  await home.close();
  const page = await libraryPage(context, 'library');
  await expect(page.getByText(/Attention Is All You Need/).first()).toBeVisible({ timeout: 20_000 });
  const body = await page.locator('main, body').first().innerText();
  const titles = [A, B, C].filter((p) => p.title.test(body)).map((p) => String(p.title));
  const tagCount = (await page.getByRole('navigation').filter({ hasText: TAG }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  await page.close();
  return { titles, tagCount, updatedNote };
}

/** `PRAGMA user_version` of the library database, read from its file in OPFS (SQLite header, big-endian, byte 60 after the pool's 4096). */
async function schemaVersion(context: BrowserContext): Promise<number | null> {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/library.html#/home`);
  const v = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('.sop-db');
    const opaque = await dir.getDirectoryHandle('.opaque');
    for await (const [, h] of opaque.entries()) {
      if (h.kind !== 'file') continue;
      const bytes = new Uint8Array(await (await (h).getFile()).arrayBuffer());
      if (bytes.length > 4200 && new TextDecoder('latin1').decode(bytes.slice(4096, 4111)) === 'SQLite format 3') {
        return new DataView(bytes.buffer).getUint32(4096 + 60, false);
      }
    }
    return null;
  });
  await page.close();
  return v;
}

/** Every other thing a build upgrade could break, read raw from the extension's own storage. */
async function rawState(context: BrowserContext): Promise<{ drafts: string[]; storageKeys: string[]; pdfBlobs: number }> {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/library.html#/home`);
  const out = await page.evaluate(async () => {
    const drafts = Object.keys(localStorage).filter((k) => k.startsWith('sop-draft:')).map((k) => `${k}=${localStorage.getItem(k)}`);
    const storageKeys = Object.keys(await chrome.storage.local.get(null)).sort();
    let pdfBlobs = 0;
    const walk = async (d: FileSystemDirectoryHandle): Promise<void> => {
      for await (const [, h] of d.entries()) {
        if (h.kind === 'directory') await walk(h);
        else pdfBlobs++;
      }
    };
    const root = await navigator.storage.getDirectory();
    await walk(await root.getDirectoryHandle('pdf').catch(() => root.getDirectoryHandle('.nothing', { create: true })));
    return { drafts, storageKeys, pdfBlobs };
  });
  await page.close();
  return out;
}

async function enableDeveloperMode(context: BrowserContext): Promise<void> {
  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  const toggle = page.locator('extensions-toolbar cr-toggle#devMode');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.locator('extensions-toolbar cr-toggle#devMode[aria-pressed="true"]').waitFor();
  await page.close();
}

/** The Reload button on the extension's card in chrome://extensions, which is the owner's step 4. Returns the card's version text. */
async function pressReload(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  await page.goto('chrome://extensions/');
  const item = page.locator(`extensions-item#${EXTENSION_ID}`);
  const versionBefore = (await item.locator('#version').innerText().catch(() => '')).trim();
  await item.locator('#dev-reload-button').click();
  await page.waitForTimeout(1500);
  await page.close();
  return versionBefore;
}

async function manifestOf(context: BrowserContext): Promise<{ version: string; version_name?: string }> {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/library.html#/home`);
  const m = await page.evaluate(() => chrome.runtime.getManifest());
  await page.close();
  return m;
}

// ---------------------------------------------------------------------------------------------------------------- the check

test.describe('upgrade check', () => {
  test.skip(!PREVIOUS, 'UPGRADE_PREVIOUS_DIR is not set: run `pnpm upgrade:check -- <previous-unpacked-dir>`');
  test.setTimeout(600_000);

  let work: string;
  let server: FixtureServer & { close(): Promise<void> };
  test.beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), 'sop-upgrade-'));
    server = await startFixtureServer();
  });
  test.afterEach(async () => {
    await server.close();
    await rm(work, { recursive: true, force: true });
  });

  /** One folder, as the owner keeps it (C:\sickofpdfs): the previous build is copied in. */
  async function install(): Promise<{ folder: string; profile: string }> {
    const folder = join(work, 'sickofpdfs');
    await cp(PREVIOUS!, folder, { recursive: true });
    return { folder, profile: join(work, 'profile') };
  }

  async function makeLibrary(context: BrowserContext): Promise<{ marksA: number; marksB: number; keep: Page }> {
    await enableDeveloperMode(context);
    // paper A: marks, a comment, a tag and a context note
    const a = await viewerFor(context, server, A);
    await addMarks(a);
    await addNote(a, 6, COMMENT_A);
    await addTagAndContext(a);
    await a.close();
    // paper B: a mark and a comment
    const b = await viewerFor(context, server, B);
    await selectLine(b, 1);
    await b.keyboard.press('h');
    await expect.poll(() => marksOf(b)).toBeGreaterThanOrEqual(1);
    await addNote(b, 3, COMMENT_B);
    await b.close();
    // paper C: a note started and left unsent, in a tab that stays open
    const keep = await viewerFor(context, server, C);
    // The owner reads first: Test build 6 and older drop the note's journal copy if it is begun in the seconds after the save (heldletters-report.md).
    await keep.waitForTimeout(6000);
    await selectLine(keep, 1);
    await keep.keyboard.press('Control+Alt+m');
    await expect(noteBox(keep)).toBeVisible({ timeout: 5000 });
    await keep.keyboard.type(UNSENT, { delay: 5 });
    await expect.poll(() => keep.evaluate((w) => Object.keys(localStorage).some((k) => k.startsWith('sop-draft:c:') && (localStorage.getItem(k) ?? '').includes(w)), UNSENT)).toBe(true);
    await setSettings(context);
    // what each paper draws when it is opened fresh, with no note box open: the numbers to match after the update
    const marks: number[] = [];
    for (const paper of [A, B]) {
      const p = await viewerFor(context, server, paper);
      await expect(card(p, paper === A ? COMMENT_A : COMMENT_B)).toBeVisible({ timeout: 15_000 });
      await p.waitForTimeout(800);
      marks.push(await marksOf(p));
      await p.close();
    }
    return { marksA: marks[0], marksB: marks[1], keep };
  }

  async function verifyEverything(context: BrowserContext, before: { marksA: number; marksB: number; raw: Awaited<ReturnType<typeof rawState>> }, label: string): Promise<void> {
    // the database is at the current schema
    expect(await schemaVersion(context), `${label}: database schema`).toBe(SCHEMA_VERSION);
    // the library shows the three readings and the tag
    const lib = await readLibrary(context);
    expect(lib.titles, `${label}: readings in the library`).toHaveLength(3);
    expect(lib.tagCount, `${label}: the tag is listed`).toContain(TAG);
    // settings
    expect(await readSettings(context), `${label}: settings`).toEqual({ rule: true, boldWordStarts: true });
    // paper A: marks, comment, tag and context
    const a = await viewerFor(context, server, A);
    await expect(card(a, COMMENT_A), `${label}: paper A comment`).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => marksOf(a), { message: `${label}: paper A marks`, timeout: 10_000 }).toBe(before.marksA);
    expect(await readAbout(a), `${label}: paper A tag and context`).toEqual({ tags: expect.stringContaining(TAG) as unknown as string, context: CONTEXT });
    await a.close();
    // paper B
    const b = await viewerFor(context, server, B);
    await expect(card(b, COMMENT_B), `${label}: paper B comment`).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => marksOf(b), { message: `${label}: paper B marks`, timeout: 10_000 }).toBe(before.marksB);
    await b.close();
    // the unsent note: still in the drafts journal, and the paper gives it back
    const raw = await rawState(context);
    expect(raw.drafts.some((d) => d.includes(UNSENT)), `${label}: the unsent note is still in the drafts journal`).toBe(true);
    expect(raw.pdfBlobs, `${label}: saved PDF copies`).toBe(before.raw.pdfBlobs);
    const c = await viewerFor(context, server, C);
    await expect
      .poll(() => c.evaluate((words) => [...document.querySelectorAll('textarea,input,[contenteditable]')].some((e) => ((e as HTMLTextAreaElement).value ?? e.textContent ?? '').includes(words)) || document.body.innerText.includes(words), UNSENT), {
        message: `${label}: the unsent note comes back on paper C`,
        timeout: 15_000,
      })
      .toBe(true);
    await c.close();
  }

  test('replacing the files and pressing Reload loses nothing', async () => {
    const { folder, profile } = await install();
    let context = await launchExtension({ userDataDir: profile, extensionDir: folder });
    await waitForExtensionWorker(context);
    const previous = await manifestOf(context);
    const made = await makeLibrary(context);
    const before = { marksA: made.marksA, marksB: made.marksB, raw: await rawState(context) };
    const schemaBefore = await schemaVersion(context);
    expect(before.raw.drafts.some((d) => d.includes(UNSENT))).toBe(true);
    console.log(`before: version ${previous.version}, schema ${schemaBefore}, marks A ${made.marksA} B ${made.marksB}, storage keys ${before.raw.storageKeys.join(',')}`);

    // The owner's steps 3 and 4: unzip the new build over the same folder, then press the reload arrow. The paper C tab is still open.
    await cp(NEW, folder, { recursive: true, force: true });
    await pressReload(context);
    await made.keep.close().catch(() => {});
    await waitForExtensionWorker(context, 20_000).catch(() => undefined);
    const after = await manifestOf(context);
    console.log(`after reload: version ${after.version} (${after.version_name ?? 'no version_name'})`);
    expect(after.version, 'the new build is the one running').not.toBe(previous.version);
    const newManifest = JSON.parse(await readFile(join(NEW, 'manifest.json'), 'utf8')) as { version: string };
    expect(after.version).toBe(newManifest.version);

    // "Updated to test build N. Your library is safe." shows once
    const lib = await readLibrary(context);
    if (after.version_name) {
      expect(lib.updatedNote, 'the Updated note').toMatch(new RegExp(`^Updated to ${after.version_name.toLowerCase()}\\. Your library is safe\\.`));
      expect((await readLibrary(context)).updatedNote, 'the Updated note shows only once').toBeNull();
    } else {
      console.log('NOTE: the new build has no version_name (not built through `pnpm test-build`), so no Updated note is expected');
    }

    // the takeover still works after the update: a PDF link opened in a tab ends in the viewer
    const tab = await context.newPage();
    await tab.goto(server.url(`/f/${B.file}`));
    await expect.poll(() => tab.url(), { message: 'the takeover rules were made again after the update', timeout: 20_000 }).toContain(`${ORIGIN}/viewer.html`);
    await tab.close();

    await verifyEverything(context, before, 'after Reload');

    // and again after Chrome is closed and started cold
    await context.close();
    context = await launchExtension({ userDataDir: profile, extensionDir: folder });
    await waitForExtensionWorker(context);
    await verifyEverything(context, before, 'after a cold start');
    await context.close();
  });

  test('removing the extension and adding it again does lose the library (so the update text must say so)', async () => {
    const { folder, profile } = await install();
    let context = await launchExtension({ userDataDir: profile, extensionDir: folder });
    await waitForExtensionWorker(context);
    await makeLibrary(context);
    expect((await readLibrary(context)).titles).toHaveLength(3);

    // Remove. Chrome's own confirmation is a native window that a script cannot press (headless), so this does what Chrome does when
    // the removal is confirmed: it deletes everything stored under the extension's id (its files in OPFS, localStorage, IndexedDB and
    // chrome.storage). The check shows that the library lives only there.
    const page = await libraryPage(context, 'home');
    await page.evaluate(() => chrome.storage.local.clear());
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.clearDataForOrigin', { origin: ORIGIN, storageTypes: 'all' });
    await page.close();
    await context.close();

    // Add it again (Load unpacked is a launch flag in this harness) in the same profile and folder.
    context = await launchExtension({ userDataDir: profile, extensionDir: folder });
    await waitForExtensionWorker(context);
    const lib = await (async () => {
      const p = await libraryPage(context, 'library');
      await p.waitForTimeout(4000);
      const text = await p.locator('body').innerText();
      await p.close();
      return text;
    })();
    expect(A.title.test(lib) || B.title.test(lib) || C.title.test(lib), 'after Remove and add again, the readings are gone').toBe(false);
    expect((await rawState(context)).drafts.some((d) => d.includes(UNSENT)), 'and so is the unsent note').toBe(false);
    await context.close();
  });
});
