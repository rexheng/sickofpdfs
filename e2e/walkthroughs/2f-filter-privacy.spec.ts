// The learning filter's privacy holes found by the S11 privacy read (secread5), kept as regression walkthroughs. Each test is
// one of the reviewer's probes (P1–P6, P9, P11) with its assertions kept; only what the harness needs was changed (imports,
// file places, the button's new name). Each failed on 380096f and must pass from the filterfix round on.
//
// Spec R91 (Nov 2): "the owner's choices can only make the filter more careful, never less."
//   - The allow list only turns "not sure" into "save". It never saves a PDF the filter calls "not learning": no text, a CV,
//     a receipt, a bank statement or a payslip. Hard blocks still beat everything. (M1)
//   - "Always for this site" names the place on its button and in its note. It is never offered for catch-all places
//     (Downloads, Desktop, Documents, the home folder, a drive root, anything less than two levels below home; mail
//     attachments; Drive, OneDrive, Dropbox and iCloud downloads; shared object stores; chat file hosts). Typed or synced
//     entries are checked by the same rule. A bare top-level domain, `/`, a drive root or `file:///` is refused. (M2, m1)
//   - "Never for this file" holds everywhere at once: every open tab re-reads it before a first mark saves (M3); it covers
//     the reading's id, every download of it and the opened copy (M4); only the owner's own explicit Save clears it (M3).
//   - A PDF saved by the owner's click still gets the filter's protections (D9), however the save starts. (M5)
//   - Forget always asks, so "Never save this file" is always offered. (M6)
//   - If the owner's choices can't be read, the PDF is "not learning": nothing saves on its own, and a first mark asks. (M7)
//   - Reporting "not for learning" on a saved PDF says it is still in the library, and offers Forget in the same note. (m2)
//   - Round 2 (re-check of ecd1ba8): "The hard-block check reads every page at save time, not only the pages the filter
//     sampled. If an automatic save finds card, bank or ID numbers on any page, it stops before anything is written, and the
//     chip says 'Not saved: has card or bank numbers'. An owner's click saves the PDF without searchable text, with the
//     warning." (N1, probe P15)
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page, TestInfo } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { listMatches } from '../../packages/core/src/filter/rules';
import { siteRuleFor } from '../../apps/extension/src/viewer/filter/rules-source';
import { expect, hooks, test } from '../support/test';
import { TEST_ASSETS } from '../support/server';
import { store as storeOf } from '../support/store-probe.spec-blind';
import { WALKTHROUGH_DIR } from './support/fixtures.spec-blind';
import { openLocalFile } from './support/local-file.spec-blind';
import { libraryId, openPaper, savePrompt, selectPassage, SENTENCE_1, waitSaved, waitStored, type TlFixture } from './support/marks.spec-blind';
import { ensureP3Fixtures, P3_FILES, p3Url } from './support/p3-fixtures.spec-blind';
import { chipOf, chooseFileMenuItem, decided, forgetThisPdf, traceProblems, waitForStore, waitViewerReady } from './support/library-p3.spec-blind';
import { shot } from './support/takeover';
import { forceVerdict } from '../support/filter-verdict';

test.setTimeout(300_000);

interface Decision {
  verdict: string;
  rule?: string;
  reasons: string[];
  ownerSave?: unknown;
}
const decisionOf = (page: Page): Promise<Decision | null> =>
  hooks(page).eval((h) => (h as unknown as { save?: { decision?(): Decision | null } }).save?.decision?.() ?? null);

/** The banner's "Always for …" button. R91: it names the place, so it no longer says "this site". */
const alwaysButton = (page: Page) => page.getByRole('button', { name: /^always for /i });
const neverButton = (page: Page) => page.getByRole('button', { name: /never for this file/i });
/** Every status line on the screen (the banner, the snackbar), as one string. */
const statusText = async (page: Page): Promise<string> => (await page.getByRole('status').allTextContents()).join(' | ');

/** A screenshot for the gallery, once the banner, dialog or note has finished coming in (150 ms animations). */
async function still(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await shot(page, testInfo, name);
}

const BOOKLET_B: TlFixture = { name: 'booklet-b', file: `walkthroughs/${P3_FILES.notSureB}`, page: 0, dir: 'ltr' };
const CARD: TlFixture = { name: 'card', file: `walkthroughs/${P3_FILES.card}`, page: 0, dir: 'ltr' };

test.beforeAll(async () => {
  await ensureP3Fixtures();
});

// ---------------------------------------------------------------------------------------------------------------------
// M1 (probe P1): the allow list saves image-only scans, CVs, bank statements and payslips

/** A two-page CV with a contact block, Education, Experience, Skills and a References heading. */
async function makeCv(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Curriculum Vitae - Jane Example');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    [
      'Curriculum Vitae',
      'Jane Example',
      '12 Sample Street, London N1 1AA',
      'jane.example@example.com  |  +44 7700 900123  |  linkedin.com/in/janeexample',
      '',
      'Education',
      '2019 - 2023  BSc Economics, University of Example. First class honours.',
      '2017 - 2019  A levels: Mathematics, Economics, History.',
      '',
      'Experience',
      '2023 - now  Research Assistant, Example Policy Institute. Data analysis in R and Python.',
      '2022  Summer intern, Example Bank. Prepared market reports for the trading desk.',
      '2021  Volunteer tutor, Example Youth Club. Weekly maths sessions for teenagers.',
    ],
    [
      'Skills',
      'R, Python, Stata, SQL, LaTeX. Fluent English and French. Driving licence.',
      '',
      'Publications',
      'Example, J. (2024). Rent and wages in small towns. Working paper.',
      '',
      'Interests',
      'Running, chess, photography.',
      '',
      'References',
      'Available on request.',
    ],
  ];
  for (const lines of pages) {
    const p = doc.addPage([595, 842]);
    lines.forEach((t, i) => p.drawText(t, { x: 50, y: 780 - i * 22, size: 12, font }));
  }
  return doc.save();
}

async function openAndRead(openViewer: (u: string) => Promise<Page>, url: string): Promise<{ kind: string | null; decision: Decision | null; saved: boolean; chip: string }> {
  const page = await openViewer(url);
  await waitViewerReady(page);
  await waitForStore(page);
  const kind = await decided(page);
  await page.waitForTimeout(2500); // an automatic save lands
  if (!page.url().includes('/viewer.html')) {
    const u = page.url();
    await page.close();
    return { kind: 'left-viewer: ' + u.slice(0, 120), decision: null, saved: false, chip: '' };
  }
  const decision = await decisionOf(page);
  const saved = (await libraryId(page)) !== null;
  const chip = ((await chipOf(page).textContent()) ?? '').trim();
  await page.close();
  return { kind, decision, saved, chip };
}

test('M1: the allow list never saves image-only scans, a CV or paperwork that the filter would not save', async ({ openViewer, server }, testInfo) => {
  const cv = await makeCv();
  server.mount('/cv/', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': cv.byteLength });
    res.end(req.method === 'HEAD' ? undefined : cv);
    return Promise.resolve();
  });
  const targets: [string, string][] = [
    ['image-only receipt scan (Starbucks)', '/f/classifier/not-learning/receipt-starbucks-scan.pdf'],
    ['image-only receipt scan (Whole Foods)', '/f/classifier/not-learning/receipt-wholefoods-scan.pdf'],
    ['CV with text', '/cv/jane-example.pdf'],
    ['bank statement', '/f/classifier/not-learning/bank-statement-five-star-bank-sample.pdf'],
    ['payslip', '/f/classifier/not-learning/payslip-iup-understanding-pay-statement.pdf'],
    ['tax form W-2', '/f/classifier/not-learning/tax-form-irs-w2.pdf'],
  ];

  // Before the rule: none of them is saved
  const before: Record<string, unknown> = {};
  for (const [name, path] of targets) {
    const r = await openAndRead(openViewer, server.url(path));
    before[name] = { kind: r.kind, rule: r.decision?.rule, reason: r.decision?.reasons[0], saved: r.saved };
    expect(r.saved, `${name} is not saved before the rule`).toBe(false);
  }
  testInfo.annotations.push({ type: 'before Always for this site', description: JSON.stringify(before) });

  // The owner answers the not-sure banner on a harmless booklet: "Always for <the site>"
  const booklet = await openViewer(server.url(p3Url(P3_FILES.notSureB)));
  await waitViewerReady(booklet);
  await waitForStore(booklet);
  expect(await decided(booklet)).toBe('unsure');
  const always = alwaysButton(booklet);
  await expect(always).toBeVisible({ timeout: 40_000 });
  // R91: the button names the place (soft, so the reviewer's own assertion below still runs on an older build)
  await expect.soft(always, 'the button names the site').toHaveText(/^always for 127\.0\.0\.1$/i);
  await still(booklet, testInfo, 'banner-named-site');
  await always.click();
  await expect(chipOf(booklet)).toContainText(/saved to library/i, { timeout: 20_000 });
  await expect.configure({ soft: true }).poll(() => statusText(booklet), { message: 'the note names the site', timeout: 5000 }).toContain('127.0.0.1');
  await still(booklet, testInfo, 'note-named-site');
  const allow = await storeOf(booklet).call<unknown>('getSetting', 'filter.allow');
  testInfo.annotations.push({ type: 'filter.allow', description: JSON.stringify(allow) });
  await booklet.close();

  // After the rule: each one, opened and only looked at
  const after: Record<string, unknown> = {};
  const savedNames: string[] = [];
  for (const [name, path] of targets) {
    const r = await openAndRead(openViewer, server.url(path));
    after[name] = { kind: r.kind, rule: r.decision?.rule, reason: r.decision?.reasons[0], saved: r.saved, chip: r.chip };
    if (r.saved) savedNames.push(name);
  }
  testInfo.annotations.push({ type: 'after Always for this site', description: JSON.stringify(after) });
  // The finding: these were saved with no click on them.
  expect(savedNames, 'PDFs the filter never saves, saved by the allow list with no click on them').toEqual([]);

  // And the rule still does its job: another "not sure" PDF from that site is saved.
  const c = await openAndRead(openViewer, server.url(p3Url(P3_FILES.notSureC)));
  expect([c.saved, c.decision?.rule], 'a "not sure" PDF from the allowed site is saved by the allow list').toEqual([true, 'allow-list']);
});

// ---------------------------------------------------------------------------------------------------------------------
// M2 (probe P2): "Always for this folder" is offered for Downloads, without naming the folder

test('M2: no "Always" for a file in Downloads; a safe folder is named, and still never saves paperwork', async ({ context }, testInfo) => {
  // Harness change: the reviewer's folders were under the test's temp folder. A temp folder is itself a catch-all place now,
  // so the folders are made under the walkthrough fixtures, which sit under a home folder (…/home/<name>/…).
  const root = join(WALKTHROUGH_DIR, '2f-folders');
  await rm(root, { recursive: true, force: true });
  const downloads = join(root, 'home', 'rex', 'Downloads');
  await mkdir(downloads, { recursive: true });
  const reading = join(downloads, 'x7.pdf');
  await copyFile(join(WALKTHROUGH_DIR, P3_FILES.notSureC), reading);

  const page = await openLocalFile(context, pathToFileURL(reading).href);
  expect(await decided(page)).toBe('unsure');
  await expect(neverButton(page), 'the banner shows').toBeVisible({ timeout: 40_000 });
  await still(page, testInfo, 'banner-no-always-downloads');
  expect(await alwaysButton(page).count(), 'no "Always" for the Downloads folder').toBe(0);
  await page.close();

  const later: [string, string][] = [
    ['bank statement', 'classifier/not-learning/bank-statement-five-star-bank-sample.pdf'],
    ['image-only receipt scan', 'classifier/not-learning/receipt-starbucks-scan.pdf'],
    ['invoice', 'classifier/not-learning/invoice-aws-sample.pdf'],
  ];
  const out: Record<string, { rule?: string; reason?: string; saved: boolean }> = {};
  for (const [name, file] of later) {
    const dest = join(downloads, `${name}.pdf`);
    await copyFile(join(TEST_ASSETS, file), dest);
    const p = await openLocalFile(context, pathToFileURL(dest).href);
    await decided(p);
    await p.waitForTimeout(2500);
    const d = await decisionOf(p);
    out[name] = { rule: d?.rule, reason: d?.reasons[0], saved: (await libraryId(p)) !== null };
    await p.close();
  }
  testInfo.annotations.push({ type: 'later downloads', description: JSON.stringify(out) });
  expect(Object.values(out).filter((o) => o.saved), 'downloads saved with no click on them').toEqual([]);

  // A folder of its own, two levels below home: offered, and named on the button and in the note. Its name has no course words
  // (the spec's "course words in path" would add a point, and the booklet would then be saved by itself).
  const week3 = join(root, 'home', 'rex', 'Projects', 'Harbour town');
  await mkdir(week3, { recursive: true });
  const booklet = join(week3, 'booklet.pdf');
  await copyFile(join(WALKTHROUGH_DIR, P3_FILES.notSureB), booklet);
  const b = await openLocalFile(context, pathToFileURL(booklet).href);
  expect(await decided(b)).toBe('unsure');
  const always = alwaysButton(b);
  await expect(always).toBeVisible({ timeout: 40_000 });
  await expect(always, 'the button names the folder').toHaveText(/^always for the folder harbour town$/i);
  await still(b, testInfo, 'banner-named-folder');
  await always.click();
  await expect(chipOf(b)).toContainText(/saved to library/i, { timeout: 20_000 });
  await expect.poll(() => statusText(b), { message: 'the note names the folder', timeout: 5000 }).toContain('Harbour town');
  await still(b, testInfo, 'note-named-folder');
  const allow = await storeOf(b).call<string[]>('getSetting', 'filter.allow');
  expect(allow, 'the allow list holds that one folder').toEqual([expect.stringMatching(/\/Projects\/Harbour town\/$/)]);
  await b.close();

  // The rule saves the next "not sure" PDF there, and never paperwork (M1).
  const inWeek3: [string, string, boolean][] = [
    ['bank statement', join(TEST_ASSETS, later[0][1]), false],
    ['image-only receipt scan', join(TEST_ASSETS, later[1][1]), false],
    ['another not-sure booklet', join(WALKTHROUGH_DIR, P3_FILES.notSureC), true],
  ];
  const got: Record<string, unknown> = {};
  for (const [name, src, want] of inWeek3) {
    const dest = join(week3, `${name}.pdf`);
    await copyFile(src, dest);
    const p = await openLocalFile(context, pathToFileURL(dest).href);
    await decided(p);
    await p.waitForTimeout(2500);
    const d = await decisionOf(p);
    const saved = (await libraryId(p)) !== null;
    got[name] = { rule: d?.rule, reason: d?.reasons[0], saved };
    expect(saved, `${name} in the allowed folder: ${want ? 'saved' : 'not saved'}`).toBe(want);
    await p.close();
  }
  testInfo.annotations.push({ type: 'in the allowed folder', description: JSON.stringify(got) });

  // Typed or synced entries are checked by the same rule: the store refuses the Downloads folder as an allow entry.
  const lib = await openLocalFile(context, pathToFileURL(reading).href);
  const refused = await storeOf(lib)
    .call('addToSettingList', 'filter.allow', `${downloads.replaceAll('\\', '/')}/`)
    .then(() => 'stored', (e: unknown) => String(e));
  expect(refused, 'the library refuses a catch-all folder on the allow list').toMatch(/bad-input/);
  await lib.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// M2 and m1 (probe P6): what an allow-list entry matches, and what the banner offers. No browser.

// eslint-disable-next-line no-empty-pattern
test('M2, m1: allow-list entries never match far more than one site or folder, and catch-all places are never offered', ({}, testInfo) => {
  const urls = [
    'https://www.mybank.com/statements/2026-10.pdf',
    'https://shop.example.com/invoice.pdf',
    'https://hmrc.gov.uk/forms/sa100.pdf',
    'file:///home/rex/Documents/payslip.pdf',
    'file:///C:/Users/rex/Downloads/receipt.pdf',
  ];
  const entries = ['https://com/', 'http://uk', 'https://gov.uk', '/', '/home/', 'c:/', 'C:\\', 'file:///'];
  const table: Record<string, string[]> = {};
  for (const e of entries) table[e] = urls.filter((u) => listMatches([e], u, null));
  const offered: Record<string, unknown> = {};
  for (const u of [
    'https://mail-attachment.googleusercontent.com/attachment/u/0/?ui=2&ik=x&attid=0.1',
    'https://drive.usercontent.google.com/download?id=abc&export=download',
    'https://s3.amazonaws.com/some-bucket/invoice-123.pdf',
    'https://files.slack.com/files-pri/T01-F01/payslip.pdf',
    'https://cdn.discordapp.com/attachments/1/2/cv.pdf',
    'https://attachments.office.net/owa/rex@outlook.com/service.svc/s/GetAttachmentThumbnail',
    'file:///home/rex/Downloads/x.pdf',
    'file:///C:/Users/rex/Desktop/x.pdf',
  ]) offered[u] = siteRuleFor(u);
  testInfo.annotations.push({ type: 'matches', description: JSON.stringify(table) });
  testInfo.annotations.push({ type: 'banner offers', description: JSON.stringify(offered) });
  expect(table['https://com/']).toEqual([]);
  expect(table, 'none of these entries matches anything').toEqual(Object.fromEntries(entries.map((e) => [e, []])));
  expect(offered, 'the banner offers no "Always" for a catch-all place').toEqual(Object.fromEntries(Object.keys(offered).map((u) => [u, null])));
});

// ---------------------------------------------------------------------------------------------------------------------
// M3 (probe P3): "Never for this file" in one tab does not reach another open tab, and a mark there erases the choice

test('M3: Never for this file in tab B holds in tab A: a mark there asks, and the choice is kept', async ({ openViewer, server }, testInfo) => {
  const a = await openPaper(openViewer, server, BOOKLET_B);
  await waitForStore(a);
  expect(await decided(a)).toBe('unsure');
  const b = await openPaper(openViewer, server, BOOKLET_B);
  await waitForStore(b);
  expect(await decided(b)).toBe('unsure');

  await b.bringToFront();
  const never = neverButton(b);
  await expect(never).toBeVisible({ timeout: 40_000 });
  await never.click();
  await expect(chipOf(b)).toContainText(/not saved/i);

  await a.bringToFront();
  await a.waitForTimeout(1500);
  // tab A's own banner covers the title: close it the way the owner would
  const notNow = a.getByRole('button', { name: /^not now$/i });
  if (await notNow.isVisible()) await notNow.click();
  await a.waitForTimeout(500);
  const chipA = ((await chipOf(a).textContent()) ?? '').trim();
  await selectPassage(a, BOOKLET_B, { from: 'Notes on', to: 'harbour town' });
  await a.keyboard.press('h');
  await a.waitForTimeout(3000);
  const asked = await savePrompt(a).first().isVisible();
  const savedId = await libraryId(a);
  await shot(a, testInfo, 'tab-a-after-mark');

  // Undo, if offered, then reopen: is the never choice still there?
  const undo = a.locator('header').getByRole('button', { name: /undo/i });
  if (await undo.isVisible()) await undo.click();
  await a.waitForTimeout(2000);
  const c = await openViewer(server.url(`/f/${BOOKLET_B.file}`));
  await waitForStore(c);
  await decided(c);
  const dc = await decisionOf(c);
  testInfo.annotations.push({ type: 'tab A', description: JSON.stringify({ chipBeforeMark: chipA, asked, reopened: { rule: dc?.rule, reason: dc?.reasons[0] } }) });

  expect(savedId, 'a mark in tab A must not save a file the owner chose never to save').toBeNull();
  expect(asked, 'the mark asks first').toBe(true);
  expect(chipA, 'tab A follows the choice made in tab B').toMatch(/not saved/i);
  expect(dc?.rule, 'and the choice is still there on the next open').toBe('file-choice');
});

// ---------------------------------------------------------------------------------------------------------------------
// M4 (probe P4): Forget + Never save, answered in a tab showing a second download, leaves the first download unprotected

const ORIGINAL: TlFixture = { name: 'attention', file: 'classifier/learning/arxiv-1706.03762-attention.pdf', page: 0, dir: 'ltr' };
const COPY: TlFixture = { name: 'attention-copy', file: 'walkthroughs/2f-attention-second-download.pdf', page: 0, dir: 'ltr' };

test('M4: Forget + Never save from a second download covers the first download too', async ({ openViewer, server }, testInfo) => {
  const bytes = await readFile(join(TEST_ASSETS, ORIGINAL.file));
  // A second download: the same PDF with a few bytes after %%EOF (a different fingerprint, the same text).
  const copy = Buffer.concat([bytes, Buffer.from('\n% downloaded again 2026-11-02\n')]);
  await writeFile(join(TEST_ASSETS, COPY.file), copy);
  const shaA = createHash('sha256').update(bytes).digest('hex');

  const a = await openPaper(openViewer, server, ORIGINAL);
  await waitForStore(a);
  const id = await waitSaved(a, 60_000);
  expect(id).toBe(shaA);
  await a.close();

  const b = await openPaper(openViewer, server, COPY);
  await waitForStore(b);
  expect(await decided(b)).toBe('saved');
  expect(await libraryId(b), 'the second download is the same library entry (an alias)').toBe(shaA);
  await selectPassage(b, COPY, SENTENCE_1);
  await b.keyboard.press('h');
  await waitStored(b, (x) => x.marks.length === 1, 'the mark is stored', shaA);
  await forgetThisPdf(b, { never: true });
  await expect(chipOf(b)).toContainText(/not saved/i, { timeout: 30_000 });
  const traces = await traceProblems(b, { sha: shaA, phrases: ['dominant sequence transduction'], fileName: 'arxiv-1706.03762-attention.pdf' });
  await b.close();

  // The owner opens the paper again from its first address
  const again = await openViewer(server.url(`/f/${ORIGINAL.file}`));
  await waitForStore(again);
  await decided(again);
  await again.waitForTimeout(3000);
  const d = await decisionOf(again);
  const savedAgain = (await libraryId(again)) !== null;
  testInfo.annotations.push({ type: 'first download reopened', description: JSON.stringify({ rule: d?.rule, reason: d?.reasons[0], saved: savedAgain }) });
  await shot(again, testInfo, 'first-download-reopened');

  expect(traces, 'Forget leaves no trace').toEqual([]);
  expect(savedAgain, 'the paper the owner chose never to save is saved again with no click').toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// M5 (probe P5): D9 is lost after "Never save": a card statement saved again has its card number indexed

async function indexState(page: Page, id: string) {
  const s = storeOf(page);
  const doc = await s.call<{ indexText: boolean } | null>('getDocument', id);
  const stats = await s.stats();
  const hits = await s.call<unknown[]>('searchPages', '4111', 10);
  const searchHits = await s.call<unknown[]>('search', { text: '4111', limit: 10 });
  return { indexText: doc?.indexText, pageTextRows: stats.pageText, searchPagesHits: hits.length, searchHits: searchHits.length };
}

test('M5: a card statement saved again in the same tab after Forget + Never save keeps its text out of search', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, CARD);
  await waitForStore(page);
  expect(await decided(page)).toBe('not-learning');
  // D9: the owner saves it anyway
  await chipOf(page).click();
  const id = await waitSaved(page);
  const d9 = await indexState(page, id);

  // A mark, so Forget asks and offers "Never save this file"
  await page.keyboard.press('Control+a');
  await page.keyboard.press('h');
  await waitStored(page, (a) => a.marks.length >= 1, 'a mark is stored', id).catch(() => undefined);
  await forgetThisPdf(page, { never: true });
  await expect(chipOf(page)).toContainText(/not saved/i, { timeout: 30_000 });

  // The owner changes their mind and clicks the chip again, in the same tab
  await chipOf(page).click();
  const id2 = await waitSaved(page);
  await page.waitForTimeout(3000);
  const again = await indexState(page, id2);
  const notes = await statusText(page);
  testInfo.annotations.push({ type: 'index state', description: JSON.stringify({ d9, resaved: again, notes }) });
  await shot(page, testInfo, 'card-resaved');

  expect(again.indexText, 'D9: a card statement saved by choice is never indexed').toBe(false);
  expect(again.pageTextRows, 'and has no page text').toBe(0);
  expect([again.searchPagesHits, again.searchHits], 'and no search finds its card number').toEqual([0, 0]);
  expect(notes, 'the D9 warning shows').toMatch(/its text is not searchable/i);
});

test('M5: reopened after Never save, then saved from the chip, a card statement keeps its text out of search', async ({ openViewer, server }) => {
  const page = await openPaper(openViewer, server, CARD);
  await waitForStore(page);
  expect(await decided(page)).toBe('not-learning');
  await chipOf(page).click();
  const id = await waitSaved(page);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('h');
  await waitStored(page, (a) => a.marks.length >= 1, 'a mark is stored', id);
  await forgetThisPdf(page, { never: true });
  await expect(chipOf(page)).toContainText(/not saved/i, { timeout: 30_000 });
  await page.close();

  const back = await openPaper(openViewer, server, CARD);
  await waitForStore(back);
  await decided(back);
  expect((await decisionOf(back))?.rule, 'the reopened file is "never" by the owner’s choice').toBe('file-choice');
  await chipOf(back).click();
  const id2 = await waitSaved(back);
  await back.waitForTimeout(3000);
  const state = await indexState(back, id2);
  expect(state.pageTextRows, 'D9: no page text for a card statement saved by choice').toBe(0);
  expect(state.indexText).toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// M6 (probe P9): Forget on a PDF with no marks or notes offers no "Never save this file"

const PAPER = '/f/classifier/learning/arxiv-1706.03762-attention.pdf';

test('M6: Remove from library on a PDF with no notes asks, offers "Never save this file", and that holds', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(PAPER));
  await waitViewerReady(page);
  await waitForStore(page);
  await waitSaved(page, 60_000);
  await chipOf(page).click();
  const item = page.getByRole('menuitem', { name: /remove from library/i });
  await expect(item).toBeVisible();
  await item.click();
  const dialog = await page.getByRole('dialog').first().waitFor({ state: 'visible', timeout: 2500 }).then(() => true, () => false);
  expect(dialog, 'the owner is offered "Never save this file"').toBe(true);
  const box = page.getByRole('dialog').getByRole('checkbox', { name: /never save this file/i });
  await expect(box).toBeVisible();
  await expect(page.getByRole('dialog'), 'with no marks or notes, it does not count any').not.toContainText(/will be deleted too/i);
  await still(page, testInfo, 'forget-dialog-no-notes');
  await box.check();
  await page.getByRole('dialog').getByRole('button', { name: /^forget$/i }).click();
  await expect(chipOf(page)).toContainText(/not saved/i, { timeout: 20_000 });
  await page.close();

  const again = await openViewer(server.url(PAPER));
  await waitViewerReady(again);
  await waitForStore(again);
  await decided(again);
  await again.waitForTimeout(3000);
  const d = await decisionOf(again);
  expect((await libraryId(again)) !== null, 'opened again, it is not saved again').toBe(false);
  expect(d?.rule).toBe('file-choice');
});

// ---------------------------------------------------------------------------------------------------------------------
// M7 (probe P11): when the owner's choices cannot be read, a "never" file falls back to "not sure", and a first mark saves it

test('M7: choices unreadable: a never-save file is "not learning", and a first mark asks', async ({ openViewer, server }) => {
  const a = await openPaper(openViewer, server, BOOKLET_B);
  await waitForStore(a);
  expect(await decided(a)).toBe('unsure');
  const never = neverButton(a);
  await expect(never).toBeVisible({ timeout: 40_000 });
  await never.click();
  await expect(chipOf(a)).toContainText(/not saved/i);
  // sop-local becomes a newer version's database: a v1 open now fails
  await a.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const r = indexedDB.open('sop-local', 2);
        r.onsuccess = () => {
          r.result.close();
          resolve();
        };
        r.onerror = () => reject(new Error(String(r.error))); // harness change: the lint rule wants an Error
      }),
  );
  await a.close();

  const b = await openPaper(openViewer, server, BOOKLET_B);
  await waitForStore(b);
  // soft, so the reviewer's own assertion below still runs on an older build
  expect.soft(await decided(b), 'nothing saves on its own when the choices cannot be read').toBe('not-learning');
  await expect.soft(chipOf(b)).toContainText(/not saved/i);
  await selectPassage(b, BOOKLET_B, { from: 'Notes on', to: 'harbour town' });
  await b.keyboard.press('h');
  await b.waitForTimeout(3000);
  const asked = await savePrompt(b).first().isVisible();
  const saved = (await libraryId(b)) !== null;
  expect(saved, 'a file the owner chose never to save is not saved by a mark when the choice cannot be read').toBe(false);
  expect(asked, 'the mark asks').toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// m2: "Report a wrong decision: it's not for learning" on a saved PDF leaves it saved, and did not say so

test('m2: reporting a saved PDF as not for learning says it is still in the library, and offers Forget', async ({ openViewer, server }, testInfo) => {
  const page = await openViewer(server.url(PAPER));
  await waitViewerReady(page);
  await waitForStore(page);
  await waitSaved(page, 60_000);
  await chooseFileMenuItem(page, /report a wrong decision/i);
  const dialog = page.getByRole('dialog').first();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /not for learning/i }), 'a saved PDF is reported as not for learning by default').toBeChecked();
  await dialog.getByRole('button', { name: /^report$/i }).click();
  await expect.poll(() => statusText(page), { message: 'the note says it is still in the library', timeout: 5000 }).toMatch(/still in your library/i);
  const forget = page.getByRole('status').getByRole('button', { name: /forget/i });
  await expect(forget, 'and offers Forget in the same note').toBeVisible();
  await still(page, testInfo, 'report-note');
  await forget.click();
  await expect(page.getByRole('dialog').first(), 'Forget asks first').toContainText(/forget this pdf/i);
  expect(await libraryId(page), 'nothing is removed until the owner says so').not.toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------------
// N1 (probe P15, re-check of ecd1ba8): D9 looked only at the filter's sample (the first and last 5 pages)

/** A PDF of plain Helvetica lines, one list of lines per page. */
async function pagedPdf(pages: string[][]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const lines of pages) {
    const p = doc.addPage([595, 842]);
    lines.forEach((t, k) => p.drawText(t, { x: 50, y: 780 - k * 22, size: 12, font }));
  }
  return doc.save();
}

/** The reviewer's 12-page statement: its card number, IBAN, sort code with account number and NI number only on page 7. */
async function statement(): Promise<Uint8Array> {
  return pagedPdf(
    Array.from({ length: 12 }, (_, k) => {
      const i = k + 1;
      return i === 7
        ? ['Account details', 'Card number 4111 1111 1111 1111', 'IBAN GB82 WEST 1234 5698 7654 32', 'Sort code 12-34-56 Account number 12345678', 'National Insurance number QQ 12 34 56 C']
        : [`Statement page ${i}`, 'Date Description Amount', '02/10 Coffee shop 3.20', '03/10 Groceries 45.10', '04/10 Train ticket 12.50', 'Balance carried forward 1,204.33'];
    }),
  );
}

/**
 * A 12-page paper the filter saves by itself (an arXiv number and a References section: force save, positive evidence 7.5, so
 * no override), whose page 7, outside the sample, holds a card number and an IBAN.
 */
async function paperWithCardOnPage7(): Promise<Uint8Array> {
  const prose = (i: number): string[] => [
    `Part ${i}`,
    'The fisherman unloads the quay and the harbour wall at dawn, before the market opens.',
    'The boats come back with the tide, and the nets are dried along the beach in the afternoon.',
    'In winter the harbour is quiet, and the town mends its boats and its houses for the spring.',
    'The old lighthouse keeper writes down the weather, the tides and the boats that come and go.',
  ];
  return pagedPdf(
    Array.from({ length: 12 }, (_, k) => {
      const i = k + 1;
      if (i === 1) return ['arXiv:2301.12345v2 [cs.LG] 3 Feb 2023', 'Notes on a small harbour town', 'Jane Example', ...prose(1).slice(1)];
      if (i === 7) return ['Appendix C. Payment details', 'Card number 4111 1111 1111 1111', 'IBAN GB82 WEST 1234 5698 7654 32'];
      if (i === 12) return ['References', 'A. Author. Harbour towns. Journal of Things, 2020.', 'B. Writer. Small boats. Journal of Stuff, 2019.'];
      return prose(i);
    }),
  );
}

async function searchHits(page: Page, needle: string): Promise<number> {
  const s = storeOf(page);
  return (await s.call<unknown[]>('searchPages', needle, 10)).length + (await s.call<unknown[]>('search', { text: needle, limit: 10 })).length;
}

test('N1: a card number outside the sample pages is not indexed after an owner save', async ({ openViewer, server }, testInfo) => {
  const bytes = await statement();
  server.mount('/stmt/', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return Promise.resolve();
  });
  const page = await openViewer(server.url('/stmt/october.pdf'));
  await waitViewerReady(page);
  await waitForStore(page);
  const kind = await decided(page);
  const d = await decisionOf(page);
  await chipOf(page).click();
  const id = await waitSaved(page);
  await page.waitForTimeout(2500);
  const s = storeOf(page);
  const doc = await s.call<{ indexText: boolean } | null>('getDocument', id);
  const hits = await searchHits(page, '4111');
  const notes = await statusText(page);
  testInfo.annotations.push({ type: 'statement', description: JSON.stringify({ kind, rule: d?.rule, reason: d?.reasons[0], indexText: doc?.indexText, pageText: (await s.stats()).pageText, hits4111: hits }) });
  expect(hits, 'the card number is not searchable').toBe(0);
  expect(doc?.indexText, 'D9: its text is not indexed').toBe(false);
  expect(notes, 'the D9 warning shows').toMatch(/its text is not searchable/i);
});

test('N1: a PDF the filter would save by itself, with a card number on page 7, is not saved', async ({ openViewer, server }, testInfo) => {
  const file = '2f-paper-card-p7.pdf';
  const bytes = await paperWithCardOnPage7();
  await writeFile(join(WALKTHROUGH_DIR, file), bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const page = await openViewer(server.url(`/f/walkthroughs/${file}`));
  await waitViewerReady(page);
  await waitForStore(page);
  expect(await decided(page), 'the automatic save stops: the PDF is not learning').toBe('not-learning');
  await page.waitForTimeout(1500);
  const d = await decisionOf(page);
  testInfo.annotations.push({ type: 'decision', description: JSON.stringify({ rule: d?.rule, reasons: d?.reasons }) });
  expect(await libraryId(page), 'nothing was saved').toBeNull();
  await expect(chipOf(page), 'the chip says why').toContainText(/not saved: has card or bank numbers/i);
  await still(page, testInfo, 'chip-card-on-page-7');
  expect(await traceProblems(page, { sha, phrases: ['Payment details', 'harbour wall at dawn'], fileName: file }), 'and nothing of it was written').toEqual([]);

  // The owner's click still saves it, without searchable text and with the warning (D9).
  await chipOf(page).click();
  const id = await waitSaved(page);
  await page.waitForTimeout(2500);
  const doc = await storeOf(page).call<{ indexText: boolean } | null>('getDocument', id);
  expect(doc?.indexText, 'saved by the owner without searchable text').toBe(false);
  expect(await searchHits(page, '4111'), 'and its card number is not searchable').toBe(0);
  expect(await statusText(page), 'the D9 warning shows').toMatch(/its text is not searchable/i);
});

test('N1: a first mark on a "not sure" PDF with a card number on page 7 asks, and saves nothing', async ({ context, openViewer, server }, testInfo) => {
  // The test build's verdict switch makes the statement "not sure", so its first mark would save it without a question.
  await forceVerdict(context, 'unsure');
  const file = '2f-statement-card-p7.pdf';
  await writeFile(join(WALKTHROUGH_DIR, file), await statement());
  const fx: TlFixture = { name: 'statement-p7', file: `walkthroughs/${file}`, page: 0, dir: 'ltr' };
  const page = await openPaper(openViewer, server, fx);
  await waitForStore(page);
  expect(await decided(page)).toBe('unsure');
  await selectPassage(page, fx, { from: 'Coffee', to: 'shop' });
  await page.keyboard.press('h');
  await expect(savePrompt(page).first(), 'the first mark asks first').toBeVisible({ timeout: 15_000 });
  await still(page, testInfo, 'first-mark-asks-card-on-page-7');
  expect(await libraryId(page), 'and nothing is saved').toBeNull();
  expect((await decisionOf(page))?.rule).toBe('hard-block');
});
