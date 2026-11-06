// Gate 1, Phase 3 plan, item 7: "Search."
//   "Ctrl+K in the viewer and in the library. Type a phrase from a page, a title word and a word from your comment. Each group finds it.
//    Enter lands on the passage. A trashed or forgotten reading does not appear. Filters narrow the list."
// Spec, "How it feels to use" 7: 'Press Ctrl+K in any viewer or library tab and type "parallel trends". Results show readings, matching
// pages and your notes; Enter jumps to the exact passage.' "One search box (Ctrl+K) covers titles, authors, full page text, figure captions,
// your notes and Claude's replies ... ranked by relevance with highlighted snippets. Enter jumps to the exact page and passage. Filters:
// starred, has notes, date read, and type." Plan, S9 (contracts section 5): "Trashed and unsaved documents never appear."
//
// The readings: the Callaway and Sant'Anna difference-in-differences paper (45 pages; "choose treatment status" is on page 8 and nowhere
// else, checked with pdftotext) with a note that holds the made-up word "zebrafish", and "Attention Is All You Need", starred. Both mention
// "conditional" on several pages, which is what the filter chips narrow.
//
// Guard: runtime. The library tab is opened first and Ctrl+K pressed; if no palette (a dialog) opens, the slice is not here and the test
// is skipped before it spends time on set-up.
// GUESSES: the palette is a dialog with a text field; its groups carry the headings "Readings", "Pages" and "Notes"; every hit is an
// option; the filter chips are buttons named "Starred" and "Has notes"; Enter opens the first hit in the group order Readings, Pages, Notes
// (so a query that matches only pages, or only a note, lands on that).
import type { BrowserContext, Page } from '@playwright/test';
import { expect, hooks, test, type FixtureServer } from '../support/test';
import { store as storeOf } from '../support/store-probe.spec-blind';
import { cardWith, findOnPage, postNote, saveFirst, type OpenViewer, type TlFixture, openPaper } from './support/marks.spec-blind';
import { OUR_VIEWER_RE } from './support/takeover';
import {
  ATTENTION,
  DID,
  DID_PAGE8_INDEX,
  DID_PAGE8_PHRASE,
  FORCE,
  allReadings,
  openLibrary,
  shotOf,
  waitForStore,
  waitViewerReady,
} from './support/library-p3.spec-blind';

test.setTimeout(420_000);

const DID_FX: TlFixture = { name: 'did', file: DID.file, page: 0, dir: 'ltr' };
const NOTE = 'Zebrafish analogy for staggered adoption';
const NOTE_PASSAGE = { from: 'Brantly', to: 'Callaway' };

const palette = (page: Page) => page.getByRole('dialog').first();
const hits = (page: Page) => palette(page).getByRole('option');
const heading = (page: Page, name: 'Readings' | 'Pages' | 'Notes') => palette(page).getByText(name, { exact: true });
const field = (page: Page) => palette(page).locator('input, [role=combobox], [role=searchbox], [contenteditable=true]').first();

async function openPalette(page: Page, timeout = 4000): Promise<boolean> {
  await page.keyboard.press('Control+k');
  return palette(page).waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}
async function ask(page: Page, text: string): Promise<void> {
  await field(page).fill(text);
  await page.waitForTimeout(600); // typing feels live; results follow a moment later
}
async function closePalette(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(palette(page)).toBeHidden();
}

interface Set {
  did: Page;
  didId: string;
  attentionId: string;
}

async function setUp(openViewer: OpenViewer, server: FixtureServer): Promise<Set> {
  const did = await openPaper(openViewer, server, DID_FX);
  await waitForStore(did);
  const didId = await saveFirst(did);
  await postNote(did, DID_FX, NOTE_PASSAGE, NOTE);

  const attention = await openViewer(server.url(ATTENTION.path));
  await waitViewerReady(attention);
  await waitForStore(attention);
  const attentionId = await saveFirst(attention);
  await storeOf(attention).call('setStarred', attentionId, true);
  await attention.close();
  await did.bringToFront();
  return { did, didId, attentionId };
}

async function paletteIsHere(context: BrowserContext): Promise<boolean> {
  const lib = await openLibrary(context, 'library');
  const here = await openPalette(lib);
  await lib.close();
  return here;
}

test('Search with Ctrl+K: from the viewer, from the library, and with filters', async ({ step }, testInfo) => {
  test.setTimeout(1_260_000);
  await step('Ctrl+K in the viewer: a title word, a page phrase and a word from your note each find their group; Enter lands on the passage', async ({ context, openViewer, server }) => {
    if (!FORCE && !(await paletteIsHere(context))) {
      testInfo.annotations.push({ type: 'step skipped', description: 'Ctrl+K opens no palette yet (slice S15)' });
      return;
    }
    const { did } = await setUp(openViewer, server);

    expect(await openPalette(did), 'Ctrl+K opens the palette in a viewer tab').toBe(true);
    await shotOf(did, testInfo, '01-palette-open');

    // a word from your comment: the Notes group
    await ask(did, 'zebrafish');
    await expect(heading(did, 'Notes'), 'a word from your comment is found under Notes').toBeVisible();
    await expect(hits(did).filter({ hasText: /zebrafish/i }).first()).toBeVisible();
    await shotOf(did, testInfo, '02-found-in-notes');

    // a title word: the Readings group
    await ask(did, 'difference');
    await expect(heading(did, 'Readings'), 'a title word is found under Readings').toBeVisible();
    await expect(hits(did).filter({ hasText: DID.rowName }).first()).toBeVisible();
    await shotOf(did, testInfo, '03-found-in-readings');

    // a phrase from a page: the Pages group, with the phrase highlighted in its snippet
    await ask(did, DID_PAGE8_PHRASE);
    await expect(heading(did, 'Pages'), 'a phrase from a page is found under Pages').toBeVisible();
    const hit = hits(did).filter({ hasText: /treatment status/i }).first();
    await expect(hit).toBeVisible();
    await expect(hit.locator('b, mark, strong').first(), 'the snippet highlights what matched').toBeVisible();
    await shotOf(did, testInfo, '04-found-in-pages');

    // Enter jumps to the exact passage, in this tab
    const before = did.url();
    await did.keyboard.press('Enter');
    await expect(palette(did), 'Enter closes the palette').toBeHidden();
    await expect.poll(() => hooks(did).eval((h) => h.viewer.currentPage()), { message: 'and lands on page 8', timeout: 15_000 }).toBe(DID_PAGE8_INDEX);
    expect(did.url().split('#')[0], 'in the same tab and the same document').toBe(before.split('#')[0]);
    // Triage (S15): page 8 reads "choose” treatment status" (a closing quote after "choose"), so the whole phrase is not on it as one run; the last two words are.
    const where = await findOnPage(did, DID_PAGE8_INDEX, 'treatment status');
    // Triage (TB4, rule 7): a test race; the palette lands correctly a moment later, once page 8's text layer is drawn.
    let spot = { c: { x: NaN, y: NaN }, height: 0 };
    await expect
      .poll(
        async () => {
          spot = await hooks(did).eval((h, a) => ({ c: h.glyphCenter(a.p, a.i), height: h.viewer.viewportHeight() }), { p: DID_PAGE8_INDEX, i: where.start });
          return Number.isFinite(spot.c.y) && spot.c.y > 0 && spot.c.y < spot.height + 80;
        },
        { message: 'the passage itself is on the screen', timeout: 5_000 },
      )
      .toBe(true);
    await shotOf(did, testInfo, '05-landed-on-the-passage');
  }, 420_000);
  await step('Ctrl+K in the library: Enter on a note opens its reading at the note, Enter on a page opens it at the passage', async ({ context, openViewer, server }) => {
    if (!FORCE && !(await paletteIsHere(context))) {
      testInfo.annotations.push({ type: 'step skipped', description: 'Ctrl+K opens no palette yet (slice S15)' });
      return;
    }
    const { did } = await setUp(openViewer, server);
    await did.close();

    const lib = await openLibrary(context, 'library');
    expect(await openPalette(lib), 'Ctrl+K opens the palette in the library').toBe(true);

    await ask(lib, 'zebrafish');
    await expect(heading(lib, 'Notes')).toBeVisible();
    const [byNote] = await Promise.all([context.waitForEvent('page'), lib.keyboard.press('Enter')]);
    await expect.poll(() => byNote.url(), { message: 'Enter opens the reading in our viewer', timeout: 20_000 }).toMatch(OUR_VIEWER_RE);
    await waitViewerReady(byNote);
    await expect(cardWith(byNote, NOTE), "at the note: its card is on the screen").toBeVisible({ timeout: 15_000 });
    await shotOf(byNote, testInfo, '06-opened-at-the-note');
    await byNote.close();

    await lib.bringToFront();
    expect(await openPalette(lib)).toBe(true);
    await ask(lib, DID_PAGE8_PHRASE);
    await expect(heading(lib, 'Pages')).toBeVisible();
    const [byPage] = await Promise.all([context.waitForEvent('page'), lib.keyboard.press('Enter')]);
    await expect.poll(() => byPage.url(), { timeout: 20_000 }).toMatch(OUR_VIEWER_RE);
    await waitViewerReady(byPage);
    await expect.poll(() => hooks(byPage).eval((h) => h.viewer.currentPage()), { message: 'a page hit opens the reading on page 8', timeout: 20_000 }).toBe(DID_PAGE8_INDEX);
    await shotOf(byPage, testInfo, '07-opened-at-the-page');
  }, 420_000);
  await step('the filters narrow the results, and a trashed or forgotten reading does not appear', async ({ context, openViewer, server }) => {
    if (!FORCE && !(await paletteIsHere(context))) {
      testInfo.annotations.push({ type: 'step skipped', description: 'Ctrl+K opens no palette yet (slice S15)' });
      return;
    }
    const { did, didId, attentionId } = await setUp(openViewer, server);
    const lib = await openLibrary(context, 'library');
    expect(await openPalette(lib)).toBe(true);

    // "conditional" is on pages of both papers
    await ask(lib, 'conditional');
    const rows = hits(lib);
    await expect(rows.first()).toBeVisible();
    await expect(rows.filter({ hasText: DID.rowName }).first(), 'both papers have pages that match').toBeVisible();
    await expect(rows.filter({ hasText: ATTENTION.rowName }).first()).toBeVisible();
    await shotOf(lib, testInfo, '08-both-papers');

    await palette(lib).getByRole('button', { name: /has notes/i }).click();
    await lib.waitForTimeout(600);
    await expect(rows.filter({ hasText: ATTENTION.rowName }), 'Has notes leaves only the paper with a note').toHaveCount(0);
    await expect(rows.filter({ hasText: DID.rowName }).first()).toBeVisible();
    await shotOf(lib, testInfo, '09-has-notes');
    await palette(lib).getByRole('button', { name: /has notes/i }).click(); // off again

    await palette(lib).getByRole('button', { name: /starred/i }).click();
    await lib.waitForTimeout(600);
    await expect(rows.filter({ hasText: DID.rowName }), 'Starred leaves only the starred paper').toHaveCount(0);
    await expect(rows.filter({ hasText: ATTENTION.rowName }).first()).toBeVisible();
    await shotOf(lib, testInfo, '10-starred');
    await closePalette(lib);

    // a trashed reading does not appear (nor its notes)
    await did.bringToFront();
    await storeOf(did).call('trashDocument', didId);
    await lib.bringToFront();
    expect(await openPalette(lib)).toBe(true);
    await ask(lib, 'zebrafish');
    await expect(hits(lib).filter({ hasText: /zebrafish/i }), "a trashed reading's notes are not found").toHaveCount(0);
    await ask(lib, 'difference');
    await expect(hits(lib).filter({ hasText: DID.rowName }), 'nor the reading itself').toHaveCount(0);
    expect(await storeOf(did).call<unknown[]>('search', { text: 'choose treatment status', limit: 20 }), 'nor its pages').toEqual([]);
    await shotOf(lib, testInfo, '11-trashed-not-found');
    await closePalette(lib);

    // restoring it brings it back
    await storeOf(did).call('restoreDocument', didId);
    await lib.bringToFront();
    expect(await openPalette(lib)).toBe(true);
    await ask(lib, 'zebrafish');
    await expect(hits(lib).filter({ hasText: /zebrafish/i }).first(), 'restored: found again').toBeVisible();
    await closePalette(lib);

    // a forgotten reading does not appear
    await storeOf(did).call('forgetDocument', attentionId);
    await lib.bringToFront();
    expect(await openPalette(lib)).toBe(true);
    await ask(lib, 'attention');
    await expect(hits(lib).filter({ hasText: ATTENTION.rowName }), 'a forgotten reading is not found').toHaveCount(0);
    expect((await allReadings(did)).map((r) => r.id)).toEqual([didId]);
    await shotOf(lib, testInfo, '12-forgotten-not-found');
  }, 420_000);
});
