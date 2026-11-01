// Gate 1, Phase 2 plan section 4, item 6: "Typing is safe."
//   "In the note box, H, 1-5, Delete and Ctrl+Alt+M never touch marks, and Ctrl+B formats the text. Simulated German and Polish
//    AltGr keys type their characters."
// Spec, Shortcuts: "Single-key and Ctrl+Alt shortcuts never fire while you are typing, because on some keyboards Ctrl+Alt is AltGr.
// Letters and symbols are matched by the character they type ... only the number row (Alt+Shift+5, 1 to 5) is matched by position."
// Writing a note: "Type plain text or light Markdown (Ctrl+B and Ctrl+I format the note)." "Undo / redo: Ctrl+Z / Ctrl+Y, Reading (the
// note box keeps its own undo)."
//
// An AltGr key is simulated the way Windows reports it: a keydown with Ctrl and Alt down that names the character (key "ł", code KeyL),
// followed by the browser inserting that character unless the page cancelled the keydown (see altGr() in support/marks.spec-blind.ts).
// A box that cancels the keydown, or a shortcut that takes it, leaves the character out and fails the test.
import { expect, test } from '../support/test';
import {
  ATTENTION,
  LINES,
  allCards,
  altGr,
  anyBox,
  cardWith,
  describe,
  focusInfo,
  isPlain,
  lineBoxes,
  lineColours,
  markMenu,
  markTokens,
  noteBox,
  note,
  openPaper,
  paintOfSelection,
  readBox,
  replyBox,
  selectPassage,
  startNote,
  strokesOf,
} from './support/marks.spec-blind';
import { shot } from './support/takeover';

test.setTimeout(120_000);
const YELLOW = 0;

test('typing H, 1 to 5, Delete and Ctrl+Alt+M in the note box and the reply box types text and touches no mark', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);

  // A mark the keys could hurt: a highlight, focused if a click can focus it.
  const mark = await selectPassage(page, ATTENTION, LINES.l1);
  await page.keyboard.press('h');
  const boxes = await lineBoxes(page, mark);
  await page.mouse.click((boxes[0].left + boxes[0].right) / 2, (boxes[0].top + boxes[0].bottom) / 2);
  note(testInfo, 'focus after a click on a mark', JSON.stringify(await focusInfo(page)));

  // 1. the note box
  const sel = await selectPassage(page, ATTENTION, LINES.l5);
  const box = await startNote(page);
  await page.keyboard.type('Hi 12345 it', { delay: 10 });
  expect((await readBox(box)).text, 'H and 1 to 5 are typed into the box').toBe('Hi 12345 it');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  expect((await readBox(box)).text, 'Delete deletes a letter in the box').toBe('Hi 12345 i');
  await page.keyboard.press('Control+Alt+m');
  await page.waitForTimeout(400);
  await expect(noteBox(page), 'Ctrl+Alt+M inside the box does not open a second box').toHaveCount(1);
  await expect(allCards(page), 'and does not make a second note').toHaveCount(1);
  expect((await readBox(box)).text, 'and does not send or change the text').toBe('Hi 12345 i');
  await shot(page, testInfo, 'typed-in-the-note-box');
  await page.keyboard.press('Enter');
  await expect(cardWith(page, 'Hi 12345 i')).toBeVisible();

  // 2. the reply box of the card that was just sent
  const card = cardWith(page, 'Hi 12345 i');
  await card.click();
  const reply = replyBox(page);
  await expect(reply).toBeVisible();
  await reply.click();
  await page.keyboard.type('h 1 2 3 4 5 H', { delay: 10 });
  expect((await readBox(reply)).text, 'the same keys type in the reply box').toBe('h 1 2 3 4 5 H');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  expect((await readBox(reply)).text, 'Delete deletes in the reply box').toBe('h 1 2 3 4 5 ');
  await page.keyboard.press('Control+Alt+m');
  await page.waitForTimeout(300);
  await expect(allCards(page), 'Ctrl+Alt+M in the reply box makes no note').toHaveCount(1);
  await shot(page, testInfo, 'typed-in-the-reply-box');

  // The marks are exactly as they were: the first highlight is still yellow, the comment's highlight is still on its words.
  await page.keyboard.press('Escape');
  await page.mouse.click(8, (page.viewportSize()?.height ?? 800) / 2);
  const first = await paintOfSelection(page, mark, { name: 'first-mark-untouched', testInfo });
  expect(first.paint.share(tokens.fill[YELLOW]), `the first highlight is still yellow: ${describe(first.paint)}`).toBeGreaterThanOrEqual(0.6);
  const second = await paintOfSelection(page, sel);
  expect(second.paint.share(tokens.fill[YELLOW]), `the comment's highlight is still yellow: ${describe(second.paint)}`).toBeGreaterThanOrEqual(0.6);
  const elsewhere = await selectPassage(page, ATTENTION, LINES.l9);
  expect(isPlain((await paintOfSelection(page, elsewhere)).paint), 'no other words were marked by the typing').toBe(true);
});

test('in the note box Ctrl+B formats the note (Markdown bold), Ctrl+I italic, and Ctrl+U, Ctrl+B and Ctrl+Z leave the page alone', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  const tokens = await markTokens(page);
  const sel = await selectPassage(page, ATTENTION, LINES.l7);
  const box = await startNote(page);
  const before = await paintOfSelection(page, sel);

  await page.keyboard.type('bold me', { delay: 10 });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+b');
  expect((await readBox(box)).text, 'Ctrl+B in the box makes the selected text Markdown bold').toBe('**bold me**');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('italic me', { delay: 10 });
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+i');
  expect((await readBox(box)).text, 'Ctrl+I makes the selected text italic').toBe('*italic me*');
  await page.keyboard.press('Control+u');
  await page.keyboard.press('Control+b');
  const after = await paintOfSelection(page, sel, { name: 'page-after-box-formatting', testInfo });
  expect(Math.abs(after.paint.ink - before.paint.ink) / before.paint.ink, 'Ctrl+B in the box does not make the page text bold').toBeLessThan(0.01);
  expect(strokesOf(after.shot, after.boxes[0], lineColours(tokens.line[YELLOW], tokens.fill[YELLOW])).rows, 'and Ctrl+U in the box does not underline the page text').toEqual([]);

  // Ctrl+Z inside the box undoes typing, not the highlight the note made
  await page.keyboard.press('Control+a');
  await page.keyboard.type('xyz', { delay: 10 });
  await page.keyboard.press('Control+z');
  expect((await readBox(box)).text, 'Ctrl+Z in the box undoes the typing in the box').not.toContain('xyz');
  const lit = await paintOfSelection(page, sel);
  expect(lit.paint.share(tokens.fill[YELLOW]), `and not the note's highlight: ${describe(lit.paint)}`).toBeGreaterThanOrEqual(0.6);
  await expect(noteBox(page)).toHaveCount(1);
});

const GERMAN: [string, string, string][] = [
  ['@', 'KeyQ', 'AltGr+Q'],
  ['€', 'KeyE', 'AltGr+E'],
  ['{', 'Digit7', 'AltGr+7'],
  ['}', 'Digit0', 'AltGr+0'],
  ['[', 'Digit8', 'AltGr+8'],
  ['\\', 'Minus', 'AltGr+ß'],
  ['µ', 'KeyM', 'AltGr+M (Ctrl+Alt+M on the key that opens a comment)'],
];
const POLISH: [string, string, string][] = [
  ['ą', 'KeyA', 'AltGr+A'],
  ['ć', 'KeyC', 'AltGr+C'],
  ['ę', 'KeyE', 'AltGr+E'],
  ['ł', 'KeyL', 'AltGr+L'],
  ['ń', 'KeyN', 'AltGr+N'],
  ['ó', 'KeyO', 'AltGr+O'],
  ['ś', 'KeyS', 'AltGr+S (Ctrl+Alt+S saves to the library)'],
  ['ź', 'KeyX', 'AltGr+X'],
  ['ż', 'KeyZ', 'AltGr+Z'],
];

for (const [layout, keys] of [['German', GERMAN], ['Polish', POLISH]] as const) {
  test(`${layout} AltGr keys type their characters in the note box, the reply box and the edit box`, async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    await selectPassage(page, ATTENTION, LINES.l3);
    const box = await startNote(page);
    const want = keys.map(([ch]) => ch).join('');
    for (const [ch, code, label] of keys) {
      await altGr(page, ch, code);
      const text = (await readBox(box)).text;
      expect(text.endsWith(ch), `${label} typed "${ch}" in the note box (the box holds ${JSON.stringify(text)})`).toBe(true);
    }
    expect((await readBox(box)).text, `${layout} AltGr characters, in order`).toBe(want);
    await expect(noteBox(page), 'no second box was opened by an AltGr key').toHaveCount(1);
    await expect(allCards(page), 'and none was sent').toHaveCount(1);
    await shot(page, testInfo, `${layout.toLowerCase()}-altgr-in-the-note-box`);
    await page.keyboard.press('Enter');
    const card = cardWith(page, want);
    await expect(card, 'the sent note keeps every character').toBeVisible();

    // the reply box
    await card.click();
    const reply = replyBox(page);
    await reply.click();
    for (const [ch, code] of keys.slice(0, 4)) await altGr(page, ch, code);
    expect((await readBox(reply)).text, 'and in the reply box').toBe(keys.slice(0, 4).map(([ch]) => ch).join(''));
    await page.keyboard.press('Escape');
  });

  test(`${layout} AltGr keys, pressed while reading, do nothing but what the keyboard says`, async ({ openViewer, server }, testInfo) => {
    const page = await openPaper(openViewer, server, ATTENTION);
    const sel = await selectPassage(page, ATTENTION, LINES.l9);
    for (const [ch, code] of keys.filter(([ch]) => ch !== 'µ')) await altGr(page, ch, code);
    await page.waitForTimeout(500);
    await expect(markMenu(page)).toHaveCount(0);
    await expect(anyBox(page), 'an AltGr character is not a shortcut: no note box opens').toHaveCount(0);
    await expect(allCards(page)).toHaveCount(0);
    const p = await paintOfSelection(page, sel, { name: `${layout.toLowerCase()}-altgr-reading`, testInfo });
    expect(isPlain(p.paint), `and nothing is marked: ${describe(p.paint)}`).toBe(true);
  });
}

test('on a German keyboard Ctrl+Alt+M arrives as "µ" and still opens the comment (plan, risk "AltGr layouts")', async ({ openViewer, server }, testInfo) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await selectPassage(page, ATTENTION, LINES.l11);
  // the keydown a German keyboard sends for Ctrl+Alt+M: the key types "µ", the physical key is M
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 3, key: 'µ', code: 'KeyM', windowsVirtualKeyCode: 0 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers: 0, key: 'µ', code: 'KeyM', text: 'µ', unmodifiedText: 'µ' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 3, key: 'µ', code: 'KeyM' });
  await expect(noteBox(page), 'the shortcut is matched on the physical key M, so the comment opens').toBeVisible({ timeout: 3000 });
  expect((await readBox(noteBox(page))).text, 'and the µ is not typed into the new box').toBe('');
  await shot(page, testInfo, 'german-ctrl-alt-m');
});
