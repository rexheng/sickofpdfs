// Spec-blind helpers for the Phase 3 walkthroughs (the learning filter, the library, search, backup and restore).
//
// Written from the spec ("Library and knowledge base", "Learning filter and privacy", "Storage, sync and backup"), the cross-phase
// contracts (section 5) and the plan's Gate 1 list. Where those name no markup, the helpers look for what the owner reads or
// what a screen reader announces (roles and accessible names), never a CSS class.
//
// Three kinds of "is the feature there yet" guards, all in this file so a test's header says in one line why it is skipped:
//  - FILTER_IN_VIEWER: the viewer's code calls the real classifier (`classify(`). Until then Phase 1's stand-in calls every PDF
//    "Not sure", and the filter walkthroughs cannot say anything true.
//  - BACKUP_WRITER: the contracts put the writer in apps/extension/src/backup/ (contracts section 1, "Backup format").
//  - runtime checks on a page ("is this page built yet", "does Ctrl+K open a palette") for the rest.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import { REPO_ROOT } from '../../support/launch';
import { readNetlogRequests } from '../../support/netlog';
import { TEST_ASSETS } from '../../support/server';
import { listOpfs, save as saveOf } from '../../support/save-probe.spec-blind';
import { scanOpfs, store as storeOf, waitForStore, ZERO_STATS } from '../../support/store-probe.spec-blind';
import { EXTENSION_ID, expect, hooks, probeIdb, sha256File, type NetGate } from '../../support/test';

export { waitForStore };

// ---------------------------------------------------------------------------------------------------------------
// What exists in this tree

const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sourcesUnder(rel: string): string[] {
  const root = join(REPO_ROOT, rel);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'node_modules') walk(path);
      } else if (/\.tsx?$/.test(name) && !/\.(test|spec-blind|browser\.test)\./.test(name) && !/\.spec-blind\./.test(name)) out.push(path);
    }
  };
  walk(root);
  return out;
}

/**
 * `P3_RUN_ALL=1 npx playwright test ...` runs the guarded walkthroughs even though their slice is not in the tree, so a run can show
 * why each one fails today (the guards are there to keep a merge round quiet, not to hide anything).
 */
export const FORCE = process.env.P3_RUN_ALL === '1';

/** True once the viewer's own code calls the real classifier. Phase 1's stand-in never does. */
export const FILTER_IN_VIEWER = FORCE || sourcesUnder('apps/extension/src/viewer').some((f) => /\bclassify\s*\(/.test(code(readFileSync(f, 'utf8'))));
export const NO_FILTER = 'needs the real learning filter in the viewer (slice S11): the viewer does not call classify() yet, so Phase 1\'s stand-in still calls every PDF "Not sure"';

/** True once the viewer's code uses the Markdown export (contracts section 5: `exportMarkdown`). */
export const EXPORT_IN_VIEWER = FORCE || sourcesUnder('apps/extension/src/viewer').some((f) => /\bexportMarkdown\b/.test(code(readFileSync(f, 'utf8'))));
export const NO_EXPORT = 'needs the Export notes action in the viewer (slice S3 part 2): nothing in apps/extension/src/viewer/ uses exportMarkdown yet';

/** The contracts put the backup writer in apps/extension/src/backup/. */
export const BACKUP_WRITER = FORCE || existsSync(join(REPO_ROOT, 'apps/extension/src/backup'));
export const NO_BACKUP = 'needs the backup writer (slice S13): apps/extension/src/backup/ does not exist yet';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

export interface Pdf {
  /** Under test-assets/. */
  file: string;
  /** The path the fixture server serves it at. */
  path: string;
  /** The real title as printed on page 1. */
  title: RegExp;
  /** The title, or (if the library cannot find one) the file name: for finding the row in a list. */
  rowName: RegExp;
}
const pdf = (file: string, title: RegExp, rowName: RegExp): Pdf => ({ file, path: `/f/${file}`, title, rowName });

export const ATTENTION = pdf('classifier/learning/arxiv-1706.03762-attention.pdf', /attention is all you need/i, /attention is all you need|arxiv-1706\.03762/i);
export const RESNET = pdf('classifier/learning/arxiv-1512.03385-resnet.pdf', /deep residual learning/i, /deep residual learning|arxiv-1512\.03385/i);
export const DID = pdf('classifier/learning/arxiv-1803.09015-did-multiple-periods.pdf', /difference-in-differences with multiple time periods/i, /difference-in-differences|arxiv-1803\.09015/i);
export const PLOS = pdf('classifier/learning/plosone-10.1371-journal.pone.0000308.pdf', /sharing detailed research data/i, /sharing detailed research data|plosone|pone\.0000308/i);
export const PLOS_DOI = '10.1371/journal.pone.0000308';
export const ATTENTION_ARXIV = '1706.03762';
/** The MIT handout the plan says the filter cannot decide on its own ("not sure"). */
export const HANDOUT = pdf('classifier/learning/handout-mit-14.01-f23-handout10.pdf', /market equilibrium|handout/i, /handout|market equilibrium/i);
/** An invoice (text) and a receipt (text): "Not saved: looks like ...". */
export const INVOICE = pdf('classifier/not-learning/invoice-aws-sample.pdf', /invoice/i, /invoice/i);
export const RECEIPT = pdf('classifier/not-learning/receipt-oyo-hotel.pdf', /receipt/i, /receipt|oyo/i);
/** A phrase on the AWS invoice's first page, and one on the OYO receipt's. */
export const INVOICE_PHRASE = 'This invoice is for';
export const RECEIPT_PHRASE = 'PAYMENT RECEIPT';

/** A phrase that is on page 8 of the DiD paper and on no other page (checked with pdftotext). */
export const DID_PAGE8_PHRASE = 'choose treatment status';
export const DID_PAGE8_INDEX = 7;

export const fixtureUrl = (server: { url(p: string): string }, f: Pdf | string): string => server.url(typeof f === 'string' ? f : f.path);
export const fileOf = (f: Pdf): string => join(TEST_ASSETS, f.file);
export const shaOf = (f: Pdf): Promise<string> => sha256File(fileOf(f));

/** Every research fixture in a folder (`learning` or `not-learning`), by name. */
export function researchFixtures(label: 'learning' | 'not-learning'): string[] {
  return readdirSync(join(TEST_ASSETS, 'classifier', label))
    .filter((n) => n.endsWith('.pdf'))
    .sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The viewer

/** Waits until the viewer has opened the PDF. */
export async function waitViewerReady(page: Page, timeout = 30_000): Promise<void> {
  await expect
    .poll(() => hooks(page).eval((h) => (h as unknown as { viewerState?: () => string }).viewerState?.() ?? null).catch(() => null), { message: 'the viewer should open the PDF', timeout })
    .toBe('ready');
}

/** The chip in the header: the save decision, in words. Its name starts with its label (the icon is not part of it). */
export const CHIP_NAME = /^(saved to library|not sure|not saved|saving|save to library|couldn.t save|in trash|incognito)/i;
export const chipOf = (page: Page): Locator => page.locator('header').getByRole('button', { name: CHIP_NAME }).first();

/** What the chip says (white space folded). */
export async function chipText(page: Page): Promise<string> {
  return ((await chipOf(page).textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

/** The chip's hover text (a Radix tooltip). Moves the pointer onto the chip and waits for it. */
export async function chipTooltip(page: Page): Promise<string> {
  await chipOf(page).hover();
  const tip = page.getByRole('tooltip').first();
  await expect(tip, 'hovering the chip shows why').toBeVisible({ timeout: 5000 });
  return ((await tip.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}

/** The save controller's state kind ('saved', 'unsure', 'not-learning', 'asking', 'checking', ...), or null if the page cannot say. */
export async function stateKind(page: Page): Promise<string | null> {
  return saveOf(page)
    .state()
    .then((s) => s?.kind ?? null)
    .catch(() => null);
}

/** Waits until the filter has decided (the state is not 'checking'). Returns the kind; null if the page left the viewer meanwhile. */
export async function decided(page: Page, timeout = 60_000): Promise<string | null> {
  const until = Date.now() + timeout;
  for (;;) {
    const kind = await stateKind(page);
    if (kind !== null && kind !== 'checking') return kind;
    if (!page.url().includes('/viewer.html')) return null; // a form PDF goes on to Chrome's own viewer
    if (Date.now() > until) throw new Error(`the filter never decided (state: ${String(kind)})`);
    await page.waitForTimeout(150);
  }
}

/** Opens a PDF from the fixture server in a new viewer tab and waits for the filter's decision. */
export async function openAndDecide(
  openViewer: (source: string) => Promise<Page>,
  url: string,
  timeout = 60_000,
): Promise<{ page: Page; kind: string | null }> {
  const page = await openViewer(url);
  const kind = await decided(page, timeout);
  return { page, kind };
}

/** The chip's Undo/Forget-style text buttons live in the header too. */
export const headerButton = (page: Page, name: string | RegExp): Locator => page.locator('header').getByRole('button', { name });

/** Opens the viewer's File menu and chooses an item by what it says. */
export async function chooseFileMenuItem(page: Page, name: RegExp): Promise<void> {
  await openFileMenu(page);
  await page.getByRole('menu').getByRole('menuitem', { name }).click();
}

/**
 * Triage (S11, rule 7): under load a click on "File" could land while the menu from the step before was still closing, and so
 * close it again; the item was then waited for until the test ran out of time (2d). Open it, and make sure it is open.
 */
async function openFileMenu(page: Page): Promise<void> {
  const file = page.getByRole('menubar').getByRole('menuitem', { name: 'File', exact: true });
  await expect(page.getByRole('menu'), 'no menu is still open').toHaveCount(0, { timeout: 10_000 });
  await file.click();
  if (!(await page.getByRole('menu').first().isVisible().catch(() => false))) {
    await page.waitForTimeout(300);
    if (!(await page.getByRole('menu').first().isVisible().catch(() => false))) await file.click();
  }
  await expect(page.getByRole('menu').first(), 'the File menu is open').toBeVisible({ timeout: 10_000 });
}

/** True when the viewer's File menu has an item with this name. */
export async function fileMenuHas(page: Page, name: RegExp): Promise<boolean> {
  await openFileMenu(page);
  const has = (await page.getByRole('menu').getByRole('menuitem', { name }).count()) > 0;
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu'), 'the File menu closes').toHaveCount(0, { timeout: 10_000 }); // Triage (S11): see openFileMenu
  return has;
}

/**
 * "Forget this PDF" (spec: "removes it completely"), from the File menu as a person does it. It asks first when there are notes; when
 * it asks, the dialog is answered with its confirming button. `never` ticks "Never save this file" when the dialog offers it.
 * Returns whether a dialog was shown, and its text.
 */
export async function forgetThisPdf(page: Page, o: { never?: boolean } = {}): Promise<{ asked: boolean; text: string }> {
  await chooseFileMenuItem(page, /forget this pdf/i);
  const dialog = page.getByRole('dialog').first();
  const asked = await dialog.waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false);
  if (!asked) return { asked, text: '' };
  const text = ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  if (o.never === true) await dialog.getByRole('checkbox', { name: /never save/i }).check();
  await dialog.getByRole('button', { name: /^(forget|remove|delete|yes|ok|continue)/i }).last().click();
  return { asked, text };
}

// ---------------------------------------------------------------------------------------------------------------
// The library tab

export type Route = 'home' | 'library' | 'recent' | 'starred' | 'notes' | 'trash' | 'settings';
export const ROUTE_LABEL: Record<Route, string> = { home: 'Home', library: 'My library', recent: 'Recent', starred: 'Starred', notes: 'Notes', trash: 'Trash', settings: 'Settings' };
export const libraryUrl = (route: Route = 'library'): string => `chrome-extension://${EXTENSION_ID}/library.html#/${route}`;

/** Opens the library tab on a page and waits for the shell. */
export async function openLibrary(context: BrowserContext, route: Route = 'library', viewport = { width: 1280, height: 800 }): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  await page.goto(libraryUrl(route));
  await expect(page.getByRole('navigation', { name: 'Library' }), 'the library shell is drawn').toBeVisible({ timeout: 20_000 });
  return page;
}

export const navLink = (page: Page, route: Route): Locator => page.getByRole('navigation', { name: 'Library' }).getByRole('link', { name: ROUTE_LABEL[route], exact: true });

export async function goTo(page: Page, route: Route): Promise<void> {
  if (route === 'settings' && !(await navLink(page, route).isVisible())) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  else await navLink(page, route).click();
  await expect.poll(() => page.url()).toContain(`#/${route}`);
}

/**
 * True when the page is a placeholder ("... isn't ready yet"): its slice has not landed. Waits for the library to connect and draw a
 * heading first, because until then the page is an empty card and says nothing either way.
 */
export async function pageNotBuilt(page: Page): Promise<boolean> {
  await page.getByRole('heading').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  return page.getByText(/isn.t ready yet/i).first().isVisible();
}

/** The reading rows of the list layout (not the header row). */
export const listRows = (page: Page): Locator => page.getByRole('grid').getByRole('row').filter({ has: page.getByRole('gridcell') });
export const rowFor = (page: Page, name: RegExp): Locator => listRows(page).filter({ hasText: name }).first();

/** The titles on the page, top to bottom, in either layout (rows' title cells, or the cards' names). */
export async function readingTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const grid = document.querySelector('[role=grid]');
    if (!grid) return [];
    const cards = [...grid.querySelectorAll('[role=gridcell][aria-label]')];
    if (cards.length > 0) return cards.map((c) => c.getAttribute('aria-label') ?? '');
    return [...grid.querySelectorAll('[role=row]')]
      .filter((r) => r.querySelector('[role=gridcell]'))
      .map((r) => {
        const cell = r.querySelector('[role=gridcell]')!;
        const titled = [...cell.querySelectorAll('[title]')].find((e) => (e.textContent ?? '').trim() !== '');
        return (titled?.getAttribute('title') ?? (cell as HTMLElement).innerText.split('\n')[0] ?? '').trim();
      });
  });
}

/** The titles once the list has `count` of them and holds still (a click on a sort header redraws the list a moment later). */
export async function settledTitles(page: Page, count: number): Promise<string[]> {
  let last: string[] = [];
  await expect
    .poll(
      async () => {
        const now = await readingTitles(page);
        const same = now.length === count && now.join('\n') === last.join('\n');
        last = now;
        return same;
      },
      { message: `the list should settle on ${count} reading(s)`, timeout: 15_000, intervals: [150, 250, 400] },
    )
    .toBe(true);
  return last;
}

/** Opens a row's menu the way a person does: a right-click on the row. */
export async function openRowMenu(page: Page, row: Locator): Promise<Locator> {
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu').first();
  await expect(menu, 'a right-click on a reading opens its menu').toBeVisible({ timeout: 5000 });
  return menu;
}

/** The snackbar (a polite live region) at the bottom of the library. */
export const snackbar = (page: Page): Locator => page.getByRole('status').first();

// ---------------------------------------------------------------------------------------------------------------
// What a PDF that was not saved must leave behind: nothing

export interface TraceProbe {
  /** The file's SHA-256 (its fingerprint). */
  sha: string;
  /** Distinctive text from the PDF's pages. */
  phrases: string[];
  /** The file's name, with and without the extension. */
  fileName: string;
  /** Console lines the browser printed during the test. */
  logs?: string[];
  /** Also expect no draft or save-pending record in localStorage. */
  noDrafts?: boolean;
}

/**
 * Everything the owner's disk and the extension's storage could hold about a PDF, as a list of problems. An empty list means the
 * PDF left no trace: no row, no copy, no thumbnail, no search entry, no log line, no draft (spec "Local traces"). `page` must be
 * a viewer tab (it carries the store). Each check reads the real thing: the store's tables and indexes, every OPFS file, the
 * extension's localStorage, and its IndexedDB databases.
 */
export async function traceProblems(page: Page, p: TraceProbe): Promise<string[]> {
  const problems: string[] = [];
  const s = storeOf(page);
  await waitForStore(page);

  const stats = await s.stats();
  for (const key of Object.keys(ZERO_STATS) as (keyof typeof ZERO_STATS)[]) {
    if (stats[key] !== 0) problems.push(`the library has ${stats[key]} ${key} row(s)`);
  }
  for (const view of ['all', 'recent', 'starred', 'trash'] as const) {
    const list = await s.call<{ total: number }>('listDocuments', { view, sort: { by: 'title', dir: 'asc' }, limit: 50 });
    if (list.total !== 0) problems.push(`the ${view} list shows ${list.total} reading(s)`);
  }
  for (const phrase of p.phrases) {
    const hits = await s.call<unknown[]>('search', { text: phrase, limit: 20 });
    if (hits.length > 0) problems.push(`search finds "${phrase}" (${hits.length} hit(s))`);
    const pages = await s.call<unknown[]>('searchPages', phrase, 20);
    if (pages.length > 0) problems.push(`page search finds "${phrase}"`);
  }

  const files = (await listOpfs(page, '')).map((f) => f.path);
  for (const f of files) {
    if (f.startsWith('pdf/')) problems.push(`a saved copy exists: ${f}`);
    if (f.startsWith('thumbs/')) problems.push(`a thumbnail exists: ${f}`);
    if (f.includes(p.sha.slice(0, 16))) problems.push(`a file is named by the fingerprint: ${f}`);
  }
  for (const phrase of p.phrases) {
    const found = await scanOpfs(page, phrase);
    if (found.length > 0) problems.push(`the text "${phrase}" is inside stored file(s): ${found.join(', ')}`);
  }

  const local = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      out[k] = localStorage.getItem(k) ?? '';
    }
    return out;
  });
  const needles = [p.sha, p.sha.slice(0, 16), ...p.phrases, p.fileName, p.fileName.replace(/\.pdf$/i, '')];
  for (const [k, v] of Object.entries(local)) {
    const hit = needles.find((n) => n.length >= 6 && (k.includes(n) || v.includes(n)));
    if (hit !== undefined) problems.push(`localStorage "${k}" mentions the PDF ("${hit.slice(0, 24)}")`);
    if (p.noDrafts === true && /^sop-(draft|pending)/.test(k)) problems.push(`localStorage "${k}" is a draft or save-pending record`);
  }

  for (const db of ['sop-local', 'sop-device', 'sop-handles']) {
    const probe = await probeIdb(page, db, p.sha);
    if (probe.containsNeedle) problems.push(`the IndexedDB "${db}" holds the raw fingerprint`);
  }

  for (const line of p.logs ?? []) {
    const hit = needles.find((n) => n.length >= 6 && line.includes(n));
    if (hit !== undefined) problems.push(`a console line mentions the PDF: ${line.slice(0, 80)}`);
  }
  return problems;
}

/** Collects the browser's console output (every page of the context) as it comes. */
export function collectConsole(context: BrowserContext): string[] {
  const lines: string[] = [];
  context.on('console', (m) => lines.push(m.text()));
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// The request log (read after the browser has closed)

/** Closes the browser and returns every http(s) URL the net log saw, other than Chromium's own services', in order. */
export async function requestUrls(netgate: NetGate): Promise<string[]> {
  await netgate.report();
  const all = await readNetlogRequests(netgate.netlogPath);
  return all.filter((r) => !r.browserService && /^https?:/i.test(r.url)).map((r) => r.url);
}

// ---------------------------------------------------------------------------------------------------------------
// Settings

export async function openSettings(context: BrowserContext): Promise<Page> {
  return openLibrary(context, 'settings');
}

/** The first button whose name matches, anywhere on the page. */
export const buttonLike = (page: Page, name: RegExp): Locator => page.getByRole('button', { name }).first();

// ---------------------------------------------------------------------------------------------------------------
// A backup folder the tests can drive. The real folder picker cannot be driven headless (the plan, P0-8), so the page's own
// `showDirectoryPicker` is replaced by one that answers with a folder in the extension's private file storage (OPFS). An OPFS
// folder is a FileSystemDirectoryHandle like any other: it can be stored in IndexedDB and written through createWritable().
// Chrome's permission prompt is faked the same way, with one switch both the pages and the hidden document read.

export const PICKER_FOLDER = 'p3-backup-target';
const PERMISSION_KEY = '__test_fs_permission';
const PICKER_KEY = '__test_picker_folder';

const FAKES_JS = `(() => {
  try {
    const w = window;
    const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    if (typeof w.showDirectoryPicker === 'function' && !w.__testPickerInstalled) {
      w.__testPickerInstalled = true;
      w.showDirectoryPicker = async () => {
        const name = read(${JSON.stringify(PICKER_KEY)}) || ${JSON.stringify(PICKER_FOLDER)};
        return (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
      };
    }
    const proto = w.FileSystemHandle && w.FileSystemHandle.prototype;
    if (proto && !proto.__testPermissionInstalled) {
      proto.__testPermissionInstalled = true;
      const realQuery = proto.queryPermission;
      const realRequest = proto.requestPermission;
      proto.queryPermission = async function (d) {
        const fake = read(${JSON.stringify(PERMISSION_KEY)});
        if (fake) return fake;
        return realQuery ? realQuery.call(this, d) : 'granted';
      };
      proto.requestPermission = async function (d) {
        if (read(${JSON.stringify(PERMISSION_KEY)}) === 'prompt') {
          if (!(navigator.userActivation && navigator.userActivation.isActive)) throw new DOMException('A click is needed to ask for permission.', 'SecurityError');
          localStorage.setItem(${JSON.stringify(PERMISSION_KEY)}, 'granted');
          return 'granted';
        }
        return realRequest ? realRequest.call(this, d) : 'granted';
      };
    }
  } catch (e) { /* a page that cannot run this has no folder to pick */ }
})();`;

/** Every page opened from now on picks `PICKER_FOLDER`, and asks the permission switch before answering a permission query. */
export async function installBackupFakes(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: FAKES_JS });
}

/** Runs JS in the extension's hidden (offscreen) document through the debugging protocol, and returns its (JSON) result. */
export async function inOffscreen<T>(context: BrowserContext, via: Page, expression: string): Promise<T> {
  const cdp = await context.newCDPSession(via);
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.url.endsWith('/offscreen.html'));
    if (!target) throw new Error('the extension has no hidden document open');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the hidden document did not answer')), 10_000);
      cdp.on('Target.receivedMessageFromTarget', (e: { sessionId: string; message: string }) => {
        if (e.sessionId !== sessionId) return;
        const m = JSON.parse(e.message) as { id?: number; error?: unknown; result?: { exceptionDetails?: unknown; result: { value: T } } };
        if (m.id !== 1) return;
        clearTimeout(timer);
        if (m.error || m.result?.exceptionDetails) reject(new Error(JSON.stringify(m.error ?? m.result?.exceptionDetails)));
        else resolve(m.result!.result.value);
      });
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }) });
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** Puts the same fakes into the hidden document, which was already running when the init script was registered. */
export async function fakePermissionInHiddenDocument(context: BrowserContext, via: Page): Promise<void> {
  await inOffscreen(context, via, FAKES_JS);
}

/** Sets what Chrome would answer about the picked folder from now on: 'prompt' (lost), 'granted', or null (the real answer). Needs a page of the extension. */
export async function setFolderPermission(page: Page, state: 'prompt' | 'granted' | null): Promise<void> {
  await page.evaluate(
    ({ key, state }) => (state === null ? localStorage.removeItem(key) : localStorage.setItem(key, state)),
    { key: PERMISSION_KEY, state },
  );
}

/** Which folder the faked picker answers with (default PICKER_FOLDER). */
export async function setPickerFolder(page: Page, name: string): Promise<void> {
  await page.evaluate(({ key, name }) => localStorage.setItem(key, name), { key: PICKER_KEY, name });
}

// ---- the files of a folder in OPFS, read and written the way a backup tool would ----

export interface FolderFile {
  /** Relative to the folder, with `/`. */
  path: string;
  size: number;
}

export async function folderFiles(page: Page, folder: string): Promise<FolderFile[]> {
  const prefix = `${folder}/`;
  return (await listOpfs(page, folder)).map((f) => ({ path: f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path, size: f.size }));
}

export async function readFolderFile(page: Page, folder: string, rel: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    async ({ folder, rel }) => {
      const parts = [...folder.split('/'), ...rel.split('/')].filter(Boolean);
      const name = parts.pop()!;
      let dir = await navigator.storage.getDirectory();
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      const file = await (await dir.getFileHandle(name)).getFile();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    },
    { folder, rel },
  );
  return Buffer.from(b64, 'base64');
}

export async function readFolderText(page: Page, folder: string, rel: string): Promise<string> {
  return (await readFolderFile(page, folder, rel)).toString('utf8');
}

export async function writeFolderFile(page: Page, folder: string, rel: string, data: Buffer | string): Promise<void> {
  const b64 = (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
  await page.evaluate(
    async ({ folder, rel, b64 }) => {
      const parts = [...folder.split('/'), ...rel.split('/')].filter(Boolean);
      const name = parts.pop()!;
      let dir = await navigator.storage.getDirectory();
      for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
    },
    { folder, rel, b64 },
  );
}

export async function removeFolderFile(page: Page, folder: string, rel: string): Promise<void> {
  await page.evaluate(
    async ({ folder, rel }) => {
      const parts = [...folder.split('/'), ...rel.split('/')].filter(Boolean);
      const name = parts.pop()!;
      let dir = await navigator.storage.getDirectory();
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      await dir.removeEntry(name);
    },
    { folder, rel },
  );
}

/** Copies every file of a folder in one page's OPFS into a folder in another page's OPFS (another browser profile: "a fresh computer"). */
export async function copyFolderBetween(from: Page, fromFolder: string, to: Page, toFolder: string): Promise<number> {
  const files = await folderFiles(from, fromFolder);
  for (const f of files) await writeFolderFile(to, toFolder, f.path, await readFolderFile(from, fromFolder, f.path));
  return files.length;
}

// ---- finding and reading a backup ----

export interface BackupManifestShape {
  format: string;
  version: number;
  createdAt: number;
  schemaVersion: number;
  appVersion: string;
  counts: { documents: number; threads: number; marks: number; comments: number; pdfs: number };
  pdfs: Record<string, number>;
}
export interface FoundBackup {
  /** The folder holding manifest.json, relative to the picked folder ('' if the picked folder is the backup, else 'sickofpdfs-backup'). */
  root: string;
  files: FolderFile[];
  manifest: BackupManifestShape;
  /** Reads a file of the backup by its path in the backup (`pdf/ab/ab12....pdf`). */
  text(rel: string): Promise<string>;
  bytes(rel: string): Promise<Buffer>;
  has(rel: string): boolean;
  list(prefix: string): string[];
}

/** The backup in the picked folder, wherever the writer put `manifest.json`; null while there is none. */
export async function findBackup(page: Page, folder: string): Promise<FoundBackup | null> {
  const files = await folderFiles(page, folder);
  const manifests = files.filter((f) => f.path === 'manifest.json' || f.path.endsWith('/manifest.json')).sort((a, b) => a.path.length - b.path.length);
  if (manifests.length === 0) return null;
  const root = manifests[0].path.replace(/manifest\.json$/, '').replace(/\/$/, '');
  const at = (rel: string): string => (root === '' ? rel : `${root}/${rel}`);
  let manifest: BackupManifestShape;
  try {
    manifest = JSON.parse(await readFolderText(page, folder, manifests[0].path)) as BackupManifestShape;
  } catch {
    return null; // half written: the manifest is written last, so this is not a finished backup
  }
  const set = new Set(files.map((f) => f.path));
  return {
    root,
    files,
    manifest,
    text: (rel) => readFolderText(page, folder, at(rel)),
    bytes: (rel) => readFolderFile(page, folder, at(rel)),
    has: (rel) => set.has(at(rel)),
    list: (prefix) => files.map((f) => f.path).filter((p) => p.startsWith(at(prefix))).map((p) => (root === '' ? p : p.slice(root.length + 1))),
  };
}

/** Waits for a finished backup whose manifest was made after `after` (Unix ms). */
export async function waitForBackup(page: Page, folder: string, o: { after?: number; timeout?: number; message?: string } = {}): Promise<FoundBackup> {
  let found: FoundBackup | null = null;
  await expect
    .poll(
      async () => {
        found = await findBackup(page, folder).catch(() => null);
        return found !== null && found.manifest.createdAt > (o.after ?? 0);
      },
      { timeout: o.timeout ?? 90_000, message: o.message ?? 'a finished backup (manifest.json) should appear in the folder', intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return found!;
}

/** The files of the backup that mention `needle` (as UTF-8 text). */
export async function backupFilesMentioning(page: Page, folder: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  for (const f of await folderFiles(page, folder)) {
    // Triage (p3s13b): the writer removes files while a test polls, so a file listed a moment ago may be gone by the time it is read (a wrong
    // guess that the folder stands still). A file that is gone does not mention anything.
    const bytes = await readFolderFile(page, folder, f.path).catch((e: unknown) => {
      if (/NotFoundError|could not be found/i.test(String(e))) return null;
      throw e;
    });
    if (bytes !== null && bytes.includes(Buffer.from(needle, 'utf8'))) hits.push(f.path);
  }
  return hits;
}

/** A key-shaped test secret, built at run time (contracts section 6: no key-shaped text is committed, not even a fake one). */
export function fakeApiKey(): string {
  return ['sk', 'ant', 'api03', crypto.randomUUID().replaceAll('-', ''), crypto.randomUUID().replaceAll('-', '')].join('-');
}

// ---- dates ----

export const DAY = 24 * 60 * 60 * 1000;
export const isoDay = (t: number, utc = true): string => {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return utc ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// ---- the Backup and Restore parts of Settings ----

/** The Backup section's control that picks the folder ("Choose a folder"). */
export const chooseFolderButton = (page: Page): Locator => page.getByRole('button', { name: /(choose|pick|select|change|set up|connect).*(folder|backup)|backup folder/i }).first();
/** "Back up now": not named by the spec, so a test uses it only when it exists. */
export const backUpNowButton = (page: Page): Locator => page.getByRole('button', { name: /back ?up now|run (a )?backup/i }).first();
export const restoreButton = (page: Page): Locator => page.getByRole('button', { name: /restore from backup|restore/i }).first();

/** True when the Settings page has a Backup section. */
export async function hasBackupSection(page: Page): Promise<boolean> {
  return page.getByRole('heading', { name: /backup/i }).first().isVisible();
}

// ---------------------------------------------------------------------------------------------------------------
// Small things

/** A screenshot into test-results/ (evidence, not a check). */
export async function shotOf(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  try {
    await page.screenshot({ path });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  } catch {
    // a screenshot is evidence, not a check
  }
}

export function note(testInfo: TestInfo, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The store's documents as `{ id, title }`, newest list order irrelevant (a probe for tests that cannot see the library UI). */
export async function allReadings(page: Page, view: 'all' | 'trash' = 'all'): Promise<{ id: string; title: string | null; noteCount: number; starred: boolean; blobStored: boolean }[]> {
  const list = await storeOf(page).call<{ items: { doc: { id: string; title: string | null; starred: boolean; blobStored: boolean }; noteCount: number }[] }>('listDocuments', {
    view,
    sort: { by: 'title', dir: 'asc' },
    limit: 100,
  });
  return list.items.map((i) => ({ id: i.doc.id, title: i.doc.title, noteCount: i.noteCount, starred: i.doc.starred, blobStored: i.doc.blobStored }));
}
