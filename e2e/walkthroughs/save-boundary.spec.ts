// Regression walkthroughs for the moment a PDF becomes saved, or stops being saved (ruling R67). Written from the Test
// build 2 code-and-security critic's bug report (tb2-critic-code-security.md, findings 1 to 6) and the student critic's
// "Undo silently deletes a long first note", not spec-blind: each test is the critic's reproduction, done the way the
// owner does it, with no "Save?" press first, because in TB2 every PDF is "Not sure" and the owner's first note always
// lands in this moment.
//
// R67, in short:
//   (a) what is made while the save is on its way is kept as save-pending, under the file's fingerprint; a tab that closes
//       or crashes mid-save loses nothing, and the next open completes the save; a failed save keeps the text and says
//       "Couldn't save. Try again";
//   (b) only real content saves: the first applied mark, or the first keystroke in a new note. An empty note box and Esc
//       leave nothing saved and nothing stored;
//   (c) the first-mark Undo chip goes as soon as there is anything else, in any tab;
//   (d) every open tab follows an Undo back to "Not sure" and drops the undone mark;
//   (e) Undo clears the PDF's localStorage too;
//   (f) a save a note started has no Undo chip at all.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { dragSelect } from '../support/drag-select';
import { forceVerdict, realVerdict } from '../support/filter-verdict';
import { TEST_ASSETS } from '../support/server';
import { settle, setZoom, waitForTextLayer } from '../support/tl-blind.spec-blind';
import { store as storeOf, waitForStore, ZERO_STATS } from '../support/store-probe.spec-blind';
import { expect, hooks, test, type FixtureServer } from '../support/test';
import {
  ATTENTION,
  savePrompt,
  RECEIPT,
  LINES,
  cardWith,
  crashRenderer,
  libraryId,
  noteBox,
  openPaper,
  postNote,
  readBox,
  selectPassage,
  startNote,
  type TlFixture,
  waitSaved,
} from './support/marks.spec-blind';
import { chipText, forgetThisPdf, saveFromChip } from './support/library-p3.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(180_000);

// Triage (S11): Phase 3's real filter calls these papers learning and saves them as they open. These tests are about the
// moment a "not sure" PDF is saved, so the test build's switch makes every PDF "not sure", as TB2's stand-in filter did.
test.beforeEach(async ({ context }) => forceVerdict(context, 'unsure'));

/** A 714-page textbook: its save reads every page's text first, so "Saving…" lasts seconds (4–4.5 s on the critic's box). */
const BOOK: TlFixture = { name: 'boyd', file: 'classifier/learning/textbook-boyd-convex-optimization.pdf', page: 0, dir: 'ltr' };

const undoChip = (page: Page) => page.getByRole('button', { name: /^undo$/i });
const notSureChip = (page: Page) => page.getByRole('button', { name: /^not sure/i });
const savedChip = (page: Page) => page.getByText(/^saved to library$/i);
const savingChip = (page: Page) => page.getByText(/^saving/i);
const address = (server: FixtureServer, fx: TlFixture): string => server.url(`/f/${fx.file}`);

/** Opens `fx` and waits until the chip says "Not sure": the stand-in filter's verdict on every PDF in TB2. */
async function openNotSure(openViewer: Parameters<typeof openPaper>[0], server: FixtureServer, fx: TlFixture): Promise<Page> {
  const page = await openPaper(openViewer, server, fx);
  await waitForStore(page);
  await expect(notSureChip(page), 'the chip says "Not sure: Save?"').toBeVisible({ timeout: 30_000 });
  return page;
}

/** Drags over the first long word on the fixture's page (for a PDF whose text these tests do not know). */
async function selectAWord(page: Page, fx: TlFixture): Promise<void> {
  const text = await hooks(page).eval((h, i) => h.backend.getPageText(h.doc()!.open.doc, i), fx.page);
  const m = /[A-Za-z]{6,}/u.exec(text);
  if (!m) throw new Error(`no word to select on page ${fx.page + 1}`);
  const { ranges } = await dragSelect(page, fx.page, m.index, m.index + m[0].length - 1);
  expect(ranges.length, 'the drag selects the word').toBeGreaterThan(0);
}

/** Everything this computer keeps of the PDF in the extension's localStorage: journal, save-pending, margin hint. */
async function tracesOf(page: Page, sha: string): Promise<string[]> {
  return page.evaluate((s) => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? '';
      const v = localStorage.getItem(k) ?? '';
      if (k.startsWith('sop-draft:') || k.startsWith('sop-pending:') || k.includes(s) || v.includes(s.slice(0, 16))) out.push(k);
    }
    return out;
  }, sha);
}

/** The PDF copies the extension keeps in its private file storage. */
async function storedCopies(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const out: string[] = [];
    const walk = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
      for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind === 'directory') await walk(h as FileSystemDirectoryHandle, `${path}${name}/`);
        else if (/\.pdf$/i.test(name)) out.push(`${path}${name}`);
      }
    };
    await walk(await navigator.storage.getDirectory(), '/');
    return out;
  });
}

const fingerprintOf = (page: Page): Promise<string> => hooks(page).eval((h) => h.doc()!.loaded.sha256);

/** The text in the open note box, once one is on the screen. */
async function noteText(page: Page, timeout = 20_000): Promise<string> {
  const box = noteBox(page);
  await expect(box, 'a note box is on the screen').toBeVisible({ timeout });
  return (await readBox(box)).text;
}

/** Keeps checking for `ms` that the Undo chip never shows. */
async function neverUndo(page: Page, ms: number, message: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect(await undoChip(page).count(), message).toBe(0);
    await page.waitForTimeout(100);
  }
}

test.describe('the first note on a "Not sure" PDF (finding 1, the blocker)', () => {
  for (const how of ['reload', 'close and reopen'] as const) {
    test(`two letters typed before the save lands, left unsent: after a ${how} the note is back`, async ({ openViewer, server }, testInfo) => {
      const page = await openNotSure(openViewer, server, BOOK);
      await selectAWord(page, BOOK);
      await startNote(page);
      await page.keyboard.type('Hi', { delay: 5 }); // typing stops before the long save is done
      const id = await waitSaved(page, 60_000);
      await page.waitForTimeout(1500); // the box is still open, holding the text, well after the save
      await shot(page, testInfo, 'typed-and-saved');

      let again = page;
      if (how === 'reload') await page.reload();
      else {
        await page.close();
        again = await openViewer(address(server, BOOK));
      }
      await expect.poll(() => noteText(again).catch(() => ''), { timeout: 30_000, message: 'the unsent note is back in its box' }).toBe('Hi');
      expect(await libraryId(again), 'and the PDF is still the saved one').toBe(id);
      await shot(again, testInfo, 'note-back');
    });
  }
});

test.describe('a note typed while the chip says "Saving…" (finding 2, R67 a)', () => {
  const NOTE = 'An important thought I must not lose';
  const WAYS = [
    { name: 'the tab is closed', go: (p: Page) => p.close({ runBeforeUnload: true }) },
    { name: 'the renderer crashes', go: (p: Page) => crashRenderer(p) },
  ];
  for (const { name, go } of WAYS) {
    test(`${name} mid-save: on the next open the save completes and the note is back`, async ({ openViewer, server }, testInfo) => {
      const page = await openNotSure(openViewer, server, BOOK);
      await selectAWord(page, BOOK);
      await startNote(page);
      await page.keyboard.type(NOTE, { delay: 10 });
      await expect(savingChip(page), 'the save is still on its way').toBeVisible({ timeout: 2000 });
      expect(await libraryId(page), 'nothing is in the library yet').toBeNull();
      await shot(page, testInfo, 'typed-while-saving');

      await go(page);

      const again = await openViewer(address(server, BOOK));
      await expect.poll(() => noteText(again).catch(() => ''), { timeout: 60_000, message: 'the note is back in its box' }).toBe(NOTE);
      await waitSaved(again, 60_000);
      await expect(savedChip(again), 'the save the owner started has completed').toBeVisible({ timeout: 30_000 });
      await shot(again, testInfo, 'saved-and-note-back');
    });
  }
});

test.describe('only real content saves (finding 3, R67 b)', () => {
  test('opening a note box and pressing Esc, with nothing typed, saves nothing and stores nothing', async ({ openViewer, server }, testInfo) => {
    const page = await openNotSure(openViewer, server, ATTENTION);
    const sha = await fingerprintOf(page);
    await selectPassage(page, ATTENTION, LINES.l1);
    await startNote(page);
    await page.waitForTimeout(1500);
    await expect(notSureChip(page), 'an open, empty note box does not save the PDF').toBeVisible();
    await shot(page, testInfo, 'empty-note-open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(3000);
    await expect(notSureChip(page), 'and after Esc it is still "Not sure"').toBeVisible();
    expect(await libraryId(page), 'nothing is in the library').toBeNull();
    expect(await storeOf(page).stats(), 'not a document, location, page of text, history row or outbox row').toEqual(ZERO_STATS);
    expect(await storedCopies(page), 'no copy of the PDF').toEqual([]);
    expect(await tracesOf(page, sha), 'and nothing about it in localStorage').toEqual([]);
    await shot(page, testInfo, 'after-esc');
  });

  test('a letter typed and deleted again before Esc leaves nothing saved either', async ({ openViewer, server }, testInfo) => {
    const page = await openNotSure(openViewer, server, ATTENTION);
    const sha = await fingerprintOf(page);
    await selectPassage(page, ATTENTION, LINES.l3);
    await startNote(page);
    await page.keyboard.type('x');
    await page.waitForTimeout(400);
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await expect.poll(() => libraryId(page), { timeout: 15_000, message: 'the save the letter started is taken back' }).toBeNull();
    await expect(notSureChip(page)).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => storeOf(page).stats(), { timeout: 10_000 }).toEqual(ZERO_STATS);
    expect(await storedCopies(page), 'no copy of the PDF').toEqual([]);
    expect(await tracesOf(page, sha), 'and nothing about it in localStorage').toEqual([]);
    await shot(page, testInfo, 'erased-and-esc');
  });
});

test.describe('Undo only removes what it promises (findings 5 and 6, R67 c and f)', () => {
  test('a save started by a note never shows Undo, while the note is typed or after it is sent', async ({ openViewer, server }, testInfo) => {
    const page = await openNotSure(openViewer, server, ATTENTION);
    await selectPassage(page, ATTENTION, LINES.l5);
    await startNote(page);
    await page.keyboard.type('A long, deliberate first note that must never vanish on a quick Undo', { delay: 5 });
    await waitSaved(page, 15_000);
    await neverUndo(page, 2500, 'no Undo chip while the note is open');
    await shot(page, testInfo, 'note-saved-no-undo');
    await page.keyboard.press('Enter');
    await expect(cardWith(page, 'A long, deliberate first note')).toBeVisible({ timeout: 5000 });
    await neverUndo(page, 1500, 'nor once it is sent');
  });

  test('the first-mark Undo goes as soon as a note box opens in the same tab', async ({ openViewer, server }, testInfo) => {
    const page = await openNotSure(openViewer, server, ATTENTION);
    await selectPassage(page, ATTENTION, LINES.l1);
    await page.keyboard.press('h');
    await waitSaved(page, 15_000);
    await expect(undoChip(page), 'a first mark saves with an Undo chip').toBeVisible({ timeout: 5000 });
    await selectPassage(page, ATTENTION, LINES.l7);
    await startNote(page);
    await expect(undoChip(page), 'with a note box open there is no Undo').toHaveCount(0, { timeout: 2000 });
    await shot(page, testInfo, 'note-open-no-undo');
  });

  test('the first-mark Undo goes as soon as another tab writes a note on the same PDF', async ({ openViewer, server }, testInfo) => {
    const a = await openNotSure(openViewer, server, ATTENTION);
    const b = await openNotSure(openViewer, server, ATTENTION);
    await a.bringToFront();
    await selectPassage(a, ATTENTION, LINES.l1);
    await a.keyboard.press('h');
    await waitSaved(a, 15_000);
    await expect(undoChip(a), 'tab A: the first mark saved it, with Undo').toBeVisible({ timeout: 5000 });
    await expect(savedChip(b), 'tab B follows: "Saved to library"').toBeVisible({ timeout: 10_000 });

    await b.bringToFront();
    await selectPassage(b, ATTENTION, LINES.l9);
    await startNote(b);
    await b.keyboard.type('Written in tab B', { delay: 10 });
    await expect(undoChip(a), "tab A's Undo goes: it would delete tab B's note").toHaveCount(0, { timeout: 3000 });
    await shot(a, testInfo, 'tab-a-no-undo');
  });
});

test.describe('every tab follows an Undo (finding 4, R67 d and e)', () => {
  test('Undo in tab A: tab B goes back to "Not sure" and drops the mark; a note B writes then is saved and kept', async ({ openViewer, server }, testInfo) => {
    const a = await openNotSure(openViewer, server, ATTENTION);
    const b = await openNotSure(openViewer, server, ATTENTION);
    const sha = await fingerprintOf(a);
    await a.bringToFront();
    await selectPassage(a, ATTENTION, LINES.l1);
    await a.keyboard.press('h');
    await waitSaved(a, 15_000);
    await expect(savedChip(b), 'tab B follows the save').toBeVisible({ timeout: 10_000 });
    await expect.poll(() => hooks(b).eval((h) => h.annotations?.state().marks.length ?? -1), { timeout: 10_000, message: "tab B draws A's highlight" }).toBe(1);

    await undoChip(a).click();
    await expect.poll(() => libraryId(a), { timeout: 10_000, message: 'Undo takes the PDF out of the library' }).toBeNull();
    await expect(notSureChip(b), 'tab B never shows "Saved" for a PDF that is not saved').toBeVisible({ timeout: 5000 });
    await expect.poll(() => hooks(b).eval((h) => h.annotations?.state().marks.length ?? -1), { timeout: 5000, message: 'and drops the undone highlight' }).toBe(0);
    expect(await tracesOf(a, sha), 'Undo leaves nothing about the PDF in localStorage').toEqual([]);
    await shot(b, testInfo, 'tab-b-after-undo-in-a');

    await b.bringToFront();
    await postNote(b, ATTENTION, LINES.l3, 'Written in B after A undid');
    await waitSaved(b, 15_000);
    await b.close();
    await a.close();

    const c = await openPaper(openViewer, server, ATTENTION);
    await expect(cardWith(c, 'Written in B after A undid'), "B's note was saved and is there").toBeVisible({ timeout: 20_000 });
    await shot(c, testInfo, 'reopened');
  });
});

test.describe('a save that fails (R67 a)', () => {
  test('the note stays in the tab and on this computer, the chip says "Couldn\'t save. Try again", and the click saves it', async ({ openViewer, server }, testInfo) => {
    const page = await openNotSure(openViewer, server, ATTENTION);
    // The engine cannot read the middle pages' text, which the save needs (the filter only read the first and last five).
    await hooks(page).eval((h) => {
      const b = h.backend as unknown as { getPageText(doc: unknown, i: number): Promise<string>; __real?: unknown };
      const real = b.getPageText.bind(b);
      b.__real = real;
      b.getPageText = (doc, i) => (i >= 5 && i < 10 ? Promise.reject(new Error('engine-failed: test')) : real(doc, i));
    });
    await selectPassage(page, ATTENTION, LINES.l11);
    await startNote(page);
    const NOTE = 'Kept while the save fails';
    await page.keyboard.type(NOTE, { delay: 10 });
    const failedChip = page.getByRole('button', { name: /couldn.t save\. try again/i });
    await expect(failedChip, 'the chip says the save failed, and offers to try again').toBeVisible({ timeout: 15_000 });
    expect((await readBox(noteBox(page))).text, 'the text is still in its box').toBe(NOTE);
    const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sop-pending:')).map((k) => localStorage.getItem(k) ?? ''));
    expect(kept.some((v) => v.includes(NOTE)), 'and on this computer').toBe(true);
    await shot(page, testInfo, 'save-failed');

    await hooks(page).eval((h) => {
      const b = h.backend as unknown as { getPageText: unknown; __real: unknown };
      b.getPageText = b.__real; // the engine reads every page again
    });
    await failedChip.click(); // the click leaves the note box, which sends the note (leaving a card sends typed text)
    await waitSaved(page, 15_000);
    await page.reload();
    await expect(cardWith(page, NOTE), 'after a reload the note is there').toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'saved-on-try-again');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// R67 tightened (1 Nov 2026), from the independent security read 3 (secread3-report.md, findings 1 to 4). A second
// download of the same book (the same bytes plus a comment line, so another fingerprint with the same text) is still
// "checking" for seconds after it opens, because the library holds a book with the same page count.

/** Serves a second download of the book: the same pages, another fingerprint. Returns its address. */
async function serveBookCopy(server: FixtureServer): Promise<string> {
  const bytes = await readFile(join(TEST_ASSETS, BOOK.file));
  server.serveSequence('/s/book-copy.pdf', [new Uint8Array(Buffer.concat([bytes, Buffer.from('\n% a second download of the same book\n')]))]);
  return server.url('/s/book-copy.pdf');
}

/** Opens `url` the way openPaper opens a fixture: wide window, rail shut, 100%, page 1's text layer built. */
async function openAt(openViewer: Parameters<typeof openPaper>[0], url: string): Promise<Page> {
  const page = await openViewer(url);
  await page.setViewportSize({ width: 1280, height: 1160 });
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 30_000 });
  if (await hooks(page).eval((h) => h.viewer.snapshot().railOpen)) await page.keyboard.press('F4');
  await setZoom(page, 1);
  await waitForTextLayer(page, 0);
  await settle(page);
  return page;
}

const saveKind = (page: Page): Promise<string> => hooks(page).eval((h) => h.save.state().kind);

test.describe('R67 tightened: a second download still being identified (secread3 findings 1 and 2)', () => {
  for (const what of ['a mark', 'a note'] as const) {
    test(`${what} made on the second download while it is "checking": tab A's first-mark Undo goes, and nothing B made can be undone away`, async ({ openViewer, server }, testInfo) => {
      const copyUrl = await serveBookCopy(server);
      const a = await openNotSure(openViewer, server, BOOK);
      await selectAWord(a, BOOK);
      await a.keyboard.press('h');
      const id = await waitSaved(a, 60_000);
      await expect(undoChip(a), 'tab A: the first mark saved the book, with Undo').toBeVisible({ timeout: 5000 });

      const b = await openAt(openViewer, copyUrl);
      expect(await saveKind(b), 'tab B is still working out which PDF it is').toBe('checking');
      await selectAWord(b, BOOK);
      if (what === 'a mark') await b.keyboard.press('h');
      else {
        await startNote(b);
        await b.keyboard.type('keep this', { delay: 10 });
      }
      await expect(undoChip(a), "tab A's Undo goes at once: it would delete what tab B made").toHaveCount(0, { timeout: 3000 });
      await shot(a, testInfo, 'tab-a-no-undo');

      await expect.poll(() => libraryId(b), { timeout: 60_000, message: 'tab B finds the copy is the same book' }).toBe(id);
      if (what === 'a mark') {
        await expect.poll(async () => (await storeOf(b).call<{ marks: unknown[] }>('listAnnotations', id)).marks.length, { timeout: 15_000, message: "both tabs' marks are kept" }).toBe(2);
      } else {
        await b.close();
        const again = await openAt(openViewer, copyUrl);
        await expect.poll(() => noteText(again).catch(() => ''), { timeout: 60_000, message: "tab B's note is kept" }).toBe('keep this');
      }
    });
  }

  test('a note typed while the second download is "checking" survives the tab closing before it knows', async ({ openViewer, server }, testInfo) => {
    const copyUrl = await serveBookCopy(server);
    const first = await openNotSure(openViewer, server, BOOK);
    await saveFromChip(first); // the owner saves the book (R95: the "Not sure" chip's menu has "Save to library")
    const id = await waitSaved(first, 60_000);
    // The chip says "Saved" once all 714 pages of text are stored too; the copy is matched against that text.
    await expect(savedChip(first), 'the save is complete').toBeVisible({ timeout: 60_000 });
    await first.close();

    const b = await openAt(openViewer, copyUrl);
    expect(await saveKind(b), 'still working out which PDF it is').toBe('checking');
    await selectAWord(b, BOOK);
    await startNote(b);
    await b.keyboard.type('remember me', { delay: 10 });
    expect(await saveKind(b), 'and still checking when the tab closes').toBe('checking');
    await shot(b, testInfo, 'typed-while-checking');
    await b.close({ runBeforeUnload: true });

    const again = await openAt(openViewer, copyUrl);
    await expect.poll(() => noteText(again).catch(() => ''), { timeout: 60_000, message: 'the note is back' }).toBe('remember me');
    expect(await libraryId(again), 'in the saved book').toBe(id);
    await shot(again, testInfo, 'note-back');
  });
});

test.describe('R67 tightened: no Undo for a save that carries a note (secread3 findings 3 and 4)', () => {
  test('a note whose save failed, then sent with Enter once the engine recovers: the save has no Undo', async ({ openViewer, server }, testInfo) => {
    const page = await openNotSure(openViewer, server, ATTENTION);
    await hooks(page).eval((h) => {
      const b = h.backend as unknown as { getPageText(doc: unknown, i: number): Promise<string>; __real?: unknown };
      const real = b.getPageText.bind(b);
      b.__real = real;
      b.getPageText = (doc, i) => (i >= 5 && i < 10 ? Promise.reject(new Error('engine-failed: test')) : real(doc, i));
    });
    await selectPassage(page, ATTENTION, LINES.l11);
    await startNote(page);
    await page.keyboard.type('My important note', { delay: 10 });
    await expect(page.getByRole('button', { name: /couldn.t save\. try again/i })).toBeVisible({ timeout: 15_000 });
    await hooks(page).eval((h) => {
      const b = h.backend as unknown as { getPageText: unknown; __real: unknown };
      b.getPageText = b.__real;
    });
    await page.keyboard.press('Enter');
    await waitSaved(page, 15_000);
    await neverUndo(page, 3000, 'a save that carries a note never offers Undo');
    await shot(page, testInfo, 'sent-after-failed-save');
  });

  test('two tabs closed mid-save: the next open shows "Saving your notes…", finishes the save with no Undo, and both marks are back', async ({ openViewer, server }, testInfo) => {
    const a = await openNotSure(openViewer, server, BOOK);
    const b = await openNotSure(openViewer, server, BOOK);
    await a.bringToFront();
    await selectAWord(a, BOOK);
    await a.keyboard.press('h');
    await expect(savingChip(a), 'tab A is saving').toBeVisible({ timeout: 3000 });
    await b.bringToFront();
    await dragSelect(b, 0, ...(await secondWord(b)));
    await b.keyboard.press('h');
    await b.waitForTimeout(300);
    expect(await libraryId(a), 'nothing is in the library yet').toBeNull();
    await a.close({ runBeforeUnload: true });
    await b.close({ runBeforeUnload: true });

    const again = await openAt(openViewer, address(server, BOOK));
    await expect(again.getByText(/^saving your notes/i), 'the chip says the notes are being saved').toBeVisible({ timeout: 30_000 });
    await shot(again, testInfo, 'saving-your-notes');
    await waitSaved(again, 60_000);
    await neverUndo(again, 2500, 'a save finished on reopen never offers Undo');
    await expect.poll(() => hooks(again).eval((h) => h.annotations?.state().marks.length ?? 0), { timeout: 15_000, message: 'both marks are back' }).toBe(2);
  });
});

/** The glyph range of the second long word on page 1 (the first is what selectAWord takes). */
async function secondWord(page: Page): Promise<[number, number]> {
  const text = await hooks(page).eval((h) => h.backend.getPageText(h.doc()!.open.doc, 0));
  const words = [...text.matchAll(/[A-Za-z]{6,}/gu)];
  const w = words[1] ?? words[0];
  return [w.index, w.index + w[0].length - 1];
}

// ---------------------------------------------------------------------------------------------------------------------
// The re-check of de49e7e (secread3-report.md, "Re-check of de49e7e"): N1 and N2.

test.describe('R67 re-check: an empty note box is not content (N1)', () => {
  test('tab B only opens an empty note box: tab A\'s note typed and erased before Esc still takes its save back', async ({ openViewer, server }, testInfo) => {
    const a = await openNotSure(openViewer, server, ATTENTION);
    const b = await openNotSure(openViewer, server, ATTENTION);
    const sha = await fingerprintOf(a);
    await a.bringToFront();
    await selectPassage(a, ATTENTION, LINES.l3);
    await startNote(a);
    await a.keyboard.type('x'); // real content: the save starts
    await b.bringToFront();
    await selectPassage(b, ATTENTION, LINES.l7);
    await startNote(b); // an empty note box, nothing typed
    await a.bringToFront();
    await noteBox(a).focus();
    await a.keyboard.press('Backspace');
    await a.waitForTimeout(300);
    await a.keyboard.press('Escape');
    await b.bringToFront();
    await noteBox(b).focus();
    await b.keyboard.press('Escape');
    await expect.poll(() => libraryId(a), { timeout: 20_000, message: 'nothing was made, so the save is taken back' }).toBeNull();
    await expect.poll(() => storeOf(a).stats(), { timeout: 10_000 }).toEqual(ZERO_STATS);
    expect(await storedCopies(a), 'no copy of the PDF').toEqual([]);
    expect(await tracesOf(a, sha), 'and nothing about it in localStorage').toEqual([]);
    await expect(notSureChip(b), 'tab B follows: "Not sure"').toBeVisible({ timeout: 10_000 });
    await shot(a, testInfo, 'nothing-saved');
  });
});

test.describe('R67 re-check: a resumed save on a PDF judged not learning keeps its notes while it asks (N2)', () => {
  // Triage (S11): this one needs the real filter's "not learning" verdict for the receipt, not the file's forced "not sure".
  test.beforeEach(async ({ context }) => realVerdict(context));
  test('the notes a crashed tab kept stay on this computer while "Save this PDF?" is open, and come back after a close', async ({ openViewer, server }, testInfo) => {
    // Needs the real filter's "not learning" verdict. There is no test hook for the verdict, and the stand-in filter
    // calls every PDF "Not sure" until Phase 3's filter lands, so this runs by itself from then on.
    const fileBytes = await readFile(join(TEST_ASSETS, RECEIPT.file));
    const { createHash } = await import('node:crypto');
    const fingerprint = createHash('sha256').update(fileBytes).digest('hex');
    const NOTE = 'Kept from a tab that crashed';

    const seedTab = await openPaper(openViewer, server, ATTENTION); // any extension page can write the extension's localStorage
    await seedTab.evaluate(
      ({ fp, note }) => {
        const t = Date.now();
        const thread = { id: 'aaaaaaaa-0000-4000-8000-00000000t001', documentId: fp, anchor: { kind: 'page', page: 0 }, pageIndex: 0, sortKey: 0, placement: 'placed', draftOfTab: 'tab-that-crashed', createdAt: t, updatedAt: t, rev: 0, hlc: '', deletedAt: null };
        const draft = { id: 'aaaaaaaa-0000-4000-8000-00000000c001', threadId: thread.id, documentId: fp, author: 'me', body: note, draftOfTab: 'tab-that-crashed', meta: { sopDraft: { thread, highlight: null } }, createdAt: t, editedAt: null, rev: 0, hlc: '', deletedAt: null };
        const rec = { v: 1, fingerprint: fp, tab: 'tab-that-crashed', life: 'life-that-crashed', at: t, undoable: false, ops: [], drafts: [draft], edits: [] };
        localStorage.setItem(`sop-pending:${fp}:tab-that-crashed:life-that-crashed`, JSON.stringify(rec));
      },
      { fp: fingerprint, note: NOTE },
    );
    const kept = (p: Page) => p.evaluate((fp) => Object.keys(localStorage).filter((k) => k.startsWith(`sop-pending:${fp}:`)).map((k) => localStorage.getItem(k) ?? ''), fingerprint);

    const page = await openPaper(openViewer, server, RECEIPT);
    await waitForStore(page);
    // A PDF judged not learning asks before the save finishes; under the stand-in filter ("Not sure") it just saves.
    let kind = '';
    await expect.poll(async () => (kind = await saveKind(page)), { timeout: 30_000, message: 'the resumed save asks, or saves' }).toMatch(/^(asking|saved)$/);
    test.skip(kind === 'saved', 'the stand-in filter calls every PDF "Not sure" until Phase 3, and there is no test hook for the verdict');

    await expect(savePrompt(page).first(), 'the save the crashed tab started asks first on a PDF judged not learning').toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    expect((await kept(page)).some((v) => v.includes(NOTE)), 'while the question is open, the notes are still kept on this computer').toBe(true);
    await shot(page, testInfo, 'question-open-notes-kept');
    await page.close(); // closed without answering

    const again = await openPaper(openViewer, server, RECEIPT);
    await expect(savePrompt(again).first(), 'it asks again').toBeVisible({ timeout: 25_000 });
    expect((await kept(again)).some((v) => v.includes(NOTE)), 'and the notes are still there').toBe(true);
    await again.getByRole('dialog').getByRole('button', { name: /^save$/i }).click(); // the question's "Save" (plain wording, R73)
    await waitSaved(again, 15_000);
    await expect.poll(() => noteText(again).catch(() => ''), { timeout: 20_000, message: 'Yes saves the PDF and the note is back' }).toBe(NOTE);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// TB4 code and security critic, finding 1 (major): Forget in one tab was undone by an unsent note in another tab. The
// other tab heard the delete, went back to "Not sure" and saved its note again before it learnt that the delete was the
// owner's Forget. Ruling (Nov 2): Forget wins. Every tab follows a Forget first; an unsent note in another tab stays in
// that tab (in memory, and in the drafts journal: no lost text); its chip says "Not saved: removed from your library",
// and nothing saves again until the owner acts. Not spec-blind: the critic's reproduction (p4/p5-forget-*.mjs), kept
// as a regression walkthrough under rule 10's exception (no lost notes, privacy).

test.describe('TB4 ruling: Forget wins over an unsent note in another tab (code and security critic, finding 1)', () => {
  test('tab B holds an unsent note while tab A forgets the PDF: A, B and the library all stay forgotten, and B keeps its text', async ({ openViewer, server }, testInfo) => {
    const DRAFT = 'draft in tab B';
    const a = await openNotSure(openViewer, server, ATTENTION);
    await saveFromChip(a); // the owner saves the paper
    await waitSaved(a);
    const b = await openPaper(openViewer, server, ATTENTION);
    await expect.poll(() => saveKind(b), { timeout: 30_000, message: 'tab B finds the paper in the library' }).toBe('saved');
    await b.bringToFront();
    await selectPassage(b, ATTENTION, LINES.l3);
    await startNote(b);
    await b.keyboard.type(DRAFT, { delay: 10 }); // not sent
    await b.waitForTimeout(500);

    await a.bringToFront();
    const forgot = await forgetThisPdf(a); // "Never save this file" left unticked
    expect(forgot.asked, 'Forget asks first').toBe(true);

    // Watch for 6 s, as the critic did: no tab and no write may bring the PDF back.
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      expect(await libraryId(a), 'the library never holds the PDF again').toBeNull();
      expect(await saveKind(b), 'tab B never saves it again on its own').not.toMatch(/^saved$/);
      await a.waitForTimeout(250);
    }
    await expect.poll(() => chipText(a), { timeout: 5000 }).toMatch(/not saved: removed from your library/i);
    await expect.poll(() => chipText(b), { timeout: 5000 }).toMatch(/not saved: removed from your library/i);
    expect((await storeOf(a).stats()).documents, 'no document row').toBe(0);
    await shot(a, testInfo, 'tab-a-forgotten');

    await b.bringToFront();
    expect((await readBox(noteBox(b))).text, "tab B's unsent note is still in its box").toBe(DRAFT);
    const kept = await b.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sop-draft:')).map((k) => localStorage.getItem(k) ?? ''));
    expect(kept.some((v) => v.includes(DRAFT)), 'and in the drafts journal (no lost text)').toBe(true);
    await shot(b, testInfo, 'tab-b-keeps-its-note');

    // Saving again needs the owner's own action: the next letter in the note asks first.
    await noteBox(b).focus();
    await b.keyboard.type('!');
    await expect(savePrompt(b).first(), 'the next letter asks "Save this PDF to keep your notes?"').toBeVisible({ timeout: 5000 });
    expect(await libraryId(b), 'and nothing is saved while it asks').toBeNull();
  });
});
