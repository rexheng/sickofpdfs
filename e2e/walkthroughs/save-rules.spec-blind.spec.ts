// Gate 1, Phase 2 plan section 4, item 10: "Save rules (walkthrough 10)."
//   "The first mark on a 'not sure' PDF saves it and shows an Undo chip. Undo removes both the save and the mark. On a PDF forced to
//    'not learning', the first mark asks first. If you answer No and close the tab, nothing is stored. In Incognito there are no
//    marks and no menu."
// Spec, "Notes on a PDF that isn't saved": "Your first mark or note on a 'not sure' PDF saves it to the library, with an Undo chip.
// Your first mark on a PDF judged not learning asks: 'Save this PDF to keep your notes?' Yes saves it. No keeps the notes in memory
// only, until the tab closes, and nothing is stored." "A PDF that isn't saved leaves no history row, thumbnail, search entry or log
// line." "Incognito ... the extension never saves." Done-when 8: "Notes on unsaved PDFs follow the save rules (Task 30). Incognito has
// no marks."
//
// The PDFs: the MIT 14.01 handout is the one the filter cannot decide on its content alone ("not sure"); the AWS invoice is "not
// learning" ("looks like an invoice or receipt"). Each test first checks the chip says so, so a wrong guess about a fixture shows as that.
// The Incognito test does not need the save decision: the viewer already knows when it is in Incognito.
//
// GUESSES: the chip's words ("Not sure", "Not saved", "Saved to library") are the spec's; the Undo chip is a button named "Undo"; the
// question has buttons "Yes" and "No".
import { expect, hooks, test } from '../support/test';
import { store as storeOf, waitForStore } from '../support/store-probe.spec-blind';
import {
  HANDOUT_LINE,
  INVOICE_LINE,
  NO_SAVING,
  RECEIPT,
  SAVING_AVAILABLE,
  UNSURE,
  allCards,
  altGr,
  annotations,
  answerSavePrompt,
  anyBox,
  cardWith,
  describe,
  isPlain,
  libraryId,
  markMenu,
  markTokens,
  noteBox,
  openPaper,
  paintOfSelection,
  postNote,
  reloadAndWait,
  rightClickSelection,
  savePrompt,
  selectPassage,
  waitSaved,
  watchContextMenu,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(120_000);
const YELLOW = 0;

const undoChip = (page: Parameters<typeof libraryId>[0]) => page.getByRole('button', { name: /^undo$/i }).first();

test.describe('on a PDF the filter is not sure about', () => {
  test.skip(!SAVING_AVAILABLE, NO_SAVING);

  test('the first mark saves it and shows an Undo chip; Undo removes both the save and the mark', async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, UNSURE);
    const tokens = await markTokens(page);
    await waitForStore(page);
    await expect(page.getByText(/not sure/i).first(), 'the chip says the filter is not sure about this handout').toBeVisible({ timeout: 25_000 });
    expect(await libraryId(page), 'nothing is saved before the first mark').toBeNull();
    await shot(page, testInfo, 'not-sure-chip');

    const sel = await selectPassage(page, UNSURE, HANDOUT_LINE);
    await page.keyboard.press('h');
    await waitSaved(page, 15_000);
    await expect(undoChip(page), 'the save shows an Undo chip').toBeVisible({ timeout: 5000 });
    const marked = await paintOfSelection(page, sel, { name: 'first-mark-saved', testInfo });
    expect(marked.paint.share(tokens.fill[YELLOW]), `the mark is drawn: ${describe(marked.paint)}`).toBeGreaterThanOrEqual(0.6);
    await expect(page.getByText(/saved/i).first(), 'and the chip says the PDF is saved').toBeVisible();
    await shot(page, testInfo, 'saved-with-undo');

    await undoChip(page).click();
    await expect.poll(() => libraryId(page), { message: 'Undo takes the PDF out of the library again', timeout: 10_000 }).toBeNull();
    const stats = await storeOf(page).stats();
    expect(stats.documents, 'the library is empty again').toBe(0);
    const gone = await paintOfSelection(page, sel, { name: 'after-undo', testInfo });
    expect(isPlain(gone.paint), `and the mark is gone too: ${describe(gone.paint)}`).toBe(true);
    await shot(page, testInfo, 'after-undo');
  });

  test('the first note saves it too, with the note', async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, UNSURE);
    await waitForStore(page);
    await expect(page.getByText(/not sure/i).first()).toBeVisible({ timeout: 25_000 });
    await postNote(page, UNSURE, HANDOUT_LINE, 'My first note on a not-sure PDF');
    const id = await waitSaved(page, 15_000);
    // Triage (R67 f, 1 Nov 2026, a spec change): a save a note started shows no Undo chip. A typed note is deliberate
    // work and must never vanish on a quick Undo; the owner can delete the note itself. Only a first mark gets the chip.
    await expect(undoChip(page), 'a save started by a note has no Undo (R67 f)').toHaveCount(0);
    expect((await annotations(page, id)).comments.map((c) => c.body)).toEqual(['My first note on a not-sure PDF']);
    await reloadAndWait(page, UNSURE);
    // Triage (tb2notes, ruling R69): the handout's pages are landscape (720 pt, 960 px at 100%), so in this window the page and
    // the note margin do not fit side by side at 100%. A note never changes the zoom any more: the cards fold into the
    // toolbar's Notes button, and the note is read in the notes panel (Shift+F4) instead of the margin.
    await expect
      .poll(() => page.evaluate(() => (globalThis as unknown as { __sopTest: { annotations: { state(): { threads: unknown[] } } | null } }).__sopTest.annotations?.state().threads.length ?? 0), { message: 'the note is loaded again', timeout: 10_000 })
      .toBe(1);
    if ((await cardWith(page, 'My first note on a not-sure PDF').count()) === 0) await page.keyboard.press('Shift+F4');
    await expect(cardWith(page, 'My first note on a not-sure PDF'), 'and it is there after a reload').toBeVisible({ timeout: 10_000 });
    await shot(page, testInfo, 'note-saved');
  });
});

/**
 * Triage (TB2), a gap: until Phase 3 wires the real filter, Task 30's stand-in calls every PDF "Not sure", and the test
 * build has no way to force "not learning" (plan section 4 item 10 says "forced"). These tests wait for the chip to settle
 * and skip, with this reason, while it says "Not sure"; they run by themselves once the filter judges the invoice.
 */
async function skipUnlessNotLearning(page: import('@playwright/test').Page): Promise<void> {
  const chip = page.getByText(/^(not sure|not saved)/i).first();
  await expect(chip, 'the save chip settles').toBeVisible({ timeout: 25_000 });
  test.skip(/not sure/i.test((await chip.textContent()) ?? ''), 'the stand-in filter calls every PDF "Not sure" until Phase 3, so no PDF is "not learning" yet');
}

test.describe('on a PDF judged not learning', () => {
  test.skip(!SAVING_AVAILABLE, NO_SAVING);

  test('the first mark asks first; No keeps the mark in the tab only, and closing the tab leaves nothing stored', async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, RECEIPT);
    const tokens = await markTokens(page);
    await waitForStore(page);
    await skipUnlessNotLearning(page);
    await expect(page.getByText(/not saved/i).first(), 'the chip says it was not saved').toBeVisible({ timeout: 25_000 });
    const sel = await selectPassage(page, RECEIPT, INVOICE_LINE);
    await page.keyboard.press('h');
    await expect(savePrompt(page).first(), 'the first mark asks: "Save this PDF to keep your notes?"').toBeVisible({ timeout: 5000 });
    await shot(page, testInfo, 'asks-first');
    expect(await answerSavePrompt(page, 'No')).toBe(true);
    await expect(savePrompt(page)).toHaveCount(0);

    const kept = await paintOfSelection(page, sel, { name: 'after-no', testInfo });
    expect(kept.paint.share(tokens.fill[YELLOW]), `No keeps the mark in the tab: ${describe(kept.paint)}`).toBeGreaterThanOrEqual(0.6);
    expect(await libraryId(page), 'but nothing is saved').toBeNull();

    // a second mark does not ask again
    await selectPassage(page, RECEIPT, { from: 'Greetings from Amazon', to: 'Web Services' });
    await page.keyboard.press('Control+u');
    await page.waitForTimeout(600);
    await expect(savePrompt(page), 'it only asks once').toHaveCount(0);

    // close the tab; open the PDF again in a new one
    await page.close();
    const again = await openPaper(openViewer, server, RECEIPT);
    await waitForStore(again);
    const stats = await storeOf(again).stats();
    expect(stats, 'a PDF that was not saved leaves no trace in the library').toEqual({ documents: 0, aliases: 0, locations: 0, pageText: 0, history: 0, outbox: 0 });
    const clean = await paintOfSelection(again, sel, { name: 'reopened', testInfo });
    expect(isPlain(clean.paint), `and the marks are gone from the reopened PDF: ${describe(clean.paint)}`).toBe(true);
    await shot(again, testInfo, 'reopened-nothing-kept');
  });

  test('Yes saves the PDF with the mark, and the mark is there after a reload', async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, RECEIPT);
    const tokens = await markTokens(page);
    await waitForStore(page);
    await skipUnlessNotLearning(page);
    await expect(page.getByText(/not saved/i).first()).toBeVisible({ timeout: 25_000 });
    const sel = await selectPassage(page, RECEIPT, INVOICE_LINE);
    await page.keyboard.press('h');
    await expect(savePrompt(page).first()).toBeVisible({ timeout: 5000 });
    expect(await answerSavePrompt(page, 'Yes')).toBe(true);
    await waitSaved(page, 15_000);
    await reloadAndWait(page, RECEIPT);
    const after = await paintOfSelection(page, sel, { name: 'saved-after-yes', testInfo });
    expect(after.paint.share(tokens.fill[YELLOW]), `the mark survives a reload: ${describe(after.paint)}`).toBeGreaterThanOrEqual(0.6);
  });

  test('a note asks the same question, and a Polish AltGr+S (the letter ś, not Ctrl+Alt+S) saves nothing', async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, RECEIPT);
    await waitForStore(page);
    await skipUnlessNotLearning(page);
    await expect(page.getByText(/not saved/i).first()).toBeVisible({ timeout: 25_000 });
    await altGr(page, 'ś', 'KeyS');
    await page.waitForTimeout(800);
    await expect(savePrompt(page), 'AltGr+S types a letter on a Polish keyboard; it is not the Save shortcut').toHaveCount(0);
    expect(await libraryId(page)).toBeNull();

    await selectPassage(page, RECEIPT, INVOICE_LINE);
    await page.keyboard.press('Control+Alt+m');
    await expect(savePrompt(page).first(), 'the first note asks too').toBeVisible({ timeout: 5000 });
    expect(await answerSavePrompt(page, 'No')).toBe(true);
    await expect(noteBox(page), 'then the note box opens').toBeVisible({ timeout: 3000 });
    await shot(page, testInfo, 'note-after-no');
    expect(await libraryId(page)).toBeNull();
  });
});

test.describe('in Incognito', () => {
  test('there are no marks and no menu: the viewer only views', async ({ context, openViewer, server }, testInfo) => {
    // The viewer asks the browser whether it is in an Incognito window; this is the browser's answer there.
    await context.addInitScript(() => {
      Object.defineProperty(chrome.extension, 'inIncognitoContext', { get: () => true, configurable: true });
    });
    const page = await openPaper(openViewer, server, UNSURE);
    const tokens = await markTokens(page);
    expect(await hooks(page).eval((h) => 'store' in h && (h as unknown as { store: unknown }).store === null), 'there is no library in Incognito').toBe(true);
    const sel = await selectPassage(page, UNSURE, HANDOUT_LINE);

    const read = await watchContextMenu(page);
    await rightClickSelection(page, sel);
    const seen = await read();
    expect(seen.prevented, "a right-click on selected text gets Chrome's menu, not ours").toBe(false);
    await expect(markMenu(page), 'no mark-up menu').toHaveCount(0);

    await selectPassage(page, UNSURE, HANDOUT_LINE);
    await page.keyboard.press('h');
    await page.keyboard.press('Control+u');
    await page.keyboard.press('Control+b');
    await page.keyboard.press('Alt+Shift+5');
    await page.keyboard.press('Control+Alt+m');
    await page.waitForTimeout(700);
    await expect(anyBox(page), 'no note box').toHaveCount(0);
    await expect(allCards(page), 'no card').toHaveCount(0);
    await expect(savePrompt(page), 'and nothing asks to save').toHaveCount(0);
    const p = await paintOfSelection(page, sel, { name: 'incognito-nothing-marked', testInfo });
    expect(isPlain(p.paint), `nothing is marked: ${describe(p.paint)}`).toBe(true);
    expect(p.paint.share(tokens.fill[YELLOW], 6)).toBeLessThan(0.1);
    await shot(page, testInfo, 'incognito');
  });
});
