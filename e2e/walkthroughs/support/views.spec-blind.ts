// Helpers for walkthrough 18 (Task 26): rotate, two-page view and presentation mode.
//
// Written from the spec ("Rotate and views", the keyboard table) and the Task 26 interface file only. What the helpers assume of the
// product, all of it from that file:
//  - the View menu has rows named "Rotate clockwise", "Rotate counter-clockwise", "Two-page view" (a check box row) and "Presentation mode";
//  - Ctrl+] and Ctrl+[ turn the pages; the viewer's snapshot has `viewRotation` (0|90|180|270) and `twoPage` (boolean);
//  - presentation mode asks the browser for fullscreen (`document.fullscreenElement` is set while it lasts).
// Everything about what is SHOWN is judged from the screen (pixels, element boxes), as the owner would see it.
import type { Locator, Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import type { FixtureServer } from '../../support/test';
import { changed, type Frame } from '../../support/rings.spec-blind';
import { findOnPage, rangeText, settle, th } from '../../support/tl-blind.spec-blind';
import { printLog, type PrintLog } from './nav.spec-blind';
import { decodePng, readStrip, type CssRect } from './pixels.spec-blind';
import { expect, hooks, rt, settled, type ZoomMode } from './viewer.spec-blind';
import type { Box, Passage, Selected, TlFixture } from './marks.spec-blind';
import { snapFrame } from './figures.spec-blind';

// ---------------------------------------------------------------------------------------------------------------
// The names a person reads in the View menu (interface file, "Wording")

export const ROWS = {
  cw: /Rotate clockwise/,
  ccw: /Rotate counter-clockwise/,
  two: /Two-page view/,
  present: /Presentation mode/,
} as const;

/** A window wide enough for a page turned on its side (1056 px at 100%) and the margin column beside it. */
export const TURN_WINDOW = { width: 1500, height: 1160 };
/** A window wide enough for a pair of pages at 100% (1648 px) and the margin column beside the pair. */
export const PAIR_WINDOW = { width: 2300, height: 1160 };

// ---------------------------------------------------------------------------------------------------------------
// The view's own state

export interface ViewSnapshot {
  zoom: ZoomMode;
  scale: number;
  currentPage: number;
  viewRotation: number;
  twoPage: boolean;
  railOpen: boolean;
}

/** The viewer's snapshot with the two fields Task 26 adds. */
export async function view(page: Page): Promise<ViewSnapshot> {
  return (await rt(page).snapshot()) as unknown as ViewSnapshot;
}

export const isFullscreen = (page: Page): Promise<boolean> => page.evaluate(() => document.fullscreenElement !== null);

// ---------------------------------------------------------------------------------------------------------------
// The View menu

export async function openViewMenu(page: Page): Promise<Locator> {
  await page.getByRole('menubar').getByRole('menuitem', { name: 'View', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu, 'the View menu opens').toBeVisible();
  return menu;
}

export const rowIn = (menu: Locator, name: RegExp): Locator => menu.getByRole('menuitem', { name }).or(menu.getByRole('menuitemcheckbox', { name }));

/** View → the row, as a person would with the mouse. */
export async function chooseView(page: Page, name: RegExp): Promise<void> {
  const menu = await openViewMenu(page);
  const row = rowIn(menu, name);
  await expect(row, `View has a row named like ${name}`).toBeVisible();
  await row.click();
  await expect(page.getByRole('menu'), 'the menu closes when a row is chosen').toBeHidden();
}

/** Whether the View menu shows the Two-page view row ticked. Opens the menu and shuts it again. */
export async function twoPageTicked(page: Page): Promise<boolean> {
  const menu = await openViewMenu(page);
  const checked = await rowIn(menu, ROWS.two).getAttribute('aria-checked');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  return checked === 'true';
}

// ---------------------------------------------------------------------------------------------------------------
// Turning

/** Waits until the layout has stopped moving after a view change. */
export async function settleView(page: Page, ms = 350): Promise<void> {
  await settled(() => rt(page).scrollTop(), 0.5, 3_000);
  await settled(() => rt(page).scale(), 0.0005, 3_000);
  await settle(page, ms);
}

/** Ctrl+] (cw) or Ctrl+[ (ccw), then waits for the new turn to show and the layout to settle. Returns the new viewRotation. */
export async function turn(page: Page, dir: 'cw' | 'ccw'): Promise<number> {
  const before = (await view(page)).viewRotation;
  const want = (before + (dir === 'cw' ? 90 : 270)) % 360;
  await page.keyboard.press(dir === 'cw' ? 'Control+]' : 'Control+[');
  await expect
    .poll(async () => (await view(page)).viewRotation, { message: `${dir === 'cw' ? 'Ctrl+]' : 'Ctrl+['} turns the pages from ${before} to ${want} degrees`, timeout: 5_000, intervals: [50, 100, 200] })
    .toBe(want);
  await settleView(page);
  return want;
}

/** Waits until char `charIndex` of page `pageIndex` has a place on the screen (its text layer is built for the new turn). */
export async function waitGlyph(page: Page, pageIndex: number, charIndex: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const c = await th(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: pageIndex, i: charIndex });
        return Number.isFinite(c.x) && Number.isFinite(c.y);
      },
      { message: `char ${charIndex} of page ${pageIndex + 1} should have a place on the screen`, timeout: 10_000, intervals: [100, 200, 400] },
    )
    .toBe(true);
}

/** The passage's chars on a page, found by the engine (no mouse): what `selectPassage` would select. */
export async function charsOf(page: Page, fx: TlFixture, p: Passage): Promise<Selected> {
  const first = await findOnPage(page, fx.page, p.from);
  const last = await findOnPage(page, fx.page, p.to);
  const a = first.start;
  const b = last.start + last.count - 1;
  return { fx, a, b, text: await rangeText(page, fx.page, a, b + 1), ranges: [] };
}

/** The point of the PDF at the centre of the screen (a nearby point when the centre falls in the gap between pages). */
export async function passageAtCentre(page: Page): Promise<{ pageIndex: number; x: number; y: number }> {
  const r = await page.evaluate(() => {
    const s = document.querySelector('[role="document"]')!;
    const b = s.getBoundingClientRect();
    return { x: b.left + s.clientWidth / 2, y: b.top + b.height / 2 };
  });
  for (const dy of [0, 30, -30, 70, -70]) {
    const p = await rt(page).pdfPointAt(r.x, r.y + dy);
    if (p) return p;
  }
  throw new Error('no page under the centre of the screen');
}

/** The scroller's visible area: x, y, width (without the scroll bar), height; CSS px in the window. */
export async function visibleArea(page: Page): Promise<CssRect> {
  return page.evaluate(() => {
    const s = document.querySelector('[role="document"]')!;
    const b = s.getBoundingClientRect();
    return { x: b.left, y: b.top, width: s.clientWidth, height: b.height };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Which pages can be read off the screen (book-400: each page carries its number in squares)

export interface Shown {
  index: number;
  /** The page number its squares show, or null when they cannot be read (not drawn yet, or out of the picture). */
  n: number | null;
  rect: CssRect;
}

/** Every page element and the page number read off its squares on the screen (the visible part is the scroller, or the whole window in fullscreen). */
export async function pagesShown(page: Page): Promise<Shown[]> {
  const img = decodePng(await page.screenshot());
  const info = await page.evaluate(() => {
    const s = document.querySelector('[role="document"]');
    const sr = s?.getBoundingClientRect() ?? null;
    return {
      iw: window.innerWidth,
      ih: window.innerHeight,
      full: document.fullscreenElement !== null,
      scroller: s && sr ? { x: sr.left, y: sr.top, width: s.clientWidth, height: sr.height } : null,
      pages: Array.from(document.querySelectorAll('[data-page-index]')).map((e) => {
        const r = e.getBoundingClientRect();
        return { index: Number(e.getAttribute('data-page-index')), x: r.left, y: r.top, width: r.width, height: r.height };
      }),
    };
  });
  const ratio = img.width / info.iw;
  const visible: CssRect = info.full || info.scroller === null ? { x: 0, y: 0, width: info.iw, height: info.ih } : info.scroller;
  return info.pages.map((p) => {
    const rect = { x: p.x, y: p.y, width: p.width, height: p.height };
    let n: number | null = null;
    for (const strip of [0, 1, 2]) {
      n = readStrip(img, ratio, rect, visible, strip);
      if (n !== null) break;
    }
    return { index: p.index, n, rect };
  });
}

/** The page numbers readable on the screen now, in order. */
export async function numbersShown(page: Page): Promise<number[]> {
  return (await pagesShown(page))
    .map((p) => p.n)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b);
}

/** Waits until exactly these page numbers can be read off the screen. */
export async function expectShown(page: Page, want: number[], message: string, timeout = 8_000): Promise<void> {
  await expect.poll(() => numbersShown(page), { message, timeout, intervals: [60, 120, 250] }).toEqual(want);
}

// ---------------------------------------------------------------------------------------------------------------
// Presentation mode

export async function startPresentation(page: Page): Promise<void> {
  await chooseView(page, ROWS.present);
  await expect.poll(() => isFullscreen(page), { message: 'Presentation mode goes fullscreen', timeout: 8_000 }).toBe(true);
  await settle(page, 500);
}

export async function waitNotFullscreen(page: Page, why: string): Promise<void> {
  await expect.poll(() => isFullscreen(page), { message: `${why}: the page leaves fullscreen`, timeout: 8_000 }).toBe(false);
  await settle(page, 500);
}

/** Pixels of the screen outside `keep` (grown by `pad` px) that are not black, as a share of those pixels, and where the first is. */
export async function notBlackOutside(page: Page, keep: CssRect, pad = 4): Promise<{ share: number; first: { x: number; y: number } | null }> {
  const img = decodePng(await page.screenshot());
  const iw = await page.evaluate(() => window.innerWidth);
  const ratio = img.width / iw;
  const x0 = (keep.x - pad) * ratio;
  const x1 = (keep.x + keep.width + pad) * ratio;
  const y0 = (keep.y - pad) * ratio;
  const y1 = (keep.y + keep.height + pad) * ratio;
  let n = 0;
  let bad = 0;
  let first: { x: number; y: number } | null = null;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) continue;
      n++;
      const o = (y * img.width + x) * 4;
      const l = 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
      if (l > 28) {
        bad++;
        first ??= { x: x / ratio, y: y / ratio };
      }
    }
  }
  return { share: n === 0 ? 0 : bad / n, first };
}

/** The CSS cursor of whatever is under (x, y). */
export const cursorAt = (page: Page, x: number, y: number): Promise<string | null> =>
  page.evaluate(([px, py]) => {
    const el = document.elementFromPoint(px, py);
    return el ? getComputedStyle(el).cursor : null;
  }, [x, y] as const);

/** The share of pixels of `frame` that differ from `other` outside `keep` (each grown by `pad` px), over the whole window. */
export function changedOutside(frame: Frame, other: Frame, keep: Box[], pad: number): number {
  const probe = changed(frame, other);
  let n = 0;
  let hit = 0;
  for (let y = 0; y < frame.img.height; y++) {
    for (let x = 0; x < frame.img.width; x++) {
      const cx = x / frame.dpr + frame.ox;
      const cy = y / frame.dpr + frame.oy;
      if (keep.some((k) => cx >= k.left - pad && cx <= k.right + pad && cy >= k.top - pad && cy <= k.bottom + pad)) continue;
      n++;
      if (probe(x, y)) hit++;
    }
  }
  return n === 0 ? 0 : hit / n;
}

export { snapFrame };

// ---------------------------------------------------------------------------------------------------------------
// Timing a turn, in the page

export interface TurnTiming {
  /** ms from the key press (capture phase) to the first frame that shows the turned page with its picture. */
  ms: number;
}

/**
 * Installs a timer in the page: at Ctrl+] or Ctrl+[ (capture phase) it notes the event time, then watches every animation frame until the
 * viewer's snapshot has the new turn AND the page in view is on screen turned the new way (its box is landscape if the pages are portrait and
 * the turn is 90 or 270, and the other way round otherwise) AND its canvas has ink. The time of the first such frame, minus the key's time, is how
 * long the turn took. Pages must be portrait when the timer is installed.
 */
export async function installTurnTimer(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Hooks = { viewer: { snapshot(): { viewRotation: number }; currentPage(): number } };
    const w = window as unknown as { __turn: { keyAt: number | null; doneAt: number | null }; __sopTest: Hooks };
    w.__turn = { keyAt: null, doneAt: null };
    // The viewer's own key handler may run before this one, so the turn before the key is tracked here, not read at the key.
    let current = w.__sopTest.viewer.snapshot().viewRotation;
    const hasInk = async (c: HTMLCanvasElement): Promise<boolean> => {
      if (c.width < 16 || c.height < 16) return false;
      const bmp = await createImageBitmap(c, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'medium' });
      const oc = new OffscreenCanvas(64, 64);
      const ctx = oc.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const px = ctx.getImageData(0, 0, 64, 64).data;
      for (let i = 0; i < px.length; i += 4) if ((px[i + 3] ?? 0) > 200 && 0.299 * (px[i] ?? 0) + 0.587 * (px[i + 1] ?? 0) + 0.114 * (px[i + 2] ?? 0) < 240) return true;
      return false;
    };
    window.addEventListener(
      'keydown',
      (e) => {
        if (!e.ctrlKey || (e.key !== ']' && e.key !== '[')) return;
        w.__turn.keyAt = e.timeStamp;
        w.__turn.doneAt = null;
        const want = (current + (e.key === ']' ? 90 : 270)) % 360;
        current = want;
        const tick = async (): Promise<void> => {
          if (w.__turn.doneAt !== null) return;
          if (w.__sopTest.viewer.snapshot().viewRotation === want) {
            const el = document.querySelector(`[data-page-index="${w.__sopTest.viewer.currentPage()}"]`);
            const r = el?.getBoundingClientRect();
            const canvas = el?.querySelector('canvas') ?? null;
            const sideways = want % 180 === 90;
            if (r && canvas && r.width > 0 && r.height > 0 && r.width > r.height === sideways && (await hasInk(canvas))) {
              requestAnimationFrame(() => {
                w.__turn.doneAt = performance.now();
              });
              return;
            }
          }
          requestAnimationFrame(() => void tick());
        };
        void tick();
      },
      true,
    );
  });
}

/** Presses a turn key and returns how long the turn took, from the key to the turned page on screen. */
export async function timedTurn(page: Page, dir: 'cw' | 'ccw'): Promise<TurnTiming> {
  await page.keyboard.press(dir === 'cw' ? 'Control+]' : 'Control+[');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __turn: { doneAt: number | null } }).__turn.doneAt), { message: 'the turned page never showed up', timeout: 10_000, intervals: [50, 100] })
    .not.toBeNull();
  const t = await page.evaluate(() => (window as unknown as { __turn: { keyAt: number; doneAt: number } }).__turn);
  return { ms: t.doneAt - t.keyAt };
}

// ---------------------------------------------------------------------------------------------------------------
// Printing (as walkthrough 17 does it: window.print() is a recorder; the PDF the browser would print is asked of Chromium)

const MARKS_WORD = /\b(?:marks?|notes?|annotations?)\b/i;
const WITH_MARKS = /^(?!.*\b(?:without|no|exclude)\b)(?=.*\b(?:marks?|notes?|annotations?)\b).*\b(?:with|include|print)\b/i;
const WITHOUT_MARKS = /\bwithout\b.*\b(?:marks?|notes?|annotations?)\b|\bno\s+(?:marks?|notes?|annotations?)\b|\bexclude\b|\bpages? only\b|\bjust the pages\b|\bplain\b/i;

/**
 * Ctrl+P, then the choice if the viewer asks for one (a button or box named for the marks, and a Print button), then waits for the viewer to ask
 * the browser to print. Returns the print log after the call.
 */
export async function printNow(page: Page, withMarks: boolean | null): Promise<PrintLog> {
  const before = (await printLog(page)).calls;
  await page.keyboard.press('Control+p');
  if (withMarks === null) {
    // R99: Ctrl+P's first step asks which pages even with no marks; All is chosen and Enter means Print.
    const step = page.getByRole('dialog', { name: 'Print' });
    if (await step.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false)) await page.keyboard.press('Enter');
  } else {
    const wanted = withMarks ? WITH_MARKS : WITHOUT_MARKS;
    const roles = ['button', 'radio', 'menuitemradio', 'menuitem', 'option', 'tab'] as const;
    const pick = roles.map((role) => page.getByRole(role, { name: wanted })).reduce((a, b) => a.or(b));
    const tick = page.getByRole('checkbox', { name: MARKS_WORD }).or(page.getByRole('switch', { name: MARKS_WORD })).or(page.getByRole('menuitemcheckbox', { name: MARKS_WORD }));
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if ((await printLog(page)).calls > before) break;
      if (await pick.first().isVisible().catch(() => false)) await pick.first().click();
      else if (await tick.first().isVisible().catch(() => false)) await tick.first().setChecked(withMarks);
      else {
        await page.waitForTimeout(150);
        continue;
      }
      const go = page.getByRole('dialog').getByRole('button', { name: /^(?:print|continue|ok|next|start)\b/i });
      if (await go.first().isVisible({ timeout: 600 }).catch(() => false)) await go.first().click();
      break;
    }
  }
  await expect.poll(async () => (await printLog(page)).calls, { message: 'Ctrl+P ends in window.print()', timeout: 120_000, intervals: [200, 500, 1000] }).toBeGreaterThan(before);
  return printLog(page);
}

/** The PDF the browser would print right now, with the print copy disposed afterwards as the browser's afterprint does. */
export async function printedPdf(page: Page): Promise<Buffer> {
  const afterprint = (await printLog(page)).afterprint;
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  await page.emulateMedia({ media: null });
  if ((await printLog(page)).afterprint === afterprint) await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#sop-print-root'), 'after printing the print copy is disposed').toHaveCount(0, { timeout: 8_000 });
  return pdf;
}

/** The size of every sheet of a printed PDF, in points. */
export async function sheetSizes(pdf: Buffer): Promise<{ width: number; height: number }[]> {
  return (await PDFDocument.load(pdf)).getPages().map((p) => p.getSize());
}

/** The printout opened in a viewer tab at 100%, to be photographed sheet by sheet. */
export async function openPrintout(openViewer: (source: string) => Promise<Page>, server: FixtureServer, pdf: Buffer, name: string, size: { width: number; height: number }): Promise<Page> {
  server.serveSequence(`/p/${name}.pdf`, [pdf]);
  const out = await openViewer(server.url(`/p/${name}.pdf`));
  await out.setViewportSize(size);
  await expect.poll(() => rt(out).state(), { message: 'the printout opens', timeout: 45_000 }).toBe('ready');
  await hooks(out).eval((h) => h.viewer.setScale(1));
  return out;
}

/** Sheet `i` of a printout on the screen: its picture and where the sheet is. */
export async function sheetOf(out: Page, i: number): Promise<{ frame: Frame; box: Box }> {
  await hooks(out).eval((h, idx) => h.viewer.scrollTo(idx), i);
  await out.waitForSelector(`[data-page-index="${i}"]`, { state: 'attached' });
  await settle(out, 1_200);
  await out.mouse.move(4, 420);
  const frame = await snapFrame(out);
  const r = await out.evaluate((idx) => {
    const e = document.querySelector(`[data-page-index="${idx}"]`)!.getBoundingClientRect();
    return { left: e.left, top: e.top, right: e.right, bottom: e.bottom };
  }, i);
  return { frame, box: r };
}
