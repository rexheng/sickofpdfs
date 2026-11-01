// Helpers for the Find (Ctrl+F) walkthroughs (Task 25). Written from the task's interface file only:
//  - Ctrl+F opens a bar with a search box labelled "Find in document", the count "{current+1} of {total}", previous and
//    next buttons and a close button;
//  - the hits are painted with the CSS tokens --find-hit (rgba(251,188,4,.4)) and --find-current (rgba(251,188,4,.8));
//  - Enter and Shift+Enter step, Esc closes, Alt+Enter selects the current hit as a real text selection.
// What the interface file leaves open is guessed here, in one place, and listed in the task-25 tests report:
//  - the bar is the search landmark (role="search") that holds the box, else "the nearest ancestor of the search box that
//    holds at least three buttons" (previous, next, close);
//  - the count is the first "N of M" in the bar's text; "No results" is that text, case-insensitive;
//  - a painted hit is any element in the viewer whose computed background (or SVG fill) is the token's colour.
// Triage after the first run (find-triage.md):
//  - The colours are read from the shipped CSS variables, not literals. The current hit is orange at .5 because yellow at
//    .8 left black text unreadable.
//  - The bar is the search landmark. The scan note sits under the row of buttons, so the row alone missed it.
//  - A hit is one SVG path with one rectangle (subpath) a line, so each subpath is counted as its own rectangle.
import type { Locator, Page } from '@playwright/test';
import { expect, rt, scrollerRect, settled } from './viewer.spec-blind';

export const FIND_LABEL = 'Find in document';
/** The interface file's --find-hit (tokens.css). The painted-hit scan reads both tokens from the page's CSS instead. */
export const FIND_HIT = { r: 251, g: 188, b: 4, a: 0.4 } as const;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * --find-hit and --find-current as the page's CSS has them, or null where a token is missing or not a colour. The build may
 * write a token in any colour syntax (#fbbc0466 for rgba(251,188,4,.4)), so each is resolved by painting a probe with it.
 */
export async function findTokens(page: Page): Promise<{ hit: Rgba | null; current: Rgba | null }> {
  return page.evaluate(() => {
    const host = document.querySelector('#viewer-root') ?? document.body;
    const parse = (v: string) => {
      const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i.exec(v);
      if (!m) return null;
      const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
      return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
    };
    const resolve = (name: string) => {
      if (getComputedStyle(host).getPropertyValue(name).trim() === '') return null;
      const probe = document.createElement('span');
      probe.style.backgroundColor = `var(${name})`;
      host.append(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return parse(c);
    };
    return { hit: resolve('--find-hit'), current: resolve('--find-current') };
  });
}

/** The search box. */
export const field = (page: Page): Locator => page.getByRole('searchbox', { name: FIND_LABEL });

/** The bar: the search landmark around the box, else its nearest ancestor with at least three buttons (previous, next, close). */
export const bar = (page: Page): Locator =>
  field(page).locator('xpath=ancestor::*[@role="search" or self::search][1]').or(field(page).locator('xpath=ancestor::*[count(.//button) >= 3][1]')).first();

/** Ctrl+F, then the box is on screen and has the keyboard, so typing needs no click. */
export async function openFind(page: Page): Promise<void> {
  await page.keyboard.press('Control+f');
  await expect(field(page), `Ctrl+F should open a find bar with a search box named "${FIND_LABEL}"`).toBeVisible({ timeout: 5_000 });
  await expect(field(page), 'the search box has the keyboard as soon as the bar opens').toBeFocused();
}

/** Puts `q` in the search box in one go (the way a paste does). */
export async function fillQuery(page: Page, q: string): Promise<void> {
  await field(page).fill(q);
}

export interface BarReading {
  /** The bar is on screen. */
  open: boolean;
  /** Everything the bar says. */
  text: string;
  /** "k of n" as numbers (k is 1-based), or null when the bar shows no count. */
  count: { current: number; total: number } | null;
  noResults: boolean;
}

/** What the bar shows right now. */
export async function readBar(page: Page): Promise<BarReading> {
  return page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="search"]'));
    const labelled = (el: HTMLInputElement) => {
      const names = [el.getAttribute('aria-label') ?? '', ...Array.from(el.labels ?? []).map((l) => l.textContent ?? '')];
      const by = el.getAttribute('aria-labelledby');
      if (by) for (const id of by.split(/\s+/)) names.push(document.getElementById(id)?.textContent ?? '');
      return names.some((n) => /find in document/i.test(n));
    };
    const box = boxes.find(labelled) ?? null;
    if (!box) return { open: false, text: '', count: null, noResults: false };
    let node: HTMLElement | null = box.closest<HTMLElement>('[role="search"], search');
    if (!node) {
      node = box;
      while (node && node.querySelectorAll('button').length < 3) node = node.parentElement;
    }
    const rect = (node ?? box).getBoundingClientRect();
    const text = (node ?? box).innerText.replace(/\s+/g, ' ').trim();
    const m = /(\d[\d,.]*)\s+of\s+(\d[\d,.]*)/i.exec(text);
    const num = (s: string) => Number(s.replace(/[^\d]/g, ''));
    return { open: rect.width > 0 && rect.height > 0, text, count: m ? { current: num(m[1]), total: num(m[2]) } : null, noResults: /no results/i.test(text) };
  });
}

/** Waits for the bar to say "current of total". */
export async function expectCount(page: Page, current: number, total: number, what: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => (await readBar(page)).count, { message: `${what}: the bar should say "${current} of ${total}"`, timeout, intervals: [50, 100, 200, 400] })
    .toEqual({ current, total });
}

/** Waits for the bar to settle on a total (the current hit may be anything) and returns what it shows. */
export async function expectTotal(page: Page, total: number, what: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => (await readBar(page)).count?.total ?? null, { message: `${what}: the bar should count ${total} hits`, timeout, intervals: [50, 100, 200, 400] })
    .toBe(total);
}

// ---- the painted hits ---------------------------------------------------------------------------------------------

export interface PaintedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  current: boolean;
  /** 0-based page the rectangle belongs to, from the page that holds it (data-page-index) or else from its place on screen. */
  pageIndex: number | null;
}

/**
 * Every rectangle in the viewer painted with --find-hit or --find-current: elements whose computed background colour
 * (or SVG fill) has the token's red, green and blue and its alpha (give or take 0.03), as the page's CSS sets them.
 */
export async function paintedRects(page: Page): Promise<PaintedRect[]> {
  const tokens = await findTokens(page);
  if (tokens.hit === null || tokens.current === null) throw new Error('the page has no --find-hit / --find-current colour tokens');
  const raw = await page.evaluate(
    ({ hit, current }) => {
      const parse = (s: string) => {
        const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/i.exec(s);
        if (!m) return null;
        const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
      };
      const near = (c: { r: number; g: number; b: number; a: number }, t: { r: number; g: number; b: number; a: number }) =>
        Math.abs(c.r - t.r) <= 2 && Math.abs(c.g - t.g) <= 2 && Math.abs(c.b - t.b) <= 2 && Math.abs(c.a - t.a) <= 0.03;
      const out: { x: number; y: number; width: number; height: number; current: boolean; page: number | null }[] = [];
      const root = document.querySelector('#viewer-root') ?? document.body;
      for (const el of Array.from(root.querySelectorAll<Element>('*'))) {
        const style = getComputedStyle(el);
        for (const colour of [style.backgroundColor, style.fill]) {
          const c = colour ? parse(colour) : null;
          if (!c) continue;
          const isCurrent = near(c, current);
          if (!isCurrent && !near(c, hit)) continue;
          const holder = el.closest<HTMLElement>('[data-page-index]');
          const page = holder ? Number(holder.dataset.pageIndex) : null;
          // One SVG path may paint several rectangles (one subpath a line): each subpath counts as its own rectangle.
          const d = el instanceof SVGPathElement ? (el.getAttribute('d') ?? '') : '';
          const parts = d.match(/[Mm][^Mm]*/g) ?? [];
          const boxes: DOMRect[] = [];
          if (parts.length > 1) {
            for (const part of parts) {
              const probe = el.cloneNode(false) as SVGPathElement;
              probe.setAttribute('d', part);
              el.after(probe);
              boxes.push(probe.getBoundingClientRect());
              probe.remove();
            }
          } else {
            boxes.push(el.getBoundingClientRect());
          }
          for (const r of boxes) {
            if (r.width < 1 || r.height < 1) continue;
            out.push({ x: r.left, y: r.top, width: r.width, height: r.height, current: isCurrent, page });
          }
          break;
        }
      }
      return out;
    },
    { hit: tokens.hit, current: tokens.current },
  );
  const rects: PaintedRect[] = [];
  for (const r of raw) {
    let pageIndex = r.page;
    if (pageIndex === null) pageIndex = (await rt(page).pdfPointAt(r.x + r.width / 2, r.y + r.height / 2))?.pageIndex ?? null;
    rects.push({ x: r.x, y: r.y, width: r.width, height: r.height, current: r.current, pageIndex });
  }
  return rects;
}

/** The current hit's rectangles (one per line it covers) and the other hits'. */
export async function paint(page: Page): Promise<{ current: PaintedRect[]; others: PaintedRect[] }> {
  const all = await paintedRects(page);
  return { current: all.filter((r) => r.current), others: all.filter((r) => !r.current) };
}

/**
 * Waits until the current hit is painted on `pageIndex` (0-based), lets any scrolling finish (a jump may be animated), and
 * checks that the hit is on screen. Returns its rectangles as they are once the page has stopped moving.
 */
export async function expectCurrentOnPage(page: Page, pageIndex: number, what: string, timeout = 10_000): Promise<PaintedRect[]> {
  await expect
    .poll(
      async () => {
        const now = (await paint(page)).current;
        return now.length > 0 ? now[0].pageIndex : 'nothing painted with --find-current';
      },
      { message: `${what}: the current hit should be painted (--find-current) on page ${pageIndex + 1}`, timeout, intervals: [50, 100, 200, 400] },
    )
    .toBe(pageIndex);
  await settled(() => rt(page).scrollTop(), 1, 4_000);
  const rects = (await paint(page)).current;
  expect(rects.length, `${what}: the current hit is still painted once the page has stopped moving`).toBeGreaterThan(0);
  const view = await scrollerRect(page);
  const mid = rects[0].y + rects[0].height / 2;
  expect(mid, `${what}: the current hit is scrolled into view`).toBeGreaterThanOrEqual(view.y);
  expect(mid, `${what}: the current hit is scrolled into view`).toBeLessThanOrEqual(view.y + view.height);
  return rects;
}

/** How many separate lines a set of rectangles covers (rectangles whose vertical middles are within half a line count as one). */
export function lineCount(rects: { y: number; height: number }[]): number {
  const mids = rects.map((r) => r.y + r.height / 2).sort((a, b) => a - b);
  let lines = 0;
  let last = -Infinity;
  const tall = Math.max(...rects.map((r) => r.height), 1);
  for (const m of mids) {
    if (m - last > tall / 2) lines++;
    last = m;
  }
  return lines;
}

/** The text of the page letters only: lower case is kept, accents are kept, anything that is not a letter or digit goes. */
export const lettersOnly = (s: string): string => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');

/** `lettersOnly`, lower case, accents removed: what two spellings of the same word have in common. */
export const fold = (s: string): string => lettersOnly(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
