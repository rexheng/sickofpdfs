// Gate 1, Phase 2 plan section 4, item 8: "Tabs in step."
//   "A highlight and a sent comment made in tab A appear in tab B without a reload."
// Spec, The Ctrl+Alt+M flow, 6: "The same document open in two tabs stays in step; a draft belongs to the tab where it was started."
// Done-when 8: "Two tabs on one PDF stay in step." (The draft half of this is in no-lost-text.spec-blind.spec.ts.)
//
// Both tabs show the same saved PDF, so this needs the save decision (Task 30). The walkthrough looks at the screen of tab B only:
// the colour under the words, and the cards.
import { expect, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  NO_SAVING,
  SAVING_AVAILABLE,
  SENTENCE_1,
  allCards,
  cardWith,
  clearSelection,
  describe,
  highlightFromMenu,
  isPlain,
  markTokens,
  openPaper,
  paintOfSelection,
  postNote,
  replyBox,
  selectPassage,
  waitSaved,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(150_000);
test.skip(!SAVING_AVAILABLE, NO_SAVING);

const GREEN = 1;
const YELLOW = 0;

test('a highlight, a sent comment, a reply and a removed highlight made in tab A appear in tab B without a reload', async ({ openViewer, server }, testInfo) => {
  const a = await openPaper(openViewer, server, ATTENTION);
  const b = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(a);
  await waitSaved(a);
  await waitSaved(b);

  // 1. a highlight in A
  await a.bringToFront();
  const green = await selectPassage(a, ATTENTION, SENTENCE_1);
  await highlightFromMenu(a, green, 'green');
  await b.bringToFront();
  await expect
    .poll(async () => (await paintOfSelection(b, green)).paint.share(tokens.fill[GREEN]), { message: 'the green highlight appears in tab B by itself', timeout: 10_000 })
    .toBeGreaterThanOrEqual(0.6);
  await shot(b, testInfo, 'b-sees-the-highlight');

  // 2. a sent comment in A
  await a.bringToFront();
  const noted = await postNote(a, ATTENTION, LINES.l7, 'Written in tab A');
  await b.bringToFront();
  await expect(cardWith(b, 'Written in tab A'), 'the comment appears in tab B by itself').toBeVisible({ timeout: 10_000 });
  const lit = await paintOfSelection(b, noted);
  expect(lit.paint.share(tokens.fill[YELLOW]), `and so does its highlight: ${describe(lit.paint)}`).toBeGreaterThanOrEqual(0.6);
  await shot(b, testInfo, 'b-sees-the-comment');

  // 3. a reply in B shows up in A
  const cardB = cardWith(b, 'Written in tab A');
  await cardB.click();
  await replyBox(b).click();
  await b.keyboard.type('Answered in tab B', { delay: 8 });
  await b.keyboard.press('Enter');
  await expect(cardWith(b, 'Answered in tab B')).toBeVisible();
  await a.bringToFront();
  await expect(cardWith(a, 'Written in tab A'), 'the reply made in B reaches A: the card shows one reply').toContainText(/1 reply|Answered in tab B/, { timeout: 10_000 });
  await expect(allCards(a)).toHaveCount(1);

  // 4. the highlight taken off in A goes from B
  await selectPassage(a, ATTENTION, SENTENCE_1);
  await a.keyboard.press('h'); // H uses the last colour, green, and the words are already green: it takes the highlight off
  await clearSelection(a);
  await b.bringToFront();
  await expect
    .poll(async () => isPlain((await paintOfSelection(b, green)).paint), { message: 'when A undoes the highlight, it goes from B too', timeout: 10_000 })
    .toBe(true);
});
