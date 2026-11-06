// Regression walkthrough, R103 (no lost notes): a saved web page changes and is saved again as a newer version. The owner's
// marks and notes move to the newer version, re-anchored on their quotes. A note whose words left the page shows under
// "Couldn't place" with its quote and is never deleted; a mark whose words left stays on the earlier version, where it is still
// drawn. The earlier version says "Your notes moved to the newer version", in About this PDF and in the viewer, at once in a
// tab that has it open.
//
// The owner's steps, on the news article fixture (support/article-pages.ts): save it from the toolbar menu; on the reading,
// highlight two passages and comment on two others; the article changes (a correction is added at the top, and one paragraph is
// taken out); save it again from the menu.
//
// The menu is opened as `popup.html?tab=<id>` (the test build's hook): Playwright cannot click the toolbar button. The network
// gate (`enforce`) fails the test on any request beyond the fixture server.
import type { BrowserContext, Page, Worker } from '@playwright/test';
import type { DocumentId } from '../../packages/core/src/ids';
import { EXTENSION_ID, expect, hooks, test, type FixtureServer, VIEWER_ROOT } from '../support/test';

test.setTimeout(240_000);
test.use({ viewport: { width: 1280, height: 900 } });

/** The passages the owner marks. `gone` ones are in the paragraph the article later loses. */
const KEPT_HIGHLIGHT = 'storm surge pushed the river to its highest level';
const KEPT_NOTE_ON = 'eight steel gates';
const GONE_HIGHLIGHT = 'We were told this would protect everyone';
const GONE_NOTE_ON = 'under a foot of water by midnight';
const KEPT_NOTE = 'Ask the council how high the gates go.';
const GONE_NOTE = 'Check this against the farmers’ union statement.';

async function articleTab(context: BrowserContext, sw: Worker, server: FixtureServer, path: string): Promise<{ page: Page; tabId: number }> {
  const page = await context.newPage();
  await page.goto(server.url(path));
  await page.waitForLoadState('load');
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? -1, page.url());
  expect(tabId, 'the article tab is found').toBeGreaterThan(0);
  return { page, tabId };
}

/** The owner opens the toolbar menu on `tabId` and clicks "Save this page to library": the tab that saves it. */
async function savePage(context: BrowserContext, tabId: number): Promise<Page> {
  const menu = await context.newPage();
  await menu.setViewportSize({ width: 320, height: 260 });
  await menu.goto(`chrome-extension://${EXTENSION_ID}/popup.html?tab=${tabId}`);
  const opened = context.waitForEvent('page', { timeout: 30_000 });
  await menu.getByRole('menuitem', { name: 'Save this page to library' }).click();
  return opened;
}

async function waitSavedReading(page: Page): Promise<DocumentId> {
  await page.waitForURL(/viewer\.html/u, { timeout: 60_000 });
  await page.waitForSelector(VIEWER_ROOT, { state: 'attached' });
  await expect.poll(() => hooks(page).eval((h) => h.save?.state().kind ?? null), { message: 'the reading is in the library', timeout: 30_000 }).toBe('saved');
  await expect.poll(() => hooks(page).eval((h) => h.annotations !== null), { timeout: 15_000 }).toBe(true);
  return (await hooks(page).eval((h) => h.save.documentId())) as DocumentId;
}

/** Selects `phrase` with the mouse (it may run over a line break), finding it in the page text. */
async function select(page: Page, phrase: string): Promise<{ pageIndex: number; x: number; y: number }> {
  const pages = await hooks(page).eval((h) => h.doc()!.open.pageCount);
  for (let p = 0; p < pages; p++) {
    const text = await hooks(page).eval((h, i) => h.backend.getPageText(h.doc()!.open.doc, i), p);
    const m = new RegExp(phrase.split(' ').join('\\s+'), 'u').exec(text);
    if (m === null) continue;
    await hooks(page).eval((h, i) => h.viewer.scrollTo(i), p);
    await page.waitForTimeout(600);
    const [a, b] = await hooks(page).eval((h, q) => [h.glyphCenter(q[0], q[1]), h.glyphCenter(q[0], q[2])], [p, m.index, m.index + m[0].length - 1] as [number, number, number]);
    if (a.y < 140 || b.y > 860) {
      await page.mouse.wheel(0, a.y - 450);
      await page.waitForTimeout(400);
      return select(page, phrase);
    }
    await page.mouse.move(a.x - 2, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x + 2, b.y, { steps: 8 });
    await page.mouse.up();
    return { pageIndex: p, x: (a.x + b.x) / 2, y: a.y };
  }
  throw new Error(`"${phrase}" is not in the reading`);
}

async function highlight(page: Page, phrase: string): Promise<void> {
  const at = await select(page, phrase);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitemradio', { name: /^yellow$/iu }).click();
  await expect(page.getByRole('menu')).toBeHidden();
}

async function comment(page: Page, phrase: string, words: string): Promise<void> {
  const at = await select(page, phrase);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: /comment/iu }).first().click();
  await page.waitForTimeout(400);
  await page.keyboard.type(words);
  await page.keyboard.press('Enter');
}

type Stored = { marks: { quote: string | null }[]; threads: { quote: string | null; placement: string; comments: string[] }[]; reasons: string[] };

async function stored(page: Page, id: string): Promise<Stored> {
  return hooks(page).eval(async (h, doc) => {
    const a = await h.store!.listAnnotations(doc as never);
    const row = await h.store!.getDocument(doc as never);
    const quote = (x: { anchor: { kind: string; quote?: { quote: string } } }) => (x.anchor.kind === 'text' ? (x.anchor.quote?.quote ?? null) : null);
    return {
      marks: a.marks.filter((m) => m.deletedAt === null).map((m) => ({ quote: quote(m as never) })),
      threads: a.threads
        .filter((t) => t.deletedAt === null)
        .map((t) => ({ quote: quote(t as never), placement: t.placement, comments: a.comments.filter((c) => c.threadId === t.id && c.deletedAt === null).map((c) => c.body) })),
      reasons: row?.saveReasons ?? [],
    };
  }, id);
}

const folded = (s: string | null) => (s ?? '').replace(/\s+/gu, ' ').trim();

test('a saved web page that changed is saved again: the marks and notes move to the newer version, and none is lost', async ({ context, sw, server }, testInfo) => {
  // 1. The owner saves the news article and marks it up.
  const article = await articleTab(context, sw, server, '/a/news-article');
  const first = await savePage(context, article.tabId);
  const earlier = await waitSavedReading(first);
  await hooks(first).eval((h) => h.viewer.setScale(1));
  await highlight(first, KEPT_HIGHLIGHT);
  await comment(first, KEPT_NOTE_ON, KEPT_NOTE);
  await highlight(first, GONE_HIGHLIGHT);
  await comment(first, GONE_NOTE_ON, GONE_NOTE);
  await expect
    .poll(async () => {
      const s = await stored(first, earlier);
      return [s.marks.length, s.threads.filter((t) => t.comments.length > 0).length];
    }, { message: 'two highlights and two notes are in the library', timeout: 15_000 })
    .toEqual([2, 2]);
  await first.screenshot({ path: testInfo.outputPath('1-earlier-version-marked-up.png') });

  // 2. The article changes: a correction at the top, and the farmer's paragraph is taken out.
  await article.page.evaluate(() => {
    const body = document.querySelector('article')!;
    const correction = document.createElement('p');
    correction.textContent =
      'Correction, 6 November: an earlier version of this article gave the wrong date for the public meeting. It is on 18 November, not 8 November. The rest of the report is unchanged.';
    body.insertBefore(correction, body.querySelector('figure'));
    const gone = Array.from(body.querySelectorAll('p')).find((p) => p.textContent?.includes('We were told this would protect everyone'));
    gone?.remove();
  });

  // 3. The owner saves it again. The saving tab says one note couldn't be placed, and one mark stays on the earlier version.
  const second = await savePage(context, article.tabId);
  await expect(second.getByText('Your notes moved to this version.'), 'the saving tab says the notes moved').toBeVisible({ timeout: 60_000 });
  await expect(second.getByText(/1 note couldn’t be placed in the new text/u)).toBeVisible();
  await expect(second.getByText(/1 mark is on words that are no longer on the page/u)).toBeVisible();
  await second.screenshot({ path: testInfo.outputPath('2-saving-tab-says-what-moved.png') });
  await second.getByRole('button', { name: 'Open it' }).click();
  const newer = await waitSavedReading(second);
  expect(newer, 'the changed page is a new reading').not.toBe(earlier);

  // 4. The newer version holds both notes, with their words; the one whose words left is "unplaced". The kept highlight moved.
  const now = await stored(second, newer);
  const byNote = (words: string) => now.threads.find((t) => t.comments.includes(words));
  expect(byNote(KEPT_NOTE)?.placement, 'the note whose words are still there is placed on the newer version').toBe('placed');
  expect(folded(byNote(KEPT_NOTE)?.quote ?? null)).toBe(KEPT_NOTE_ON);
  expect(byNote(GONE_NOTE)?.placement, 'the note whose words left moved too, as "Couldn\'t place"').toBe('unplaced');
  expect(folded(byNote(GONE_NOTE)?.quote ?? null), 'it keeps its quote').toBe(GONE_NOTE_ON);
  expect(now.marks.map((m) => folded(m.quote)), 'the highlight whose words are still there moved').toEqual([KEPT_HIGHLIGHT]);

  // The kept highlight is drawn on the newer version where its words are now; the notes panel lists the lost note's quote.
  await expect.poll(() => hooks(second).eval((h) => h.annotations!.state().marks.length), { timeout: 10_000 }).toBe(1);
  await second.getByRole('button', { name: /^Notes/u }).click();
  const panel = second.getByRole('complementary').filter({ hasText: 'Notes' }).last();
  await expect(panel.getByText(KEPT_NOTE), 'the moved note is in the notes panel').toBeVisible({ timeout: 10_000 });
  const unplaced = panel.locator('section').filter({ hasText: /Couldn.t place/u });
  await expect(unplaced.getByText(GONE_NOTE), 'the note whose words left is under "Couldn\'t place"').toBeVisible();
  await expect(unplaced.getByText(/under a foot of water/u), 'with its quote').toBeVisible();
  await second.screenshot({ path: testInfo.outputPath('3-newer-version-notes.png') });

  // 5. The earlier version keeps only the highlight whose words left, and says the notes moved, at once in the tab it is open in.
  const before = await stored(second, earlier);
  expect(before.threads, 'no note is left behind on the earlier version').toEqual([]);
  expect(before.marks.map((m) => folded(m.quote)), 'the highlight on words that left stays where it is drawn').toEqual([GONE_HIGHLIGHT]);
  expect(before.reasons, 'the earlier version is flagged as moved').toContain(`web-page:notes-moved:${newer}`);
  await first.bringToFront();
  await expect(first.getByText('Your notes moved to the newer version.'), 'the open earlier version says so at once').toBeVisible({ timeout: 15_000 });
  await first.reload();
  await waitSavedReading(first);
  await expect(first.getByText('Your notes moved to the newer version.'), 'and again when it is opened').toBeVisible({ timeout: 15_000 });
  await first.screenshot({ path: testInfo.outputPath('4-earlier-version-says-moved.png') });

  // About this PDF in the library says it too, on the earlier version's row ("Earlier version").
  const lib = await context.newPage();
  await lib.goto(`chrome-extension://${EXTENSION_ID}/library.html#/library`);
  await expect(lib.getByRole('navigation', { name: 'Library' })).toBeVisible({ timeout: 20_000 });
  await lib.getByRole('row').filter({ hasText: 'City’s new flood barrier' }).filter({ hasText: 'Earlier version' }).first().click();
  await lib.keyboard.press('i');
  await expect(lib.getByText('Your notes moved to the newer version.'), 'About this PDF on the earlier version says the notes moved').toBeVisible({ timeout: 10_000 });
  await lib.getByText('Your notes moved to the newer version.').scrollIntoViewIfNeeded();
  await lib.screenshot({ path: testInfo.outputPath('5-about-earlier-version.png') });

  // Every word the owner wrote is still in the library, exactly once.
  const all = [...now.threads, ...before.threads].flatMap((t) => t.comments);
  expect(all.sort(), 'no note is lost or doubled').toEqual([GONE_NOTE, KEPT_NOTE].sort());
});
