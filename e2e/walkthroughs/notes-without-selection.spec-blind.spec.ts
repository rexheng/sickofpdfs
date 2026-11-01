// Gate 1, Phase 2 plan section 4, item 7: "Notes with nothing selected."
//   "Ctrl+Alt+M makes a point note over a page, or a page note off the pages. Ctrl+Alt+Shift+M makes a document note. On
//    scan-120.pdf, page, point and area notes all work."
// Spec, "How it feels to use" 4: "With nothing selected, Ctrl+Alt+M makes a note where the pointer is, or for the page." Shortcuts
// table: "Comment on selection, or note at pointer or page: Ctrl+Alt+M. Document note: Ctrl+Alt+Shift+M." Plan S14: "With nothing
// selected, it makes a point note at the pointer, or else a page note. Ctrl+Alt+Shift+M makes a document note." Spec, Scanned PDFs:
// "Release 1: scans open normally and take page, point and area notes." Area marks (Alt+drag) belong to slice S16, so the area step
// waits for it.
//
// GUESSES: a card for a page note says which page ("Page 3"), a card for a document note says it is on the whole document (the UI
// kit's card label: "Page 4", "Whole document"); a point note sits level with the pointer.
import type { Page } from '@playwright/test';
import { expect, hooks, test } from '../support/test';
import {
  ATTENTION,
  FIGURES_AVAILABLE,
  LINES,
  NO_FIGURES,
  NO_SAVING,
  SAVING_AVAILABLE,
  SCAN,
  WIDE,
  allCards,
  annotations,
  boxOf,
  cardWith,
  clearSelection,
  describe,
  grab,
  isPlain,
  lineBoxes,
  middleOf,
  noteBox,
  note,
  openPaper,
  pageRect,
  paintOf,
  paintOfSelection,
  reloadAndWait,
  selectPassage,
  settle,
  startNoteAnswering,
  waitSaved,
  waitStored,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(120_000);

/** Pointer over a page, nothing selected, Ctrl+Alt+M, a note typed and sent. */
async function noteAt(page: Page, at: { x: number; y: number }, text: string, keys = 'Control+Alt+m'): Promise<void> {
  await clearSelection(page);
  await page.mouse.move(at.x, at.y);
  await startNoteAnswering(page, 'No', keys);
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, text), `the note "${text}" becomes a card`).toBeVisible({ timeout: 5000 });
}

const GUTTER = { x: 8, y: 420 };

test('with nothing selected and the pointer over a page, Ctrl+Alt+M makes a point note level with the pointer, and marks no words', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l11);
  const at = await middleOf(page, sel);
  await clearSelection(page);
  await page.mouse.move(at.x, at.y);
  // Triage (TB2): the page moves when the note margin opens; the point is where the pointer was on the page before that.
  const pBefore = await pageRect(page, 0);
  const box = await startNoteAnswering(page, 'No');
  await page.waitForTimeout(300);
  await shot(page, testInfo, 'point-note-box');
  const card = page.getByRole('article').filter({ has: box });
  const c = await boxOf(card);
  const p = await pageRect(page, 0);
  expect(c.left, 'the note box is in the margin, not on the page').toBeGreaterThanOrEqual(p.right - 4);
  expect(Math.abs(c.top - at.y), `the note is level with the pointer (pointer y ${at.y.toFixed(0)}, card top ${c.top.toFixed(0)})`).toBeLessThanOrEqual(120);
  await page.keyboard.type('A point note on this line', { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'A point note on this line')).toBeVisible();
  // Triage (TB2): the viewer marks a point note with a round pin at the pointer, which sits on the words; the words are
  // judged beside the pin, and the notes model must hold no highlight.
  await clearSelection(page);
  const pin = await page.getByRole('button', { name: /^note on page/i }).boundingBox();
  const lines = await lineBoxes(page, sel);
  const beside = pin === null ? lines : lines.flatMap((l) => (l.bottom < pin.y || l.top > pin.y + pin.height ? [l] : [{ ...l, right: pin.x - 2 }, { ...l, left: pin.x + pin.width + 2 }]));
  const words = paintOf(await grab(page, 'point-note-sent', testInfo), beside);
  expect(isPlain(words), `a point note is not a highlight: the words under the pointer are plain: ${describe(words)}`).toBe(true);
  expect(await hooks(page).eval((h) => h.annotations?.state().marks.length ?? -1), 'and no mark was made').toBe(0);

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const a = await waitStored(page, (x) => x.threads.some((t) => t.anchor.kind === 'point'), 'a point thread is stored');
    const t = a.threads.find((x) => x.anchor.kind === 'point')!;
    const [nx, ny] = t.anchor.point as [number, number];
    expect(Math.abs(nx - (at.x - pBefore.left) / (pBefore.right - pBefore.left)), 'the point is where the pointer was (across the page)').toBeLessThan(0.03);
    expect(Math.abs(ny - (at.y - pBefore.top) / (pBefore.bottom - pBefore.top)), 'and down the page').toBeLessThan(0.03);
    expect(t.anchor.page ?? t.pageIndex, 'on the first page').toBe(0);
    expect(a.marks.filter((m) => m.style === 'highlight' && m.deletedAt === null), 'and no highlight is stored with it').toHaveLength(0);
  }
});

test('with the pointer off the pages, Ctrl+Alt+M makes a page note for the page in view', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), 2);
  await settle(page, 600);
  await noteAt(page, GUTTER, 'A note for the whole page');
  const card = cardWith(page, 'A note for the whole page');
  // Triage (TB2): the label "Page 3" runs into the avatar icon's ligature text ("person") in textContent.
  await expect(card, 'a page note says which page it is for').toContainText(/page\s*3(?!\d)/i);
  await shot(page, testInfo, 'page-note');
  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const a = await waitStored(page, (x) => x.threads.some((t) => t.anchor.kind === 'page'), 'a page thread is stored');
    const t = a.threads.find((x) => x.anchor.kind === 'page')!;
    expect(t.anchor.page ?? t.pageIndex, 'page index 2 is the third page').toBe(2);
  }
});

test('Ctrl+Alt+Shift+M makes a document note, with or without words selected', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await noteAt(page, GUTTER, 'A note about the whole paper', 'Control+Alt+Shift+m');
  await expect(cardWith(page, 'A note about the whole paper'), 'a document note says it is for the whole document').toContainText(/document/i);

  // with words selected it is still a document note, and it does not highlight them
  const sel = await selectPassage(page, ATTENTION, LINES.l5);
  await startNoteAnswering(page, 'No', 'Control+Alt+Shift+m');
  await page.keyboard.type('A second document note', { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'A second document note')).toContainText(/document/i);
  const words = await paintOfSelection(page, sel, { name: 'document-note-no-highlight', testInfo });
  expect(isPlain(words.paint), `a document note highlights nothing: ${describe(words.paint)}`).toBe(true);
  await shot(page, testInfo, 'document-notes');

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const a = await waitStored(page, (x) => x.threads.filter((t) => t.anchor.kind === 'document').length === 2, 'two document threads are stored');
    expect(a.marks.filter((m) => m.deletedAt === null)).toHaveLength(0);
  }
});

test('point, page and document notes are all back after a reload', async ({ openViewer, server }, testInfo) => {
  test.skip(!SAVING_AVAILABLE, NO_SAVING);
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l7);
  const at = await middleOf(page, sel);
  await noteAt(page, at, 'Reloaded point note');
  // Triage (TB2): Task 30's stand-in filter calls every PDF "Not sure" until Phase 3, so the first note is what saves it.
  await waitSaved(page);
  await noteAt(page, GUTTER, 'Reloaded page note');
  await noteAt(page, GUTTER, 'Reloaded document note', 'Control+Alt+Shift+m');
  await waitStored(page, (a) => a.comments.filter((c) => c.draftOfTab === null && c.deletedAt === null).length === 3, 'three notes are stored');
  await reloadAndWait(page, ATTENTION);
  for (const text of ['Reloaded point note', 'Reloaded page note', 'Reloaded document note']) {
    await expect(cardWith(page, text), `"${text}" is back after a reload`).toBeVisible({ timeout: 10_000 });
  }
  await shot(page, testInfo, 'three-notes-after-reload');
  expect((await annotations(page)).threads.map((t) => t.anchor.kind).sort()).toEqual(['document', 'page', 'point']);
});

test.describe('a scan (scan-120.pdf)', () => {
  /** Opens page 1 of the scan, which has no text layer. */
  async function openScan(openViewer: Parameters<typeof openPaper>[0], server: Parameters<typeof openPaper>[1]): Promise<Page> {
    const page = await openViewer(server.url(`/f/${SCAN.file}`));
    await page.setViewportSize(WIDE);
    await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 25_000 });
    await hooks(page).eval((h) => h.viewer.setScale(1));
    await hooks(page).eval((h) => h.viewer.scrollTo(0));
    await settle(page, 1200);
    return page;
  }

  test('a point note and a page note work on a page with no text', async ({ openViewer, server }, testInfo) => {
    const page = await openScan(openViewer, server);
    const p = await pageRect(page, 0);
    await shot(page, testInfo, 'scan-opened');
    const centre = { x: (p.left + p.right) / 2, y: p.top + 300 };

    // The first note on a scan may ask whether to save it; the walkthrough says No and the note still works (in memory).
    await clearSelection(page);
    await page.mouse.move(centre.x, centre.y);
    await startNoteAnswering(page, 'No');
    await page.keyboard.type('A point note on the scan', { delay: 8 });
    await page.keyboard.press('Enter');
    await expect(cardWith(page, 'A point note on the scan'), 'a point note works on a scan').toBeVisible({ timeout: 5000 });
    expect(await noteBox(page).count()).toBe(0);

    await noteAt(page, GUTTER, 'A page note on the scan');
    await expect(cardWith(page, 'A page note on the scan'), 'a page note works on a scan').toContainText(/page\s*1(?!\d)/i);
    expect(await allCards(page).count()).toBe(2);
    await shot(page, testInfo, 'scan-notes');
  });

  test('an Alt+drag rectangle on a scan is an area, and Ctrl+Alt+M comments on it', async ({ openViewer, server }, testInfo) => {
    test.skip(!FIGURES_AVAILABLE, NO_FIGURES);
    const page = await openScan(openViewer, server);
    const p = await pageRect(page, 0);
    const from = { x: p.left + 120, y: p.top + 200 };
    const to = { x: p.left + 360, y: p.top + 320 };
    await page.keyboard.down('Alt');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await settle(page, 300);
    await shot(page, testInfo, 'scan-area-drawn');
    await startNoteAnswering(page, 'No');
    await page.keyboard.type('A note on this area of the scan', { delay: 8 });
    await page.keyboard.press('Enter');
    await expect(cardWith(page, 'A note on this area of the scan'), 'an area note works on a scan').toBeVisible({ timeout: 5000 });
    note(testInfo, 'area note', 'drawn with Alt+drag, commented with Ctrl+Alt+M');
  });
});
