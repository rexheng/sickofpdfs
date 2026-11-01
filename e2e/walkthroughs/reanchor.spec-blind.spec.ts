// Gate 1, Phase 2 plan section 4, item 9: "Re-anchoring (walkthrough 9)."
//   "A stamped re-download shows the marks on the same words. If the passage has moved, the card says 'Moved'. If the passage is
//    gone, the note goes under 'Couldn't place', and nothing is drawn."
// Spec, walkthrough 9: "You move, rename or re-download a file. Same contents, same fingerprint, same notes. Re-downloads that differ
// only by a download stamp, as JSTOR adds, are recognised by their text." Re-anchoring on open: "the stored position is used only if
// the quote still matches there; next comes the quote on the same page; then a fuzzy match across the document scoring at least 0.8
// on a quote of at least 12 characters ... Anything else goes to 'Couldn't place', never onto doubtful text." Contracts section 2:
// "Line breaks are not content", "A fuzzy placement is never silent: the card shows a quiet 'Moved' label"; plan section 7: "'Moved'
// shows for fuzzy, caption and image placements." Plan S15: the notes panel has a "Couldn't place" section.
//
// The PDFs are made here (a download stamp added to a real paper; a paper-shaped file with one sentence changed or replaced), served
// from the fixture server, and opened in a second tab, as the owner would open a re-download. All of it needs the library, so it
// waits for the save decision (Task 30).
//
// GUESSES: a stamp line printed at the top of every page is a "download stamp" the library takes no notice of; a sentence with one word
// changed is a "close match" (Moved); a sentence replaced by an unrelated one is "gone"; the panel opens with Shift+F4 and shows the
// note under the words "Couldn't place".
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { stampPdf } from '../../packages/viewer/test/spec-blind/p2-pdf-fixtures';
import { TEST_ASSETS } from '../support/server';
import { expect, hooks, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  NO_SAVING,
  SAVING_AVAILABLE,
  SENTENCE_1,
  WIDE,
  allCards,
  annotations,
  cardWith,
  describe,
  highlightFromMenu,
  libraryId,
  markPixelsOnPage,
  markTokens,
  paintOfSelection,
  postNote,
  selectPassage,
  settle,
  waitSaved,
  waitStored,
  type OpenViewer,
  type TlFixture,
} from './support/marks.spec-blind';
import { makePaper, TARGET_PASSAGE, TARGET } from './support/synthetic-paper.spec-blind';
import { shot } from './support/takeover';
import { store as storeOf } from '../support/store-probe.spec-blind';

test.setTimeout(150_000);
test.skip(!SAVING_AVAILABLE, NO_SAVING);

const YELLOW = 0;
const GREEN = 1;

/** Opens a PDF the fixture server holds under `path`, in a window big enough for a page and its margin column. */
async function openServed(openViewer: OpenViewer, server: { url(p: string): string }, path: string): Promise<Page> {
  const page = await openViewer(server.url(path));
  await page.setViewportSize(WIDE);
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 25_000 });
  return page;
}

/** The page (0-based) that holds `phrase`, found with the engine's own search. */
async function pageHolding(page: Page, phrase: string): Promise<number> {
  const found = await hooks(page).eval(
    async (h, q) => {
      const doc = h.doc();
      if (!doc) return -1;
      for (let i = 0; i < doc.open.pageCount; i++) {
        const hits = await h.backend.searchPage(doc.open.doc, i, q, { matchCase: true, wholeWord: false });
        if (hits.length > 0) return i;
      }
      return -1;
    },
    phrase,
  );
  expect(found, `"${phrase}" is somewhere in the paper`).toBeGreaterThanOrEqual(0);
  return found;
}

/** Scrolls to page `index` and waits for its text layer. */
async function showPage(page: Page, index: number): Promise<TlFixture> {
  await hooks(page).eval((h) => h.viewer.setScale(1));
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), index);
  await page.waitForSelector(`[data-page-index="${index}"] [data-start]`, { state: 'attached', timeout: 20_000 });
  await settle(page, 600);
  return { name: `page-${index + 1}`, file: '', page: index, dir: 'ltr' };
}

const bytesOfAttention = (): Promise<Buffer> => readFile(join(TEST_ASSETS, ATTENTION.file));

test('a stamped re-download shows the same marks and notes on the same words, with no "Moved" label', async ({ openViewer, server }, testInfo) => {
  const original = await bytesOfAttention();
  server.serveSequence('/gen/attention-original.pdf', [original]);
  server.serveSequence('/gen/attention-stamped.pdf', [await stampPdf(original, { where: 'header' })]);
  const a = await openServed(openViewer, server, '/gen/attention-original.pdf');
  const tokens = await markTokens(a);
  const fx = await showPage(a, 0);
  const id = await waitSaved(a);
  const green = await selectPassage(a, fx, SENTENCE_1);
  await highlightFromMenu(a, green, 'green');
  await postNote(a, fx, LINES.l7, 'Note that must survive a re-download');
  await waitStored(a, (x) => x.marks.length >= 2 && x.comments.some((c) => c.body === 'Note that must survive a re-download' && c.draftOfTab === null), 'the marks and the note are stored');
  await shot(a, testInfo, 'original');

  const b = await openServed(openViewer, server, '/gen/attention-stamped.pdf');
  const fxB = await showPage(b, 0);
  expect(await waitSaved(b), 'the stamped copy is the same library document, not a new one').toBe(id);
  const sentence = await selectPassage(b, fxB, SENTENCE_1);
  const line = await selectPassage(b, fxB, LINES.l7);
  await expect(cardWith(b, 'Note that must survive a re-download'), 'the note is on the stamped copy').toBeVisible({ timeout: 15_000 });
  const hl = await paintOfSelection(b, sentence, { name: 'stamped-green', testInfo });
  expect(hl.paint.share(tokens.fill[GREEN]), `the green highlight is on the same words in the stamped copy: ${describe(hl.paint)}`).toBeGreaterThanOrEqual(0.6);
  const cm = await paintOfSelection(b, line);
  expect(cm.paint.share(tokens.fill[YELLOW]), `and so is the comment's highlight: ${describe(cm.paint)}`).toBeGreaterThanOrEqual(0.6);
  await expect(b.getByText('Moved', { exact: true }), 'the words are exactly where the note says: no "Moved" label').toHaveCount(0);
  const stats = await storeOf(b).stats();
  expect(stats.documents, 'the library holds one document').toBe(1);
  expect((await annotations(b, id)).comments.filter((c) => c.deletedAt === null)).toHaveLength(1);
  await shot(b, testInfo, 'stamped-copy');
});

test('the same file under another address (moved or renamed) shows the same notes', async ({ openViewer, server }, testInfo) => {
  const original = await bytesOfAttention();
  server.serveSequence('/gen/folder-one/attention.pdf', [original]);
  server.serveSequence('/gen/folder-two/renamed-copy-1.pdf', [original]);
  const a = await openServed(openViewer, server, '/gen/folder-one/attention.pdf');
  const fx = await showPage(a, 0);
  const id = await waitSaved(a);
  await postNote(a, fx, LINES.l3, 'Follows the file, not the address');
  await waitStored(a, (x) => x.comments.some((c) => c.body === 'Follows the file, not the address' && c.draftOfTab === null), 'the note is stored');

  const b = await openServed(openViewer, server, '/gen/folder-two/renamed-copy-1.pdf');
  await showPage(b, 0);
  expect(await waitSaved(b)).toBe(id);
  await expect(cardWith(b, 'Follows the file, not the address'), 'the note is there at the new address').toBeVisible({ timeout: 15_000 });
  await expect(b.getByText('Moved', { exact: true })).toHaveCount(0);
  await shot(b, testInfo, 'renamed-copy');
});

test('if the passage has moved a little (a word changed), the note is placed on the closest match and the card says "Moved"', async ({ openViewer, server }, testInfo) => {
  server.serveSequence('/gen/paper-v1.pdf', [await makePaper('v1')]);
  server.serveSequence('/gen/paper-v2.pdf', [await makePaper('v2')]);
  const a = await openServed(openViewer, server, '/gen/paper-v1.pdf');
  const index = await pageHolding(a, TARGET.v1);
  const fx = await showPage(a, index);
  const id = await waitSaved(a);
  const tokens = await markTokens(a);
  await postNote(a, fx, TARGET_PASSAGE.v1, 'A note on the placebo sentence');
  await waitStored(a, (x) => x.comments.some((c) => c.body === 'A note on the placebo sentence' && c.draftOfTab === null), 'the note is stored');

  const b = await openServed(openViewer, server, '/gen/paper-v2.pdf');
  const fxB = await showPage(b, await pageHolding(b, TARGET.v2));
  expect(await waitSaved(b), 'the edited paper is the same library document').toBe(id);
  const card = cardWith(b, 'A note on the placebo sentence');
  await expect(card, 'the note is shown on the edited paper').toBeVisible({ timeout: 15_000 });
  await expect(card, 'a close match is never silent: the card says Moved').toContainText('Moved');
  const sentence = await selectPassage(b, fxB, TARGET_PASSAGE.v2);
  const painted = await paintOfSelection(b, sentence, { name: 'moved-highlight', testInfo });
  expect(painted.paint.share(tokens.fill[YELLOW]), `and the highlight is on the closest match: ${describe(painted.paint)}`).toBeGreaterThanOrEqual(0.6);
  await shot(b, testInfo, 'moved');
});

test('if the passage is gone, the note goes under "Couldn\'t place" and nothing is drawn', async ({ openViewer, server }, testInfo) => {
  server.serveSequence('/gen/paper-v1.pdf', [await makePaper('v1')]);
  server.serveSequence('/gen/paper-v3.pdf', [await makePaper('v3')]);
  const a = await openServed(openViewer, server, '/gen/paper-v1.pdf');
  const index = await pageHolding(a, TARGET.v1);
  const fx = await showPage(a, index);
  const id = await waitSaved(a);
  const tokens = await markTokens(a);
  await postNote(a, fx, TARGET_PASSAGE.v1, 'A note on a sentence that will go');
  await waitStored(a, (x) => x.comments.some((c) => c.body === 'A note on a sentence that will go' && c.draftOfTab === null), 'the note is stored');

  const b = await openServed(openViewer, server, '/gen/paper-v3.pdf');
  await showPage(b, index);
  expect(await waitSaved(b), 'the edited paper is the same library document').toBe(id);
  await b.waitForTimeout(1500); // time for the notes to be placed
  expect(await markPixelsOnPage(b, index, tokens), 'nothing is drawn where the passage used to be (no highlight of any colour)').toBeLessThan(20);
  await shot(b, testInfo, 'gone-nothing-drawn');

  await b.keyboard.press('Shift+F4');
  await expect(b.getByText(/couldn.t place/i).first(), 'the notes panel has a "Couldn\'t place" section').toBeVisible({ timeout: 5000 });
  const card = cardWith(b, 'A note on a sentence that will go');
  await expect(card.first(), 'and the note is in it').toBeVisible();
  await expect(card.first()).toContainText(/couldn.t place/i);
  await shot(b, testInfo, 'couldnt-place-in-the-panel');
  expect(await markPixelsOnPage(b, index, tokens), 'still nothing drawn with the panel open').toBeLessThan(20);
  expect(await allCards(b).count()).toBeGreaterThan(0);
  expect(await libraryId(b)).toBe(id);
});
