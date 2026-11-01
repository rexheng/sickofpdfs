// Spec-blind helpers for the Phase 2 Round 2 walkthroughs (marks, comments, the notes panel).
//
// Written from the spec, the cross-phase contracts and the plan's section 4. Where the spec names no markup, the helpers say
// what they look for, and they look at what the owner sees:
//   - a mark is judged by the PIXELS of the page (the colour of the selected line, the line under it, how heavy the ink is),
//     never by a CSS class or an element the spec does not name;
//   - the menu, the cards and the note box are found by role and accessible name, the way a screen-reader user would
//     (the shared UI kit in packages/ui names them: a menu with menuitems and a "Green" radio, `article` cards that say
//     "Note by You: ...", a text box called "Note", "Reply" or "Edit note");
//   - what the library holds is read through the store the viewer publishes (`store.listAnnotations`, contracts section 3).
import { existsSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { dragSelect } from '../../support/drag-select';
import { REPO_ROOT } from '../../support/launch';
import { store as storeOf } from '../../support/store-probe.spec-blind';
import { expect, hooks, type FixtureServer } from '../../support/test';
import {
  clearSelection,
  findOnPage,
  openFixture,
  pageMap,
  rangeRects,
  rangeText,
  readSelection,
  settle,
  type CharRange,
  type TlFixture,
} from '../../support/tl-blind.spec-blind';
import { decodePng, overWhite, parseCssColor, type Box, type Img } from '../../support/tl-paint.spec-blind';

export { clearSelection, findOnPage, openFixture, pageMap, rangeRects, rangeText, readSelection, settle };
export type { Box, CharRange, TlFixture };

// ---------------------------------------------------------------------------------------------------------------
// What exists in this tree

/** Task 30 (the save decision) puts its code here. Until it exists nothing is saved, so "survives a reload" cannot be checked. */
export const SAVING_AVAILABLE = existsSync(`${REPO_ROOT}apps/extension/src/viewer/save`);
export const NO_SAVING = 'needs the save decision (Task 30): apps/extension/src/viewer/save/ does not exist yet';
/** Slice S16 (figures, pins, areas) puts its code here. */
export const FIGURES_AVAILABLE = existsSync(`${REPO_ROOT}apps/extension/src/viewer/figures`);
export const NO_FIGURES = 'needs slice S16 (figures, pins, areas): apps/extension/src/viewer/figures/ does not exist yet';

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

const at = (name: string, file: string, page = 0): TlFixture => ({ name, file, page, dir: 'ltr' });

/** "Attention Is All You Need", page 1: one wide abstract of 15 lines. The main reading paper of these walkthroughs. */
export const ATTENTION = at('attention', 'classifier/learning/arxiv-1706.03762-attention.pdf');
/** ResNet, page 1: two columns. */
export const RESNET = at('resnet', 'classifier/learning/arxiv-1512.03385-resnet.pdf');
/** Page 1 of a PLoS ONE paper: "doi:10.1371/journal.pone.0000308" stands on a line of its own. */
export const PLOS = at('plos', 'classifier/learning/plosone-10.1371-journal.pone.0000308.pdf');
export const PLOS_DOI = '10.1371/journal.pone.0000308';
/** A handout the filter cannot decide on content alone ("not sure"). */
export const UNSURE = at('mit-handout', 'classifier/learning/handout-mit-14.01-f23-handout10.pdf');
/** An invoice: "looks like an invoice or receipt". */
export const RECEIPT = at('invoice', 'classifier/not-learning/invoice-aws-sample.pdf');
/** 120 pages of photographed text: no text layer. */
export const SCAN = at('scan-120', 'scan-120.pdf');

/** Phrases inside ONE line of the Attention abstract: each is a single-line passage (a start phrase and an end phrase). */
export interface Passage {
  from: string;
  to: string;
}
export const LINES = {
  l1: { from: 'The dominant sequence transduction', to: 'recurrent or' },
  l3: { from: 'performing models also connect', to: 'through an attention' },
  l5: { from: 'based solely on attention', to: 'and convolutions' },
  l7: { from: 'be superior in quality', to: 'significantly' },
  l9: { from: 'to-German translation task', to: 'including' },
  l11: { from: 'our model establishes a new', to: 'BLEU score of 41.8' },
} as const satisfies Record<string, Passage>;
/** A sentence that runs over two lines (lines 1 and 2). */
export const SENTENCE_1: Passage = { from: 'The dominant sequence transduction models', to: 'an encoder and a decoder.' };
/** A sentence that runs over three lines (lines 4 to 6). */
export const SENTENCE_3: Passage = { from: 'We propose a new simple network', to: 'entirely.' };

// ---------------------------------------------------------------------------------------------------------------
// Opening and selecting

export type OpenViewer = (source: string, opts?: { back?: string; page?: number }) => Promise<Page>;
export const WIDE = { width: 1280, height: 1160 };

/** Opens `fx` at 100% in a window big enough for the page and its margin column, with the text layer built. */
export async function openPaper(openViewer: OpenViewer, server: FixtureServer, fx: TlFixture, o: { viewport?: { width: number; height: number }; scale?: number } = {}): Promise<Page> {
  const opened = await openFixture(openViewer, server, fx, { viewport: o.viewport ?? WIDE, ...(o.scale !== undefined ? { scale: o.scale } : {}) });
  return opened.page;
}

export interface Selected {
  fx: TlFixture;
  /** Glyph indices, both included. */
  a: number;
  b: number;
  /** The characters the drag selected, as the engine's text. */
  text: string;
  ranges: CharRange[];
}

/** Presses on the first glyph of `p.from`, releases on the last glyph of `p.to`: a real mouse drag over the words. */
export async function selectPassage(page: Page, fx: TlFixture, p: Passage): Promise<Selected> {
  const first = await findOnPage(page, fx.page, p.from);
  const last = await findOnPage(page, fx.page, p.to);
  const a = first.start;
  const b = last.start + last.count - 1;
  const { ranges } = await dragSelect(page, fx.page, a, b);
  expect(ranges.length, `dragging over "${p.from} ... ${p.to}" should select text`).toBeGreaterThan(0);
  const text = await rangeText(page, fx.page, a, b + 1);
  return { fx, a, b, text, ranges };
}

/** Selects the passage again, unless the page still holds exactly that selection. Says whether the selection had survived. */
export async function ensureSelected(page: Page, s: Selected): Promise<boolean> {
  const now = (await readSelection(page)).ranges;
  const same = now.length === 1 && now[0].pageIndex === s.fx.page && now[0].start <= s.a + 1 && now[0].end >= s.b;
  if (same) return true;
  await dragSelect(page, s.fx.page, s.a, s.b);
  return false;
}

/** The client-px boxes of the selected lines (the engine's own merged line rectangles for the range). */
export async function lineBoxes(page: Page, s: Pick<Selected, 'fx' | 'a' | 'b'>, sub?: { from: number; to: number }): Promise<Box[]> {
  const map = await pageMap(page, s.fx.page);
  const rects = await rangeRects(page, s.fx.page, sub?.from ?? s.a, (sub?.to ?? s.b) + 1);
  return rects.map((r) => map.box(r));
}

/** The boxes of the phrase `p` alone (a part of a bigger selection). */
export async function phraseBoxes(page: Page, fx: TlFixture, p: Passage): Promise<Box[]> {
  const first = await findOnPage(page, fx.page, p.from);
  const last = await findOnPage(page, fx.page, p.to);
  return lineBoxes(page, { fx, a: first.start, b: last.start + last.count - 1 });
}

/** Where to right-click or point: the middle glyph of the selection. */
export async function middleOf(page: Page, s: Pick<Selected, 'fx' | 'a' | 'b'>): Promise<{ x: number; y: number }> {
  const mid = Math.floor((s.a + s.b) / 2);
  return hooks(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: s.fx.page, i: mid });
}

// ---------------------------------------------------------------------------------------------------------------
// Pixels

export type RGB = [number, number, number];
export interface Shot {
  img: Img;
  dpr: number;
}

/** The colour tokens of the five slots, as the page resolves them (the spec's hex values are the fallback). */
export interface MarkTokens {
  fill: RGB[];
  active: RGB[];
  line: RGB[];
  selection: RGB;
}
const FALLBACK: Record<string, string> = {
  '--sop-mark-1': '#fde293', '--sop-mark-1-active': '#fbbc04', '--sop-mark-1-line': '#e09b00',
  '--sop-mark-2': '#a8dab5', '--sop-mark-2-active': '#81c995', '--sop-mark-2-line': '#1e8e3e',
  '--sop-mark-3': '#7fcfff', '--sop-mark-3-active': '#4fc3f7', '--sop-mark-3-line': '#1a73e8',
  '--sop-mark-4': '#fba9d6', '--sop-mark-4-active': '#ff8bcb', '--sop-mark-4-line': '#e52592',
  '--sop-mark-5': '#fdc69c', '--sop-mark-5-active': '#fcad70', '--sop-mark-5-line': '#e8710a',
};
export async function markTokens(page: Page): Promise<MarkTokens> {
  const raw = await page.evaluate((names) => {
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(names.map((n) => [n, style.getPropertyValue(n).trim()]));
  }, Object.keys(FALLBACK));
  const colour = (name: string): RGB => {
    const c = parseCssColor(raw[name] || FALLBACK[name]) ?? parseCssColor(FALLBACK[name])!;
    return [c.r, c.g, c.b];
  };
  const slot = (suffix: string) => [1, 2, 3, 4, 5].map((n) => colour(`--sop-mark-${n}${suffix}`));
  return { fill: slot(''), active: slot('-active'), line: slot('-line'), selection: overWhite({ r: 11, g: 87, b: 208, a: 0.3 }).map(Math.round) as RGB };
}
export const SLOT_NAMES = ['yellow', 'green', 'blue', 'pink', 'orange'] as const;

/** Moves the pointer off the page, lets the frame settle, and takes a screenshot of the window. */
export async function grab(page: Page, name?: string, testInfo?: { outputPath(n: string): string; attach(n: string, o: { path: string; contentType: string }): Promise<void> }): Promise<Shot> {
  const size = page.viewportSize();
  await page.mouse.move(4, (size?.height ?? 800) / 2);
  await settle(page, 220);
  const path = name !== undefined && testInfo !== undefined ? testInfo.outputPath(`${name}.png`) : undefined;
  const png = await page.screenshot(path !== undefined ? { path } : {});
  if (path !== undefined && testInfo !== undefined) await testInfo.attach(name!, { path, contentType: 'image/png' });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return { img: decodePng(png), dpr };
}

const luma = (p: RGB): number => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
const dist = (p: RGB, q: RGB): number => Math.max(Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]), Math.abs(p[2] - q[2]));

/** The pixels of a CSS-px box, inset by `inset` px on every side (anti-aliased edges are not judged). */
function pixelsIn(shot: Shot, box: Box, inset = 1.5): RGB[] {
  const { img, dpr } = shot;
  const x0 = Math.max(0, Math.ceil((box.left + inset) * dpr));
  const x1 = Math.min(img.width - 1, Math.floor((box.right - inset) * dpr));
  const y0 = Math.max(0, Math.ceil((box.top + inset) * dpr));
  const y1 = Math.min(img.height - 1, Math.floor((box.bottom - inset) * dpr));
  const out: RGB[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = (y * img.width + x) * 4;
      out.push([img.data[o], img.data[o + 1], img.data[o + 2]]);
    }
  }
  return out;
}

export interface Paint {
  /** Light pixels between the ink: the page's paper, or the colour of a mark over it. */
  paper: number;
  /** Dark pixels (luminance under 128): the ink. */
  ink: number;
  /** The share of the paper pixels within `tol` of `c`. */
  share(c: RGB, tol?: number): number;
  /** The share of the paper pixels that are white or grey (nothing coloured over them). */
  neutral: number;
  /** The most common paper colour (steps of 8), for the failure message. */
  dominant: RGB;
}

/** What the lines look like: the paper between the ink, and how much ink there is. */
export function paintOf(shot: Shot, boxes: Box[]): Paint {
  const paper: RGB[] = [];
  let ink = 0;
  for (const box of boxes) {
    for (const p of pixelsIn(shot, box)) {
      const l = luma(p);
      if (l < 128) ink++;
      if (l >= 150) paper.push(p);
    }
  }
  const counts = new Map<string, number>();
  for (const p of paper) {
    const k = `${p[0] >> 3},${p[1] >> 3},${p[2] >> 3}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((l, r) => r[1] - l[1])[0];
  const dominant: RGB = best ? (best[0].split(',').map((n) => Number(n) * 8 + 4) as RGB) : [0, 0, 0];
  return {
    paper: paper.length,
    ink,
    share: (c, tol = 12) => (paper.length === 0 ? 0 : paper.filter((p) => dist(p, c) <= tol).length / paper.length),
    neutral: paper.length === 0 ? 0 : paper.filter((p) => Math.max(...p) - Math.min(...p) <= 14).length / paper.length,
    dominant,
  };
}
export const hex = (c: RGB): string => `#${c.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
export const WHITE: RGB = [255, 255, 255];

/** A one-line account of what is painted, for failure messages. */
export const describe = (p: Paint): string => `${p.paper} paper px, ${p.ink} ink px, ${(p.neutral * 100).toFixed(0)}% white or grey, most common paper colour ${hex(p.dominant)}`;

export interface Strokes {
  /** Where, as a share (0 = top of the line box, 1 = its bottom) of the box height, a row of this colour runs along the line. */
  rows: number[];
}
/**
 * Rows that run along the line in one of the colours `colours` (at least `cover` of the box width, within `tol`): the
 * underline or the strike. Give both the line colour and the line colour over the fill (multiplied), because the spec does not say
 * how a line is blended over a highlight. The search starts `above` of the box height above its top and ends `below` under its bottom,
 * because an underline may sit under the line box.
 */
export function strokesOf(shot: Shot, box: Box, colours: RGB[], o: { tol?: number; cover?: number; above?: number; below?: number } = {}): Strokes {
  const { tol = 26, cover = 0.55, above = 0.05, below = 0.3 } = o;
  const { img, dpr } = shot;
  const h = box.bottom - box.top;
  const x0 = Math.max(0, Math.ceil((box.left + 2) * dpr));
  const x1 = Math.min(img.width - 1, Math.floor((box.right - 2) * dpr));
  const y0 = Math.max(0, Math.floor((box.top - above * h) * dpr));
  const y1 = Math.min(img.height - 1, Math.ceil((box.bottom + below * h) * dpr));
  const rows: number[] = [];
  for (let y = y0; y <= y1; y++) {
    let hit = 0;
    for (let x = x0; x <= x1; x++) {
      const o2 = (y * img.width + x) * 4;
      const p: RGB = [img.data[o2], img.data[o2 + 1], img.data[o2 + 2]];
      if (colours.some((c) => dist(p, c) <= tol)) hit++;
    }
    if (x1 > x0 && hit / (x1 - x0 + 1) >= cover) rows.push((y / dpr - box.top) / h);
  }
  return { rows };
}
/** The colours a line of colour `line` can have over a highlight `fill`: itself (drawn on top) and the two multiplied. */
export const lineColours = (line: RGB, fill?: RGB): RGB[] => (fill === undefined ? [line] : [line, [line[0] * fill[0] / 255, line[1] * fill[1] / 255, line[2] * fill[2] / 255].map(Math.round) as RGB]);

/** True when the lines are plain paper: white between the ink. */
export function isPlain(p: Paint): boolean {
  return p.paper > 0 && p.neutral >= 0.97;
}

/** Marks as the owner sees them on the lines of `s`: take a picture with the selection let go of, and judge it. */
export async function paintOfSelection(
  page: Page,
  s: Pick<Selected, 'fx' | 'a' | 'b'>,
  o: { sub?: { from: number; to: number }; keepSelection?: boolean; name?: string; testInfo?: Parameters<typeof grab>[2] } = {},
): Promise<{ paint: Paint; shot: Shot; boxes: Box[] }> {
  if (o.keepSelection !== true) await clearSelection(page);
  await settle(page, 120);
  const boxes = await lineBoxes(page, s, o.sub);
  const shot = await grab(page, o.name, o.testInfo);
  return { paint: paintOf(shot, boxes), shot, boxes };
}

/** Every pixel of the page element `pageIndex` that is within `tol` of one of the five fills or lines. 0 means nothing is drawn. */
export async function markPixelsOnPage(page: Page, pageIndex: number, tokens: MarkTokens, tol = 6): Promise<number> {
  const rect = await page.evaluate((i) => {
    const r = document.querySelector(`[data-page-index="${i}"]`)?.getBoundingClientRect();
    return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  }, pageIndex);
  if (!rect) return 0;
  const shot = await grab(page);
  const wanted = [...tokens.fill, ...tokens.active, ...tokens.line];
  let n = 0;
  for (const p of pixelsIn(shot, { left: Math.max(0, rect.left), right: rect.right, top: Math.max(0, rect.top), bottom: Math.min(rect.bottom, page.viewportSize()?.height ?? rect.bottom) }, 0)) {
    if (wanted.some((c) => dist(p, c) <= tol)) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// The menu

/** The mark-up menu (the UI kit's ContextMenu: `role=menu`, named "Mark up"). */
export const markMenu = (page: Page): Locator => page.getByRole('menu');
export const menuRow = (page: Page, name: RegExp | string): Locator => markMenu(page).getByRole('menuitem', { name });
export const swatch = (page: Page, colour: (typeof SLOT_NAMES)[number]): Locator =>
  markMenu(page).getByRole('menuitemradio', { name: new RegExp(`^${colour}$`, 'i') });

/** Right-click on the selected words, as the owner does. The menu is awaited by the caller. */
export async function rightClickSelection(page: Page, s: Pick<Selected, 'fx' | 'a' | 'b'>, o: { shift?: boolean } = {}): Promise<{ x: number; y: number }> {
  const p = await middleOf(page, s);
  await rightClickAt(page, p, o);
  return p;
}

/** A right-click at a point, with Shift held when asked. */
export async function rightClickAt(page: Page, p: { x: number; y: number }, o: { shift?: boolean } = {}): Promise<void> {
  if (o.shift === true) await page.keyboard.down('Shift');
  try {
    await page.mouse.click(p.x, p.y, { button: 'right' });
  } finally {
    if (o.shift === true) await page.keyboard.up('Shift');
  }
}

/** Right-click, then pick a colour swatch: "right-click and pick green". */
export async function highlightFromMenu(page: Page, s: Selected, colour: (typeof SLOT_NAMES)[number]): Promise<void> {
  await rightClickSelection(page, s);
  await expect(markMenu(page), 'right-clicking selected text opens the mark-up menu').toBeVisible({ timeout: 3000 });
  await swatch(page, colour).click();
  await expect(markMenu(page), 'choosing a colour closes the menu').toBeHidden();
}

/**
 * Whether the page's contextmenu event for the next right-click was cancelled (so the page's own menu opens instead of
 * Chrome's). Call before the click, read after it. Listens in the capture phase, so no handler can hide the event.
 */
export async function watchContextMenu(page: Page): Promise<() => Promise<{ seen: number; prevented: boolean }>> {
  await page.evaluate(() => {
    const w = window as unknown as { __ctx?: Event[]; __ctxOn?: boolean };
    w.__ctx = [];
    if (w.__ctxOn === true) return;
    w.__ctxOn = true;
    window.addEventListener('contextmenu', (e) => w.__ctx!.push(e), { capture: true });
  });
  return () =>
    page.evaluate(
      () =>
        new Promise<{ seen: number; prevented: boolean }>((resolve) =>
          setTimeout(() => {
            const list = (window as unknown as { __ctx: Event[] }).__ctx;
            resolve({ seen: list.length, prevented: list.some((e) => e.defaultPrevented) });
          }, 50),
        ),
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Cards and the note box

/** The margin cards (and the same cards in the notes panel when it is open): `article`s named "Note by You: ..." or "New note". */
export const allCards = (page: Page): Locator => page.getByRole('article', { name: /^(note by|new note)/i });
export const cardWith = (page: Page, text: string | RegExp): Locator => allCards(page).filter({ hasText: text });
export const activeCards = (page: Page): Locator => allCards(page).and(page.locator('[aria-current="true"], [data-active="true"]'));

/** The box of a NEW note: named "Note" or "Comment"; never the reply box or the edit box. */
export const NOTE_BOX_NAME = /^(?!.*\b(?:reply|edit)\b).*\b(?:note|comment)\b/i;
export const noteBox = (page: Page): Locator => page.getByRole('textbox', { name: NOTE_BOX_NAME });
export const replyBox = (page: Page): Locator => page.getByRole('textbox', { name: /reply/i });
export const editBox = (page: Page): Locator => page.getByRole('textbox', { name: /edit/i });
/** Any box a person can write a note in. */
export const anyBox = (page: Page): Locator => page.getByRole('textbox', { name: /comment|note|reply/i });

/** What a text box holds and where its caret is. */
export async function readBox(box: Locator): Promise<{ text: string; caretAtEnd: boolean; focused: boolean }> {
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

/** Everything the owner can read on the page, text in boxes included. */
export const readEverything = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('textarea, input, [contenteditable]')].map((e) => ('value' in e ? (e as HTMLInputElement).value : (e as HTMLElement).innerText));
    return [document.body.innerText, ...boxes].join('\n');
  });
export const owns = async (page: Page, needle: string): Promise<boolean> => (await readEverything(page)).includes(needle);

/** Ctrl+Alt+M on the current selection: the note box opens and has the keyboard. */
export async function startNote(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+Alt+m');
  const box = noteBox(page);
  await expect(box, 'Ctrl+Alt+M opens a note box').toBeVisible({ timeout: 2500 });
  await expect.poll(async () => (await readBox(box)).focused, { message: 'the note box has the keyboard' }).toBe(true);
  return box;
}

/** The question the first mark or note on a PDF judged "not learning" asks. */
export const savePrompt = (page: Page): Locator => page.getByText(/save this pdf to keep your notes/i);

/** Answers that question when it is on the screen (waiting a moment for it). Says whether it was asked. */
export async function answerSavePrompt(page: Page, answer: 'Yes' | 'No', timeout = 1500): Promise<boolean> {
  const asked = await savePrompt(page)
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (asked) await page.getByRole('button', { name: new RegExp(`^${answer}$`, 'i') }).first().click();
  return asked;
}

/** Ctrl+Alt+M (or another key) for a PDF that may ask "Save this PDF to keep your notes?" first: answers it, then waits for the box. */
export async function startNoteAnswering(page: Page, answer: 'Yes' | 'No', keys = 'Control+Alt+m'): Promise<Locator> {
  await page.keyboard.press(keys);
  const box = noteBox(page);
  await Promise.race([box.waitFor({ state: 'visible', timeout: 2500 }).catch(() => undefined), savePrompt(page).first().waitFor({ state: 'visible', timeout: 2500 }).catch(() => undefined)]);
  await answerSavePrompt(page, answer, 300);
  await expect(box, `${keys} opens a note box`).toBeVisible({ timeout: 3000 });
  await expect.poll(async () => (await readBox(box)).focused, { message: 'the note box has the keyboard' }).toBe(true);
  return box;
}

/** Select a passage, press Ctrl+Alt+M, type `text` and press Enter. Leaves a posted card. */
export async function postNote(page: Page, fx: TlFixture, p: Passage, text: string): Promise<Selected> {
  const sel = await selectPassage(page, fx, p);
  await startNote(page);
  await page.keyboard.type(text, { delay: 8 });
  await page.keyboard.press('Enter');
  await expect(cardWith(page, text.split('\n')[0]), `the note "${text}" becomes a card`).toBeVisible({ timeout: 5000 });
  return sel;
}

/** Types lines; Shift+Enter between them. */
export async function typeLines(page: Page, lines: string[], delay = 8): Promise<void> {
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(line, { delay });
  }
}

/** The page element's box on the screen. */
export async function pageRect(page: Page, pageIndex: number): Promise<Box> {
  const r = await page.evaluate((i) => {
    const e = document.querySelector(`[data-page-index="${i}"]`)?.getBoundingClientRect();
    return e ? { left: e.left, top: e.top, right: e.right, bottom: e.bottom } : null;
  }, pageIndex);
  if (!r) throw new Error(`page ${pageIndex + 1} is not on the screen`);
  return r;
}

export async function boxOf(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  if (!b) throw new Error('the element has no box on the screen');
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
}
export const overlapArea = (a: Box, b: Box): number => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

// ---------------------------------------------------------------------------------------------------------------
// Keys the test harness cannot press with `keyboard.press`

/**
 * An AltGr key as Windows reports it: the keydown carries Ctrl and Alt and names the character the key types and the physical
 * key; the character is then inserted by the browser (a `char` event), unless the page cancelled the keydown.
 */
export async function altGr(page: Page, key: string, code: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 3, key, code, windowsVirtualKeyCode: 0 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', modifiers: 0, key, code, text: key, unmodifiedText: key });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 3, key, code });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** The renderer dies: the same as the "Aw, Snap" crash page. */
export async function crashRenderer(page: Page): Promise<void> {
  const crashed = new Promise<void>((resolve) => page.once('crash', () => resolve()));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.crash').catch(() => undefined); // the session dies with the page
  await crashed;
}

// ---------------------------------------------------------------------------------------------------------------
// The library, read through the store the viewer publishes

export interface MarkRow {
  id: string;
  style: 'highlight' | 'underline' | 'bold' | 'strike' | 'area';
  color: number | null;
  anchor: { kind: string; quote?: { exact: string }; start?: { page: number; index: number }; end?: { page: number; index: number }; point?: number[]; page?: number };
  pageIndex: number;
  deletedAt: number | null;
}
export interface ThreadRow {
  id: string;
  anchor: { kind: string; quote?: { exact: string }; page?: number; point?: number[] };
  pageIndex: number | null;
  placement: string;
  draftOfTab: string | null;
  deletedAt: number | null;
}
export interface CommentRow {
  id: string;
  threadId: string;
  author: 'me' | 'claude';
  body: string;
  draftOfTab: string | null;
  createdAt: number;
  deletedAt: number | null;
}
export interface Annotations {
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
}

/** The library's id for the PDF open in this tab (null until it is saved). */
export async function libraryId(page: Page): Promise<string | null> {
  const sha = await hooks(page).eval((h) => (h as unknown as { doc(): { loaded: { sha256: string } } | null }).doc()?.loaded.sha256 ?? null);
  if (sha === null) return null;
  return storeOf(page).call<string | null>('resolveFingerprint', sha).catch(() => null);
}

/** Waits until the PDF is in the library (the learning filter saved it). Returns its id. */
export async function waitSaved(page: Page, timeout = 30_000): Promise<string> {
  let id: string | null = null;
  await expect.poll(async () => (id = await libraryId(page)), { timeout, message: 'the PDF should be saved to the library' }).not.toBeNull();
  return id!;
}

export async function annotations(page: Page, documentId?: string): Promise<Annotations> {
  const id = documentId ?? (await libraryId(page));
  if (id === null) return { marks: [], threads: [], comments: [] };
  return storeOf(page).call<Annotations>('listAnnotations', id);
}

/** Waits until what the library holds satisfies `ok` (a write to the store is a moment behind the screen). */
export async function waitStored(page: Page, ok: (a: Annotations) => boolean, message: string, documentId?: string): Promise<Annotations> {
  let last: Annotations = { marks: [], threads: [], comments: [] };
  await expect.poll(async () => ok((last = await annotations(page, documentId).catch(() => last))), { timeout: 15_000, message }).toBe(true);
  return last;
}

/** Reload, and wait until the page is back with its text layer. */
export async function reloadAndWait(page: Page, fx: TlFixture): Promise<void> {
  await page.reload();
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 25_000 });
  await hooks(page).eval((h, i) => h.viewer.scrollTo(i), fx.page);
  await page.waitForSelector(`[data-page-index="${fx.page}"] [data-start]`, { state: 'attached', timeout: 20_000 });
  await settle(page, 500);
}

// ---------------------------------------------------------------------------------------------------------------
// Timing, measured in the page

export interface Timing {
  /** ms from the last key press to the first change of a mark layer (an SVG that is not the selection) on a page. */
  markDrawn: number | null;
  /** ms from the last key press to the next frame after a note box was in the page. */
  noteBox: number | null;
  /** The `startTime` of each perf mark named in the plan, relative to the same clock as the key press. */
  perf: Record<string, number[]>;
  keyAt: number | null;
}
const PERF_NAMES = ['sop:mark-drawn', 'sop:notebox-open', 'sop:figure-outline'] as const;

/** Installs the probe: it notes the time of every key press (capture phase) and of the first change of a mark layer or note box after it. */
export async function installTiming(page: Page): Promise<void> {
  await page.evaluate(
    ({ noteName }) => {
      const w = window as unknown as { __t?: { keyAt: number | null; mark: number | null; box: number | null } };
      w.__t = { keyAt: null, mark: null, box: null };
      window.addEventListener(
        'keydown',
        (e) => {
          w.__t!.keyAt = e.timeStamp;
          w.__t!.mark = null;
          w.__t!.box = null;
        },
        { capture: true },
      );
      const markLayerChange = (m: MutationRecord): boolean => {
        const els: Element[] = [];
        if (m.target instanceof Element) els.push(m.target);
        for (const n of [...m.addedNodes]) if (n instanceof Element) els.push(n);
        return els.some((el) => {
          const svg = el instanceof SVGElement ? (el.ownerSVGElement ?? (el as unknown as SVGSVGElement)) : el.querySelector('svg');
          if (!svg || !(svg instanceof SVGElement)) return false;
          if (svg.classList.contains('sop-selection') || svg.closest('.sop-selection')) return false;
          return svg.closest('[data-page-index]') !== null;
        });
      };
      const isBox = (n: Node): boolean => n instanceof Element && (n.matches('textarea') || n.querySelector('textarea') !== null) && new RegExp(noteName, 'i').test((n.matches('textarea') ? n : n.querySelector('textarea')!).getAttribute('aria-label') ?? '');
      new MutationObserver((records) => {
        const t = w.__t!;
        if (t.keyAt === null) return;
        const now = performance.now();
        for (const m of records) {
          if (t.mark === null && markLayerChange(m)) t.mark = now;
          if (t.box === null && [...m.addedNodes].some(isBox)) {
            t.box = now;
            requestAnimationFrame(() => requestAnimationFrame(() => (w.__t!.box = performance.now())));
          }
        }
      }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
    },
    { noteName: '^(?!.*(reply|edit)).*(note|comment)' },
  );
}

export async function readTiming(page: Page): Promise<Timing> {
  return page.evaluate((names) => {
    const t = (window as unknown as { __t: { keyAt: number | null; mark: number | null; box: number | null } }).__t;
    const perf: Record<string, number[]> = {};
    for (const n of names) perf[n] = performance.getEntriesByName(n).map((e) => e.startTime);
    return { keyAt: t.keyAt, markDrawn: t.keyAt !== null && t.mark !== null ? t.mark - t.keyAt : null, noteBox: t.keyAt !== null && t.box !== null ? t.box - t.keyAt : null, perf };
  }, PERF_NAMES);
}

// ---------------------------------------------------------------------------------------------------------------
// Small things

/** A line in the test report that is not a pass or a fail: what the product did where the spec is silent. */
export function note(testInfo: { annotations: { type: string; description?: string }[] }, type: string, description: string): void {
  testInfo.annotations.push({ type, description });
}

/** The keydown events of the page, with whether any handler cancelled them. Call before pressing; read after. */
export async function watchKeys(page: Page): Promise<() => Promise<{ key: string; prevented: boolean }[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __keys?: KeyboardEvent[]; __keysOn?: boolean };
    w.__keys = [];
    if (w.__keysOn === true) return;
    w.__keysOn = true;
    window.addEventListener('keydown', (e) => w.__keys!.push(e), { capture: true });
  });
  return () =>
    page.evaluate(
      () =>
        new Promise<{ key: string; prevented: boolean }[]>((resolve) =>
          setTimeout(() => resolve((window as unknown as { __keys: KeyboardEvent[] }).__keys.map((e) => ({ key: e.key, prevented: e.defaultPrevented }))), 50),
        ),
    );
}

/** What has keyboard focus, in words a failure message can use. */
export const focusInfo = (page: Page): Promise<{ tag: string; inSvg: boolean; inMarkLayer: boolean; label: string; id: string }> =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { tag: 'body', inSvg: false, inMarkLayer: false, label: '', id: '' };
    const svg = a.closest('svg');
    const inPage = a.closest('[data-page-index]') !== null;
    const inSelection = svg?.classList.contains('sop-selection') === true;
    const text = (a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 60);
    return { tag: a.tagName.toLowerCase(), inSvg: svg !== null, inMarkLayer: svg !== null && inPage && !inSelection, label: text, id: `${a.tagName}#${a.id}.${String(a.getAttribute('class') ?? '')}@${Math.round(a.getBoundingClientRect().left)},${Math.round(a.getBoundingClientRect().top)}` };
  });

/** Scales a wait to the box: the machine is shared and loaded, so waits are generous while the limits asserted are the spec's x 3. */
export const LOOSE = 3;

export async function stillNothing(page: Page, what: string, ms = 700): Promise<void> {
  await page.waitForTimeout(ms);
  await expect(markMenu(page), `${what}: no menu opened by itself`).toHaveCount(0);
  await expect(anyBox(page), `${what}: no note box opened by itself`).toHaveCount(0);
  await expect(allCards(page), `${what}: no card appeared by itself`).toHaveCount(0);
}
