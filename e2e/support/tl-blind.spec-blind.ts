// Spec-blind helpers for the Task 22 walkthrough tests: open a text-layer fixture in the real built extension, find
// glyphs on screen, drag, click, copy through the real clipboard, and judge how a selection was painted.
//
// What this file assumes of the product (all of it from the task's interface file):
//  - test hooks `selectionRanges()` and `glyphCenter(pageIndex, charIndex)` on `globalThis.__sopTest` (client px);
//  - every text-layer span carries `data-start` (the char-map offsets), inside the page's `[data-page-index]` element;
//  - the selection colour is the CSS token `--text-selection`.
// Everything else comes from the engine (hooks.backend) and the viewer's layout hooks, which exist already.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import type { SopTestHooks } from '../../apps/extension/src/testing/test-hooks';
import type { Glyph, PdfRect } from '../../packages/viewer/src/backend/types';
import { hooks, type FixtureServer } from './test';
import { breakVerdict, INVISIBLE, lineRelation } from './tl-copy.spec-blind';
import { analyzeSelectionPaint, decodePng, parseCssColor, type Box, type PaintReport, type Rgba } from './tl-paint.spec-blind';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// The hooks Task 22 adds

export interface CharRange {
  pageIndex: number;
  /** Exclusive end. */
  start: number;
  end: number;
}
interface TextHooks {
  selectionRanges(): CharRange[];
  glyphCenter(pageIndex: number, charIndex: number): { x: number; y: number };
}
type Hooks = SopTestHooks & TextHooks;

/** `hooks(page)` with the two hooks Task 22 adds. */
export function th(page: Page): { eval: <T, A = undefined>(fn: (h: Hooks, arg: A) => T | Promise<T>, arg?: A) => Promise<T> } {
  const base = hooks(page);
  return { eval: <T, A = undefined>(fn: (h: Hooks, arg: A) => T | Promise<T>, arg?: A) => base.eval(fn, arg) };
}

// ---------------------------------------------------------------------------------------------------------------
// Fixtures

export interface TlFixture {
  name: string;
  /** Under test-assets/ (the fixture server's /f/). */
  file: string;
  page: number;
  dir: 'ltr' | 'rtl';
  /** The hand-written ground truth (the P0-4 .txt), where there is one. */
  truth?: string;
}

/** The text-layer set of the interface file: the tl-*.pdf fixtures, ResNet p1 and Attention p1. */
export const FIXTURES: TlFixture[] = [
  { name: 'two-column', file: 'tl-two-column.pdf', page: 0, dir: 'ltr', truth: 'two-column' },
  { name: 'rotated-table', file: 'tl-rotated-table.pdf', page: 0, dir: 'ltr', truth: 'rotated-table' },
  { name: 'ligatures', file: 'tl-ligatures.pdf', page: 0, dir: 'ltr', truth: 'ligatures' },
  { name: 'maths', file: 'tl-maths.pdf', page: 0, dir: 'ltr', truth: 'maths' },
  { name: 'rtl', file: 'tl-rtl.pdf', page: 0, dir: 'rtl', truth: 'rtl' },
  { name: 'rotated-page', file: 'tl-rotated-page.pdf', page: 0, dir: 'ltr', truth: 'two-column' },
  { name: 'resnet-p1', file: 'classifier/learning/arxiv-1512.03385-resnet.pdf', page: 0, dir: 'ltr' },
  { name: 'attention-p1', file: 'classifier/learning/arxiv-1706.03762-attention.pdf', page: 0, dir: 'ltr' },
];
export const fixture = (name: string): TlFixture => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

/** The ground-truth text of a fixture (the Phase 0 sources, or their ported copy), or null. */
export function truthOf(fx: TlFixture): string | null {
  if (!fx.truth) return null;
  for (const dir of ['scripts/fixtures/textlayer-src', 'spikes/phase0/fixtures/src']) {
    const path = `${REPO_ROOT}${dir}/${fx.truth}.txt`;
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Opening

export interface Opened {
  page: Page;
  fx: TlFixture;
  pageIndex: number;
  /** Page errors seen since the viewer opened. */
  errors: string[];
}

export const VIEW_100 = { width: 1100, height: 1160 };
export const VIEW_200 = { width: 1700, height: 2260 };
/** For pages that display landscape (/Rotate 90). */
export const VIEW_100_WIDE = { width: 1200, height: 900 };
export const VIEW_200_WIDE = { width: 2260, height: 1760 };

/**
 * Opens the fixture, sets the zoom (1 = 100%) and a window big enough to hold the whole page (so every glyph can be
 * reached with the mouse), and waits for the text layer to appear on the page.
 */
export async function openFixture(
  openViewer: (source: string, opts?: { back?: string; page?: number }) => Promise<Page>,
  server: FixtureServer,
  fx: TlFixture,
  o: { scale?: number; viewport?: { width: number; height: number } } = {},
): Promise<Opened> {
  const page = await openViewer(server.url(`/f/${fx.file}`));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize(o.viewport ?? VIEW_100);
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 20_000 });
  // Triage note (navprint): the navigation rail (Task 24) starts open in a window 1100 px wide or more and takes 196 px.
  // These sizes were chosen so the window holds the whole page, so the rail is shut (F4) to give the pages the window.
  if (await th(page).eval((h) => h.viewer.snapshot().railOpen)) {
    await page.keyboard.press('F4');
    await page.waitForFunction(() => !(globalThis as unknown as { __sopTest: { viewer: { snapshot(): { railOpen: boolean } } } }).__sopTest.viewer.snapshot().railOpen);
  }
  const scale = o.scale ?? 1;
  await setZoom(page, scale);
  await th(page).eval((h, i) => h.viewer.scrollTo(i), fx.page);
  await waitForTextLayer(page, fx.page);
  await settle(page);
  return { page, fx, pageIndex: fx.page, errors };
}

/** Zooms to `scale` (1 = 100%) and waits until the page boxes have their new size. */
export async function setZoom(page: Page, scale: number): Promise<void> {
  await th(page).eval((h, s) => h.viewer.setScale(s), scale);
  await page.waitForFunction((s) => Math.abs((globalThis as unknown as { __sopTest: { viewer: { scale(): number } } }).__sopTest.viewer.scale() - s) < 1e-6, scale, { timeout: 10_000 });
  await settle(page);
}

/** Text layer spans carry `data-start`; they appear lazily once the page's full render is on screen. */
export async function waitForTextLayer(page: Page, pageIndex: number): Promise<void> {
  try {
    await page.waitForSelector(`[data-page-index="${pageIndex}"] [data-start]`, { state: 'attached', timeout: 20_000 });
  } catch {
    throw new Error(`the text layer did not appear on page ${pageIndex + 1}: no element with data-start inside [data-page-index="${pageIndex}"] after 20 s`);
  }
}

/** A few frames and a short pause, so layout, renders and overlay painting have caught up. */
export async function settle(page: Page, ms = 350): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  await page.waitForTimeout(ms);
}

// ---------------------------------------------------------------------------------------------------------------
// Engine data

export async function glyphsOf(page: Page, pageIndex: number): Promise<Glyph[]> {
  return th(page).eval(async (h, i) => (await h.backend.getPageGlyphs(h.doc()!.open.doc, i)).glyphs, pageIndex);
}
export async function pageText(page: Page, pageIndex: number): Promise<string> {
  return th(page).eval((h, i) => h.backend.getPageText(h.doc()!.open.doc, i), pageIndex);
}
/** The engine's own text for chars [start, end) (cleaned as getPageText). */
export async function rangeText(page: Page, pageIndex: number, start: number, end: number): Promise<string> {
  return th(page).eval((h, a) => h.backend.getTextRange(h.doc()!.open.doc, a.i, a.s, a.n), { i: pageIndex, s: start, n: end - start });
}
export async function rangeRects(page: Page, pageIndex: number, start: number, end: number): Promise<PdfRect[]> {
  return th(page).eval((h, a) => h.backend.getTextRangeRects(h.doc()!.open.doc, a.i, a.s, a.n), { i: pageIndex, s: start, n: end - start });
}
/** [start, start + count) of the first match of `query` on the page. */
export async function findOnPage(page: Page, pageIndex: number, query: string): Promise<{ start: number; count: number }> {
  const hits = await th(page).eval((h, a) => h.backend.searchPage(h.doc()!.open.doc, a.i, a.q, { matchCase: true, wholeWord: false }), { i: pageIndex, q: query });
  if (hits.length === 0) throw new Error(`"${query}" is not on page ${pageIndex + 1}`);
  return { start: hits[0].start, count: hits[0].count };
}

/** A glyph the reader can see and aim at. */
export const isVisible = (g: Glyph): boolean => !g.generated && !INVISIBLE.has(g.text) && !/^\s$/u.test(g.text) && g.box.width > 0 && g.box.height > 0;

// ---------------------------------------------------------------------------------------------------------------
// Page space to the screen

export interface PageMap {
  /** Points per CSS px. */
  pxPerPt: number;
  /** 'v' when the lines run down the screen (the page is shown turned by 90 or 270). */
  orientation: 'h' | 'v';
  toClient(x: number, y: number): { x: number; y: number };
  box(r: PdfRect): Box;
}

/** The current page-to-client map (it moves when the page scrolls or the zoom changes: ask again). */
export async function pageMap(page: Page, pageIndex: number): Promise<PageMap> {
  const m = await th(page).eval((h, i) => {
    const size = h.doc()!.open.pages[i];
    const at = (x: number, y: number) => h.viewer.clientPointOf({ pageIndex: i, x, y });
    return { W: size.width, H: size.height, p00: at(0, 0), p10: at(size.width, 0), p01: at(0, size.height), turn: (size.rotation + h.viewer.snapshot().viewRotation) % 360 };
  }, pageIndex);
  const ax = { x: (m.p10.x - m.p00.x) / m.W, y: (m.p10.y - m.p00.y) / m.W };
  const ay = { x: (m.p01.x - m.p00.x) / m.H, y: (m.p01.y - m.p00.y) / m.H };
  const toClient = (x: number, y: number) => ({ x: m.p00.x + x * ax.x + y * ay.x, y: m.p00.y + x * ax.y + y * ay.y });
  return {
    pxPerPt: Math.hypot(ax.x, ax.y),
    orientation: m.turn === 90 || m.turn === 270 ? 'v' : 'h',
    toClient,
    box(r) {
      const pts = [toClient(r.x, r.y), toClient(r.x + r.width, r.y), toClient(r.x, r.y + r.height), toClient(r.x + r.width, r.y + r.height)];
      return { left: Math.min(...pts.map((p) => p.x)), right: Math.max(...pts.map((p) => p.x)), top: Math.min(...pts.map((p) => p.y)), bottom: Math.max(...pts.map((p) => p.y)) };
    },
  };
}

export const centreOf = (map: PageMap, g: Glyph): { x: number; y: number } => map.toClient(g.box.x + g.box.width / 2, g.box.y + g.box.height / 2);
/** A point `fraction` (0 to 1) of the way along the glyph's box, on its vertical middle: pages shown upright only. */
export const pointIn = (map: PageMap, g: Glyph, fraction: number): { x: number; y: number } => map.toClient(g.box.x + g.box.width * fraction, g.box.y + g.box.height / 2);

// ---------------------------------------------------------------------------------------------------------------
// Mouse and selection

/** Press at `from`, move to `to` in `steps` moves, release. */
export async function dragClient(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
  await page.waitForTimeout(40);
}

export async function readSelection(page: Page): Promise<{ ranges: CharRange[]; domText: string }> {
  return th(page).eval((h) => ({ ranges: h.selectionRanges(), domText: String(getSelection() ?? '') }));
}
export async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => getSelection()?.removeAllRanges());
}

/** The drag the interface file describes: press at glyphCenter(a), release at glyphCenter(b), through 8 moves. */
export async function dragGlyphs(page: Page, pageIndex: number, a: number, b: number): Promise<{ ranges: CharRange[]; domText: string }> {
  const [from, to] = await th(page).eval((h, args) => [h.glyphCenter(args.i, args.a), h.glyphCenter(args.i, args.b)] as const, { i: pageIndex, a, b });
  await dragClient(page, from, to);
  return readSelection(page);
}

/**
 * The reader's range for a drag over glyphs a and b: both glyphs included (R27). With `glyphs`, an end on half of a
 * surrogate pair (a maths italic letter is two PDFium chars in one box) takes the whole letter. Triage (TB1): a selection
 * cannot hold half a letter, and the layer selects the whole one.
 */
export const inclusive = (pageIndex: number, a: number, b: number, glyphs?: Glyph[]): CharRange => {
  let start = Math.min(a, b);
  let end = Math.max(a, b) + 1;
  if (glyphs) {
    const high = (i: number) => /^[\uD800-\uDBFF]$/u.test(glyphs[i]?.text ?? '');
    const low = (i: number) => /^[\uDC00-\uDFFF]$/u.test(glyphs[i]?.text ?? '');
    if (low(start) && high(start - 1)) start--;
    if (high(end - 1) && low(end)) end++;
  }
  return { pageIndex, start, end };
};

// ---------------------------------------------------------------------------------------------------------------
// Copy, through the real clipboard

const SENTINEL = '\u0001sop-test-nothing-copied\u0001';

export interface ClipboardReader {
  clear(): Promise<void>;
  read(): Promise<string>;
  close(): Promise<void>;
}

/**
 * A second tab on the fixture server's origin that may read and write the clipboard. The viewer is an extension page, to
 * which Chromium will not grant clipboard permission, and the clipboard is shared by the whole browser.
 */
export async function openClipboardReader(context: BrowserContext, server: FixtureServer): Promise<ClipboardReader> {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
  const tab = await context.newPage();
  await tab.goto(server.url(`/mock?contentType=${encodeURIComponent('text/html')}&body=${encodeURIComponent('<p>clipboard reader</p>')}`));
  return {
    async clear() {
      await tab.bringToFront();
      await tab.evaluate((s) => navigator.clipboard.writeText(s), SENTINEL);
    },
    async read() {
      await tab.bringToFront();
      return tab.evaluate(() => navigator.clipboard.readText());
    },
    close: () => tab.close(),
  };
}

/** Ctrl+C in the viewer; what lands on the clipboard. '' means nothing was copied. */
export async function copySelection(page: Page, reader: ClipboardReader): Promise<string> {
  await reader.clear();
  await page.bringToFront();
  await page.keyboard.press('Control+C');
  await page.waitForTimeout(120);
  const text = await reader.read();
  await page.bringToFront();
  return text === SENTINEL ? '' : text;
}

// ---------------------------------------------------------------------------------------------------------------
// Words (R28)

export interface Word {
  text: string;
  /** Glyph indices, end exclusive. */
  start: number;
  end: number;
}

const isGeneratedBreak = (g: Glyph) => g.generated && (g.text === '\r' || g.text === '\n');
/** How far apart two neighbouring glyphs are along their line, in points (box edge to box edge). */
function alongGap(prev: Glyph, next: Glyph): number {
  const t = (prev.angle * Math.PI) / 180;
  const extent = (g: Glyph) => Math.abs(g.box.width * Math.cos(t)) + Math.abs(g.box.height * Math.sin(t));
  return Math.abs(lineRelation(prev, next).along) - (extent(prev) + extent(next)) / 2;
}

/**
 * The words of the page, by ICU word breaks over the engine's text (what a double-click is expected to select).
 * Triage (TB1): a line break PDFium put inside a line (between the letters of a rotated table header, before a
 * superscript) is joined first, as R26 joins it for copy (breakVerdict 'join'): with nothing when the glyphs touch, with a
 * space when they are a gap apart. Otherwise "Statio⏎n" would be two words and x⏎2 not the x² a reader sees.
 */
export function wordsOf(glyphs: Glyph[], locale: string, o: { rtl?: boolean } = {}): Word[] {
  let text = '';
  const owner: number[] = [];
  let last: Glyph | null = null;
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (INVISIBLE.has(g.text)) continue;
    if (isGeneratedBreak(g)) {
      let j = i;
      while (j < glyphs.length && isGeneratedBreak(glyphs[j])) j++;
      const next = glyphs[j];
      if (last && next && isVisible(next) && breakVerdict(last, next, o) === 'join') {
        if (alongGap(last, next) > 0.15 * Math.max(last.fontSize, next.fontSize)) {
          text += ' ';
          owner.push(g.index);
        }
        i = j - 1;
        continue;
      }
    }
    for (const unit of g.text.split('')) {
      text += unit;
      owner.push(g.index);
    }
    if (isVisible(g)) last = g;
  }
  const words: Word[] = [];
  for (const part of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
    if (!part.isWordLike) continue;
    words.push({ text: part.segment, start: owner[part.index], end: owner[part.index + part.segment.length - 1] + 1 });
  }
  return words;
}

/** `range` with whitespace, generated chars and invisible chars trimmed off both ends. */
export function trimmed(glyphs: Glyph[], range: { start: number; end: number }): [number, number] {
  const blank = (g: Glyph) => g.generated || INVISIBLE.has(g.text) || /^\s$/u.test(g.text);
  let a = range.start;
  let b = range.end;
  while (a < b && blank(glyphs[a])) a++;
  while (b > a && blank(glyphs[b - 1])) b--;
  return [a, b];
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded choices

export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` pairs of distinct glyph indices from `pool`: half anywhere, half within 40 glyphs of each other. */
export function seededPairs(pool: number[], n: number, seed: string): [number, number][] {
  const random = rng(seed);
  const pairs: [number, number][] = [];
  while (pairs.length < n) {
    const i = Math.floor(random() * pool.length);
    const near = pairs.length % 2 === 1;
    const j = near ? Math.min(pool.length - 1, Math.max(0, i + Math.floor((random() - 0.5) * 80))) : Math.floor(random() * pool.length);
    if (i !== j) pairs.push([pool[i], pool[j]]);
  }
  return pairs;
}

// ---------------------------------------------------------------------------------------------------------------
// Painting (R44)

/** The colour the selection must be painted in: the page's --text-selection token, else the spec's value. */
export async function selectionColour(page: Page): Promise<Rgba> {
  const css = await page.evaluate(() => getComputedStyle(document.querySelector('[data-page-index]') ?? document.documentElement).getPropertyValue('--text-selection'));
  return parseCssColor(css) ?? { r: 11, g: 87, b: 208, a: 0.3 };
}

/**
 * Screenshots the page as it is (saved under test-results as `name`) and judges how the current selection of `pageIndex` is
 * painted, against the engine's own line rectangles and glyph boxes for the same range.
 */
export async function judgePainting(page: Page, testInfo: TestInfo, pageIndex: number, name: string, ranges?: CharRange[]): Promise<PaintReport & { lineCount: number }> {
  const mine = (ranges ?? (await readSelection(page)).ranges).filter((r) => r.pageIndex === pageIndex);
  if (mine.length === 0) throw new Error('nothing is selected on the page');
  const glyphs = await glyphsOf(page, pageIndex);
  const map = await pageMap(page, pageIndex);
  const lines: Box[] = [];
  const selected: { tight: Box; loose: Box; fontSize: number }[] = [];
  for (const r of mine) {
    for (const rect of await rangeRects(page, pageIndex, r.start, r.end)) lines.push(map.box(rect));
    for (const g of glyphs.slice(r.start, r.end)) if (isVisible(g)) selected.push({ tight: map.box(g.tight), loose: map.box(g.box), fontSize: g.fontSize });
  }
  await page.mouse.move(2, 2);
  await settle(page, 250);
  const shot = await page.screenshot({ path: testInfo.outputPath(name) });
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const report = analyzeSelectionPaint(decodePng(shot), { orientation: map.orientation, dpr, pxPerPt: map.pxPerPt, lines, glyphs: selected, colour: await selectionColour(page) });
  return { ...report, lineCount: lines.length };
}

/** A one-line account of a painting report, for test annotations. */
export const describePaint = (r: PaintReport): string =>
  `${r.lines.length} lines, thickness ${r.lines.map((l) => l.thickness.toFixed(1)).join('/')} px, ${r.doubleBlendPixels} double-painted px, colour ${r.dominant?.join(',') ?? 'none'}`;
