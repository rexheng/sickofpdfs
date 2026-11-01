import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/test';
// Task 22's e2e/support/drag-select.ts. Until it exists, playwright.config.ts leaves this spec out (testIgnore). The ignore below
// keeps typecheck and lint quiet in the meantime; the cast keeps the call typed. Remove the ignore when Task 22 has merged.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- module not merged yet
import { dragSelect as dragSelectFromTask22 } from '../support/drag-select';
import { shot } from './support/takeover';

type DragSelect = (page: Page, pageIndex: number, a: number, b: number) => Promise<{ ranges: readonly unknown[]; domText: string }>;
const dragSelect = dragSelectFromTask22 as DragSelect;

// Gate 1, "No lost text" (Phase 2 plan, done-when 5 and Gate 1 item 5; walkthrough 4, "You mark up and comment").
// Written from the spec and the contracts only. It cannot pass until the viewer exists (Phase 1 Tasks 20-23: loading, the page
// list, the text layer and the viewer chrome) and the comment UI is in it (Phase 2 S13 and S14: marks, Ctrl+Alt+M, the note
// box and the margin cards), and the store is wired (Task 28, Task 30). Until then it fails at the first selection.
//
// What it does, the way the owner would: select text, press Ctrl+Alt+M, type, and then lose the tab.
//   - kill the renderer 100 ms after the last key, or close the tab mid-draft; reopen the PDF; the draft is back in its card with
//     the caret at the end;
//   - Esc and clicking away never lose the text;
//   - with two tabs on one PDF, the draft stays with tab A until A is gone; tab B sees the notes A posted, never A's draft.
//
// GUESSES about the screen (the spec names no markup): the note box and the cards' editor are a text box (a textarea or a
// contenteditable) whose accessible name contains "comment", "note" or "reply"; a posted note shows its text in the margin;
// a selection is made with Task 22's dragSelect (glyph indices on page 0 of paper-50.pdf, which is text).

const PAPER = '/f/paper-50.pdf';
const FIRST = [60, 110] as const; // glyph indices on page 0
const SECOND = [200, 250] as const;
const LINE_1 = 'Does the placebo test rule out anticipation effects?';
const LINE_2 = 'Zażółć gęślą jaźń 🙂 and a second line';

/** The text box of a note being written (the last one, if several cards are open). */
const noteBox = (page: Page): Locator => page.getByRole('textbox', { name: /comment|note|reply/i }).last();

/** What the box holds and where the caret is: works for a textarea and for a contenteditable. */
async function readBox(box: Locator): Promise<{ text: string; caretAtEnd: boolean; focused: boolean }> {
  return box.evaluate((el) => {
    const focused = document.activeElement === el || el.contains(document.activeElement);
    if ('value' in el) {
      const t = el as HTMLTextAreaElement | HTMLInputElement;
      return { text: t.value, caretAtEnd: t.selectionStart === t.value.length && t.selectionEnd === t.value.length, focused };
    }
    const sel = getSelection();
    const text = (el as HTMLElement).innerText;
    if (!sel || sel.rangeCount === 0 || !el.contains(sel.focusNode)) return { text, caretAtEnd: false, focused };
    const after = document.createRange();
    after.selectNodeContents(el);
    after.setStart(sel.focusNode!, sel.focusOffset);
    return { text, caretAtEnd: sel.isCollapsed && after.toString().replace(/\n$/, '') === '', focused };
  });
}

/** Everything the owner can read on the page, including the text inside boxes. */
const readEverything = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('textarea, input, [contenteditable]')].map((e) => ('value' in e ? (e as HTMLInputElement).value : (e as HTMLElement).innerText));
    return [document.body.innerText, ...boxes].join('\n');
  });
const owns = async (page: Page, needle: string): Promise<boolean> => (await readEverything(page)).includes(needle);

/** Select some words and press Ctrl+Alt+M: the note box opens and has the keyboard. */
async function startNote(page: Page, at: readonly [number, number]): Promise<Locator> {
  const { ranges } = await dragSelect(page, 0, at[0], at[1]);
  expect(ranges.length, 'the selection should hold text').toBeGreaterThan(0);
  await page.keyboard.press('Control+Alt+m');
  const box = noteBox(page);
  await expect(box, 'Ctrl+Alt+M opens a note box').toBeVisible({ timeout: 2000 });
  await expect.poll(async () => (await readBox(box)).focused, { message: 'the note box has the keyboard' }).toBe(true);
  return box;
}

/** Type like a person, one line with Shift+Enter in the middle, then stop. */
async function typeNote(page: Page): Promise<string> {
  await page.keyboard.type(LINE_1, { delay: 15 });
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type(LINE_2, { delay: 15 });
  return `${LINE_1}\n${LINE_2}`;
}

/** The renderer dies: the same as the "Aw, Snap" crash page. */
async function crashRenderer(page: Page): Promise<void> {
  const crashed = new Promise<void>((resolve) => page.once('crash', () => resolve()));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.crash').catch(() => undefined); // the session dies with the page
  await crashed;
}

const KILLS = [
  { name: 'the renderer is killed', kill: crashRenderer },
  { name: 'the tab is closed', kill: (page: Page) => page.close({ runBeforeUnload: true }) },
];

test.describe('No lost text', () => {
  // Needs the comment UI of Phase 2 (S13 and S14). Run with SOP_PHASE2_UI=1 once they are merged, then delete this line.
  test.skip(process.env['SOP_PHASE2_UI'] !== '1', 'needs the Phase 2 comment UI (S13, S14)');

  for (const { name, kill } of KILLS) {
    test(`${name} 100 ms after the last key: the draft is back in its card, with the caret at the end`, async ({ openViewer, server }, testInfo) => {
      const url = server.url(PAPER);
      const first = await openViewer(url);
      await startNote(first, FIRST);
      const typed = await typeNote(first);
      await first.waitForTimeout(100); // "100 ms after typing stops"
      await shot(first, testInfo, 'typed-just-before-the-kill');

      await kill(first);

      const again = await openViewer(url);
      const box = noteBox(again);
      await expect(box, 'the draft is back in a note box').toBeVisible({ timeout: 10_000 });
      await expect.poll(async () => (await readBox(box)).text, { message: 'every character, the new line and the emoji included' }).toBe(typed);
      expect((await readBox(box)).caretAtEnd, 'the caret is at the end of the text').toBe(true);
      await shot(again, testInfo, 'draft-back-in-its-card');
    });
  }

  test('a draft left alone for a while is just as safe (300 ms, the saving rule)', async ({ openViewer, server }) => {
    const url = server.url(PAPER);
    const first = await openViewer(url);
    await startNote(first, FIRST);
    const typed = await typeNote(first);
    await first.waitForTimeout(300);
    await crashRenderer(first);
    const again = await openViewer(url);
    await expect.poll(async () => (await readBox(noteBox(again))).text, { timeout: 10_000 }).toBe(typed);
  });

  for (const way of ['Escape', 'clicking away'] as const) {
    test(`${way} never loses the text: it is still there after a reload`, async ({ openViewer, server }, testInfo) => {
      const url = server.url(PAPER);
      const page = await openViewer(url);
      await startNote(page, FIRST);
      await page.keyboard.type(LINE_1, { delay: 15 });

      if (way === 'Escape') await page.keyboard.press('Escape');
      else await page.mouse.click(8, 400); // somewhere that is not the note
      await expect.poll(() => owns(page, LINE_1), { message: 'the text is still on the screen (as a card or a draft)' }).toBe(true);
      await shot(page, testInfo, `after-${way === 'Escape' ? 'esc' : 'click-away'}`);

      await page.reload();
      await expect.poll(() => owns(page, LINE_1), { timeout: 10_000, message: 'the text is still there after a reload' }).toBe(true);
      await shot(page, testInfo, 'after-reload');
    });
  }

  test('two tabs on one PDF: the draft stays with tab A while A is open; B sees the notes A posted, never A\'s draft; when A is gone, B has the draft', async ({ openViewer, server }, testInfo) => {
    const url = server.url(PAPER);
    const a = await openViewer(url);

    // A posts a note (Enter) and starts a second one, which it does not finish
    const firstBox = await startNote(a, FIRST);
    await a.keyboard.type('Posted from tab A', { delay: 10 });
    await a.keyboard.press('Enter');
    await expect(a.getByText('Posted from tab A')).toBeVisible();
    await expect(firstBox).toBeHidden();
    await startNote(a, SECOND);
    await a.keyboard.type('Still writing in tab A', { delay: 10 });
    await a.waitForTimeout(400);

    const b = await openViewer(url);
    await expect(b.getByText('Posted from tab A'), 'B shows what A posted').toBeVisible({ timeout: 10_000 });
    await b.waitForTimeout(500);
    expect(await owns(b, 'Still writing in tab A'), "B must not show A's draft").toBe(false);
    await shot(b, testInfo, 'tab-b-sees-the-posted-note-not-the-draft');

    // A keeps going and posts the draft: B shows it without a reload
    await a.keyboard.press('Enter');
    await expect(b.getByText('Still writing in tab A'), 'tabs stay in step').toBeVisible({ timeout: 5000 });

    // A writes a third note and then goes away; B (reloaded, so it asks who is alive) now owns the draft
    await startNote(a, [300, 340]);
    await a.keyboard.type('Third note, left behind', { delay: 10 });
    await a.waitForTimeout(100);
    await crashRenderer(a);
    await b.reload();
    await expect.poll(async () => (await readBox(noteBox(b))).text, { timeout: 10_000, message: 'tab B adopted the draft of the tab that is gone' }).toBe('Third note, left behind');
    await shot(b, testInfo, 'tab-b-adopted-the-draft');
  });
});
