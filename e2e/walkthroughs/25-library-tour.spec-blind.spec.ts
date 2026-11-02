// Gate 1, Phase 3 plan, item 6: "Library tour."
//   "Switch list and grid. Sort by title and last opened. Star a reading and find it under Starred. Trash it, see it in Trash, restore it.
//    Recent, Home 'Continue reading' and the Notes page show the right items."
// Spec, "Library pages, laid out like Google Drive": Home ("Continue reading and recent notes"), My library ("Every saved reading, list or
// grid, sortable like Drive"), Recent ("Readings by last opened"), Starred, Notes ("Every note and thread across all readings, newest first,
// searchable"), Trash ("Removed readings and notes, kept 30 days"), Settings. Visual design: "Home | 'Welcome' title, collapsible Continue
// reading and Recent notes sections".
//
// Three papers are read, oldest first (PLOS, ResNet, Attention), two of them with a note, so every page has something true to show. The
// papers are saved the way the owner would get them saved: by the filter, or (until the filter is real) by the chip's "Save?".
//
// The pages that exist today (My library, Recent, Starred, Trash) run now. Home and Notes are checked only when their pages are built (a
// placeholder says "... isn't ready yet"); the test notes which ones it skipped.
//
// GUESSES: a header button named "Title" or "Last opened" sorts; a column's first click gives its natural order (titles A to Z, dates newest
// first) and a second click reverses it; the layout toggle is a pair of radios "List layout" / "Grid layout"; the row menu has "Add to
// Starred", "Move to Trash", "Restore" (Drive's wording); Recent groups by "Today".
import type { Page } from '@playwright/test';
import { expect, test, type FixtureServer } from '../support/test';
import { ATTENTION as ATTENTION_FX, LINES, PLOS as PLOS_FX, PLOS_DOI_PASSAGE, cardWith, openPaper, postNote, saveFirst, waitSaved, type OpenViewer } from './support/marks.spec-blind';
import { OUR_VIEWER_RE } from './support/takeover';
import {
  ATTENTION,
  PLOS,
  RESNET,
  allReadings,
  goTo,
  listRows,
  note,
  openLibrary,
  openRowMenu,
  pageNotBuilt,
  rowFor,
  settledTitles,
  shotOf,
  sleep,
  snackbar,
  waitForStore,
  waitViewerReady,
} from './support/library-p3.spec-blind';

test.setTimeout(300_000);

const NOTE_PLOS = 'Plos note about data sharing and citations';
const NOTE_ATTENTION = 'Attention note about heads and scaling';
const PAPERS = [PLOS, RESNET, ATTENTION] as const; // the order they are read in: oldest first

/** Which paper a title is, as an index into PAPERS (-1 when it is none of them). */
const which = (title: string): number => PAPERS.findIndex((p) => p.rowName.test(title));

async function readThree(openViewer: OpenViewer, server: FixtureServer): Promise<string[]> {
  const ids: string[] = [];
  // 1. PLOS, with a note
  const plos = await openPaper(openViewer, server, PLOS_FX);
  await waitForStore(plos);
  ids.push(await saveFirst(plos));
  await postNote(plos, PLOS_FX, PLOS_DOI_PASSAGE, NOTE_PLOS);
  await waitSaved(plos);
  await plos.close();
  await sleep(1200);
  // 2. ResNet, read only
  const resnet = await openViewer(server.url(RESNET.path));
  await waitViewerReady(resnet);
  await waitForStore(resnet);
  ids.push(await saveFirst(resnet));
  await resnet.close();
  await sleep(1200);
  // 3. Attention, with a note
  const attention = await openPaper(openViewer, server, ATTENTION_FX);
  await waitForStore(attention);
  ids.push(await saveFirst(attention));
  await postNote(attention, ATTENTION_FX, LINES.l1, NOTE_ATTENTION);
  await attention.close();
  return ids;
}

const sortedAsc = (xs: string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1].toLowerCase().localeCompare(x.toLowerCase()) <= 0);
const columnHeader = (page: Page, name: RegExp) => page.getByRole('columnheader', { name });
const header = (page: Page, name: RegExp) => columnHeader(page, name).getByRole('button');

test('the library tour: list and grid, sort, star, trash and restore, Recent, Home and Notes', async ({ context, openViewer, server }, testInfo) => {
  await readThree(openViewer, server);
  const probe = await openViewer(server.url('/h/plain.pdf')); // carries the store, to check what the library holds
  await waitViewerReady(probe);
  await waitForStore(probe);
  expect((await allReadings(probe)).length, 'three readings are saved').toBe(3);

  const lib = await openLibrary(context, 'library');
  await expect(listRows(lib), 'My library lists the three readings').toHaveCount(3, { timeout: 15_000 });
  await shotOf(lib, testInfo, '01-my-library-list');

  // ---- sort by title, then by last opened ----
  const byTitle = await settledTitles(lib, 3);
  // soft: what the list calls a title (the library's, or the file name where it has none) must be what it sorts by
  expect.soft(sortedAsc(byTitle), `the list opens sorted by the titles it shows, A to Z: ${byTitle.join(' | ')}`).toBe(true);
  await expect(columnHeader(lib, /^title/i), 'and the Title column says so').toHaveAttribute('aria-sort', 'ascending');
  await header(lib, /^title/i).click();
  const zToA = await settledTitles(lib, 3);
  expect.soft(zToA, 'a second click on Title turns the order round').toEqual([...byTitle].reverse());
  await shotOf(lib, testInfo, '02-sorted-title-z-to-a');

  await header(lib, /^last opened/i).click();
  const opened = (await settledTitles(lib, 3)).map(which);
  expect(opened.every((i) => i >= 0), 'every title is one of the three papers').toBe(true);
  expect(opened, 'sorted by last opened, newest first: Attention, ResNet, PLOS').toEqual([2, 1, 0]);
  await header(lib, /^last opened/i).click();
  expect((await settledTitles(lib, 3)).map(which), 'a second click gives the oldest first').toEqual([0, 1, 2]);
  await shotOf(lib, testInfo, '03-sorted-last-opened');
  await header(lib, /^title/i).click(); // a new column starts with its natural order: back to A to Z
  expect.soft(sortedAsc(await settledTitles(lib, 3)), 'Title starts with A to Z again').toBe(true);

  // ---- list and grid ----
  await lib.getByRole('radio', { name: /grid layout/i }).click();
  await expect(lib.getByRole('gridcell'), 'the grid shows one card per reading').toHaveCount(3);
  await expect(lib.getByRole('columnheader'), 'and no column headings').toHaveCount(0);
  await shotOf(lib, testInfo, '04-grid');
  await lib.reload();
  await expect(lib.getByRole('gridcell'), 'the layout is remembered after a reload').toHaveCount(3, { timeout: 15_000 });
  await lib.getByRole('radio', { name: /list layout/i }).click();
  await expect(listRows(lib)).toHaveCount(3);

  // ---- star ----
  const attentionRow = () => rowFor(lib, ATTENTION.rowName);
  let menu = await openRowMenu(lib, attentionRow());
  await menu.getByRole('menuitem', { name: /add to starred/i }).click();
  await goTo(lib, 'starred');
  await expect(listRows(lib), 'Starred lists only the starred reading').toHaveCount(1);
  await expect(rowFor(lib, ATTENTION.rowName)).toBeVisible();
  await shotOf(lib, testInfo, '05-starred');
  menu = await openRowMenu(lib, rowFor(lib, ATTENTION.rowName));
  await menu.getByRole('menuitem', { name: /remove from starred/i }).click();
  await expect(listRows(lib), 'unstarring takes it off the Starred page').toHaveCount(0);

  // ---- trash and restore ----
  await goTo(lib, 'library');
  menu = await openRowMenu(lib, rowFor(lib, RESNET.rowName));
  await menu.getByRole('menuitem', { name: /move to trash/i }).click();
  await expect(snackbar(lib), 'Drive says it was moved, with an Undo').toContainText(/moved to trash/i);
  await expect(listRows(lib), 'it leaves My library').toHaveCount(2);
  await goTo(lib, 'recent');
  await expect(listRows(lib), 'and Recent').toHaveCount(2);
  await goTo(lib, 'trash');
  await expect(listRows(lib), 'Trash lists it').toHaveCount(1);
  await expect(rowFor(lib, RESNET.rowName)).toBeVisible();
  await expect(lib.getByText(/30 days/), 'and says how long it stays').toBeVisible();
  await shotOf(lib, testInfo, '06-trash');
  await rowFor(lib, RESNET.rowName).hover();
  await rowFor(lib, RESNET.rowName).getByRole('button', { name: /^restore$/i }).click();
  await expect(listRows(lib), 'Restore empties Trash').toHaveCount(0);
  await goTo(lib, 'library');
  await expect(listRows(lib), 'and puts it back in My library').toHaveCount(3);

  // ---- Recent ----
  await goTo(lib, 'recent');
  expect((await settledTitles(lib, 3)).map(which), 'Recent is newest first: Attention, ResNet, PLOS').toEqual([2, 1, 0]);
  await expect(lib.getByRole('rowgroup', { name: 'Today' }), 'grouped by when each was last opened').toBeVisible();
  await shotOf(lib, testInfo, '07-recent');

  // ---- Home ----
  await goTo(lib, 'home');
  if (await pageNotBuilt(lib)) note(testInfo, 'Home', 'not built yet: skipped');
  else {
    await expect(lib.getByRole('heading', { name: /welcome/i })).toBeVisible();
    const continueBtn = lib.getByRole('button', { name: /continue reading/i }).first();
    // Triage (S14), wrong guess: the heading holds the fold button (WAI disclosure pattern), so both match; either one shows it.
    await expect(continueBtn.or(lib.getByRole('heading', { name: /continue reading/i }).first()).first(), 'Home has "Continue reading"').toBeVisible();
    await expect(lib.getByText(/recent notes/i).first(), 'and "Recent notes"').toBeVisible();
    const text = await lib.evaluate(() => document.body.innerText);
    const from = text.search(/continue reading/i);
    const to = text.search(/recent notes/i);
    const section = text.slice(from, to > from ? to : undefined);
    const at = PAPERS.map((p) => section.search(p.rowName));
    expect(at.every((i) => i >= 0), `Continue reading names the three readings: ${section.slice(0, 200)}`).toBe(true);
    expect(at[2] < at[1] && at[1] < at[0], 'newest first: Attention, then ResNet, then PLOS').toBe(true);
    await shotOf(lib, testInfo, '08-home');
    if (await continueBtn.isVisible()) {
      const expanded = await continueBtn.getAttribute('aria-expanded');
      if (expanded !== null) {
        await continueBtn.click();
        await expect(continueBtn, 'Continue reading folds away').toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
        await continueBtn.click();
      }
    }
  }

  // ---- Notes ----
  await goTo(lib, 'notes');
  if (await pageNotBuilt(lib)) note(testInfo, 'Notes', 'not built yet: skipped');
  else {
    await expect(lib.getByText(NOTE_ATTENTION), 'the Notes page shows the Attention note').toBeVisible({ timeout: 10_000 });
    await expect(lib.getByText(NOTE_PLOS), 'and the PLOS note').toBeVisible();
    const text = await lib.evaluate(() => document.body.innerText);
    expect(text.indexOf(NOTE_ATTENTION) < text.indexOf(NOTE_PLOS), 'newest first: the Attention note is above the PLOS note').toBe(true);
    await shotOf(lib, testInfo, '09-notes');
    const claude = lib.getByRole('tab', { name: /^claude$/i }).or(lib.getByRole('radio', { name: /^claude$/i })).or(lib.getByRole('button', { name: /^claude$/i }));
    if (await claude.first().isVisible()) {
      await claude.first().click();
      await expect(lib.getByText(NOTE_ATTENTION), 'the Claude filter hides notes you wrote').toHaveCount(0);
    }
  }

  // ---- open a reading from the library: its notes are there ----
  await goTo(lib, 'library');
  const [opened2] = await Promise.all([context.waitForEvent('page'), rowFor(lib, ATTENTION.rowName).dblclick()]);
  await expect.poll(() => opened2.url(), { message: 'opening a reading shows it in our viewer', timeout: 20_000 }).toMatch(OUR_VIEWER_RE);
  await waitViewerReady(opened2);
  await expect(cardWith(opened2, NOTE_ATTENTION), 'with its note in the margin').toBeVisible({ timeout: 15_000 });
  await shotOf(opened2, testInfo, '10-opened-from-the-library');
});
