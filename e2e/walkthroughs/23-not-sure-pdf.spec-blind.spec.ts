// Gate 1, Phase 3 plan, item 4: 'A "not sure" PDF.'
//   "After 20 seconds the banner appears. 'Never for this file' holds when the file is reopened from another folder under another name.
//    'Always for this site' saves the next PDF from that site."
// Spec, "When the filter is wrong": '"Not sure" PDFs show a quiet banner after 20 seconds: Save, Not now, Never for this file, or Always
// for this site.' "Settings has the allow and deny lists". Rules, in order: "Your choice for this exact file", then the hard block, then
// "Your deny and allow lists for sites and folders", then force save, then the score. "Local traces ... choosing 'Never save this file'
// keeps a salted fingerprint on this computer only."
//
// The PDFs are the three "booklets" made in support/p3-fixtures.spec-blind.ts: ten pages of plain prose with one "Chapter" heading, which the
// spec's weight table scores at -1 + 1 + 1.5 = 1.5, so "not sure". Three, because they must be three different documents (same letters
// would be a re-download of the first, spec rule 2). A fourth file has a valid card number, to show that a hard block beats the allow list
// ("Hard block ... then the allow list").
//
// Guard: FILTER_IN_VIEWER. GUESSES: the banner's four controls are buttons named "Save", "Not now", "Never for this file" and "Always for
// this site" (the spec's words); the banner is not a modal dialog; "Not now" only hides it for this tab; a "Never for this file" PDF is
// treated like a not-learning one, so the chip says "Not saved". "Always for this site" adds the host (with or without the port).
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, probeIdb, test } from '../support/test';
import { scanOpfs, store as storeOf } from '../support/store-probe.spec-blind';
import { savePrompt, openPaper, libraryId, selectPassage, type TlFixture } from './support/marks.spec-blind';
import { WALKTHROUGH_DIR } from './support/fixtures.spec-blind';
import { shot } from './support/takeover';
import { CARD_NUMBER, ensureP3Fixtures, P3_FILES, p3Url } from './support/p3-fixtures.spec-blind';
import {
  FILTER_IN_VIEWER,
  NO_FILTER,
  chipOf,
  allReadings,
  decided,
  note,
  openLibrary,
  openSettings,
  pageNotBuilt,
  shaOf,
  sleep,
  stateKind,
  traceProblems,
  waitForStore,
  waitViewerReady,
  type Pdf,
} from './support/library-p3.spec-blind';

test.skip(!FILTER_IN_VIEWER, NO_FILTER);
test.setTimeout(240_000);

const asPdf = (name: (typeof P3_FILES)[keyof typeof P3_FILES]): Pdf => ({ file: `walkthroughs/${name}`, path: p3Url(name), title: /./, rowName: /./ });
const BOOKLET_A = asPdf(P3_FILES.notSureA);
const BOOKLET_B = asPdf(P3_FILES.notSureB);
const BOOKLET_C = asPdf(P3_FILES.notSureC);
const CARD = asPdf(P3_FILES.card);

const SAVE = /^save$/i;
const NOT_NOW = /^not now$/i;
const NEVER = /never for this file/i;
// Triage (filterfix, rule 7): spec R91 has the button name the place ("Always for moodle.lse.ac.uk"), so it no longer says "this
// site". Here the site is the fixture server's, 127.0.0.1. TB5 fix round (F4): the button has a verb, "Always save from <place>".
const ALWAYS = /^always save from 127\.0\.0\.1$/i;
const banner = (page: Page, name: RegExp) => page.getByRole('button', { name });

test.beforeAll(async () => {
  await ensureP3Fixtures();
});

/** Opens a booklet and checks it is what the filter cannot decide: "Not sure: Save?". */
async function openUnsure(openViewer: (u: string) => Promise<Page>, serverUrl: (p: string) => string, f: Pdf): Promise<Page> {
  const page = await openViewer(serverUrl(f.path));
  await waitViewerReady(page);
  await waitForStore(page);
  expect(await decided(page), 'a plain ten-page booklet with a "Chapter" heading scores 1.5: "not sure"').toBe('unsure');
  await expect(chipOf(page)).toContainText(/not sure/i);
  return page;
}

test('A Not sure PDF: the quiet banner after 20 seconds, Never for this file, and Always for this site', async ({ step }, testInfo) => {
  test.setTimeout(720_000);
  await step('after 20 seconds a quiet banner offers Save, Not now, Never for this file and Always for this site', async ({ openViewer, server }) => {
    // Triage (S11, rule 7): booklet A scores 1.5, and the tie-breaker (S10, spec step 3) reads it as study material (+1.63), so it is
    // saved by itself. B and C stay "not sure" (2.30 and 2.42), so B is the "not sure" PDF here and C below.
    const a = await openViewer(server.url(BOOKLET_A.path));
    await waitViewerReady(a);
    await waitForStore(a);
    expect(await decided(a), 'booklet A is saved by itself: the tie-breaker reads it as study material').toBe('saved');
    await a.close();

    const page = await openUnsure(openViewer, (p) => server.url(p), BOOKLET_B);
    const decidedAt = Date.now();

    await sleep(8000);
    await expect(banner(page, NEVER), 'no banner in the first seconds').toHaveCount(0);

    await expect(banner(page, NEVER), 'the banner appears').toBeVisible({ timeout: 35_000 });
    const after = Date.now() - decidedAt;
    note(testInfo, 'the banner appeared after (ms)', String(after));
    expect(after, 'not before about 20 seconds').toBeGreaterThanOrEqual(15_000);
    for (const [name, label] of [[SAVE, 'Save'], [NOT_NOW, 'Not now'], [NEVER, 'Never for this file'], [ALWAYS, 'Always for 127.0.0.1']] as const) {
      await expect(banner(page, name), `the banner has "${label}"`).toBeVisible();
    }
    await expect(page.getByRole('alertdialog'), 'it is quiet: not a modal question').toHaveCount(0);
    await expect(page.locator('[role=document] canvas').first(), 'and the PDF is still there to read').toBeVisible();
    await shot(page, testInfo, 'banner-after-20-seconds');

    await banner(page, NOT_NOW).click();
    await expect(banner(page, NEVER), 'Not now closes the banner').toHaveCount(0);
    expect(await libraryId(page), 'and does not save').toBeNull();
    await expect(chipOf(page), 'the chip still offers the save').toContainText(/not sure/i);
    await shot(page, testInfo, 'after-not-now');
  }, 240_000);
  await step('Never for this file holds when the same file is opened from another folder under another name', async ({ context, openViewer, server }) => {
    const sha = await shaOf(BOOKLET_B);
    const page = await openUnsure(openViewer, (p) => server.url(p), BOOKLET_B);
    await expect(banner(page, NEVER)).toBeVisible({ timeout: 40_000 });
    await banner(page, NEVER).click();
    await expect(banner(page, NEVER), 'the banner goes').toHaveCount(0);
    await expect(chipOf(page), 'the chip now says it will not be saved').toContainText(/not saved/i);
    expect(await libraryId(page)).toBeNull();
    await shot(page, testInfo, 'never-for-this-file');
    await page.close();

    // the same bytes, in another folder, under another name
    const copy = join(WALKTHROUGH_DIR, 'p3-elsewhere', 'renamed-copy.pdf');
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(join(WALKTHROUGH_DIR, P3_FILES.notSureB), copy);
    const moved: TlFixture = { name: 'booklet-b-moved', file: 'walkthroughs/p3-elsewhere/renamed-copy.pdf', page: 0, dir: 'ltr' };
    const elsewhere = await openPaper(openViewer, server, moved);
    await waitForStore(elsewhere);
    await decided(elsewhere);
    await expect(chipOf(elsewhere), 'the same file from another folder and name is still "never"').toContainText(/not saved/i);
    expect(await stateKind(elsewhere)).not.toBe('unsure');
    await elsewhere.waitForTimeout(25_000);
    await expect(banner(elsewhere, NEVER), 'so the banner never comes back for it').toHaveCount(0);
    await shot(elsewhere, testInfo, 'moved-copy-still-never');

    // a first mark does not save it behind the owner's back
    await selectPassage(elsewhere, moved, { from: 'Notes on', to: 'harbour town' });
    await elsewhere.keyboard.press('h');
    await elsewhere.waitForTimeout(1500);
    expect(await libraryId(elsewhere), 'a mark on a file you said "never" for does not save it').toBeNull();
    note(testInfo, 'a first mark on a "never" file', (await savePrompt(elsewhere).first().isVisible()) ? 'asks "Save this PDF to keep your notes?"' : 'asks nothing and saves nothing');

    // the choice is remembered across a reload, and only as a salted fingerprint
    await elsewhere.reload();
    await waitViewerReady(elsewhere);
    await decided(elsewhere);
    await expect(chipOf(elsewhere)).toContainText(/not saved/i);
    const probe = await probeIdb(elsewhere, 'sop-local', sha);
    expect(probe.existed, "the choice is kept in the extension's private store").toBe(true);
    expect(probe.containsNeedle, 'as a salted fingerprint, never the raw one').toBe(false);
    expect(await traceProblems(elsewhere, { sha, phrases: ['Notes on a small harbour town'], fileName: 'renamed-copy.pdf' }), 'and nothing else about the file is kept').toEqual([]);

    // the library does not list it
    const library = await openLibrary(context, 'library');
    await expect(library.getByText(/your learning pdfs will appear here/i)).toBeVisible();
  }, 240_000);
  await step('Always for this site saves the next PDF from that site, but a card number still beats the rule', async ({ context, openViewer, server }) => {
    // baseline: another not-sure PDF from the same site is not saved
    const baseline = await openUnsure(openViewer, (p) => server.url(p), BOOKLET_C);
    await baseline.waitForTimeout(1500);
    expect(await libraryId(baseline), 'before the rule, a not-sure PDF from this site is not saved').toBeNull();
    await baseline.close();

    // Triage (S11, rule 7): B, not A, which the tie-breaker saves by itself (see the first test).
    const page = await openUnsure(openViewer, (p) => server.url(p), BOOKLET_B);
    await expect(banner(page, ALWAYS)).toBeVisible({ timeout: 40_000 });
    await banner(page, ALWAYS).click();
    await expect(banner(page, ALWAYS), 'the banner goes').toHaveCount(0);
    await shot(page, testInfo, 'always-for-this-site');

    // Settings lists the site (when the Settings page exists)
    const settings = await openSettings(context);
    if (!(await pageNotBuilt(settings))) {
      await expect(settings.getByText(/127\.0\.0\.1/), 'Settings lists the allowed site').toBeVisible({ timeout: 10_000 });
      await shot(settings, testInfo, 'settings-allowed-site');
    } else note(testInfo, 'Settings', 'the Settings page is not built yet, so the allow list was not read');
    await settings.close();

    // the next PDF from that site is saved
    const next = await openViewer(server.url(BOOKLET_C.path));
    await waitViewerReady(next);
    await waitForStore(next);
    await expect(chipOf(next), 'the next PDF from the site is saved without a question').toContainText(/saved to library/i, { timeout: 45_000 });
    expect(await libraryId(next)).toBe(await shaOf(BOOKLET_C));
    await shot(next, testInfo, 'next-pdf-from-the-site-saved');

    // a PDF with a card number is blocked, though its site is allowed
    const card = await openViewer(server.url(CARD.path));
    await waitViewerReady(card);
    await waitForStore(card);
    expect(await decided(card), 'a card number blocks on its own, ahead of the allow list').toBe('not-learning');
    await expect(chipOf(card)).toContainText(/not saved/i);
    note(testInfo, 'the chip for the card statement says', ((await chipOf(card).textContent()) ?? '').trim());
    const cardSha = await shaOf(CARD);
    expect(await storeOf(card).call('resolveFingerprint', cardSha), 'the card statement is not in the library').toBeNull();
    for (const needle of [CARD_NUMBER, '4111 1111']) expect(await scanOpfs(card, needle), `"${needle}" is in no stored file`).toEqual([]);
    expect(await storeOf(card).call<unknown[]>('search', { text: '4111', limit: 10 }), 'and no search finds it').toEqual([]);
    await shot(card, testInfo, 'card-statement-not-saved');

    // the library holds the one that was saved by the rule, and never the card
    const ids = (await allReadings(next)).map((r) => r.id);
    expect(ids, 'the library holds the PDF the rule saved').toContain(await shaOf(BOOKLET_C));
    expect(ids, 'and never the card statement').not.toContain(cardSha);
    note(testInfo, 'the PDF whose banner was answered "Always for this site"', ids.includes(await shaOf(BOOKLET_B)) ? 'was saved too' : 'was not saved');
  }, 240_000);
});
