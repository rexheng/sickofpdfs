// Gate 1, Phase 2 plan section 4, item 2: "The keys."
//   "H, Ctrl+U, Ctrl+B and Alt+Shift+5 each apply a style; pressing one again removes it. Toggling a style off in the middle of a
//    mark splits the mark. Highlight and underline can share text. With a mark focused, 1-5 recolour it and Delete removes it.
//    Ctrl+Z and Ctrl+Y undo and redo. Ctrl+U with nothing selected does nothing."
// Spec, Shortcuts table: "Highlight / underline / bold / strikethrough: H / Ctrl+U / Ctrl+B / Alt+Shift+5, when text is selected";
// "Move between marks: Tab / Shift+Tab, a mark is focused"; "Recolour / delete: 1 to 5 / Delete, a mark is focused"; "Undo / redo:
// Ctrl+Z / Ctrl+Y". "Ctrl+U only acts when text is selected." Marks: "One passage can carry several styles at once, such as highlight
// plus underline. Applying a style that already covers the whole selection removes it from that selection, splitting the mark if
// needed." Contracts section 2: "Applying a style puts it on the whole target and joins it with every same-colour mark the target
// overlaps or touches into one row."
//
// GUESSES (the spec is silent): whether the page's selection is still there after a mark is applied (the walkthrough selects again
// when it is not, and notes which it was); how a mark gets focus (the walkthrough clicks it, and then tries Tab); where an
// underline sits (in the lower part of the line, or just under it) and a strike (through the middle).
import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  SAVING_AVAILABLE,
  allCards,
  anyBox,
  clearSelection,
  describe,
  ensureSelected,
  focusInfo,
  hex,
  isPlain,
  lineBoxes,
  lineColours,
  markMenu,
  markTokens,
  note,
  openPaper,
  paintOfSelection,
  phraseBoxes,
  selectPassage,
  strokesOf,
  waitSaved,
  waitStored,
  watchKeys,
  grab,
  paintOf,
  reloadAndWait,
  type Selected,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(120_000);

const YELLOW = 0;

/** Press a key combination on the selected words (selecting them again if the page let go of them). */
async function apply(page: Page, sel: Selected, keys: string, testInfo: Parameters<typeof note>[0]): Promise<void> {
  const survived = await ensureSelected(page, sel);
  if (!survived) note(testInfo, 'selection after a mark', 'was let go of, so the walkthrough selected the words again');
  await page.keyboard.press(keys);
}

test('Mark keys: H, Ctrl+U, Alt+Shift+5 and Ctrl+B put marks on and take them off, also two on the same words', async ({ step }, testInfo) => {
  test.setTimeout(600_000);
  await step('H highlights the selection in the default colour; H again takes the highlight off', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const sel = await selectPassage(page, ATTENTION, LINES.l3);
    const plain = await paintOfSelection(page, sel);
    expect(isPlain(plain.paint)).toBe(true);

    await apply(page, sel, 'h', testInfo);
    const on = await paintOfSelection(page, sel, { name: 'h-on', testInfo });
    expect(on.paint.share(tokens.fill[YELLOW]), `H highlights in yellow, the default colour (${hex(tokens.fill[YELLOW])}): ${describe(on.paint)}`).toBeGreaterThanOrEqual(0.6);

    await apply(page, sel, 'h', testInfo);
    const off = await paintOfSelection(page, sel, { name: 'h-off', testInfo });
    expect(isPlain(off.paint), `H again removes it: ${describe(off.paint)}`).toBe(true);
    expect(Math.abs(off.paint.ink - plain.paint.ink) / plain.paint.ink, 'and the page is as it was').toBeLessThan(0.01);
  }, 120_000);
  await step('Ctrl+U underlines in a line under the words; Ctrl+U again removes it', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const sel = await selectPassage(page, ATTENTION, LINES.l5);
    await clearSelection(page);

    await apply(page, sel, 'Control+u', testInfo);
    const on = await paintOfSelection(page, sel, { name: 'ctrl-u-on', testInfo });
    const rows = strokesOf(on.shot, on.boxes[0], lineColours(tokens.line[YELLOW])).rows;
    expect(rows.length, `an underline in the line colour ${hex(tokens.line[YELLOW])} runs along the words`).toBeGreaterThan(0);
    expect(Math.min(...rows), 'the underline is in the lower part of the line, not through the middle').toBeGreaterThanOrEqual(0.6);
    expect(on.paint.share(tokens.fill[YELLOW], 6), 'an underline does not fill the line').toBeLessThan(0.2);
    expect(on.paint.ink, 'the words are still there').toBeGreaterThan(0);

    await apply(page, sel, 'Control+u', testInfo);
    const off = await paintOfSelection(page, sel, { name: 'ctrl-u-off', testInfo });
    expect(strokesOf(off.shot, off.boxes[0], lineColours(tokens.line[YELLOW])).rows, 'Ctrl+U again removes the underline').toEqual([]);
  }, 120_000);
  await step('Alt+Shift+5 strikes through the words; Alt+Shift+5 again removes it', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const sel = await selectPassage(page, ATTENTION, LINES.l7);
    await clearSelection(page);

    await apply(page, sel, 'Alt+Shift+5', testInfo);
    const on = await paintOfSelection(page, sel, { name: 'strike-on', testInfo });
    // Triage (TB2): the strike runs behind the black text (the mark layer multiplies, so text stays black), so only the
    // gaps between letters show the line colour: a quarter of the row is the bar, not half.
    const rows = strokesOf(on.shot, on.boxes[0], lineColours(tokens.line[YELLOW]), { above: 0, below: 0, cover: 0.2 }).rows;
    expect(rows.length, `a line in the line colour ${hex(tokens.line[YELLOW])} runs through the words`).toBeGreaterThan(0);
    expect(rows.every((r) => r >= 0.2 && r <= 0.8), `the strike is through the middle of the line: rows at ${rows.map((r) => r.toFixed(2)).join(', ')}`).toBe(true);

    await apply(page, sel, 'Alt+Shift+5', testInfo);
    const off = await paintOfSelection(page, sel, { name: 'strike-off', testInfo });
    expect(strokesOf(off.shot, off.boxes[0], lineColours(tokens.line[YELLOW]), { above: 0, below: 0, cover: 0.2 }).rows, 'Alt+Shift+5 again removes the strike').toEqual([]);
  }, 120_000);
  await step('Ctrl+B makes the words bold, drawn from their own outlines (heavier ink, same place); Ctrl+B again takes it off', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const sel = await selectPassage(page, ATTENTION, LINES.l9);
    const plain = await paintOfSelection(page, sel);

    await apply(page, sel, 'Control+b', testInfo);
    const on = await paintOfSelection(page, sel, { name: 'bold-on', testInfo });
    expect(on.paint.darkness, `bold ink is heavier: ${plain.paint.darkness.toFixed(0)} black px before, ${on.paint.darkness.toFixed(0)} after`).toBeGreaterThanOrEqual(plain.paint.darkness * 1.03);
    expect(on.paint.darkness, 'but it is the same words, not a smear').toBeLessThanOrEqual(plain.paint.darkness * 2);
    expect(on.paint.neutral, 'bold has no colour').toBeGreaterThanOrEqual(0.97);

    await apply(page, sel, 'Control+b', testInfo);
    const off = await paintOfSelection(page, sel, { name: 'bold-off', testInfo });
    expect(Math.abs(off.paint.darkness - plain.paint.darkness) / plain.paint.darkness, 'Ctrl+B again takes the bold off').toBeLessThan(0.01);
  }, 120_000);
  await step('highlight and underline can share the same words, and each can be taken off on its own', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const sel = await selectPassage(page, ATTENTION, LINES.l1);
    await apply(page, sel, 'h', testInfo);
    await apply(page, sel, 'Control+u', testInfo);
    const both = await paintOfSelection(page, sel, { name: 'highlight-and-underline', testInfo });
    const lineHere = lineColours(tokens.line[YELLOW], tokens.fill[YELLOW]);
    expect(both.paint.share(tokens.fill[YELLOW]), `the words are highlighted: ${describe(both.paint)}`).toBeGreaterThanOrEqual(0.5);
    expect(strokesOf(both.shot, both.boxes[0], lineHere).rows.length, 'and underlined').toBeGreaterThan(0);

    // take the highlight off: the underline stays
    await apply(page, sel, 'h', testInfo);
    const underOnly = await paintOfSelection(page, sel, { name: 'underline-only', testInfo });
    expect(underOnly.paint.share(tokens.fill[YELLOW], 6), 'the highlight is gone').toBeLessThan(0.1);
    expect(strokesOf(underOnly.shot, underOnly.boxes[0], lineColours(tokens.line[YELLOW])).rows.length, 'the underline stays').toBeGreaterThan(0);

    // put the highlight back and take the underline off: the highlight stays
    await apply(page, sel, 'h', testInfo);
    await apply(page, sel, 'Control+u', testInfo);
    const fillOnly = await paintOfSelection(page, sel, { name: 'highlight-only', testInfo });
    expect(fillOnly.paint.share(tokens.fill[YELLOW]), 'the highlight is back').toBeGreaterThanOrEqual(0.6);
    expect(strokesOf(fillOnly.shot, fillOnly.boxes[0], lineHere).rows, 'and the underline is gone').toEqual([]);
  }, 120_000);
});

test('Mark keys: splitting and extending a mark, recolouring by keys, undo and redo, nothing selected, and marks after a reload', async ({ step }, testInfo) => {
  test.setTimeout(720_000);
  await step('toggling a style off in the middle of a mark splits it: the two ends stay highlighted', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const whole = await selectPassage(page, ATTENTION, LINES.l1);
    await apply(page, whole, 'h', testInfo);

    const middle = await selectPassage(page, ATTENTION, { from: 'transduction models are', to: 'on complex' });
    await page.keyboard.press('h');
    await clearSelection(page);
    const shotNow = await grab(page, 'split-in-the-middle', testInfo);
    const left = paintOf(shotNow, await phraseBoxes(page, ATTENTION, { from: 'The dominant', to: 'sequence' }));
    const mid = paintOf(shotNow, await phraseBoxes(page, ATTENTION, { from: 'transduction models are', to: 'on complex' }));
    // Triage (TB2): 'or' alone matched an earlier "or" on the page (an empty box); the phrase is named whole.
    const right = paintOf(shotNow, await phraseBoxes(page, ATTENTION, { from: 'recurrent', to: 'recurrent or' }));
    expect(left.share(tokens.fill[YELLOW]), `the left end is still highlighted: ${describe(left)}`).toBeGreaterThanOrEqual(0.6);
    expect(isPlain(mid), `the middle has lost its highlight: ${describe(mid)}`).toBe(true);
    // Triage (TB2): "recurrent or" has only x-height letters, so its tight glyph box is half anti-aliased letter edge; the
    // end counts as highlighted when the highlight is its paper colour.
    expect(Math.max(...right.dominant.map((v, i) => Math.abs(v - tokens.fill[YELLOW][i]))), `the right end is still highlighted: ${describe(right)}`).toBeLessThanOrEqual(8);

    if (SAVING_AVAILABLE) {
      await waitSaved(page);
      const stored = await waitStored(page, (a) => a.marks.filter((m) => m.style === 'highlight' && m.deletedAt === null).length === 2, 'the library holds two highlight marks after the split');
      expect(stored.marks.filter((m) => m.style === 'highlight' && m.deletedAt === null)).toHaveLength(2);
    }

    // highlighting the middle again joins the three pieces into one
    await ensureSelected(page, middle);
    await page.keyboard.press('h');
    const joined = await paintOfSelection(page, whole, { name: 'joined-again', testInfo });
    expect(joined.paint.share(tokens.fill[YELLOW]), `highlighting the gap joins the pieces: ${describe(joined.paint)}`).toBeGreaterThanOrEqual(0.6);
    if (SAVING_AVAILABLE) {
      await waitStored(page, (a) => a.marks.filter((m) => m.style === 'highlight' && m.deletedAt === null).length === 1, 'the pieces are one mark again');
    }
  }, 120_000);
  await step('highlighting a line that is part highlighted already covers the whole line', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const whole = await selectPassage(page, ATTENTION, LINES.l3);
    const part = await selectPassage(page, ATTENTION, { from: 'performing models also', to: 'decoder through' });
    await page.keyboard.press('h');
    await clearSelection(page);
    const halfShot = await grab(page);
    const tail = paintOf(halfShot, await phraseBoxes(page, ATTENTION, { from: 'an attention', to: 'an attention' }));
    expect(isPlain(tail), 'only the first part is highlighted so far').toBe(true);
    void part;

    await apply(page, whole, 'h', testInfo);
    const now = await paintOfSelection(page, whole, { name: 'whole-line', testInfo });
    expect(now.paint.share(tokens.fill[YELLOW]), `the whole line is highlighted (it is not toggled off): ${describe(now.paint)}`).toBeGreaterThanOrEqual(0.6);
  }, 120_000);
  await step('with a mark focused, 1 to 5 recolour it, Tab moves to the next mark, and Delete removes it', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const a = await selectPassage(page, ATTENTION, LINES.l3);
    await page.keyboard.press('h');
    const b = await selectPassage(page, ATTENTION, LINES.l7);
    await page.keyboard.press('h');
    await clearSelection(page);

    // Focus the first mark. The spec names no way in; the owner clicks it, and then Tab walks from the page into the marks.
    let how: string | null = null;
    const boxes = await lineBoxes(page, a);
    await page.mouse.click((boxes[0].left + boxes[0].right) / 2, (boxes[0].top + boxes[0].bottom) / 2);
    let focus = await focusInfo(page);
    if (focus.inMarkLayer) how = 'a click on the marked words';
    for (let i = 0; how === null && i < 3; i++) {
      await page.keyboard.press('Tab');
      focus = await focusInfo(page);
      if (focus.inMarkLayer) how = `Tab (${i + 1} presses after a click)`;
    }
    note(testInfo, 'how a mark got focus', how ?? `not found (focus is on ${JSON.stringify(focus)})`);
    expect(how, 'a mark can be focused, by clicking the marked words or by Tab: the shortcuts "1 to 5" and "Delete" apply to "a focused mark"').not.toBeNull();
    const firstFocus = await focusInfo(page);
    await shot(page, testInfo, 'first-mark-focused');

    await page.keyboard.press('3');
    const blue = await paintOfSelection(page, a, { name: 'recoloured-blue' , testInfo });
    expect(blue.paint.share(tokens.fill[2]), `1 to 5 recolour the focused mark: 3 is blue: ${describe(blue.paint)}`).toBeGreaterThanOrEqual(0.5);
    const other = await paintOfSelection(page, b);
    expect(other.paint.share(tokens.fill[YELLOW]), 'the other mark is not touched').toBeGreaterThanOrEqual(0.6);

    await page.keyboard.press('Tab');
    const second = await focusInfo(page);
    expect(second.inMarkLayer, `Tab moves to the next mark (focus: ${JSON.stringify(second)})`).toBe(true);
    expect(second.id, 'and it is another mark').not.toBe(firstFocus.id);
    await page.keyboard.press('4');
    const pink = await paintOfSelection(page, b);
    expect(pink.paint.share(tokens.fill[3]), `4 recolours the second mark pink: ${describe(pink.paint)}`).toBeGreaterThanOrEqual(0.5);

    await page.keyboard.press('Shift+Tab');
    expect((await focusInfo(page)).id, 'Shift+Tab goes back to the first mark').toBe(firstFocus.id);
    await page.keyboard.press('Delete');
    const gone = await paintOfSelection(page, a, { name: 'deleted', testInfo });
    expect(isPlain(gone.paint), `Delete removes the focused mark: ${describe(gone.paint)}`).toBe(true);
    const kept = await paintOfSelection(page, b);
    expect(kept.paint.share(tokens.fill[3]), 'and only that mark').toBeGreaterThanOrEqual(0.5);
  }, 120_000);
  await step('Ctrl+Z undoes, Ctrl+Y redoes, one step at a time', async ({ openViewer, server }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const sel = await selectPassage(page, ATTENTION, LINES.l9);
    await apply(page, sel, 'h', testInfo);
    await apply(page, sel, 'Control+u', testInfo);
    await clearSelection(page);
    const fillOn = (p: Awaited<ReturnType<typeof paintOfSelection>>) => p.paint.share(tokens.fill[YELLOW]) >= 0.5;
    const underlined = (p: Awaited<ReturnType<typeof paintOfSelection>>) => strokesOf(p.shot, p.boxes[0], lineColours(tokens.line[YELLOW], tokens.fill[YELLOW])).rows.length > 0;
    let now = await paintOfSelection(page, sel);
    expect([fillOn(now), underlined(now)], 'highlight and underline are on').toEqual([true, true]);

    await page.keyboard.press('Control+z');
    now = await paintOfSelection(page, sel, { name: 'undo-1', testInfo });
    expect([fillOn(now), underlined(now)], 'Ctrl+Z takes off the last thing done: the underline').toEqual([true, false]);
    await page.keyboard.press('Control+z');
    now = await paintOfSelection(page, sel, { name: 'undo-2', testInfo });
    expect(isPlain(now.paint), 'Ctrl+Z again takes off the highlight').toBe(true);
    await page.keyboard.press('Control+y');
    now = await paintOfSelection(page, sel, { name: 'redo-1', testInfo });
    expect([fillOn(now), underlined(now)], 'Ctrl+Y puts the highlight back').toEqual([true, false]);
    await page.keyboard.press('Control+y');
    now = await paintOfSelection(page, sel, { name: 'redo-2', testInfo });
    expect([fillOn(now), underlined(now)], 'Ctrl+Y again puts the underline back').toEqual([true, true]);
  }, 120_000);
  await step('with nothing selected, H, Ctrl+U, Ctrl+B and Alt+Shift+5 do nothing, and Ctrl+U and Ctrl+B leave Chrome alone', async ({ openViewer, server, context }) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const sel = await selectPassage(page, ATTENTION, LINES.l3);
    const before = await paintOfSelection(page, sel); // this lets go of the selection
    expect(await page.evaluate(() => String(getSelection() ?? ''))).toBe('');
    const pagesBefore = context.pages().length;
    const read = await watchKeys(page);
    for (const keys of ['h', 'Control+u', 'Control+b', 'Alt+Shift+5']) await page.keyboard.press(keys);
    const events = await read();
    await page.waitForTimeout(500);
    const after = await paintOfSelection(page, sel, { name: 'nothing-selected-nothing-happens', testInfo });
    expect(isPlain(after.paint), `nothing was marked: ${describe(after.paint)}`).toBe(true);
    expect(Math.abs(after.paint.ink - before.paint.ink) / before.paint.ink, 'and the page is unchanged').toBeLessThan(0.01);
    const ctrl = events.filter((e) => e.key.toLowerCase() === 'u' || e.key.toLowerCase() === 'b');
    expect(ctrl.length).toBe(2);
    // Triage (TB2), controller ruling: Ctrl+U with nothing selected does nothing in the viewer and never opens view-source,
    // so the viewer always takes it; Ctrl+B is left to Chrome when nothing is selected (plan section 7).
    expect(ctrl.map((e) => e.prevented), 'Ctrl+U is always the viewer\'s (it never opens view-source); Ctrl+B is left to Chrome with nothing selected').toEqual([true, false]);
    expect(context.pages().length, 'no tab was opened (Ctrl+U is view-source in Chrome)').toBe(pagesBefore);
    await expect(markMenu(page)).toHaveCount(0);
    await expect(anyBox(page)).toHaveCount(0);
    await expect(allCards(page)).toHaveCount(0);
  }, 120_000);
  await step('the marks of a saved paper are still on the same words after a reload (a highlight, an underline, a strike)', async ({ openViewer, server }) => {
    if (!SAVING_AVAILABLE) {
      testInfo.annotations.push({ type: 'step skipped', description: 'needs the save decision (Task 30): apps/extension/src/viewer/save/ does not exist yet' });
      return;
    }
    const page = await openPaper(openViewer, server, ATTENTION);
    const tokens = await markTokens(page);
    const l1 = await selectPassage(page, ATTENTION, LINES.l1);
    await page.keyboard.press('h');
    // Triage (TB2): Task 30's stand-in filter calls every PDF "Not sure" until Phase 3, so the first mark is what saves it.
    await waitSaved(page);
    const l5 = await selectPassage(page, ATTENTION, LINES.l5);
    await page.keyboard.press('Control+u');
    const l9 = await selectPassage(page, ATTENTION, LINES.l9);
    await page.keyboard.press('Alt+Shift+5');
    await waitStored(page, (a) => a.marks.filter((m) => m.deletedAt === null).length === 3, 'three marks are stored');
    await reloadAndWait(page, ATTENTION);
    const one = await paintOfSelection(page, l1, { name: 'reloaded-highlight', testInfo });
    expect(one.paint.share(tokens.fill[YELLOW]), `the highlight is back: ${describe(one.paint)}`).toBeGreaterThanOrEqual(0.6);
    const two = await paintOfSelection(page, l5);
    expect(strokesOf(two.shot, two.boxes[0], lineColours(tokens.line[YELLOW])).rows.length, 'the underline is back').toBeGreaterThan(0);
    const three = await paintOfSelection(page, l9);
    // Triage (TB2): the strike runs behind the black text (see the strike test).
    expect(strokesOf(three.shot, three.boxes[0], lineColours(tokens.line[YELLOW]), { above: 0, below: 0, cover: 0.2 }).rows.length, 'the strike is back').toBeGreaterThan(0);
  }, 120_000);
});
