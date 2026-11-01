// Crash model probe (gap 2 of the Test build 2 triage). Not a gate: it measures what Chrome does when one viewer renderer
// dies, with the real test build, and prints it. Run: pnpm exec playwright test -c spikes/crash-model --workers=1
//
// For each way of killing a renderer it records which of our contexts die (the other viewer tab, the offscreen store
// document, the service worker), the extension's state over time, what a reopen does, and what the owner's way back costs.
import { execFileSync } from 'node:child_process';
import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_ID, expect, test } from '../../e2e/support/test';
import { ATTENTION, openPaper, saveFirst } from '../../e2e/walkthroughs/support/marks.spec-blind';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE = `chrome-extension://${EXTENSION_ID}/`;

interface View {
  url: string;
  type: string;
  renderProcessId: number;
}

/** chrome://extensions, which can read the extension's state and its live views even while the extension is terminated. */
async function extensionsPage(context: BrowserContext): Promise<Page> {
  const p = await context.newPage();
  await p.goto(`chrome://extensions/?id=${EXTENSION_ID}`);
  return p;
}
const info = (ext: Page) =>
  ext.evaluate(
    (id) =>
      new Promise<{ state: string; views: View[] }>((resolve) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).chrome.developerPrivate.getExtensionInfo(id, (x: { state: string; views: View[] }) => resolve({ state: x.state, views: x.views })),
      ),
    EXTENSION_ID,
  );
const viewsText = (views: View[]) => views.map((v) => `${v.type}:${v.url.replace(BASE, '').split('?')[0]}@rp${v.renderProcessId}`).join(', ');

/** The profile folder of this test's own browser, as chrome://version reports it. */
async function userDataDir(context: BrowserContext): Promise<string> {
  const p = await context.newPage();
  await p.goto('chrome://version');
  const profile = (await p.locator('#profile_path').textContent())?.trim() ?? '';
  await p.close();
  if (!profile) throw new Error('no profile path on chrome://version');
  return profile.replace(/\/[^/]+$/, ''); // ".../Default" -> the user data dir
}

/**
 * Our extension's renderer processes, from ps, in THIS test's browser only: the process tree under the browser whose
 * `--user-data-dir` is ours (other browsers on the machine are never touched). `--extension-process` marks a renderer
 * that hosts extension pages.
 */
function extensionPids(dir: string): number[] {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' }));
  const root = rows.find((r) => r.args.includes(`--user-data-dir=${dir}`) && !r.args.includes('--type='));
  if (!root) throw new Error(`no browser process for ${dir}`);
  const mine = new Set([root.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) if (!mine.has(r.pid) && mine.has(r.ppid)) (mine.add(r.pid), (grew = true));
  }
  return rows.filter((r) => mine.has(r.pid) && r.args.includes('--type=renderer') && r.args.includes('--extension-process')).map((r) => r.pid);
}

async function alive(p: Page): Promise<string> {
  return Promise.race([p.evaluate(() => 1 + 1).then(() => 'alive', (e: Error) => `dead (${e.message.split('\n')[0]})`), sleep(3000).then(() => 'no answer in 3 s')]);
}

const METHODS = ['Page.crash', 'chrome://crash', 'chrome://kill', 'kill -9'] as const;

for (const method of METHODS) {
  test(`one viewer renderer killed by ${method}`, async ({ context, openViewer, server, sw }) => {
    test.setTimeout(240_000);
    const out: string[] = [];
    const t0 = Date.now();
    const note = (s: string) => out.push(`[${String(Date.now() - t0).padStart(6)} ms] ${s}`);
    void sw;
    const dir = await userDataDir(context);

    const a = await openPaper(openViewer, server, ATTENTION);
    await saveFirst(a);
    const b = await openViewer(server.url(`/f/${ATTENTION.file}`));
    await b.waitForSelector('[data-page-index="0"]');
    const ext = await extensionsPage(context);
    const before = await info(ext);
    note(`before: state ${before.state}; views ${viewsText(before.views)}`);
    note(`extension renderer pids in this browser (ps): ${extensionPids(dir).join(', ')}`);
    const processIds = new Set(before.views.map((v) => v.renderProcessId));
    note(`distinct render processes among our views: ${processIds.size}`);

    // localStorage durability: a write sent in the same CDP batch as the crash
    const cdpA = await context.newCDPSession(a);
    const stamp = String(Date.now());
    const crashedA = new Promise<number>((r) => a.once('crash', () => r(Date.now())));
    const crashedB = new Promise<number>((r) => b.once('crash', () => r(Date.now())));
    void cdpA.send('Runtime.evaluate', { expression: `localStorage.setItem('crash-probe', '${stamp}')` }).catch(() => undefined);

    const killedAt = Date.now();
    if (method === 'Page.crash') void cdpA.send('Page.crash').catch(() => undefined);
    else if (method === 'kill -9') {
      const pids = extensionPids(dir);
      if (pids.length !== 1) throw new Error(`expected one extension renderer in this browser, found ${pids.length}`);
      note(`kill -9 ${pids[0]}`);
      execFileSync('kill', ['-9', String(pids[0])]);
    } else void a.goto(method).catch((e: Error) => note(`goto ${method}: ${e.message.split('\n')[0]}`));

    const [ca, cb] = await Promise.all([Promise.race([crashedA, sleep(10_000).then(() => -1)]), Promise.race([crashedB, sleep(10_000).then(() => -1)])]);
    note(`crash event: A ${ca < 0 ? 'none' : `+${ca - killedAt} ms`}, B ${cb < 0 ? 'none' : `+${cb - killedAt} ms`}`);
    note(`A ${await alive(a)}; B ${await alive(b)}`);
    const after = await info(ext);
    note(`after: state ${after.state}; views ${viewsText(after.views) || 'none'}`);
    note(`extension renderer pids in this browser (ps): ${extensionPids(dir).join(', ') || 'none'}`);
    note(`Playwright service workers: ${context.serviceWorkers().map((w) => w.url().replace(BASE, '')).join(', ') || 'none'}`);

    // Does Chrome bring it back by itself?
    const watchMs = method === 'Page.crash' ? 60_000 : 8_000;
    let last = after.state;
    const watchEnd = Date.now() + watchMs;
    while (Date.now() < watchEnd) {
      const s = (await info(ext)).state;
      if (s !== last) (note(`state -> ${s}`), (last = s));
      await sleep(500);
    }
    note(`state after watching ${watchMs / 1000} s: ${last}`);

    const reopen = await context.newPage();
    note(`reopen viewer.html: ${await reopen.goto(`${BASE}viewer.html`).then(() => 'loaded', (e: Error) => e.message.split('\n')[0])}`);
    const pdfTab = await context.newPage();
    await pdfTab.goto(server.url(`/f/${ATTENTION.file}`)).catch((e: Error) => note(`open the PDF link: ${e.message.split('\n')[0]}`));
    await sleep(1500);
    note(`open the PDF link while terminated lands on: ${pdfTab.url().slice(0, 90)}`);
    await pdfTab.close().catch(() => undefined);
    await reopen.close().catch(() => undefined);

    // The owner's way back: the Reload button chrome://extensions shows for a terminated extension (the crash notification's
    // click does the same reload).
    const reload = ext.locator('#terminated-reload-button').filter({ visible: true });
    note(`terminated Reload button visible: ${await reload.isVisible().catch(() => false)}`);
    if (await reload.isVisible().catch(() => false)) {
      const t = Date.now();
      await reload.click();
      await expect.poll(async () => (await info(ext)).state, { timeout: 15_000 }).toBe('ENABLED');
      note(`ENABLED ${Date.now() - t} ms after the click`);
      await expect.poll(() => context.serviceWorkers().some((w) => w.url().startsWith(BASE)), { timeout: 15_000 }).toBe(true);
      note(`service worker running ${Date.now() - t} ms after the click`);
      const tab = await context.newPage();
      await tab.goto(server.url(`/f/${ATTENTION.file}`)).catch(() => undefined);
      await sleep(2000);
      note(`the PDF link after the reload lands on: ${tab.url().slice(0, 60)}`);
      const v = await openViewer(server.url(`/f/${ATTENTION.file}`));
      note(`localStorage write sent with the crash: ${(await v.evaluate(() => localStorage.getItem('crash-probe'))) === stamp ? 'kept' : 'lost'}`);
      const tabs = await v.evaluate(async (base) => {
        const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType] });
        const live = new Set(ctx.map((c) => c.tabId));
        return (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(base)).map((t) => `tab ${t.id} ${t.status} ${live.has(t.id!) ? 'live' : 'DEAD'} ${t.url!.slice(base.length, base.length + 12)}`);
      }, `${BASE}viewer.html`);
      note(`viewer tabs after the reload: ${tabs.join('; ')}`);
    }
    console.log(`\n=== ${method} ===\n${out.join('\n')}\n`);
  });
}

/** Reloads a terminated extension the way the owner would: the Reload button on chrome://extensions. */
async function ownerReloads(ext: Page): Promise<void> {
  await ext.reload();
  const button = ext.locator('#terminated-reload-button').filter({ visible: true });
  await button.click({ timeout: 15_000 });
  await expect.poll(async () => (await info(ext)).state, { timeout: 15_000 }).toBe('ENABLED');
}

test('a localStorage write that has returned survives kill -9 of the renderer right after', async ({ context, openViewer, server }) => {
  test.setTimeout(240_000);
  const dir = await userDataDir(context);
  const ext = await extensionsPage(context);
  const results: string[] = [];
  for (let i = 0; i < 8; i++) {
    const v = await openViewer(server.url(`/f/${ATTENTION.file}`));
    const stamp = `${i}-${Date.now()}`;
    // setItem has returned in the renderer when evaluate answers; the kill follows at once (a few ms of CDP and ps)
    await v.evaluate((s) => localStorage.setItem('crash-probe', s), stamp);
    const views = viewsText((await info(ext)).views);
    const pids = extensionPids(dir);
    if (pids.length !== 1) throw new Error(`expected one extension renderer in this browser, found ${pids.length}`);
    const crashed = new Promise<void>((r) => v.once('crash', () => r()));
    execFileSync('kill', ['-9', String(pids[0])]);
    await crashed;
    await sleep(300);
    const state = (await info(ext)).state;
    console.log(`round ${i}: views before the kill ${views}; state after ${state}`);
    await v.close().catch(() => undefined);
    if (state === 'TERMINATED') await ownerReloads(ext);
    const w = await openViewer(server.url(`/f/${ATTENTION.file}`));
    results.push((await w.evaluate(() => localStorage.getItem('crash-probe'))) === stamp ? 'kept' : 'LOST');
    await w.close();
  }
  console.log(`\n=== localStorage, kill -9 right after setItem: ${results.join(' ')} ===\n`);
  expect(results.every((r) => r === 'kept')).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------
// The journal at work: the renderer is killed in the same instant as the last key, before any store write can land.

test('the renderer is killed right after the last key: what the store has, what the journal has, what comes back', async ({ context, openViewer, server }) => {
  test.setTimeout(400_000);
  const { selectPassage, startNote, noteBox, readBox, LINES, RESNET } = await import('../../e2e/walkthroughs/support/marks.spec-blind');
  const { store } = await import('../../e2e/support/store-probe.spec-blind');
  const { ownerReloadsAfterCrash } = await import('../../e2e/support/crash');
  const rows: string[] = [];
  let id: string | null = null;
  const lines = [LINES.l1, LINES.l3, LINES.l5, LINES.l7, LINES.l9];
  for (let round = 0; round < lines.length; round++) {
    const a = await openPaper(openViewer, server, ATTENTION);
    id ??= await saveFirst(a);
    await expect(a.getByRole('button', { name: /^saved/i }).first()).toBeVisible({ timeout: 20_000 });
    await sleep(2000); // the notes of the earlier rounds load and the margin settles
    await a.keyboard.press('Escape');
    await selectPassage(a, ATTENTION, lines[round]!);
    await startNote(a);
    const typed = `Round ${round}: the last key is the kill`;
    await a.keyboard.type(typed.slice(0, -1), { delay: 10 });
    const cdp = await context.newCDPSession(a);
    // the last character, then the crash in the same breath: the input is handled before the reply comes back
    await cdp.send('Input.insertText', { text: typed.slice(-1) });
    void cdp.send('Page.crash').catch(() => undefined);
    await Promise.race([new Promise<void>((r) => a.once('crash', () => r())), sleep(10_000)]);
    await a.close().catch(() => undefined);
    await ownerReloadsAfterCrash(context);

    // Look before any viewer of this PDF restores (and so merges) the draft: a viewer of another PDF reads both.
    const other = await openPaper(openViewer, server, RESNET);
    const journal = await other.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sop-draft:')).map((k) => JSON.parse(localStorage.getItem(k)!) as { body: string; tab: string; pending: boolean; documentId: string }));
    const mine = journal.find((j) => j.body.startsWith(`Round ${round}:`));
    const storeDrafts = mine ? await store(other).call<{ body: string }[]>('listDrafts', id, mine.tab) : [];
    const inStore = storeDrafts.find((r) => r.body.startsWith(`Round ${round}:`))?.body ?? '(none)';
    await other.close();

    const again = await openViewer(server.url(`/f/${ATTENTION.file}`));
    const box = noteBox(again);
    await expect(box).toBeVisible({ timeout: 15_000 });
    const back = await readBox(box);
    rows.push(
      `round ${round}: journal ${mine ? `"${mine.body.slice(-8)}" pending=${mine.pending}` : '(none)'}; store "${inStore.slice(-8)}"; back "${back.text.slice(-8)}" ${back.text === typed ? 'WHOLE' : 'SHORT'}, caret at end ${back.caretAtEnd}`,
    );
    // send it, so the next round starts clean
    await box.focus();
    await again.keyboard.press('Enter');
    await again.waitForTimeout(500);
    await again.close();
  }
  console.log(`\n=== last key + kill ===\n${rows.join('\n')}\n`);
  const after = await openViewer(server.url(`/f/${ATTENTION.file}`));
  await after.waitForTimeout(1500);
  console.log(`journal entries left after every note was sent: ${await after.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sop-draft:')).length)}`);
});

test('nothing is journaled before a save or after an Undo, and nothing in Incognito', async ({ context, openViewer, server }) => {
  test.setTimeout(120_000);
  const { selectPassage, startNote, LINES } = await import('../../e2e/walkthroughs/support/marks.spec-blind');
  const journalKeys = (p: Page) => p.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sop-draft:')));
  const a = await openPaper(openViewer, server, ATTENTION);
  await expect(a.getByRole('button', { name: /^not sure/i }).first()).toBeVisible({ timeout: 25_000 });
  await a.mouse.wheel(0, 2000);
  await sleep(800);
  await a.mouse.wheel(0, -2000);
  await sleep(800);
  const afterReading = await journalKeys(a);
  // The first note on a "Not sure" PDF saves it, with an Undo: from then on the draft is journaled, like the store's copy.
  await selectPassage(a, ATTENTION, LINES.l1);
  await startNote(a);
  await a.keyboard.type('typed after the save', { delay: 10 });
  const whileSaved = await journalKeys(a);
  await a.getByRole('button', { name: /^undo$/i }).first().click();
  await expect(a.getByRole('button', { name: /^not sure/i }).first()).toBeVisible({ timeout: 10_000 });
  const afterUndo = await journalKeys(a);
  await a.keyboard.type(' and more after the Undo', { delay: 10 });
  await sleep(500);
  const typingAfterUndo = await journalKeys(a);

  await context.addInitScript(() => {
    if (location.protocol === 'chrome-extension:') Object.defineProperty(chrome.extension, 'inIncognitoContext', { get: () => true, configurable: true });
  });
  const inc = await openPaper(openViewer, server, ATTENTION);
  await sleep(1500);
  await selectPassage(inc, ATTENTION, LINES.l3);
  await inc.keyboard.press('Control+Alt+m');
  await sleep(800);
  await inc.keyboard.type('typed in Incognito', { delay: 10 });
  await sleep(500);
  const incognito = await journalKeys(inc);
  console.log(`\n=== journal: after reading ${JSON.stringify(afterReading)}; while saved ${whileSaved.length} entry; after Undo ${JSON.stringify(afterUndo)}; typing after Undo ${JSON.stringify(typingAfterUndo)}; Incognito ${JSON.stringify(incognito)} ===\n`);
  expect(afterReading).toEqual([]);
  expect(whileSaved).toHaveLength(1);
  expect(afterUndo).toEqual([]);
  expect(typingAfterUndo).toEqual([]);
  expect(incognito).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------
// The way back: once the owner reloads the extension, the dead PDF tabs reopen by themselves, at their page, with the draft.

test('after the reload, a dead viewer tab reopens by itself at its page and adopts the draft of the tab that is gone; a second crash soon after is not reloaded again', async ({ context, openViewer, server }) => {
  test.setTimeout(240_000);
  const { selectPassage, startNote, LINES } = await import('../../e2e/walkthroughs/support/marks.spec-blind');
  const { ownerReloadsAfterCrash } = await import('../../e2e/support/crash');
  const { hooks } = await import('../../e2e/support/test');
  const dir = await userDataDir(context);
  const a = await openPaper(openViewer, server, ATTENTION);
  await saveFirst(a);
  const b = await openViewer(server.url(`/f/${ATTENTION.file}`));
  await b.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 25_000 });
  await hooks(b).eval((h) => h.viewer.scrollTo(3)); // page 4
  await sleep(1200); // the address follows the page after 300 ms
  const bUrl = b.url();
  const bTabId = await b.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
  await a.bringToFront();
  await selectPassage(a, ATTENTION, LINES.l1);
  await startNote(a);
  await a.keyboard.type('Typed in A, which crashes', { delay: 10 });
  await sleep(100);
  const aTab = await a.evaluate(() => Object.values(localStorage).map((v) => { try { return (JSON.parse(v) as { tab?: string; body?: string }); } catch { return null; } }).find((j) => j?.body?.startsWith('Typed in A'))?.tab);

  const cdp = await context.newCDPSession(a);
  void cdp.send('Page.crash').catch(() => undefined);
  await Promise.race([new Promise<void>((r) => a.once('crash', () => r())), sleep(10_000)]);
  await a.close().catch(() => undefined); // the owner closes A; B is a sad tab too
  const clicked = Date.now();
  await ownerReloadsAfterCrash(context);

  const look = await context.newPage();
  await look.goto(`chrome-extension://${EXTENSION_ID}/viewer.html`).catch(() => undefined);
  let report = '';
  await expect
    .poll(
      async () => {
        const r = await look.evaluate(async (id) => {
          const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType] });
          const t = await chrome.tabs.get(id!);
          const held = ((await navigator.locks.query()).held ?? []).map((l) => l.name ?? '').filter((n) => n.startsWith('sop-tab:')).map((n) => n.slice(8));
          const j = Object.values(localStorage).map((v) => { try { return JSON.parse(v) as { tab?: string; body?: string }; } catch { return null; } }).find((x) => x?.body?.startsWith('Typed in A'));
          return { live: ctx.some((c) => c.tabId === id), url: t.url ?? '', owner: j?.tab ?? null, held };
        }, bTabId);
        report = JSON.stringify(r);
        return r.live && r.owner !== null && r.owner !== aTab && r.held.includes(r.owner);
      },
      { timeout: 30_000, message: 'tab B is alive again and owns the draft' },
    )
    .toBe(true);
  const back = Date.now() - clicked;
  const info2 = JSON.parse(report) as { url: string };
  console.log(`\n=== the way back: B live again and owning A's draft ${back} ms after the Reload click; B's address before ${bUrl.slice(-10)}, after ${info2.url.slice(-10)}; ${report} ===\n`);
  expect(info2.url.endsWith('#page=4')).toBe(true);

  // A second crash right after: B is not reloaded again (the guard), so a PDF that keeps crashing cannot trap the owner.
  await look.close();
  const pids = extensionPids(dir);
  if (pids.length !== 1) throw new Error(`expected one extension renderer in this browser, found ${pids.length}`);
  execFileSync('kill', ['-9', String(pids[0])]);
  await sleep(500);
  await ownerReloadsAfterCrash(context);
  const look2 = await context.newPage();
  await look2.goto(`chrome-extension://${EXTENSION_ID}/viewer.html`).catch(() => undefined);
  await sleep(5000);
  const second = await look2.evaluate(async (id) => (await chrome.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType] })).some((c) => c.tabId === id), bTabId);
  console.log(`\n=== second crash within 5 minutes: B reloaded again by itself? ${second} ===\n`);
  expect(second).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------
// What the owner sees, in pictures (headless shows no "Aw, Snap" page and no notification; those are Chrome's own UI).

test('screens of the way back: the blocked page while terminated, the Reload button, the PDF tab back with its draft', async ({ context, openViewer, server }, testInfo) => {
  test.setTimeout(180_000);
  const { selectPassage, startNote, noteBox, readBox, LINES } = await import('../../e2e/walkthroughs/support/marks.spec-blind');
  const shots = testInfo.outputPath('shots');
  const a = await openPaper(openViewer, server, ATTENTION);
  await saveFirst(a);
  await selectPassage(a, ATTENTION, LINES.l3);
  await startNote(a);
  const typed = 'A note that must not be lost';
  await a.keyboard.type(typed, { delay: 10 });
  await sleep(100);
  await a.screenshot({ path: `${shots}/1-typing.png` });
  const viewerUrl = a.url();
  const cdp = await context.newCDPSession(a);
  void cdp.send('Page.crash').catch(() => undefined);
  await Promise.race([new Promise<void>((r) => a.once('crash', () => r())), sleep(10_000)]);
  await a.close().catch(() => undefined);

  // The owner presses Reload on the crashed tab before reloading the extension: Chrome's "blocked" page.
  const blocked = await context.newPage();
  await blocked.goto(viewerUrl).catch(() => undefined);
  await sleep(500);
  await blocked.screenshot({ path: `${shots}/2-blocked-while-terminated.png` });
  const ext = await extensionsPage(context);
  await ext.reload();
  await sleep(800);
  await ext.screenshot({ path: `${shots}/3-extensions-page-reload-button.png` });
  const t = Date.now();
  await ext.locator('#terminated-reload-button').filter({ visible: true }).click();
  // The "blocked" tab is one of ours with no live page: the service worker reloads it, and the draft comes back in it.
  const box = noteBox(blocked);
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await readBox(box)).text, { timeout: 15_000 }).toBe(typed);
  const back = Date.now() - t;
  await sleep(500);
  await blocked.bringToFront();
  await blocked.screenshot({ path: `${shots}/4-back-with-the-draft.png` });
  console.log(`\n=== the blocked tab reloaded by itself and showed the draft ${back} ms after the Reload click; caret at end ${(await readBox(box)).caretAtEnd}; shots in ${shots} ===\n`);
});
