// Gate 1, Phase 2 plan section 4, item 1: "The menu."
//   "Select a sentence, right-click and pick green: the sentence is highlighted, and it is still highlighted after a reload.
//    Selecting text alone opens nothing. Right-clicking with no selection, or Shift+right-clicking, shows Chrome's menu."
// Spec ("Viewer and commenting", Marks): "Select text, then right-click: a small menu opens at the pointer with highlight (with
// colour), underline, bold, strikethrough, comment, Ask Claude, Search and copy. ... Nothing pops up on its own while you read.
// ... The keyboard's menu key and Shift+F10 open the menu too, and Shift+right-click shows Chrome's usual menu."
// Plan S13: "The menu opens only after a selection ... Ask Claude stays hidden until P4." "The last colour used is remembered
// (marks.lastColor). It is the colour that H and the menu use next."
//
// How the walkthrough sees things (the spec names no markup, so it looks at what the owner sees):
//   - the menu is a `role=menu` with `menuitem` rows; the colours are `menuitemradio` rows named Yellow, Green, Blue, Pink, Orange
//     (the shared UI kit's ContextMenu and ColorSwatches);
//   - a highlight is the colour of the page under the selected words: the screenshot is judged against the colour tokens
//     --sop-mark-N, after the selection is let go of so that its blue wash does not count.
import { expect, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  NO_SAVING,
  SAVING_AVAILABLE,
  SENTENCE_1,
  SLOT_NAMES,
  allCards,
  anyBox,
  boxOf,
  clearSelection,
  describe,
  ensureSelected,
  hex,
  highlightFromMenu,
  isPlain,
  markMenu,
  markTokens,
  menuRow,
  openPaper,
  paintOf,
  paintOfSelection,
  reloadAndWait,
  rightClickAt,
  rightClickSelection,
  selectPassage,
  stillNothing,
  swatch,
  waitSaved,
  waitStored,
  watchContextMenu,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';
import { squash } from '../support/tl-copy.spec-blind';
import { dragClient, openClipboardReader, th } from '../support/tl-blind.spec-blind';

test.setTimeout(120_000);

const collapse = (s: string): string => s.replace(/\s+/gu, ' ').trim();

test('select a sentence, right-click, pick green: the sentence is highlighted green and the text is still readable', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const sel = await selectPassage(page, ATTENTION, SENTENCE_1);
  const before = await paintOfSelection(page, sel);
  expect(isPlain(before.paint), `before any mark the page is plain: ${describe(before.paint)}`).toBe(true);
  await ensureSelected(page, sel);

  // Selecting alone opens nothing.
  await stillNothing(page, 'after selecting a sentence');
  await shot(page, testInfo, 'selected-nothing-opened');

  // Right-click on the words: the menu opens AT THE POINTER.
  const pointer = await rightClickSelection(page, sel);
  const menu = markMenu(page);
  await expect(menu, 'right-clicking selected text opens the mark-up menu').toBeVisible({ timeout: 3000 });
  const m = await boxOf(menu);
  const gapX = Math.max(m.left - pointer.x, pointer.x - m.right, 0);
  const gapY = Math.max(m.top - pointer.y, pointer.y - m.bottom, 0);
  expect(Math.hypot(gapX, gapY), `the menu opens at the pointer (${pointer.x.toFixed(0)}, ${pointer.y.toFixed(0)}); its box is ${m.left.toFixed(0)},${m.top.toFixed(0)} to ${m.right.toFixed(0)},${m.bottom.toFixed(0)}`).toBeLessThanOrEqual(24);
  for (const [label, name] of [['Highlight', /highlight/i], ['Underline', /underline/i], ['Bold', /bold/i], ['Strikethrough', /strike/i], ['Comment', /comment/i], ['Search', /search/i], ['Copy', /copy/i]] as const) {
    await expect(menuRow(page, name).first(), `the menu has ${label}`).toBeVisible();
  }
  for (const colour of SLOT_NAMES) await expect(swatch(page, colour), `the menu has the colour ${colour}`).toBeVisible();
  await expect(menuRow(page, /ask claude/i), 'Ask Claude stays hidden until Phase 4').toHaveCount(0);
  await shot(page, testInfo, 'menu-open');

  await swatch(page, 'green').click();
  await expect(menu, 'choosing a colour closes the menu').toBeHidden();

  const after = await paintOfSelection(page, sel, { name: 'sentence-highlighted-green', testInfo });
  expect(after.paint.share(tokens.fill[1]), `the sentence is green (${hex(tokens.fill[1])}): ${describe(after.paint)}`).toBeGreaterThanOrEqual(0.6);
  expect(after.boxes.length, 'the sentence runs over two lines, and both are highlighted').toBe(2);
  for (const [i, box] of after.boxes.entries()) {
    const line = paintOf(after.shot, [box]);
    expect(line.share(tokens.fill[1]), `line ${i + 1} of the sentence is green: ${describe(line)}`).toBeGreaterThanOrEqual(0.6);
  }
  expect(after.paint.ink, 'the words are still readable: a highlight sits under the ink, it does not cover it').toBeGreaterThanOrEqual(before.paint.ink * 0.95);

  // Another passage, further down, is untouched.
  const other = await selectPassage(page, ATTENTION, LINES.l9);
  expect(isPlain((await paintOfSelection(page, other)).paint), 'only the selected sentence is highlighted').toBe(true);
  await shot(page, testInfo, 'end');
});

test('the highlight is still there after a reload, on the same words', async ({ openViewer, server }, testInfo) => {
  test.skip(!SAVING_AVAILABLE, NO_SAVING);
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const sel = await selectPassage(page, ATTENTION, SENTENCE_1);
  await highlightFromMenu(page, sel, 'green');
  // Triage (TB2): Task 30's stand-in filter calls every PDF "Not sure" until Phase 3, so the first mark is what saves it.
  await waitSaved(page);
  const stored = await waitStored(page, (a) => a.marks.some((r) => r.style === 'highlight' && r.deletedAt === null), 'the highlight is written to the library');
  const row = stored.marks.find((r) => r.style === 'highlight')!;
  expect(row.color, 'green is colour slot 2').toBe(2);
  // Triage (TB2): contracts section 2 names the TextQuoteSelector's exact text `quote.quote`.
  expect(collapse(row.anchor.quote?.quote ?? ''), 'the mark remembers the words it is on').toBe(collapse(sel.text));

  await reloadAndWait(page, ATTENTION);
  const after = await paintOfSelection(page, sel, { name: 'after-reload', testInfo });
  expect(after.paint.share(tokens.fill[1]), `still green on the same words after a reload: ${describe(after.paint)}`).toBeGreaterThanOrEqual(0.6);
  await shot(page, testInfo, 'after-reload');
});

test('selecting text alone opens nothing: not by drag, not by double-click, not by triple-click, not after a pause', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l3);
  await stillNothing(page, 'after a drag', 1200);
  await shot(page, testInfo, 'after-drag');

  // double-click a word, triple-click a paragraph
  await clearSelection(page);
  const word = await th(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: 0, i: sel.a + 4 });
  await page.mouse.dblclick(word.x, word.y);
  expect((await page.evaluate(() => String(getSelection() ?? ''))).length, 'a double-click selects a word').toBeGreaterThan(0);
  await stillNothing(page, 'after a double-click', 900);
  await page.mouse.click(word.x, word.y, { clickCount: 3 });
  await stillNothing(page, 'after a triple-click', 900);

  // moving the pointer over the selection (hover) opens nothing either
  await dragClient(page, { x: word.x, y: word.y }, { x: word.x + 120, y: word.y }, 4);
  await page.mouse.move(word.x + 60, word.y + 2);
  await stillNothing(page, 'while hovering over a selection', 900);
  await shot(page, testInfo, 'hovering');
});

test("right-click with no selection, or Shift+right-click, shows Chrome's own menu; a plain right-click on a selection shows ours", async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l5);
  const point = await th(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: 0, i: Math.floor((sel.a + sel.b) / 2) });

  // 1. nothing selected
  await clearSelection(page);
  let read = await watchContextMenu(page);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  let seen = await read();
  expect(seen.seen, 'the page got the right-click').toBe(1);
  expect(seen.prevented, "with nothing selected the page lets Chrome's own menu open (the right-click is not cancelled)").toBe(false);
  await expect(markMenu(page), 'with nothing selected our menu is not shown').toHaveCount(0);
  await page.keyboard.press('Escape');
  await shot(page, testInfo, 'right-click-nothing-selected');

  // 2. text selected, Shift held
  await selectPassage(page, ATTENTION, LINES.l5);
  read = await watchContextMenu(page);
  await rightClickAt(page, point, { shift: true });
  seen = await read();
  expect(seen.seen).toBe(1);
  expect(seen.prevented, "Shift+right-click shows Chrome's usual menu").toBe(false);
  await expect(markMenu(page), 'Shift+right-click does not show ours').toHaveCount(0);
  await page.keyboard.press('Escape');

  // 3. the contrast: text selected, plain right-click
  await selectPassage(page, ATTENTION, LINES.l5);
  read = await watchContextMenu(page);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  seen = await read();
  expect(seen.prevented, 'a plain right-click on selected text is ours: Chrome does not also open its menu').toBe(true);
  await expect(markMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(markMenu(page), 'Esc closes the menu').toBeHidden();
  expect((await page.evaluate(() => String(getSelection() ?? ''))).length, 'the selection survives the menu').toBeGreaterThan(0);
});

test('the menu key and Shift+F10 open the same menu on a selection, and Esc closes it without losing the selection', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l7);
  for (const key of ['ContextMenu', 'Shift+F10']) {
    await page.keyboard.press(key);
    await expect(markMenu(page), `${key} opens the mark-up menu`).toBeVisible({ timeout: 3000 });
    await expect(menuRow(page, /highlight/i).first()).toBeVisible();
    await expect(swatch(page, 'green')).toBeVisible();
    await shot(page, testInfo, `menu-by-${key.replace(/\W/g, '')}`);
    await page.keyboard.press('Escape');
    await expect(markMenu(page), 'Esc closes it').toBeHidden();
    expect((await page.evaluate(() => String(getSelection() ?? ''))).length, 'the selection is kept').toBeGreaterThan(0);
  }
  // With nothing selected the menu key does not open our menu.
  await clearSelection(page);
  await page.keyboard.press('Shift+F10');
  await page.waitForTimeout(400);
  await expect(markMenu(page), 'no selection, no mark-up menu').toHaveCount(0);
  void sel;
});

test('all five colours: the menu paints each one, and 1 to 5 pick a colour from inside the open menu', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const lines = [LINES.l1, LINES.l3, LINES.l5, LINES.l7, LINES.l9] as const;
  const picked = [] as Awaited<ReturnType<typeof selectPassage>>[];
  for (const [i, line] of lines.entries()) {
    const sel = await selectPassage(page, ATTENTION, line);
    picked.push(sel);
    if (i === 2) {
      // blue, by the number key inside the open menu
      await rightClickSelection(page, sel);
      await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
      await page.keyboard.press('3');
      await expect(markMenu(page), 'a number key picks the colour and closes the menu').toBeHidden();
    } else {
      await highlightFromMenu(page, sel, SLOT_NAMES[i]);
    }
  }
  const all = await paintOfSelection(page, picked[0], { name: 'five-colours', testInfo });
  void all;
  for (const [i, sel] of picked.entries()) {
    const p = (await paintOfSelection(page, sel)).paint;
    expect(p.share(tokens.fill[i]), `line ${i + 1} is ${SLOT_NAMES[i]} (${hex(tokens.fill[i])}): ${describe(p)}`).toBeGreaterThanOrEqual(0.6);
    for (let k = 0; k < 5; k++) if (k !== i) expect(p.share(tokens.fill[k], 6), `line ${i + 1} is not ${SLOT_NAMES[k]}`).toBeLessThan(0.3);
  }
  await shot(page, testInfo, 'five-colours-all');
});

test('the colour you picked last is the one H and the menu use next', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const first = await selectPassage(page, ATTENTION, LINES.l1);
  await highlightFromMenu(page, first, 'orange');

  // H on the next line uses orange, not the default yellow
  const second = await selectPassage(page, ATTENTION, LINES.l3);
  await page.keyboard.press('h');
  const viaKey = (await paintOfSelection(page, second, { name: 'h-uses-last-colour', testInfo })).paint;
  expect(viaKey.share(tokens.fill[4]), `H uses the last colour, orange: ${describe(viaKey)}`).toBeGreaterThanOrEqual(0.6);

  // the menu shows orange as the current colour, and its Highlight row uses it too
  const third = await selectPassage(page, ATTENTION, LINES.l5);
  await rightClickSelection(page, third);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  await expect(swatch(page, 'orange'), 'the current colour is checked in the menu').toHaveAttribute('aria-checked', 'true');
  await menuRow(page, /highlight/i).first().click();
  await expect(markMenu(page)).toBeHidden();
  const viaRow = (await paintOfSelection(page, third)).paint;
  expect(viaRow.share(tokens.fill[4]), `the menu's Highlight row uses the last colour: ${describe(viaRow)}`).toBeGreaterThanOrEqual(0.6);
});

test('Copy in the menu puts the selected words on the clipboard', async ({ openViewer, server, context }, testInfo) => {
  const reader = await openClipboardReader(context, server);
  const page = await openPaper(openViewer, server, ATTENTION);
  const sel = await selectPassage(page, ATTENTION, LINES.l9);
  await reader.clear();
  await page.bringToFront();
  await rightClickSelection(page, sel);
  await expect(markMenu(page)).toBeVisible({ timeout: 3000 });
  await menuRow(page, /^copy/i).click();
  await expect(markMenu(page)).toBeHidden();
  await page.waitForTimeout(200);
  const copied = await reader.read();
  await page.bringToFront();
  expect(squash(copied), `the clipboard holds the selected words: ${JSON.stringify(copied)}`).toBe(squash(sel.text));
  await shot(page, testInfo, 'after-copy');
  expect(await anyBox(page).count(), 'copying opens no note').toBe(0);
  expect(await allCards(page).count()).toBe(0);
});
