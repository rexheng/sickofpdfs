// Gate 1, Phase 3 plan, item 3: "Marking up a receipt."
//   "You select text and comment. The app asks right away. 'No' keeps the note until the tab closes and the library stays empty. 'Yes'
//    saves it."
// Spec, "Notes on a PDF that isn't saved": 'Your first mark on a PDF judged not learning asks: "Save this PDF to keep your notes?" Yes
// saves it. No keeps the notes in memory only, until the tab closes, and nothing is stored.' "On a PDF judged not learning, Ctrl+Alt+M still
// asks its question at once (asking is not saving)" (contracts section 3, R67 b). "Nothing is written while 'Save this PDF to keep your
// notes?' is open, or after No" (R67 a).
//
// PRIVACY: after No, the note text must be in no file, no database row, no localStorage key (not even a draft or a save-pending record),
// no search hit and no console line, and the library must be empty. The test reads each of those.
//
// The PDF is the AWS invoice, the same file the Phase 2 save-rule walkthroughs use ("looks like an invoice or receipt"), so the selection
// helpers are the ones already proven on it.
//
// Guard: FILTER_IN_VIEWER. GUESSES: the question is the text "Save this PDF to keep your notes?" with buttons "Yes" and "No"; the note box
// opens after the answer, not before it.
import { expect, test } from '../support/test';
import { save as saveOf } from '../support/save-probe.spec-blind';
import {
  INVOICE_LINE,
  RECEIPT as INVOICE_FX,
  annotations,
  answerSavePrompt,
  cardWith,
  noteBox,
  openPaper,
  reloadAndWait,
  savePrompt,
  selectPassage,
  waitSaved,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';
import { FILTER_IN_VIEWER, INVOICE, INVOICE_PHRASE, NO_FILTER, chipOf, collectConsole, decided, goTo, listRows, openLibrary, rowFor, shaOf, traceProblems, waitForStore } from './support/library-p3.spec-blind';

test.skip(!FILTER_IN_VIEWER, NO_FILTER);
test.setTimeout(180_000);

const NOTE = 'Zebrafish remark about this invoice';
const FILE = 'invoice-aws-sample.pdf';

test('A note on a receipt asks first: No keeps it in the tab only, Yes saves the PDF with the note', async ({ step }, testInfo) => {
  test.setTimeout(360_000);
  await step('No keeps the note in the tab until it closes; the library stays empty and nothing is stored', async ({ context, openViewer, server }) => {
    const logs = collectConsole(context);
    const sha = await shaOf(INVOICE);
    const probe = { sha, phrases: [INVOICE_PHRASE, NOTE], fileName: FILE, noDrafts: true };

    const page = await openPaper(openViewer, server, INVOICE_FX);
    await waitForStore(page);
    expect(await decided(page), 'the filter calls the invoice "not learning"').toBe('not-learning');
    await expect(chipOf(page)).toContainText(/not saved/i);

    // select text and comment: the app asks right away, before the note box
    await selectPassage(page, INVOICE_FX, INVOICE_LINE);
    await page.keyboard.press('Control+Alt+m');
    await expect(savePrompt(page).first(), 'Ctrl+Alt+M asks "Save this PDF to keep your notes?" at once').toBeVisible({ timeout: 5000 });
    await expect(noteBox(page), 'the note box waits for the answer').toHaveCount(0);
    await shot(page, testInfo, 'asks-right-away');
    expect(await saveOf(page).state().then((s) => s?.kind), 'asking is not saving').toBe('asking');
    expect(await traceProblems(page, { ...probe, logs: [...logs] }), 'while the question is open nothing is written').toEqual([]);

    // No: the note box opens; write the note
    expect(await answerSavePrompt(page, 'No')).toBe(true);
    await expect(noteBox(page), 'after No the note box opens').toBeVisible({ timeout: 5000 });
    await expect(savePrompt(page), 'the question has closed').toHaveCount(0); // Triage (S11, rule 7): type once it has gone
    await page.keyboard.type(NOTE, { delay: 8 });
    await page.keyboard.press('Enter');
    await expect(cardWith(page, NOTE), 'the note is a card in the margin').toBeVisible({ timeout: 5000 });
    await shot(page, testInfo, 'note-kept-in-the-tab');
    await page.waitForTimeout(1200); // a draft would be written by now

    // the tab holds the note; nothing else does
    expect(await saveOf(page).documentId(), 'the PDF is not in the library').toBeNull();
    expect(await traceProblems(page, { ...probe, logs: [...logs] }), 'no row, copy, search hit, draft or log line holds the note').toEqual([]);
    const library = await openLibrary(context, 'library');
    await expect(library.getByText(/your learning pdfs will appear here/i), 'the library is still empty').toBeVisible();
    await goTo(library, 'recent');
    await expect(listRows(library)).toHaveCount(0);
    await shot(library, testInfo, 'library-still-empty');
    await library.close();

    // the tab closes: the note is gone, and still nothing is stored
    await page.close();
    const again = await openPaper(openViewer, server, INVOICE_FX);
    await waitForStore(again);
    expect(await decided(again)).toBe('not-learning');
    await expect(cardWith(again, NOTE), 'the note did not survive the tab').toHaveCount(0);
    expect(await traceProblems(again, { ...probe, logs: [...logs] }), 'after the tab closed there is still no trace').toEqual([]);
    await shot(again, testInfo, 'reopened-nothing-kept');
  }, 180_000);
  await step('Yes saves the PDF with the note, and the library lists it with the note', async ({ context, openViewer, server }) => {
    const page = await openPaper(openViewer, server, INVOICE_FX);
    await waitForStore(page);
    expect(await decided(page)).toBe('not-learning');

    await selectPassage(page, INVOICE_FX, INVOICE_LINE);
    await page.keyboard.press('Control+Alt+m');
    await expect(savePrompt(page).first(), 'it asks right away').toBeVisible({ timeout: 5000 });
    expect(await answerSavePrompt(page, 'Yes')).toBe(true);
    await expect(noteBox(page), 'after Yes the note box opens').toBeVisible({ timeout: 5000 });
    await expect(savePrompt(page), 'the question has closed').toHaveCount(0); // Triage (S11, rule 7): type once it has gone
    await page.keyboard.type(NOTE, { delay: 8 });
    await page.keyboard.press('Enter');
    await expect(cardWith(page, NOTE)).toBeVisible({ timeout: 5000 });

    const id = await waitSaved(page, 30_000);
    expect(id, "the document's id is its fingerprint").toBe(await shaOf(INVOICE));
    await expect(chipOf(page)).toContainText(/saved to library/i, { timeout: 20_000 });
    expect((await annotations(page, id)).comments.map((c) => c.body), 'the note is in the library').toEqual([NOTE]);
    await shot(page, testInfo, 'saved-with-the-note');

    // it survives a reload
    await reloadAndWait(page, INVOICE_FX);
    await expect(cardWith(page, NOTE), 'and the note is there after a reload').toBeVisible({ timeout: 10_000 });

    // the library lists it, with one note
    const library = await openLibrary(context, 'library');
    const row = rowFor(library, INVOICE.rowName);
    await expect(row, 'My library lists the invoice').toBeVisible({ timeout: 15_000 });
    await expect(row.getByRole('img', { name: /1 note/i }), 'with its one note').toBeVisible();
    await shot(library, testInfo, 'library-lists-it-with-a-note');
  }, 180_000);
});
