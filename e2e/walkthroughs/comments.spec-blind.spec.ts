// Gate 1, Phase 2 plan section 4, items 3 and 4: "Comments" and "Replies."
//   3. "Ctrl+Alt+M opens the note box beside the line, not over it. Shift+Enter adds a new line, and Enter saves. The card survives a
//       reload. Esc with text keeps the note. Esc on an empty new note drops its highlight. Emptying an existing note keeps its
//       highlight. Ctrl+Alt+M on a passage that already has a comment opens that thread."
//   4. "Clicking a card makes it light, moves it left and darkens its highlight. Two replies stay in order after a reload."
// Spec, "The Ctrl+Alt+M flow": "1. With text selected, Ctrl+Alt+M creates a comment on the selection, shown with a highlight in under
// 50 ms, and opens a note box in the right margin, level with the selection, never covering it. ... 3. Shift+Enter adds a new line.
// Esc or clicking away also saves typed text. An empty new note cancels its highlight; emptying an existing note keeps the highlight.
// 4. A selection over an existing comment opens that thread ... instead of stacking a duplicate. 5. Cards line up with their marks
// down the margin, like Google Docs. The active card moves left and its mark darkens." Done-when 4: "A clicked card turns light, moves
// 12 px left, and its mark darkens." Plan S14: "The margin column appears once the document has a thread or a note box opens. The page
// then shifts left in one move, keeping the anchored line in place." "Comments are separate from styles."
//
// How the walkthrough sees things: a card is an `article` named "Note by You: ..." (the shared UI kit's ThreadCard), the active
// card has aria-current; the box for a new note is a text box named "Note", the box for a reply "Reply", and for an edit "Edit note".
// GUESSES: Esc and a click away on a note WITH text send it (plan section 7: "Esc with text sends the note"); the highlight a
// comment makes is in the colour H would use (the last colour, yellow on a fresh profile).
// Triage (tb2marks), ruling R68: commenting never changes a mark's colour, so a note makes no highlight. Words with no
// style show the dotted underline (plan S13), and while the note's card is open a neutral wash; marked words keep their
// marks, and an open card darkens its highlight. Where a test is about a note's highlight, the words are highlighted
// with H first, as the owner would.
import { expect, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  NO_SAVING,
  SAVING_AVAILABLE,
  SENTENCE_1,
  activeCards,
  allCards,
  hasDottedUnderline,
  boxOf,
  cardWith,
  clearSelection,
  describe,
  editBox,
  hex,
  isPlain,
  isWashed,
  lineBoxes,
  markTokens,
  noteBox,
  note,
  openPaper,
  overlapArea,
  pageRect,
  paintOfSelection,
  postNote,
  readBox,
  reloadAndWait,
  replyBox,
  selectPassage,
  startNote,
  threadUnderlineColour,
  typeLines,
  waitSaved,
  waitStored,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';
import { th } from '../support/tl-blind.spec-blind';

test.setTimeout(120_000);
const YELLOW = 0;

const luminance = (css: string): number => {
  const m = /rgba?\(([^)]+)\)/.exec(css);
  const [r, g, b] = (m?.[1] ?? '0,0,0').split(/[\s,/]+/).filter(Boolean).map(Number);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

test('Ctrl+Alt+M shows the passage at once and opens a note box in the right margin, level with the line and not over it', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const sel = await selectPassage(page, ATTENTION, SENTENCE_1);
  const plain = await paintOfSelection(page, sel);
  const firstGlyph = await th(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: 0, i: sel.a });
  const pageBefore = await pageRect(page, 0);
  await selectPassage(page, ATTENTION, SENTENCE_1);

  const box = await startNote(page);
  await page.waitForTimeout(400); // the margin column and the page settle
  await shot(page, testInfo, 'note-box-open');

  // The comment shows its words at once (before a word is typed).
  const lit = await paintOfSelection(page, sel, { name: 'passage-while-the-box-is-open', testInfo });
  // Triage (tb2marks), R68: the open note's words get a neutral wash, never a mark colour (before R68: the active yellow).
  expect(isWashed(lit.paint, tokens), `the commented words are picked out already, in a neutral wash and in no mark colour: ${describe(lit.paint)}`).toBe(true);
  expect(lit.paint.ink, 'the words are still readable').toBeGreaterThanOrEqual(plain.paint.ink * 0.95);

  // Beside the line, in the right margin, level with it, never over it.
  const card = page.getByRole('article').filter({ has: box });
  await expect(card, 'the note box sits in a card').toBeVisible();
  const c = await boxOf(card);
  const pageNow = await pageRect(page, 0);
  const lines = await lineBoxes(page, sel);
  note(testInfo, 'page shift when the margin column appeared', `${(pageNow.left - pageBefore.left).toFixed(0)} px (left edge ${pageBefore.left.toFixed(0)} -> ${pageNow.left.toFixed(0)})`);
  expect(c.left, `the card is in the right margin, not on the page (page right edge ${pageNow.right.toFixed(0)}, card left edge ${c.left.toFixed(0)})`).toBeGreaterThanOrEqual(pageNow.right - 4);
  for (const [i, line] of lines.entries()) {
    expect(overlapArea(c, line), `the card does not cover line ${i + 1} of the selection`).toBeLessThanOrEqual(1);
  }
  expect(Math.abs(c.top - lines[0].top), `the card is level with the selection (card top ${c.top.toFixed(0)}, first line top ${lines[0].top.toFixed(0)})`).toBeLessThanOrEqual(60);

  // The page shifts, but the line the note is about stays where it was, vertically.
  const firstGlyphNow = await th(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: 0, i: sel.a });
  expect(Math.abs(firstGlyphNow.y - firstGlyph.y), 'the anchored line keeps its place when the column appears').toBeLessThanOrEqual(4);

  // The box has the keyboard and is empty, with a hint of what it is for.
  expect((await readBox(box)).text).toBe('');
  expect(await box.getAttribute('placeholder'), 'the empty box says what it is for').not.toBeNull();
});

test('Shift+Enter adds a new line and Enter saves: the note becomes a card with both lines, not a draft', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await selectPassage(page, ATTENTION, SENTENCE_1);
  const box = await startNote(page);
  await typeLines(page, ['Why does the encoder matter?', 'Check this against section 3.']);
  expect((await readBox(box)).text, 'Shift+Enter made a new line and did not send').toBe('Why does the encoder matter?\nCheck this against section 3.');
  await expect(box, 'the box is still open after Shift+Enter').toBeVisible();
  await shot(page, testInfo, 'two-lines-typed');

  await page.keyboard.press('Enter');
  const card = cardWith(page, 'Why does the encoder matter?');
  await expect(card, 'Enter turns the note into a card').toBeVisible({ timeout: 5000 });
  await expect(card).toContainText('Check this against section 3.');
  await expect(card, 'the card is the note, not a draft').not.toContainText(/draft/i);
  await expect(noteBox(page), 'the new-note box has closed').toHaveCount(0);
  // Triage (TB2): the avatar is an icon whose ligature text ("person") runs into "You" in textContent; the card's name says who.
  await expect(card).toHaveAccessibleName(/\bYou\b/);
  await shot(page, testInfo, 'note-sent-as-a-card');

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const a = await waitStored(page, (x) => x.comments.some((cm) => cm.draftOfTab === null && cm.deletedAt === null), 'the note is stored as a sent comment');
    const cm = a.comments.find((x) => x.draftOfTab === null)!;
    expect(cm.body, 'the stored text keeps the new line').toBe('Why does the encoder matter?\nCheck this against section 3.');
    expect(cm.author).toBe('me');
    expect(a.threads.filter((t) => t.deletedAt === null && t.anchor.kind === 'text'), 'one thread, on the selected words').toHaveLength(1);
    // Triage (tb2marks), R68: a note makes no highlight.
    expect(a.marks.filter((m) => m.deletedAt === null), 'and no mark: a note adds no style (R68)').toHaveLength(0);
  }
});

test('the card survives a reload, with its dotted underline, on the same words', async ({ openViewer, server }, testInfo) => {
  test.skip(!SAVING_AVAILABLE, NO_SAVING);
  const page = await openPaper(openViewer, server, ATTENTION);
  const dots = await threadUnderlineColour(page);
  const sel = await postNote(page, ATTENTION, LINES.l5, 'Survives a reload');
  // Triage (TB2): Task 30's stand-in filter calls every PDF "Not sure" until Phase 3, so the first mark is what saves it.
  await waitSaved(page);
  await waitStored(page, (a) => a.comments.some((c) => c.body === 'Survives a reload' && c.draftOfTab === null), 'the note is stored');
  await reloadAndWait(page, ATTENTION);
  const card = cardWith(page, 'Survives a reload');
  await expect(card, 'the card is back after a reload').toBeVisible({ timeout: 10_000 });
  const p = await paintOfSelection(page, sel, { name: 'reloaded', testInfo });
  // Triage (tb2marks), R68: the words of a note show its dotted underline, not a highlight.
  expect(hasDottedUnderline(p.shot, p.boxes[0], dots), 'and so is its dotted underline, under the same words').toBe(true);
  expect(isPlain(p.paint), `with no highlight (R68): ${describe(p.paint)}`).toBe(true);
  await shot(page, testInfo, 'card-after-reload');
});

test('Esc with text keeps the note: it is sent, the box closes, and its words stay marked as a note', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const dots = await threadUnderlineColour(page);
  const sel = await selectPassage(page, ATTENTION, LINES.l1);
  await startNote(page);
  await page.keyboard.type('Kept by Escape', { delay: 8 });
  await page.keyboard.press('Escape');
  await expect(noteBox(page), 'Esc closes the box').toHaveCount(0);
  await expect(cardWith(page, 'Kept by Escape'), 'and the note is still there as a card').toBeVisible();
  const p = await paintOfSelection(page, sel, { name: 'esc-with-text', testInfo });
  // Triage (tb2marks), R68: the note's words show its dotted underline (no highlight).
  expect(hasDottedUnderline(p.shot, p.boxes[0], dots), `the note's dotted underline stays: ${describe(p.paint)}`).toBe(true);
});

test('Esc on an empty new note leaves its words as they were and no card', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const dots = await threadUnderlineColour(page);
  const sel = await selectPassage(page, ATTENTION, LINES.l3);
  await startNote(page);
  const lit = await paintOfSelection(page, sel);
  // Triage (tb2marks), R68: the open note's words are washed, not highlighted.
  expect(isWashed(lit.paint, tokens), `while the empty box is open the words are picked out: ${describe(lit.paint)}`).toBe(true);
  await page.keyboard.press('Escape');
  await expect(noteBox(page), 'Esc closes the empty box').toHaveCount(0);
  await expect(allCards(page), 'and no card is left').toHaveCount(0);
  const gone = await paintOfSelection(page, sel, { name: 'esc-on-empty', testInfo });
  expect(isPlain(gone.paint), `the words are plain again: ${describe(gone.paint)}`).toBe(true);
  expect(hasDottedUnderline(gone.shot, gone.boxes[0], dots), 'with no dotted underline').toBe(false);
});

test('clicking away: an empty new note is dropped, a note with text is kept', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const dots = await threadUnderlineColour(page);
  const away = async () => {
    await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
    await page.waitForTimeout(300);
  };

  const empty = await selectPassage(page, ATTENTION, LINES.l5);
  await startNote(page);
  await away();
  await expect(allCards(page), 'a click away on an empty note leaves no card').toHaveCount(0);
  expect(isPlain((await paintOfSelection(page, empty)).paint), 'and no highlight').toBe(true);

  const withText = await selectPassage(page, ATTENTION, LINES.l7);
  await startNote(page);
  await page.keyboard.type('Kept by a click away', { delay: 8 });
  await away();
  await expect(cardWith(page, 'Kept by a click away'), 'a click away on a note with text keeps it').toBeVisible();
  const p = await paintOfSelection(page, withText, { name: 'click-away-with-text', testInfo });
  // Triage (tb2marks), R68: a kept note shows its dotted underline (no highlight).
  expect(hasDottedUnderline(p.shot, p.boxes[0], dots), 'and its words keep its dotted underline').toBe(true);
});

test('emptying an existing note keeps its highlight', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  // Triage (tb2marks), R68: a note makes no highlight, so the words are highlighted first, then the note is written on them.
  await selectPassage(page, ATTENTION, LINES.l9);
  await page.keyboard.press('h');
  const sel = await postNote(page, ATTENTION, LINES.l9, 'A note I will empty');
  const card = cardWith(page, 'A note I will empty');
  await card.click(); // make it the active card: its menu and reply box show
  await card.getByRole('button', { name: /more options/i }).first().click();
  await page.getByRole('menuitem', { name: /^edit$/i }).click();
  const edit = editBox(page);
  await expect(edit, 'Edit opens the note for editing').toBeVisible();
  await edit.focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Delete');
  expect((await readBox(edit)).text, 'the note is empty').toBe('');
  await shot(page, testInfo, 'note-emptied');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
  await page.waitForTimeout(400);
  const p = await paintOfSelection(page, sel, { name: 'after-emptying', testInfo });
  expect(p.paint.share(tokens.fill[YELLOW]), `whatever became of the note, its highlight stays: ${describe(p.paint)}`).toBeGreaterThanOrEqual(0.6);
  note(testInfo, 'after emptying a note and pressing Enter, Esc, click away', (await cardWith(page, 'A note I will empty').count()) > 0 ? 'the original text is back in its card' : 'the card is gone');
});

test('taking the highlight off a commented passage never removes the comment', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const dots = await threadUnderlineColour(page);
  // Triage (tb2marks), R68: a note makes no highlight, so the words are highlighted first, then the note is written on them.
  await selectPassage(page, ATTENTION, LINES.l11);
  await page.keyboard.press('h');
  const sel = await postNote(page, ATTENTION, LINES.l11, 'Stays when the highlight goes');
  const before = await paintOfSelection(page, sel);
  expect(before.paint.share(tokens.fill[YELLOW]) + before.paint.share(tokens.active[YELLOW]), `the note keeps the highlight under it, in its colour (R68; the darker fill while its card is open): ${describe(before.paint)}`).toBeGreaterThanOrEqual(0.6);
  await selectPassage(page, ATTENTION, LINES.l11);
  await page.keyboard.press('h');
  const p = await paintOfSelection(page, sel, { name: 'highlight-off-comment-stays', testInfo });
  expect(p.paint.share(tokens.fill[YELLOW], 6), 'the highlight is off').toBeLessThan(0.1);
  expect(hasDottedUnderline(p.shot, p.boxes[0], dots), 'and the note shows its dotted underline instead').toBe(true);
  await expect(cardWith(page, 'Stays when the highlight goes'), 'the comment is still there (comments are separate from styles)').toBeVisible();
  await shot(page, testInfo, 'comment-without-highlight');
});

test('Ctrl+Alt+M on a passage that already has a comment opens that thread instead of a second one', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await postNote(page, ATTENTION, LINES.l5, 'The first and only note here');
  await expect(allCards(page)).toHaveCount(1);
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2); // let go of the card
  await clearSelection(page);

  // the same words again
  await selectPassage(page, ATTENTION, LINES.l5);
  await page.keyboard.press('Control+Alt+m');
  await page.waitForTimeout(500);
  await expect(allCards(page), 'no second thread was stacked on the same words').toHaveCount(1);
  await expect(noteBox(page), 'no new-note box opened').toHaveCount(0);
  await expect(activeCards(page), 'the existing thread is open (the active card)').toHaveCount(1);
  await expect(cardWith(page, 'The first and only note here')).toBeVisible();
  await expect(replyBox(page), 'with its reply box ready').toBeVisible();
  await shot(page, testInfo, 'existing-thread-opened');

  // a part of the commented words
  await page.keyboard.press('Escape');
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
  await selectPassage(page, ATTENTION, { from: 'dispensing with', to: 'and convolutions' });
  await page.keyboard.press('Control+Alt+m');
  await page.waitForTimeout(500);
  await expect(allCards(page), 'a selection inside the commented words opens that thread too').toHaveCount(1);
  await expect(noteBox(page)).toHaveCount(0);

  // other words are a new note
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
  await selectPassage(page, ATTENTION, LINES.l9);
  await startNote(page);
  await expect(allCards(page), 'words with no comment get a new one').toHaveCount(2);
});

test('clicking a card makes it light, moves it 12 px left, and darkens its highlight', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  // Triage (tb2marks), R68: a note makes no highlight, so both passages are highlighted first, then the notes written.
  for (const l of [LINES.l3, LINES.l9]) {
    await selectPassage(page, ATTENTION, l);
    await page.keyboard.press('h');
  }
  const a = await postNote(page, ATTENTION, LINES.l3, 'Card A');
  const b = await postNote(page, ATTENTION, LINES.l9, 'Card B');
  const cardA = cardWith(page, 'Card A');
  const cardB = cardWith(page, 'Card B');
  // Card B was made last; click it so that A is the quiet one.
  await cardB.click();
  await expect(cardB).toHaveAttribute('aria-current', 'true');
  await expect(cardA, 'a card that is not clicked is not the active one').not.toHaveAttribute('aria-current', 'true');
  await page.waitForTimeout(400);
  const quiet = await boxOf(cardA);
  const quietColour = await cardA.evaluate((el) => getComputedStyle(el).backgroundColor);
  const quietMark = await paintOfSelection(page, a);
  expect(quietMark.paint.share(tokens.fill[YELLOW]), `A's highlight is the plain colour while A is quiet: ${describe(quietMark.paint)}`).toBeGreaterThanOrEqual(0.6);
  await shot(page, testInfo, 'a-quiet-b-active');

  await cardA.click();
  await page.waitForTimeout(500);
  await expect(cardA, 'the clicked card is the active one').toHaveAttribute('aria-current', 'true');
  await expect(cardB, 'and the one that was active is quiet').not.toHaveAttribute('aria-current', 'true');
  const lit = await boxOf(cardA);
  const litColour = await cardA.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(quiet.left - lit.left, `the active card moves 12 px left (from ${quiet.left.toFixed(1)} to ${lit.left.toFixed(1)})`).toBeGreaterThanOrEqual(8);
  expect(quiet.left - lit.left, 'and not much more than 12').toBeLessThanOrEqual(16);
  expect(luminance(litColour) - luminance(quietColour), `the active card turns light (${quietColour} -> ${litColour})`).toBeGreaterThanOrEqual(80);
  const darker = await paintOfSelection(page, a, { name: 'a-active', testInfo });
  expect(darker.paint.share(tokens.active[YELLOW]), `A's highlight darkens to ${hex(tokens.active[YELLOW])}: ${describe(darker.paint)}`).toBeGreaterThanOrEqual(0.5);
  const bNow = await paintOfSelection(page, b);
  expect(bNow.paint.share(tokens.fill[YELLOW]), "B's highlight went back to the plain colour").toBeGreaterThanOrEqual(0.6);
  await shot(page, testInfo, 'a-active-b-quiet');
});

test('replies stack under the note in the order they were sent; the quiet card says how many; the order survives a reload', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await postNote(page, ATTENTION, LINES.l7, 'The root note');
  const card = cardWith(page, 'The root note');
  await card.click();
  await expect(card).toHaveAttribute('aria-current', 'true');
  for (const reply of ['First reply', 'Second reply']) {
    const box = replyBox(page);
    await expect(box, 'an active card has a reply box').toBeVisible();
    await box.click();
    await page.keyboard.type(reply, { delay: 8 });
    await page.keyboard.press('Enter');
    await expect(cardWith(page, reply), `"${reply}" is in the thread`).toBeVisible({ timeout: 5000 });
  }
  const order = async () =>
    cardWith(page, 'The root note').evaluate((el) => {
      const text = el.textContent ?? '';
      return ['The root note', 'First reply', 'Second reply'].map((s) => text.indexOf(s));
    });
  const inOrder = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));
  expect(inOrder(await order()), `the root, then the first reply, then the second (offsets ${(await order()).join(', ')})`).toBe(true);
  const ys = await Promise.all(['The root note', 'First reply', 'Second reply'].map(async (t) => (await card.getByText(t).first().boundingBox())?.y ?? NaN));
  expect(ys[0] < ys[1] && ys[1] < ys[2], `and they stack top to bottom (y ${ys.map((y) => y.toFixed(0)).join(', ')})`).toBe(true);
  await shot(page, testInfo, 'two-replies');

  // let go of the card: it folds to the note and a count
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
  await page.waitForTimeout(400);
  note(testInfo, 'quiet card with two replies', (await cardWith(page, 'The root note').textContent())?.replace(/\s+/g, ' ').slice(0, 160) ?? '');
  await expect(cardWith(page, 'The root note'), 'a quiet card shows how many replies it has').toContainText(/2 replies/i);

  if (SAVING_AVAILABLE) {
    await waitSaved(page);
    const stored = await waitStored(page, (a) => a.comments.filter((c) => c.deletedAt === null && c.draftOfTab === null).length === 3, 'three comments are stored');
    expect(stored.comments.sort((x, y) => x.createdAt - y.createdAt).map((c) => c.body)).toEqual(['The root note', 'First reply', 'Second reply']);
    await reloadAndWait(page, ATTENTION);
    const again = cardWith(page, 'The root note');
    await expect(again).toBeVisible({ timeout: 10_000 });
    await again.click();
    await expect(again).toHaveAttribute('aria-current', 'true');
    const after = await again.evaluate((el) => {
      const text = el.textContent ?? '';
      return ['The root note', 'First reply', 'Second reply'].map((s) => text.indexOf(s));
    });
    expect(inOrder(after), `after a reload the replies are in the same order (offsets ${after.join(', ')})`).toBe(true);
    await shot(page, testInfo, 'replies-after-reload');
  } else {
    note(testInfo, 'skipped part', `reload: ${NO_SAVING}`);
  }
});

// Regression (TB4 code-security critic, finding 2; no lost text): a layout change never closes or unfocuses an open note box.
// Rotating (Ctrl+]) or zooming in (Ctrl+=) while typing folds the margin cards; the box moves into the notes panel with its
// text and its caret, and the letters typed straight after the key land in the note. The repro is the critic's p2/p3 run.
for (const [key, what] of [['Control+]', 'rotating'], ['Control+=', 'zooming in']] as const) {
  test(`${what} while typing a note keeps the box, its text and the caret: the next letters land in the note`, async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await selectPassage(page, ATTENTION, LINES.l3);
    await startNote(page);
    await page.keyboard.type('half a thought', { delay: 10 });
    await page.keyboard.press(key);
    await page.keyboard.type(' MORE', { delay: 10 });
    const moved = noteBox(page);
    await expect.poll(async () => (await moved.count()) === 1 && (await readBox(moved)).text, { message: `after ${key} the note box is still there with all the text` }).toBe('half a thought MORE');
    expect((await readBox(moved)).focused, `and it still has the keyboard after ${key}`).toBe(true);
    await shot(page, testInfo, `${what.replace(' ', '-')}-box-kept`);

    await page.keyboard.press('Enter');
    await expect(page.getByText('half a thought MORE').first(), 'Enter sends the whole note').toBeVisible({ timeout: 5000 });
    await expect(noteBox(page), 'and the new-note box closes').toHaveCount(0);
    if (SAVING_AVAILABLE) {
      await waitSaved(page);
      await waitStored(page, (a) => a.comments.some((c) => c.body === 'half a thought MORE' && c.draftOfTab === null && c.deletedAt === null), 'the whole note is stored');
    }
  });
}
