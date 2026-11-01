import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  NO_SAVING,
  SAVING_AVAILABLE,
  allCards,
  anyBox,
  annotations,
  cardWith,
  crashRenderer,
  editBox,
  noteBox,
  openPaper,
  owns,
  postNote,
  readBox,
  replyBox,
  selectPassage,
  startNote,
  typeLines,
  waitSaved,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

// Gate 1, "No lost text" (Phase 2 plan, done-when 5 and Gate 1 item 5; walkthrough 4, "You mark up and comment").
// Written from the spec and the contracts only. It cannot pass until the viewer's comment UI is in (Phase 2 S13 and S14: marks,
// Ctrl+Alt+M, the note box and the margin cards), and the save decision is (Task 30: a draft is stored only for a saved PDF).
//
// What it does, the way the owner would: select text, press Ctrl+Alt+M, type, and then lose the tab.
//   - kill the renderer 100 ms after the last key, or close the tab mid-draft; reopen the PDF; the draft is back in its card with
//     the caret at the end;
//   - Esc and clicking away never lose the text;
//   - with two tabs on one PDF, the draft stays with tab A until A is gone; tab B sees the notes A posted, never A's draft;
//   - an unsent reply, and an unsent edit of a sent note, are just as safe (contracts section 3, R54).
//
// Every step that needs the draft to come back after the tab is gone needs the PDF to be saved (contracts: "On a memory-only PDF,
// drafts stay in memory and nothing is written"), so those tests wait for the save decision (Task 30) to be in this tree.
//
// GUESSES about the screen (the spec names no markup): the note box is a text box named "Note" (the reply box "Reply", the edit box
// "Edit note"), whose caret is read from the element; a posted note shows its text in a card in the margin; the paper is the
// learning paper "Attention Is All You Need", which the filter saves by itself (an arXiv id and a References section).

const LINE_1 = 'Does the placebo test rule out anticipation effects?';
const LINE_2 = 'Zażółć gęślą jaźń 🙂 and a second line';

/** Type like a person, one line with Shift+Enter in the middle, then stop. */
async function typeNote(page: Page): Promise<string> {
  await typeLines(page, [LINE_1, LINE_2], 15);
  return `${LINE_1}\n${LINE_2}`;
}

const KILLS = [
  { name: 'the renderer is killed', kill: crashRenderer },
  { name: 'the tab is closed', kill: (page: Page) => page.close({ runBeforeUnload: true }) },
];

/** The address of the paper on the fixture server. */
const addressOf = (server: { url(p: string): string }): string => server.url(`/f/${ATTENTION.file}`);

test.describe('No lost text', () => {
  test.setTimeout(150_000);

  for (const { name, kill } of KILLS) {
    test(`${name} 100 ms after the last key: the draft is back in its card, with the caret at the end`, async ({ openViewer, server }, testInfo) => {
      test.skip(!SAVING_AVAILABLE, NO_SAVING);
      const first = await openPaper(openViewer, server, ATTENTION);
      await waitSaved(first);
      await selectPassage(first, ATTENTION, LINES.l1);
      await startNote(first);
      const typed = await typeNote(first);
      await first.waitForTimeout(100); // "100 ms after typing stops"
      await shot(first, testInfo, 'typed-just-before-the-kill');

      await kill(first);

      const again = await openViewer(addressOf(server));
      const box = noteBox(again);
      await expect(box, 'the draft is back in a note box').toBeVisible({ timeout: 15_000 });
      await expect.poll(async () => (await readBox(box)).text, { message: 'every character, the new line and the emoji included' }).toBe(typed);
      expect((await readBox(box)).caretAtEnd, 'the caret is at the end of the text').toBe(true);
      await shot(again, testInfo, 'draft-back-in-its-card');
    });
  }

  test('a draft left alone for a while is just as safe (300 ms, the saving rule)', async ({ openViewer, server }) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const first = await openPaper(openViewer, server, ATTENTION);
    await waitSaved(first);
    await selectPassage(first, ATTENTION, LINES.l3);
    await startNote(first);
    const typed = await typeNote(first);
    await first.waitForTimeout(300);
    await crashRenderer(first);
    const again = await openViewer(addressOf(server));
    await expect.poll(async () => (await readBox(noteBox(again))).text, { timeout: 15_000 }).toBe(typed);
  });

  test('a draft that was never sent is not in the library as a note, and is not shown as sent', async ({ openViewer, server }, testInfo) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const page = await openPaper(openViewer, server, ATTENTION);
    const id = await waitSaved(page);
    await selectPassage(page, ATTENTION, LINES.l5);
    await startNote(page);
    await page.keyboard.type('Not sent yet', { delay: 10 });
    await page.waitForTimeout(500);
    const stored = await annotations(page, id);
    expect(stored.comments.filter((c) => c.draftOfTab === null && c.body === 'Not sent yet'), 'listAnnotations returns live, non-draft rows only').toHaveLength(0);
    await shot(page, testInfo, 'draft-not-sent');
  });

  for (const way of ['Escape', 'clicking away'] as const) {
    test(`${way} never loses the text: it is still on the screen as a note`, async ({ openViewer, server }, testInfo) => {
      const page = await openPaper(openViewer, server, ATTENTION);
      await selectPassage(page, ATTENTION, LINES.l1);
      await startNote(page);
      await page.keyboard.type(LINE_1, { delay: 15 });

      if (way === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(8, 400); // somewhere that is not the note
      await expect.poll(() => owns(page, LINE_1), { message: 'the text is still on the screen (as a card or a draft)' }).toBe(true);
      await shot(page, testInfo, `after-${way === 'Escape' ? 'esc' : 'click-away'}`);
    });

    test(`${way} never loses the text: it is still there after a reload`, async ({ openViewer, server }, testInfo) => {
      test.skip(!SAVING_AVAILABLE, NO_SAVING);
      const page = await openPaper(openViewer, server, ATTENTION);
      await waitSaved(page);
      await selectPassage(page, ATTENTION, LINES.l1);
      await startNote(page);
      await page.keyboard.type(LINE_1, { delay: 15 });
      if (way === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(8, 400);
      await expect.poll(() => owns(page, LINE_1)).toBe(true);

      await page.reload();
      await expect.poll(() => owns(page, LINE_1), { timeout: 15_000, message: 'the text is still there after a reload' }).toBe(true);
      await shot(page, testInfo, 'after-reload');
    });
  }

  test('an unsent reply survives a crash, and the note it belongs to is still there', async ({ openViewer, server }, testInfo) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const first = await openPaper(openViewer, server, ATTENTION);
    await waitSaved(first);
    await postNote(first, ATTENTION, LINES.l3, 'The note that gets a reply');
    const card = cardWith(first, 'The note that gets a reply');
    await card.click();
    await expect(replyBox(first), 'an active card has a reply box').toBeVisible();
    await replyBox(first).click();
    await first.keyboard.type('A reply I never sent', { delay: 15 });
    await first.waitForTimeout(100);
    await crashRenderer(first);

    const again = await openViewer(addressOf(server));
    await expect(cardWith(again, 'The note that gets a reply'), 'the sent note is back').toBeVisible({ timeout: 15_000 });
    await expect.poll(() => owns(again, 'A reply I never sent'), { timeout: 15_000, message: 'and so is the reply that was being typed' }).toBe(true);
    await shot(again, testInfo, 'reply-draft-back');
  });

  test('an unsent edit of a sent note survives a crash, and the sent text stays until the edit is sent', async ({ openViewer, server }, testInfo) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const first = await openPaper(openViewer, server, ATTENTION);
    const id = await waitSaved(first);
    await postNote(first, ATTENTION, LINES.l7, 'Original wording');
    const card = cardWith(first, 'Original wording');
    await card.click();
    await card.getByRole('button', { name: /more options/i }).first().click();
    await first.getByRole('menuitem', { name: /^edit$/i }).click();
    const edit = editBox(first);
    await expect(edit).toBeVisible();
    await edit.focus();
    await first.keyboard.press('End');
    await first.keyboard.type(' and an unsent addition', { delay: 15 });
    await first.waitForTimeout(100);
    await crashRenderer(first);

    const again = await openViewer(addressOf(server));
    await expect.poll(() => owns(again, 'Original wording and an unsent addition'), { timeout: 15_000, message: 'the editor comes back with the unsent text' }).toBe(true);
    await shot(again, testInfo, 'edit-draft-back');
    const live = await annotations(again, id);
    expect(live.comments.filter((c) => c.deletedAt === null).map((c) => c.body), 'the sent text has not been replaced').toEqual(['Original wording']);
  });

  test("two tabs on one PDF: the draft stays with tab A while A is open; B sees the notes A posted, never A's draft; when A is gone, B has the draft", async ({ openViewer, server }, testInfo) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const a = await openPaper(openViewer, server, ATTENTION);
    await waitSaved(a);

    // A posts a note (Enter) and starts a second one, which it does not finish
    await selectPassage(a, ATTENTION, LINES.l1);
    await startNote(a);
    await a.keyboard.type('Posted from tab A', { delay: 10 });
    await a.keyboard.press('Enter');
    await expect(a.getByText('Posted from tab A')).toBeVisible();
    await expect(noteBox(a), 'the sent note has no new-note box any more').toHaveCount(0);
    await selectPassage(a, ATTENTION, LINES.l5);
    await startNote(a);
    await a.keyboard.type('Still writing in tab A', { delay: 10 });
    await a.waitForTimeout(400);

    const b = await openViewer(addressOf(server));
    await expect(b.getByText('Posted from tab A'), 'B shows what A posted').toBeVisible({ timeout: 15_000 });
    await b.waitForTimeout(500);
    expect(await owns(b, 'Still writing in tab A'), "B must not show A's draft").toBe(false);
    expect(await anyBox(b).count(), "B has no box open for A's draft").toBe(0);
    await shot(b, testInfo, 'tab-b-sees-the-posted-note-not-the-draft');

    // A keeps going and posts the draft: B shows it without a reload
    await a.bringToFront();
    await a.keyboard.press('Enter');
    await expect(b.getByText('Still writing in tab A'), 'tabs stay in step').toBeVisible({ timeout: 8000 });
    await expect(allCards(b)).toHaveCount(2);

    // A writes a third note and then goes away; B (reloaded, so it asks who is alive) now owns the draft
    await a.bringToFront();
    await selectPassage(a, ATTENTION, LINES.l9);
    await startNote(a);
    await a.keyboard.type('Third note, left behind', { delay: 10 });
    await a.waitForTimeout(100);
    await crashRenderer(a);
    await b.bringToFront();
    await b.reload();
    await expect.poll(async () => (await readBox(noteBox(b))).text, { timeout: 15_000, message: 'tab B adopted the draft of the tab that is gone' }).toBe('Third note, left behind');
    await shot(b, testInfo, 'tab-b-adopted-the-draft');
  });
});
