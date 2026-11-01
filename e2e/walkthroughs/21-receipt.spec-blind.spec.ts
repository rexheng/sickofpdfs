// Gate 1, Phase 3 plan, item 2: "A receipt."
//   "The chip says 'Not saved: looks like a receipt'. There is no row, no copy, no search hit. A request log shows only the PDF. One
//    click on the chip saves it. Forget this PDF removes everything again."
// Spec, "How it feels to use" 10: 'It displays normally with the chip "Not saved: looks like a receipt". Nothing is stored, indexed or
// uploaded. If the filter is wrong, one click on the chip saves it.' "Local traces. A PDF that isn't saved leaves no history row,
// thumbnail, search entry or log line." "'Forget this PDF' removes it completely." Mission: "Receipts and private documents are never
// touched." Phase 3 done-when 2: "A receipt or private PDF leaves no trace: no row, copy, search hit, log line or request."
//
// This is a PRIVACY test, so it reads the real storage and not just the screen: the library's tables and indexes, every file in the
// extension's private file storage (OPFS), its localStorage and IndexedDB, the browser's console, and the browser's own net log.
//
// The receipt: the OYO hotel "PAYMENT RECEIPT" (text, one page). The chip's wording after "Not saved:" is a fixed "looks like ..."
// phrase; the spec's example says "a receipt" and its list says "an invoice or receipt", so either is accepted.
//
// Guard: FILTER_IN_VIEWER. The network gate runs in 'observe' mode so the test can read the whole request log after the browser
// closes: only the PDF (and the harness's own ping) may have been requested.
import { expect, opfsList, test } from '../support/test';
import { save as saveOf } from '../support/save-probe.spec-blind';
import { shot } from './support/takeover';
import {
  RECEIPT,
  RECEIPT_PHRASE,
  FILTER_IN_VIEWER,
  NO_FILTER,
  chipOf,
  chipText,
  chipTooltip,
  collectConsole,
  decided,
  fixtureUrl,
  forgetThisPdf,
  goTo,
  listRows,
  openLibrary,
  requestUrls,
  shaOf,
  traceProblems,
  waitForStore,
  waitViewerReady,
} from './support/library-p3.spec-blind';

test.use({ networkGate: 'observe' });
test.skip(!FILTER_IN_VIEWER, NO_FILTER);
test.setTimeout(180_000);

// The harness wants the net log read before a test ends, even a test that failed early.
test.afterEach(async ({ netgate }) => {
  await netgate.report();
});

const PHRASES = [RECEIPT_PHRASE, 'Nanganallur'];

test('a receipt leaves no trace; one click saves it; Forget removes it again; only the PDF was requested', async ({ context, openViewer, server, netgate }, testInfo) => {
  const logs = collectConsole(context);
  const sha = await shaOf(RECEIPT);
  const probe = { sha, phrases: PHRASES, fileName: 'receipt-oyo-hotel.pdf', noDrafts: true };

  const page = await openViewer(fixtureUrl(server, RECEIPT));
  await waitViewerReady(page);
  await waitForStore(page);

  // 1. It displays normally, with the chip.
  expect(await decided(page), 'the filter calls a receipt "not learning", not merely "not sure"').toBe('not-learning');
  await expect(chipOf(page)).toContainText(/not saved: looks like/i);
  const label = await chipText(page);
  expect(label, 'the chip says what it looks like').toMatch(/receipt|invoice/i);
  await shot(page, testInfo, 'chip-not-saved');
  await chipTooltip(page); // the hover explains and offers the click
  await shot(page, testInfo, 'chip-hover');
  await expect(page.locator('[role=document] canvas').first(), 'the receipt is drawn like any PDF').toBeVisible();

  // 2. Nothing is stored anywhere.
  expect(await traceProblems(page, { ...probe, logs: [...logs] }), 'a receipt that was only opened leaves no trace').toEqual([]);

  // 3. The library does not know it either.
  const library = await openLibrary(context, 'library');
  await expect(library.getByText(/your learning pdfs will appear here/i), 'My library is the empty first-run screen').toBeVisible();
  for (const route of ['recent', 'starred', 'trash'] as const) {
    await goTo(library, route);
    await expect(listRows(library), `${route} lists nothing`).toHaveCount(0);
  }
  await shot(library, testInfo, 'library-empty');
  await library.close();

  // 4. One click on the chip saves it.
  await page.bringToFront();
  await chipOf(page).click();
  await expect(chipOf(page), 'one click saves it').toContainText(/saved to library/i, { timeout: 30_000 });
  await expect.poll(() => saveOf(page).hasBlob(sha), { message: 'its copy is kept', timeout: 20_000 }).toBe(true);
  await shot(page, testInfo, 'saved-by-one-click');
  const listed = await openLibrary(context, 'library');
  await expect(listRows(listed), 'and the library lists it').toHaveCount(1);
  await shot(listed, testInfo, 'library-lists-the-receipt');
  await listed.close();

  // 5. Forget this PDF removes everything again.
  await page.bringToFront();
  const forgot = await forgetThisPdf(page);
  expect(forgot.asked, 'a PDF with no notes is forgotten without a question').toBe(false);
  await expect(chipOf(page), 'the chip no longer says it is saved').not.toContainText(/saved to library/i, { timeout: 20_000 });
  await shot(page, testInfo, 'after-forget');
  await expect.poll(async () => (await opfsList(page, 'pdf')).length, { message: 'the saved copy is deleted', timeout: 20_000 }).toBe(0);
  expect(await traceProblems(page, { ...probe, logs: [...logs] }), 'after Forget this PDF nothing is left').toEqual([]);
  const emptyAgain = await openLibrary(context, 'library');
  await expect(listRows(emptyAgain)).toHaveCount(0);
  await expect(emptyAgain.getByText(/your learning pdfs will appear here/i)).toBeVisible();
  await emptyAgain.close();

  // 6. The request log: the PDF, and nothing else.
  const urls = await requestUrls(netgate);
  const allowed = new Set([RECEIPT.path, '/__gate-ping']);
  const strays = urls.filter((u) => !(u.startsWith(server.origin) && allowed.has(new URL(u).pathname)));
  expect(strays, 'the browser requested nothing but the PDF itself').toEqual([]);
  expect(urls.some((u) => new URL(u).pathname === RECEIPT.path), 'and it did request the PDF').toBe(true);
});
