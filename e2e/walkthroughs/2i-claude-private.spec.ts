// Regression walkthroughs for the TB6 fix round, slice C1 (R105, private PDFs; spec D9 and R102). The owner's rule: receipts and
// private documents are never touched, and nothing leaves the computer that the owner did not turn on.
//
// On a PDF judged not learning:
// - every Claude item is greyed out with "Claude doesn't read private files": Ask Claude in the right-click menu, Tools → Ask
//   Claude about the whole document, the @ suggestion, Explain this figure in the figure menu, and the figure toolbar;
// - an "@Claude" note gets no save question for Claude's sake;
// - the thread shows the plain refusal as a row of Claude's that stays (never a toast) until its OK, and nothing reaches Anthropic;
// - saved later anyway (R102), the row says "Claude did not read this".
import type { Page } from '@playwright/test';
import { claudeReplay } from '../support/claude-replay';
import { forceVerdict } from '../support/filter-verdict';
import { expect, hooks, test } from '../support/test';
import { claudeLine, claudeRows, messages, setUpClaude } from './support/claude';
import { centreOf, figureBox, FIG_PICTURE, openFigurePaper, AWAY } from './support/figures.spec-blind';
import { chipOf, saveFromChip } from './support/library-p3.spec-blind';
import { ATTENTION, SENTENCE_1, cardWith, markMenu, menuRow, openPaper, rightClickAt, rightClickSelection, savePrompt, selectPassage, startNote, waitSaved } from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.use({ networkGate: 'claude' });
test.setTimeout(150_000);

const HINT = /claude doesn.t read private files/i;

/** Closes an open menu as the owner does (Esc), and with a click beside the page if a hint's tooltip kept it open. */
async function closeMenus(page: Page): Promise<void> {
  await page.mouse.move(AWAY.x, AWAY.y);
  await page.keyboard.press('Escape');
  if (!(await page.getByRole('menu').count())) return;
  await page.waitForTimeout(500);
  if (await page.getByRole('menu').count()) await page.mouse.click(AWAY.x, AWAY.y);
  await expect(page.getByRole('menu'), 'the menu closes').toHaveCount(0);
}
const REFUSAL = /claude doesn.t read this pdf\. it looked private when you opened it, so nothing was sent/i;

test('R105: on a PDF judged not learning, every Claude item is greyed out, an @Claude note gets no save question, and the thread says why; nothing is sent', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'not-learning');
  const page = await openPaper(openViewer, server, ATTENTION);
  await expect.poll(() => hooks(page).eval((h) => h.save.state().kind), { timeout: 30_000, message: 'the filter judged it not learning' }).toBe('not-learning');
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  replay.use('ask-passage');

  // The right-click menu: Ask Claude is there, greyed out, and says why.
  const sel = await selectPassage(page, ATTENTION, SENTENCE_1);
  await rightClickSelection(page, sel);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  const ask = menuRow(page, /ask claude/i);
  await expect(ask, 'Ask Claude is greyed out').toBeDisabled();
  await ask.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: HINT }), 'its hint says why').toBeVisible();
  await shot(page, testInfo, 'menu-ask-claude-greyed');
  await closeMenus(page);

  // Tools → Ask Claude about the whole document: greyed out too.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Tools', exact: true }).click();
  const whole = page.getByRole('menu').getByRole('menuitem', { name: /ask claude about the whole document/i });
  await expect(whole, 'Ask Claude about the whole document is greyed out').toBeDisabled();
  await whole.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: HINT })).toBeVisible();
  await shot(page, testInfo, 'tools-whole-document-greyed');
  await closeMenus(page);

  // A note typed by hand: the @ suggestion is greyed out with the hint, and the save question never shows for it.
  await selectPassage(page, ATTENTION, SENTENCE_1);
  await startNote(page);
  await page.keyboard.type('@', { delay: 20 });
  const list = page.locator('[data-claude-mentions]');
  await expect(list, 'typing "@" shows the suggestion').toBeVisible();
  await expect(list.getByRole('option'), 'greyed out').toHaveAttribute('aria-disabled', 'true');
  await expect(list, 'with the hint').toContainText(HINT);
  await shot(page, testInfo, 'mention-greyed');
  await page.keyboard.type('Claude what is this total?', { delay: 20 });
  await expect(page.locator('[data-claude-hint]'), 'the line under the box says it too').toContainText(HINT);
  await expect(savePrompt(page), 'no save question for Claude’s sake').toHaveCount(0);
  await shot(page, testInfo, 'note-no-save-question');
  await page.keyboard.press('Enter');

  const refusal = claudeLine(page, REFUSAL);
  await expect(refusal, 'the thread says why, in a row of Claude’s').toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(7000);
  await expect(refusal, 'it stays: it is not a toast').toBeVisible();
  await expect(savePrompt(page), 'and the save question never came').toHaveCount(0);
  expect(messages(replay.requests()), 'nothing was sent to Anthropic').toHaveLength(0);
  await expect(refusal.getByRole('button', { name: 'OK' }), 'it has a plain OK that dismisses it').toBeVisible();
  await expect(refusal.getByRole('button', { name: /try again|ask again/i }), 'and nothing to try again').toHaveCount(0);
  await shot(page, testInfo, 'refusal-row-stays');

  // The owner saves the PDF anyway (R102). The note is kept, and the row says Claude did not read it.
  await saveFromChip(page);
  await waitSaved(page);
  await cardWith(page, 'what is this total?').click();
  await expect(claudeLine(page, /claude did not read this/i), 'saved later: "Claude did not read this"').toBeVisible({ timeout: 20_000 });
  expect((await claudeRows(page)).every((r) => r.status === 'error' && r.role === null), 'no answer, no model, no cost').toBe(true);
  expect(messages(replay.requests()), 'and still nothing was sent').toHaveLength(0);
  await expect(chipOf(page)).toBeVisible();
  await shot(page, testInfo, 'saved-later-not-read');

  // OK dismisses the row (R105: "a row that stays until dismissed").
  await claudeLine(page, /claude did not read this/i).getByRole('button', { name: 'OK' }).click();
  await expect(claudeLine(page, /claude did not read this/i), 'OK takes the row away').toHaveCount(0);
  await expect(cardWith(page, 'what is this total?'), 'the note itself stays').toBeVisible();
  expect(messages(replay.requests()), 'and nothing was sent').toHaveLength(0);
  await shot(page, testInfo, 'refusal-dismissed');
});

test('R105: on a PDF judged not learning, Explain this figure is greyed out in the figure menu and in the figure toolbar', async ({ context, openViewer, server }, testInfo) => {
  await forceVerdict(context, 'not-learning');
  const page = await openFigurePaper(openViewer, server, FIG_PICTURE);
  await expect.poll(() => hooks(page).eval((h) => h.save.state().kind), { timeout: 30_000 }).toBe('not-learning');
  const replay = claudeReplay(server);
  await replay.attach(page);
  await setUpClaude(page);
  const at = centreOf(await figureBox(page, FIG_PICTURE));
  // Figure detection runs when the page is idle: the menu is tried until it offers the figure's rows.
  await expect
    .poll(
      async () => {
        await page.keyboard.press('Escape');
        await page.mouse.move(AWAY.x, AWAY.y);
        await rightClickAt(page, at);
        return (await markMenu(page).getByRole('menuitem', { name: /explain this figure/i }).count()) > 0;
      },
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(true);
  const explain = menuRow(page, /explain this figure/i);
  await expect(explain, 'Explain this figure is greyed out').toBeDisabled();
  await expect(menuRow(page, /^ask claude/i), 'and Ask Claude').toBeDisabled();
  await explain.hover();
  await expect(page.getByRole('tooltip').filter({ hasText: HINT }), 'with the hint').toBeVisible();
  await shot(page, testInfo, 'figure-menu-greyed');
  await page.keyboard.press('Escape');
  await page.mouse.click(at.x, at.y); // selects the figure
  await page.waitForTimeout(800);
  await shot(page, testInfo, 'figure-toolbar-greyed');
  // Adjusted in the C3 follow-up (R105): the toolbar shows, greyed out, instead of not showing.
  const bar = page.getByRole('toolbar', { name: 'Figure' });
  await expect(bar, 'the figure toolbar shows').toBeVisible();
  for (const name of [/^ask claude$/i, /^explain$/i]) await expect(bar.getByRole('button', { name }), 'greyed out').toHaveAttribute('aria-disabled', 'true');
  await bar.getByRole('button', { name: /^explain$/i }).hover();
  await expect(page.getByRole('tooltip').filter({ hasText: HINT }), 'with the hint').toBeVisible();
  await shot(page, testInfo, 'figure-toolbar-hint');
  await bar.getByRole('button', { name: /^explain$/i }).click({ force: true }); // aria-disabled: Playwright would wait for it to be enabled
  await page.waitForTimeout(800);
  expect(messages(replay.requests()), 'pressing it sends nothing').toHaveLength(0);
  await expect(savePrompt(page), 'and asks nothing').toHaveCount(0);
});
