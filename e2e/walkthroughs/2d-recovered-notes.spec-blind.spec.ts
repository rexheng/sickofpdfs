// Phase 3 carried requirement R77 (no lost notes): "Recovered notes."
//   "Test build 2 could leave drafts in the journal with no document id (the bug R67 fixed). They can't be placed and must never be deleted
//    silently. The library's Notes page (S14) shows them under 'Recovered notes': each with its text, the time it was typed, and Copy and
//    Delete. The section disappears when empty."
// Spec, Non-negotiables: "no lost notes". Contracts section 3, "The journal (R56 corrected)": a copy of every draft is kept in the extension's
// localStorage, one key per draft: `sop-draft:c:<commentId>` (a note or reply being typed) or `sop-draft:e:<commentId>` (an unsent edit); "an
// entry goes when the store confirms the send or the delete, and `forgetDraftJournal(documentId)` runs wherever a document is forgotten."
//
// WHAT IS SEEDED. Entries as the old build wrote them: the journal's own shape (v, kind, commentId, threadId, tab, body, at, pending) with no
// usable document id: one has `documentId: ""`, the other has no `documentId` at all. They are put into the extension's localStorage from one of
// its pages, exactly where the draft journal keeps its copies.
//
// Test 1 (runs today): such an entry is NEVER deleted without the owner asking. The paths that do delete journal entries in this product are the
// ones that forget a document: Undo on a first mark, Forget this PDF, and a library tab hearing that a document was forgotten. All three are
// used, and the entries must still be there afterwards, with their text.
// Test 2 (runtime guard: the Notes page is built): the "Recovered notes" section lists each entry with its text, a time, Copy and Delete. Copy puts
// the text on the clipboard. Delete asks for nothing more than a click (or one confirmation), removes the entry for good, and the section goes
// when the last one has gone.
//
// GUESSES: the section's heading reads "Recovered notes"; Copy and Delete are buttons inside each entry; the time may be shown as a clock time
// (14:35 or 2:35 pm) or with the date ("30 Oct"); Delete may ask once.
import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { openClipboardReader } from '../support/tl-blind.spec-blind';
import { libraryId, openPaper, selectPassage, UNSURE, HANDOUT_LINE } from './support/marks.spec-blind';
import { fileMenuHas, forgetThisPdf, saveFromChip, goTo, note, openLibrary, pageNotBuilt, shotOf, waitForStore } from './support/library-p3.spec-blind';
import { store as storeOf } from '../support/store-probe.spec-blind';

test.setTimeout(240_000);

const BODY_ONE = 'Recovered note one: typed before the bug was fixed';
const BODY_TWO = 'Recovered note two: also typed back then';
const KEY_ONE = 'sop-draft:c:6a1c2d4e-0000-4000-8000-0000000000a1';
const KEY_TWO = 'sop-draft:c:6a1c2d4e-0000-4000-8000-0000000000a2';
const HOURS_AGO = 3;

/** The entries as an old build left them: no document id. */
function entries(at: number): Record<string, string> {
  const base = { v: 1, kind: 'comment', tab: 'tab-from-an-old-build', at, pending: true };
  return {
    [KEY_ONE]: JSON.stringify({ ...base, documentId: '', commentId: KEY_ONE.slice('sop-draft:c:'.length), threadId: '6a1c2d4e-0000-4000-8000-0000000000b1', body: BODY_ONE }),
    [KEY_TWO]: JSON.stringify({ ...base, commentId: KEY_TWO.slice('sop-draft:c:'.length), threadId: '6a1c2d4e-0000-4000-8000-0000000000b2', body: BODY_TWO, at: at + 60_000 }),
  };
}

async function seed(page: Page, items: Record<string, string>): Promise<void> {
  await page.evaluate((all) => Object.entries(all).forEach(([k, v]) => localStorage.setItem(k, v)), items);
}

/** What the extension's localStorage holds under the journal's prefix: key to body text. */
async function journal(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (!k.startsWith('sop-draft:')) continue;
      try {
        out[k] = (JSON.parse(localStorage.getItem(k) ?? '{}') as { body?: string }).body ?? '';
      } catch {
        out[k] = '(unreadable)';
      }
    }
    return out;
  });
}

test('a draft with no document id is not deleted when a PDF is un-saved, forgotten, or the library hears about it', async ({ context, openViewer, server }, testInfo) => {
  const lib = await openLibrary(context, 'library'); // stays open: it hears about every forgotten PDF and clears that PDF's drafts
  await seed(lib, entries(Date.now() - HOURS_AGO * 3_600_000));
  expect(Object.keys(await journal(lib)).sort(), 'two entries are in the journal').toEqual([KEY_ONE, KEY_TWO]);

  // 1. Undo on a first mark: the PDF is saved by the mark and the save is taken back
  const page = await openPaper(openViewer, server, UNSURE);
  await waitForStore(page);
  await expect(page.locator('header').getByRole('button', { name: /^(not sure|saved)/i }).first()).toBeVisible({ timeout: 30_000 });
  expect(Object.keys(await journal(lib)).sort(), 'opening a PDF in the viewer deletes no draft').toEqual([KEY_ONE, KEY_TWO]);
  const sel = await selectPassage(page, UNSURE, HANDOUT_LINE);
  expect(sel.ranges.length).toBeGreaterThan(0);
  const alreadySaved = (await libraryId(page)) !== null;
  if (!alreadySaved) {
    await page.keyboard.press('h');
    const undo = page.locator('header').getByRole('button', { name: /^undo$/i });
    await expect(undo, 'the first mark saves the PDF and offers Undo').toBeVisible({ timeout: 20_000 });
    await undo.click();
    await expect.poll(() => libraryId(page), { message: 'Undo takes the PDF out of the library', timeout: 15_000 }).toBeNull();
  } else {
    note(testInfo, 'the handout', 'was saved by the filter, so Undo was not offered; Forget this PDF is used instead');
  }
  const afterUndo = await journal(lib);
  expect(afterUndo[KEY_ONE], 'after Undo the draft with documentId "" is still there').toBe(BODY_ONE);
  expect(afterUndo[KEY_TWO], 'and the one with no documentId at all').toBe(BODY_TWO);

  // 2. Forget this PDF (File menu), after saving it by choice
  await page.bringToFront();
  const chip = page.locator('header').getByRole('button', { name: /^(not sure|not saved|saved to library)/i }).first();
  if (!/saved to library/i.test((await chip.textContent()) ?? '')) await saveFromChip(page); // R95, R96: the chip offers Save first
  await expect.poll(() => libraryId(page), { timeout: 30_000 }).not.toBeNull();
  if (await fileMenuHas(page, /forget this pdf/i)) await forgetThisPdf(page);
  else {
    note(testInfo, 'forget', 'the File menu has no "Forget this PDF" yet: the store was asked directly (the library tab still hears of it)');
    await storeOf(page).call('forgetDocument', (await libraryId(page))!);
  }
  await expect.poll(() => libraryId(page), { message: 'Forget this PDF removes it', timeout: 20_000 }).toBeNull();
  await lib.waitForTimeout(1500); // the open library tab hears about it
  const afterForget = await journal(lib);
  expect(afterForget[KEY_ONE], 'after Forget this PDF the draft is still there').toBe(BODY_ONE);
  expect(afterForget[KEY_TWO]).toBe(BODY_TWO);

  // 3. the library tab itself reloads: nothing is cleaned up behind the owner's back
  await lib.reload();
  await lib.waitForTimeout(1000);
  const afterReload = await journal(lib);
  expect(Object.keys(afterReload).sort(), 'both entries survive a reload of the library').toEqual([KEY_ONE, KEY_TWO]);
  await shotOf(lib, testInfo, '01-journal-still-holds-both');
});

test('the Notes page lists them under "Recovered notes" with their text, the time, Copy and Delete; the section goes when empty', async ({ context, server }, testInfo) => {
  const lib = await openLibrary(context, 'notes');
  if (await pageNotBuilt(lib)) test.skip(true, 'the Notes page is not built yet (slice S14)');
  const section = lib.getByRole('heading', { name: /recovered notes/i });
  await expect(section, 'with nothing to recover there is no "Recovered notes" section').toHaveCount(0);

  const at = Date.now() - HOURS_AGO * 3_600_000;
  await seed(lib, entries(at));
  await lib.reload();
  await goTo(lib, 'notes');
  await expect(section, 'the section appears').toBeVisible({ timeout: 15_000 });
  for (const body of [BODY_ONE, BODY_TWO]) await expect(lib.getByText(body), `"${body}" is listed with its text`).toBeVisible();
  await shotOf(lib, testInfo, '02-recovered-notes');

  const entryOf = (body: string) => lib.locator('li, article, [role=listitem], [role=row], div').filter({ has: lib.getByText(body, { exact: false }) }).filter({ has: lib.getByRole('button', { name: /^delete/i }) }).last();
  const one = entryOf(BODY_ONE);
  await expect(one.getByRole('button', { name: /^copy/i }), 'each entry has Copy').toBeVisible();
  await expect(one.getByRole('button', { name: /^delete/i }), 'and Delete').toBeVisible();

  // the time it was typed: a clock time or a date, as this browser would write it
  const shown = ((await one.textContent()) ?? '').replace(/\s+/g, ' ');
  const candidates = await lib.evaluate((t) => {
    const d = new Date(t);
    return [
      d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
      d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
    ];
  }, at);
  expect(
    candidates.some((c) => shown.toLowerCase().includes(c.toLowerCase())) || /\b\d{1,2}:\d{2}\b|\b(hours?|minutes?|today|yesterday) ?(ago)?\b/i.test(shown),
    `the entry says when it was typed (looked for ${candidates.join(' | ')}; the entry reads: ${shown.slice(0, 160)})`,
  ).toBe(true);

  // Copy puts the text on the clipboard
  const reader = await openClipboardReader(context, server);
  await reader.clear();
  await lib.bringToFront();
  await one.getByRole('button', { name: /^copy/i }).click();
  await lib.waitForTimeout(400);
  expect(await reader.read(), 'Copy puts the note on the clipboard').toBe(BODY_ONE);
  await reader.close();

  // Delete removes one, for good
  await lib.bringToFront();
  await entryOf(BODY_TWO).getByRole('button', { name: /^delete/i }).click();
  const confirm = lib.getByRole('dialog').getByRole('button', { name: /^delete/i });
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click();
  await expect(lib.getByText(BODY_TWO), 'Delete removes that note').toHaveCount(0);
  await expect(lib.getByText(BODY_ONE), 'and only that one').toBeVisible();
  expect(Object.keys(await journal(lib)), 'it is gone from the journal too').toEqual([KEY_ONE]);

  // the last Delete takes the section away
  await entryOf(BODY_ONE).getByRole('button', { name: /^delete/i }).click();
  if (await confirm.isVisible({ timeout: 1500 }).catch(() => false)) await confirm.click();
  await expect(section, 'when nothing is left the section disappears').toHaveCount(0);
  expect(await journal(lib)).toEqual({});
  await shotOf(lib, testInfo, '03-section-gone');
});
