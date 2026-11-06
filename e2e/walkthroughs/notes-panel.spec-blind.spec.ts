// Gate 1 for slice S15 (plan section 2): the notes panel and note navigation. The "Couldn't place" section is walked in
// reanchor.spec-blind.spec.ts (plan section 4, item 9).
//   S15: "every note is in one Docs-style panel, including any that couldn't be placed. You can step through notes with the keyboard.
//   The panel: Shift+F4 opens it. It is 320 px wide with 16 px corners, All and Mine tabs, thread cards with a reply box, and a
//   'Couldn't place' section. Navigation: Ctrl+Alt+N and Ctrl+Alt+P go to the next and previous note."
// Spec, Shortcuts: "Notes panel / thumbnails and outline: Shift+F4 / F4"; "Next / previous note: Ctrl+Alt+N / Ctrl+Alt+P".
//
// GUESSES (the spec names no markup): the panel is found as a region, complementary or dialog named like "Notes" (or any element with
// such a label that holds the All tab); the tabs are tabs named "All" and "Mine"; "next" goes to the next note down the document from
// where the reader is, and lands on it with its card active and its page in view.
import type { Page } from '@playwright/test';
import { expect, hooks, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  activeCards,
  allCards,
  boxOf,
  cardWith,
  clearSelection,
  openPaper,
  postNote,
  settle,
  startNoteAnswering,
  type Box,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(150_000);
const GUTTER = { x: 8, y: 420 };

const notesPanel = (page: Page) =>
  page
    .getByRole('complementary', { name: /notes/i })
    .or(page.getByRole('region', { name: /notes/i }))
    .or(page.getByRole('dialog', { name: /notes/i }))
    .or(page.locator('[aria-label*="notes" i]').filter({ has: page.getByRole('tab', { name: /^all$/i }) }))
    .first();

/** A page note: scroll to the page, point off the pages, Ctrl+Alt+M, type, Enter. */
async function pageNote(page: Page, index: number, text: string): Promise<void> {
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), index);
  await settle(page, 500);
  await clearSelection(page);
  await page.mouse.move(GUTTER.x, GUTTER.y);
  await startNoteAnswering(page, 'No');
  await page.keyboard.type(text, { delay: 6 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, text).first()).toBeVisible({ timeout: 5000 });
}

/** The page the reader is on: the page box that holds the middle of the screen. */
async function pageInView(page: Page): Promise<number> {
  return hooks(page).eval((h) => {
    const top = h.viewer.scrollTop();
    const mid = top + h.viewer.viewportHeight() / 3;
    const boxes = h.viewer.pageBoxes();
    const hit = boxes.findIndex((b) => mid >= b.top && mid < b.top + b.height);
    return hit >= 0 ? hit : boxes.length - 1;
  });
}

async function openPanel(page: Page): Promise<ReturnType<typeof notesPanel>> {
  await page.keyboard.press('Shift+F4');
  const panel = notesPanel(page);
  await expect(panel, 'Shift+F4 opens the notes panel').toBeVisible({ timeout: 3000 });
  return panel;
}

test('The notes panel: Shift+F4, answering a note there, and stepping through the notes', async ({ step }, testInfo) => {
  test.setTimeout(450_000);
  await step('Shift+F4 opens a 320 px notes panel with All and Mine tabs and every note in it; Shift+F4 again closes it', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await postNote(page, ATTENTION, LINES.l3, 'Panel note on a passage');
    await pageNote(page, 3, 'Panel note for page four');
    await hooks(page).eval((h) => h.viewer.scrollTo(0));
    await settle(page, 400);

    const panel = await openPanel(page);
    await shot(page, testInfo, 'panel-open');
    const b: Box = await boxOf(panel);
    expect(b.right - b.left, 'the panel is 320 px wide').toBeGreaterThanOrEqual(312);
    expect(b.right - b.left).toBeLessThanOrEqual(332);
    await expect(panel.getByRole('tab', { name: /^all$/i }), 'an All tab').toBeVisible();
    await expect(panel.getByRole('tab', { name: /^mine$/i }), 'and a Mine tab').toBeVisible();
    await expect(panel.getByRole('article').filter({ hasText: 'Panel note on a passage' }), 'every note is in the panel').toHaveCount(1);
    await expect(panel.getByRole('article').filter({ hasText: 'Panel note for page four' })).toHaveCount(1);
    await panel.getByRole('tab', { name: /^mine$/i }).click();
    await expect(panel.getByRole('article').filter({ hasText: 'Panel note on a passage' }), 'Mine lists my own notes').toHaveCount(1);
    await panel.getByRole('tab', { name: /^all$/i }).click();

    await page.keyboard.press('Shift+F4');
    await expect(panel, 'Shift+F4 again closes it').toBeHidden();
    await expect(allCards(page).filter({ hasText: 'Panel note on a passage' }), 'the cards are still in the margin').toHaveCount(1);
  }, 150_000);
  await step('a note in the panel can be answered there, and clicking it goes to its place in the document', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await pageNote(page, 5, 'Note on page six');
    await hooks(page).eval((h) => h.viewer.scrollTo(0));
    await settle(page, 400);
    expect(await pageInView(page)).toBe(0);

    const panel = await openPanel(page);
    const card = panel.getByRole('article').filter({ hasText: 'Note on page six' });
    await card.click();
    await expect.poll(() => pageInView(page), { message: 'clicking the note in the panel scrolls to its page', timeout: 5000 }).toBe(5);
    await expect(activeCards(page).filter({ hasText: 'Note on page six' }).first(), 'and makes it the active card').toBeVisible();
    await shot(page, testInfo, 'panel-click-jumps');

    const reply = panel.getByRole('article').filter({ hasText: 'Note on page six' }).getByRole('textbox', { name: /reply/i });
    await expect(reply, 'the panel card has a reply box').toBeVisible();
    await reply.click();
    await page.keyboard.type('Answered from the panel', { delay: 6 });
    await page.keyboard.press('Enter');
    await expect(panel.getByText('Answered from the panel'), 'the reply is in the thread').toBeVisible({ timeout: 5000 });
  }, 150_000);
  await step('Ctrl+Alt+N and Ctrl+Alt+P step through the notes down and up the document, each opening its card', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    for (const [index, text] of [[2, 'Step note one'], [5, 'Step note two'], [8, 'Step note three']] as const) await pageNote(page, index, text);
    await hooks(page).eval((h) => h.viewer.scrollTo(0));
    await settle(page, 500);
    await page.mouse.click(GUTTER.x, GUTTER.y); // let go of the last card
    await page.waitForTimeout(300);

    const expectOn = async (text: string, index: number, why: string) => {
      await expect.poll(() => pageInView(page), { message: `${why}: the page of "${text}" is in view`, timeout: 5000 }).toBe(index);
      await expect(activeCards(page).filter({ hasText: text }).first(), `${why}: the card of "${text}" is the active one`).toBeVisible({ timeout: 5000 });
    };
    await page.keyboard.press('Control+Alt+n');
    await expectOn('Step note one', 2, 'the first Ctrl+Alt+N');
    await shot(page, testInfo, 'next-1');
    await page.keyboard.press('Control+Alt+n');
    await expectOn('Step note two', 5, 'the second Ctrl+Alt+N');
    await page.keyboard.press('Control+Alt+n');
    await expectOn('Step note three', 8, 'the third Ctrl+Alt+N');
    await page.keyboard.press('Control+Alt+p');
    await expectOn('Step note two', 5, 'Ctrl+Alt+P');
    await page.keyboard.press('Control+Alt+p');
    await expectOn('Step note one', 2, 'a second Ctrl+Alt+P');
    await shot(page, testInfo, 'previous-2');
  }, 150_000);
});
