// Spec-blind helpers for the Phase 2 Round 3 walkthroughs: figures, areas and pins (S16), and print with marks (S17).
//
// Written from the spec, the cross-phase contracts, plan sections 2 (S16, S17), 4 and 7, and research 06 section 4.
//
// How the walkthroughs see a figure. Where the figures are is NOT read from the product: it is the hand-drawn answer key of the figure
// reference set (e2e/reference/figures/labels.json, boxes in page points), turned into window px with the viewer's published page map.
// What the product draws is judged from SCREENSHOTS (an outline is a line along each of the four sides of the figure: rings.spec-blind.ts),
// and what it keeps is read through the store the viewer publishes (contracts section 2: `figure` anchors, `sub.point`, `sub.rect`).
//   - a hover or selection outline: the pixels that CHANGED between a screenshot with the pointer away and one with it on the figure;
//   - an area: a rectangle in the design token `--sop-area-outline` (plan S4: "Area marks keep color null and draw in --sop-area-outline");
//   - a pin: "a small numbered dot" (research 06 section 4): looked for as a small element with the number 1 in it near its place;
//   - the figure card: an `article` (the shared card of the notes walkthroughs) whose text reads "Figure N · p. M" with a thumbnail in it;
//   - Ctrl+C and "Copy image": the PNG the page hands to `navigator.clipboard.write` (recorded, see installClipboardRecorder).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { REPO_ROOT } from '../../support/launch';
import { frameOf, hexOf, type Frame, type RGB } from '../../support/rings.spec-blind';
import { TEST_ASSETS } from '../../support/server';
import { hooks } from '../../support/test';
import { pageMap, type TlFixture } from '../../support/tl-blind.spec-blind';
import { decodePng, parseCssColor, type Box, type Img } from '../../support/tl-paint.spec-blind';
import { annotations, openPaper, pageRect, settle, type Annotations, type OpenViewer } from './marks.spec-blind';

export { hexOf };
export type { Box, Frame, Img, RGB };

// ---------------------------------------------------------------------------------------------------------------
// What exists in this tree

/** Slice S16 (figures, areas, pins) puts its code here; the earlier author's two walkthroughs are guarded on the same folder. */
export const FIGURES_FOLDER = `${REPO_ROOT}apps/extension/src/viewer/figures`;
/** Slice S17 (print with marks) owns this file (plan section 2). */
export const PRINT_MARKS_FILE = `${REPO_ROOT}apps/extension/src/viewer/print/print-marks.ts`;
export const FIGURES_BUILT = existsSync(FIGURES_FOLDER);
export const PRINT_MARKS_BUILT = existsSync(PRINT_MARKS_FILE);

// ---------------------------------------------------------------------------------------------------------------
// The figures: the answer key of the figure reference set

interface KeyLabel {
  pageIndex: number;
  kind: 'figure' | 'table';
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}
interface Key {
  papers: { id: string; pages: number; labels: KeyLabel[] }[];
}
const KEY = JSON.parse(readFileSync(`${REPO_ROOT}e2e/reference/figures/labels.json`, 'utf8')) as Key;

export interface FigureSpec {
  /** The paper's id in e2e/reference/figures/manifest.json. */
  paperId: string;
  /** "Figure 1", as printed. */
  label: string;
  /** 0-based. */
  pageIndex: number;
  /** The hand-drawn box in page points, origin top-left (unrotated page, crop box at 0,0). */
  rect: { x: number; y: number; width: number; height: number };
  /** A short name for test titles. */
  name: string;
  /** Where in the figure to point and click, as 0 to 1 across and down its box: on the drawing, not in a gap between panels. */
  aim: { x: number; y: number };
  /** What to open: the paper, scrolled to the figure's page. */
  fx: TlFixture;
  /** The label the card is expected to carry: "Figure 1 · p. 7". */
  cardLabel: RegExp;
}

/** One figure of the answer key, with a name for test titles. The PDF itself is under test-assets/figures/ (the README of the set says how it is fetched). */
export function figureOf(paperId: string, label: string, name: string, aim = { x: 0.5, y: 0.5 }): FigureSpec {
  const paper = KEY.papers.find((p) => p.id === paperId);
  const hit = paper?.labels.find((l) => l.label === label && l.kind === 'figure');
  if (!paper || !hit) throw new Error(`the answer key has no "${label}" in ${paperId}`);
  return {
    paperId,
    label,
    pageIndex: hit.pageIndex,
    rect: hit.rect,
    name,
    aim,
    fx: { name: paperId, file: `figures/${paperId}.pdf`, page: hit.pageIndex, dir: 'ltr' },
    cardLabel: new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*·\\s*p\\.\\s*${hit.pageIndex + 1}(?!\\d)`, 'i'),
  };
}

/** A picture on page 1, in the right column of a two-column A4 paper (a raster figure, no text in it). Page 1, so no scrolling is needed. */
export const FIG_PICTURE = figureOf('arxiv-2205.15661', 'Figure 1', 'a picture on page 1');
/** Four vector plots on page 7 with their axis labels as text (so "a drag inside a figure is still a text selection" can be tried). */
export const FIG_PLOTS = figureOf('arxiv-2102.06767', 'Figure 1', 'four plots on page 7', { x: 0.3, y: 0.32 });
/** A plot in one column of page 5 of a paper of 18 pages (for the rail's Figures tab, which has to jump). */
export const FIG_COLUMN = figureOf('arxiv-2108.03509', 'Figure 2', 'a plot in one column on page 5');

/** A point in the body text of the page the figure is on, in page points, where there is no figure (a place to hover that is not a figure). */
export const BODY_TEXT_POINT: Record<string, { x: number; y: number }> = {
  'arxiv-2205.15661': { x: 150, y: 575 },
  'arxiv-2102.06767': { x: 130, y: 660 },
};

/** The window the figure walkthroughs use: wide enough for the page, the margin column and a moved page. */
export const FIG_WINDOW = { width: 1280, height: 1160 };

/** Opens the figure's paper at 100% on the figure's page. A missing PDF is a failure with the fix in the message, not a skip. */
export async function openFigurePaper(openViewer: OpenViewer, server: Parameters<typeof openPaper>[1], fig: FigureSpec): Promise<Page> {
  const file = join(TEST_ASSETS, fig.fx.file);
  if (!existsSync(file)) {
    throw new Error(`${fig.fx.file} is not in test-assets/: fetch it as e2e/reference/figures/README.md says ("Fetching the PDFs"), then run again`);
  }
  const page = await openPaper(openViewer, server, fig.fx, { viewport: FIG_WINDOW });
  await bringFigureIntoView(page, fig);
  return page;
}

// ---------------------------------------------------------------------------------------------------------------
// Where things are on the screen

/** The size of page `i` in points, as the viewer read it. */
export async function pageSizePt(page: Page, i: number): Promise<{ width: number; height: number }> {
  return hooks(page).eval((h, idx) => {
    const s = h.doc()!.open.pages[idx];
    return { width: s.width, height: s.height };
  }, i);
}

/** The figure's hand-drawn box on the screen now (window px). Scrolls it into the middle of the window first when it is not well inside. */
export async function figureBox(page: Page, fig: FigureSpec): Promise<Box> {
  await bringFigureIntoView(page, fig);
  return (await pageMap(page, fig.pageIndex)).box(fig.rect);
}

async function bringFigureIntoView(page: Page, fig: FigureSpec): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = (await pageMap(page, fig.pageIndex)).box(fig.rect);
    const view = await page.evaluate(() => {
      const r = document.querySelector('[role="document"]')!.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    if (box.top >= view.top + 80 && box.bottom <= view.bottom - 20) return;
    await page.evaluate((dy) => {
      document.querySelector<HTMLElement>('[role="document"]')!.scrollTop += dy;
    }, (box.top + box.bottom) / 2 - (view.top + view.bottom) / 2);
    await settle(page, 300);
  }
}

export const centreOf = (b: Box): { x: number; y: number } => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
/** A point `fx` and `fy` (0 to 1) of the way across and down the box. */
export const within = (b: Box, fx: number, fy: number): { x: number; y: number } => ({ x: b.left + (b.right - b.left) * fx, y: b.top + (b.bottom - b.top) * fy });
export const grow = (b: Box, by: number): Box => ({ left: b.left - by, top: b.top - by, right: b.right + by, bottom: b.bottom + by });

/** A page point (points from the top-left of the page) on the screen now. */
export async function clientOfPoint(page: Page, pageIndex: number, x: number, y: number): Promise<{ x: number; y: number }> {
  return (await pageMap(page, pageIndex)).toClient(x, y);
}

/** The pointer parked off the pages, where nothing is hovered (the gutter left of the page; no page is that far left in the 1280 px window). */
export const AWAY = { x: 8, y: 420 };

// ---------------------------------------------------------------------------------------------------------------
// Pictures of the screen

const dprCache = new WeakMap<Page, number>();
async function dprOf(page: Page): Promise<number> {
  const known = dprCache.get(page);
  if (known !== undefined) return known;
  const v = await page.evaluate(() => window.devicePixelRatio);
  dprCache.set(page, v);
  return v;
}

/** The clip of the window a screenshot of `b` will cover: whole device px, inside the window. */
function clampClip(page: Page, b: Box): Box {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  return { left: Math.max(0, Math.floor(b.left)), top: Math.max(0, Math.floor(b.top)), right: Math.min(size.width, Math.ceil(b.right)), bottom: Math.min(size.height, Math.ceil(b.bottom)) };
}
const shotOf = (page: Page, c: Box): Promise<Buffer> => page.screenshot({ clip: { x: c.left, y: c.top, width: c.right - c.left, height: c.bottom - c.top } });

/** A screenshot of `clip` (window px; the whole window when omitted), read as pixels. */
export async function snapFrame(page: Page, clip?: Box): Promise<Frame> {
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const c = clampClip(page, clip ?? { left: 0, top: 0, right: size.width, bottom: size.height });
  return frameOf(decodePng(await shotOf(page, c)), await dprOf(page), c.left, c.top);
}

/** The picture of `clip` once it has stopped changing (the page's sharp render and any fade are done), and how long one picture takes. */
export async function stableFrame(page: Page, clip: Box, timeout = 4000): Promise<{ frame: Frame; shotMs: number }> {
  const c = clampClip(page, clip);
  const deadline = Date.now() + timeout;
  let last = await shotOf(page, c);
  for (;;) {
    await page.waitForTimeout(150);
    const t0 = Date.now();
    const next = await shotOf(page, c);
    const shotMs = Date.now() - t0;
    if (Buffer.compare(last, next) === 0 || Date.now() > deadline) return { frame: frameOf(decodePng(next), await dprOf(page), c.left, c.top), shotMs };
    last = next;
  }
}

/** The colours of the design tokens the outlines are drawn in (the file in packages/ui is the only place the hex values live; the spec's are the fallback). */
export async function outlineTokens(page: Page): Promise<{ area: RGB; selected: RGB }> {
  const raw = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return { area: s.getPropertyValue('--sop-area-outline').trim(), selected: s.getPropertyValue('--sop-figure-selected-outline').trim() };
  });
  const rgb = (css: string, fallback: string): RGB => {
    const c = parseCssColor(css) ?? parseCssColor(fallback)!;
    return [c.r, c.g, c.b];
  };
  return { area: rgb(raw.area, '#e09b00'), selected: rgb(raw.selected, '#0b57d0') };
}

// ---------------------------------------------------------------------------------------------------------------
// Alt+drag

/** Alt held, press at `from`, drag to `to` in steps, release, Alt up: the area tool's gesture (spec: "Alt+drag"). */
export async function altDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.keyboard.down('Alt');
  try {
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps });
    await page.mouse.up();
  } finally {
    await page.keyboard.up('Alt');
  }
  await page.waitForTimeout(120);
}

// ---------------------------------------------------------------------------------------------------------------
// The clipboard: what the page hands over

export interface ClipboardWrite {
  /** The types of the item, in the order the page listed them. */
  types: string[];
  /** The bytes of each type. */
  bytes: Record<string, Uint8Array>;
}

/**
 * Runs inside every extension page of the context, before it loads (context.addInitScript). It wraps `navigator.clipboard.write`,
 * notes every item the page hands over (its types and bytes), and then passes the call on. A script cannot read a real clipboard
 * without a permission the page is not given in an automated browser, so the PNG is read where the page hands it over. Serialised by
 * Playwright: it must not refer to anything outside its own body.
 */
export function installClipboardRecorder(): void {
  if (location.protocol !== 'chrome-extension:') return;
  const log: { types: string[]; base64: Record<string, string> }[] = [];
  (window as unknown as { __sopClipboard: typeof log }).__sopClipboard = log;
  const clip = navigator.clipboard;
  if (!clip || typeof clip.write !== 'function') return;
  const original = clip.write.bind(clip);
  clip.write = async (items: ClipboardItems): Promise<void> => {
    for (const item of items) {
      const entry = { types: [...item.types], base64: {} as Record<string, string> };
      for (const type of item.types) {
        const blob = await item.getType(type);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        entry.base64[type] = btoa(s);
      }
      log.push(entry);
    }
    try {
      await original(items);
    } catch {
      // the automated browser may refuse the real clipboard; what the page handed over is what is judged
    }
  };
}

export async function useClipboardRecorder(context: BrowserContext): Promise<void> {
  await context.addInitScript(installClipboardRecorder);
}

/** Everything the page has handed to `navigator.clipboard.write` since it loaded. */
export async function clipboardWrites(page: Page): Promise<ClipboardWrite[]> {
  const raw = await page.evaluate(() => ((window as unknown as { __sopClipboard?: { types: string[]; base64: Record<string, string> }[] }).__sopClipboard ?? []).map((e) => ({ types: e.types, base64: e.base64 })));
  return raw.map((e) => ({ types: e.types, bytes: Object.fromEntries(Object.entries(e.base64).map(([k, v]) => [k, new Uint8Array(Buffer.from(v, 'base64'))])) }));
}

/** The PNGs among them, decoded. */
export async function copiedPngs(page: Page): Promise<Img[]> {
  const out: Img[] = [];
  for (const w of await clipboardWrites(page)) {
    for (const [type, bytes] of Object.entries(w.bytes)) if (type === 'image/png') out.push(decodePng(bytes));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Cards

/**
 * The card's thumbnail: the biggest picture element in the card (an avatar or an icon is smaller), its size on the screen and what is in it.
 * Null when the card shows no picture of at least 24 px.
 */
export async function thumbnailOf(card: Locator): Promise<{ width: number; height: number; img: Img } | null> {
  const els = card.locator('img, canvas, svg image');
  let best: { index: number; area: number; width: number; height: number } | null = null;
  for (let i = 0; i < (await els.count()); i++) {
    const box = await els.nth(i).boundingBox();
    if (box === null || box.width < 24 || box.height < 24) continue;
    if (best === null || box.width * box.height > best.area) best = { index: i, area: box.width * box.height, width: box.width, height: box.height };
  }
  if (best === null) return null;
  return { width: best.width, height: best.height, img: decodePng(await els.nth(best.index).screenshot()) };
}

// ---------------------------------------------------------------------------------------------------------------
// What is stored

/** An anchor as the store keeps it (contracts section 2), read loosely. */
export interface StoredAnchor {
  kind: string;
  page?: number;
  rect?: [number, number, number, number];
  point?: [number, number];
  figure?: { label: string | null; detector?: string };
  sub?: { rect?: [number, number, number, number]; point?: [number, number] };
}
export interface StoredNotes {
  marks: { style: string; color: number | null; anchor: StoredAnchor; pageIndex: number }[];
  threads: { id: string; anchor: StoredAnchor; pageIndex: number | null }[];
  comments: { threadId: string; body: string; author: string; draftOfTab: string | null }[];
}

/** What the library holds for the open PDF, without what was deleted. */
export async function storedNotes(page: Page): Promise<StoredNotes> {
  const a: Annotations = await annotations(page);
  return {
    marks: a.marks.filter((m) => m.deletedAt === null) as unknown as StoredNotes['marks'],
    threads: a.threads.filter((t) => t.deletedAt === null) as unknown as StoredNotes['threads'],
    comments: a.comments.filter((c) => c.deletedAt === null && c.draftOfTab === null) as unknown as StoredNotes['comments'],
  };
}

/** A stored 0-to-1 rectangle as a window box on the page now. */
export async function boxOfNorm(page: Page, pageIndex: number, n: [number, number, number, number]): Promise<Box> {
  const r = await pageRect(page, pageIndex);
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  return { left: r.left + n[0] * w, top: r.top + n[1] * h, right: r.left + n[2] * w, bottom: r.top + n[3] * h };
}

/** A window box as 0-to-1 of the page (the page measured now). */
export async function normOfBox(page: Page, pageIndex: number, b: Box): Promise<[number, number, number, number]> {
  const r = await pageRect(page, pageIndex);
  const w = r.right - r.left;
  const h = r.bottom - r.top;
  return [(b.left - r.left) / w, (b.top - r.top) / h, (b.right - r.left) / w, (b.bottom - r.top) / h];
}

/**
 * Whether a small round thing with the number `n` in it sits near (x, y): a numbered pin. It looks at every small element of the page
 * (an SVG circle or text, a button, a span) whose centre is within `radius` px of the point and whose text or accessible name
 * holds the number as a word. Where the spec names no markup, this does not guess one.
 */
export async function numberedPinNear(page: Page, at: { x: number; y: number }, n: number, radius = 18): Promise<{ found: boolean; seen: string[] }> {
  return page.evaluate(
    (q) => {
      const seen: string[] = [];
      const word = new RegExp(`(^|\\D)${q.n}(\\D|$)`);
      let found = false;
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.width > 48 || r.height > 48) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (Math.hypot(cx - q.x, cy - q.y) > q.radius) continue;
        const words = [el.textContent ?? '', el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? ''].map((s) => s.trim()).filter((s) => s !== '');
        seen.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} ${JSON.stringify(words)}`);
        if (words.some((s) => s.length <= 24 && word.test(s))) found = true;
      }
      return { found, seen };
    },
    { x: at.x, y: at.y, n, radius },
  );
}
