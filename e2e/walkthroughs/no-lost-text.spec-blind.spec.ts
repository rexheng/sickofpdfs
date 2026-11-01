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
  saveFirst,
} from './support/marks.spec-blind';
import { boxTextsIn, draftsIn, lookInside } from '../support/crash';
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

// Triage (TB2): saveFirst presses the chip's "Save?", as the owner would while the stand-in filter calls the paper "Not sure".
// Ruling on gap 2 (tb2-triage.md, crash-report.md): a renderer crash takes the whole extension down until the owner reloads it;
// crashRenderer does that one click. The drafts journal brings the text back.

test.describe('No lost text', () => {
  test.setTimeout(150_000);

  for (const { name, kill } of KILLS) {
    test(`${name} 100 ms after the last key: the draft is back in its card, with the caret at the end`, async ({ openViewer, server }, testInfo) => {
      test.skip(!SAVING_AVAILABLE, NO_SAVING);
      const first = await openPaper(openViewer, server, ATTENTION);
      await saveFirst(first);
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
    await saveFirst(first);
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
    const id = await saveFirst(page);
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
      await saveFirst(page);
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
    await saveFirst(first);
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
    const id = await saveFirst(first);
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

  // Ruling R65 (restated by the controller). Every page of the extension shares one renderer process, so A's crash kills B too
  // (crash-report.md); after the owner's one click Chrome's tabs come back by themselves. The draft must come back in the tab
  // that owned it; if that tab does not come back, the first reopened tab for the PDF adopts it. Never lost, never twice.
  // The tabs that died are read through a fresh CDP session (lookInside): Playwright never lets a crashed Page be used again.
  test("two tabs on one PDF: the draft stays with tab A while A is open; B sees the notes A posted, never A's draft; after a crash and the owner's one click, the draft comes back in tab A and nowhere else", async ({ context, openViewer, server }, testInfo) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const a = await openPaper(openViewer, server, ATTENTION);
    const id = await saveFirst(a);

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

    // A writes a third note, and the renderer dies 100 ms after the last key: A and B both die. The owner clicks once.
    await a.bringToFront();
    await selectPassage(a, ATTENTION, LINES.l9);
    await startNote(a);
    const text = 'Third note, left behind';
    await a.keyboard.type(text, { delay: 10 });
    await a.waitForTimeout(100);
    await crashRenderer(a, { closeTab: false });
    const tabA = await lookInside(context, a);
    const tabB = await lookInside(context, b);
    await expect.poll(() => draftsIn(tabA), { timeout: 30_000, message: 'tab A comes back by itself and holds its draft' }).toEqual([text]);
    await expect.poll(() => boxTextsIn(tabA), { timeout: 10_000, message: "the draft is on A's screen, in a note box" }).toContain(text);
    await testInfo.attach('tab-a-has-its-draft-back', { body: await tabA.screenshot(), contentType: 'image/png' });
    await expect.poll(() => draftsIn(tabB), { timeout: 30_000, message: 'tab B comes back too, with no draft' }).toEqual([]);
    expect(await boxTextsIn(tabB), "B never shows A's draft").not.toContain(text);

    // Never twice: a tab opened now does not get it either, and nothing was sent in its place.
    const c = await openViewer(addressOf(server));
    await expect(c.getByText('Posted from tab A'), 'a new tab shows the sent notes').toBeVisible({ timeout: 15_000 });
    await c.waitForTimeout(1500);
    expect(await owns(c, text), 'a new tab never shows the draft that tab A owns').toBe(false);
    const stored = await annotations(c, id);
    expect(stored.comments.filter((x) => x.body === text), 'the draft was not sent in its place').toHaveLength(0);
    expect(await c.evaluate((t) => Object.keys(localStorage).filter((k) => k.startsWith('sop-draft:') && localStorage.getItem(k)?.includes(t)).length, text), 'one copy in the journal').toBe(1);
    await tabA.detach();
    await tabB.detach();
  });

  test('if the tab that owned the draft does not come back, the first reopened tab adopts it, and only that one', async ({ context, openViewer, server }, testInfo) => {
    test.skip(!SAVING_AVAILABLE, NO_SAVING);
    const a = await openPaper(openViewer, server, ATTENTION);
    const id = await saveFirst(a);
    const b = await openViewer(addressOf(server));
    await expect(b.getByRole('button', { name: /^saved/i }).first(), 'B opens the saved PDF').toBeVisible({ timeout: 25_000 });

    await a.bringToFront();
    await selectPassage(a, ATTENTION, LINES.l3);
    await startNote(a);
    const text = 'Written in a tab that never came back';
    await a.keyboard.type(text, { delay: 10 });
    await a.waitForTimeout(100);
    await crashRenderer(a); // A and B die; the owner closes A's crashed tab, then clicks once

    const tabB = await lookInside(context, b);
    await expect.poll(() => draftsIn(tabB), { timeout: 30_000, message: 'B comes back by itself and adopts the draft of the tab that is gone' }).toEqual([text]);
    await expect.poll(() => boxTextsIn(tabB), { timeout: 10_000, message: "the draft is on B's screen, in a note box" }).toContain(text);
    await testInfo.attach('tab-b-adopted-the-draft', { body: await tabB.screenshot(), contentType: 'image/png' });

    const c = await openViewer(addressOf(server));
    await expect(c.getByRole('button', { name: /^saved/i }).first()).toBeVisible({ timeout: 25_000 });
    await c.waitForTimeout(1500);
    expect(await owns(c, text), 'a tab opened later never shows a second copy').toBe(false);
    expect(await draftsIn(tabB), 'B still has it').toEqual([text]);
    const stored = await annotations(c, id);
    expect(stored.comments.filter((x) => x.body === text), 'the draft was not sent in its place').toHaveLength(0);
    await tabB.detach();
  });
});
