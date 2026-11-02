// Helpers for the caret browsing walkthroughs (ruling R93). Written from the spec only (R93, the keyboard table, R71 and R72) and the
// existing selection helpers. The feature publishes no test hook of its own that this file may rely on, so it looks at what the owner
// sees and does:
//   - the switch is a check row named "Caret browsing" in the View menu, and a row of the shortcut sheet with its key (read off the sheet);
//   - WHERE THE CURSOR IS is read the way a person finds out: press Shift+Right and see which letter the selection starts on, then
//     Shift+Left to take it back ("Shift plus any of those keys extends the selection from the cursor"). Nothing else is trusted,
//     because a click puts a collapsed selection in the page whether or not the feature works;
//   - whether a cursor is DRAWN is read from the pixels: two screenshots of the same strip, one with the cursor on it and one with it
//     elsewhere, and a thin vertical band where they differ;
//   - what is announced is read from the live regions of the page (a MutationObserver started before the key is pressed).
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import jpeg from 'jpeg-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Glyph } from '../../../packages/viewer/src/backend/types';
import { decodePng, type Img } from '../../support/tl-paint.spec-blind';
import { isVisible, pageMap, readSelection, th, wordsOf, type CharRange, type PageMap, type Word } from '../../support/tl-blind.spec-blind';
import { WALKTHROUGH_DIR, served } from './fixtures.spec-blind';
import { openViewMenu, rowIn } from './views.spec-blind';
import { expect, scrollerRect, snap } from './viewer.spec-blind';

// ---------------------------------------------------------------------------------------------------------------
// The switch

/** The name a person reads in the View menu and in the shortcut sheet (R93: View → "Caret browsing"). */
export const CARET_ROW = /caret browsing/i;

/** Whether View → Caret browsing is ticked. Opens the menu and shuts it again. */
export async function caretTicked(page: Page): Promise<boolean> {
  const menu = await openViewMenu(page);
  const row = rowIn(menu, CARET_ROW);
  await expect(row, 'View has a row named "Caret browsing" (R93: "View → Caret browsing")').toBeVisible();
  const checked = await row.getAttribute('aria-checked');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu'), 'Esc shuts the View menu').toBeHidden();
  expect(checked, 'the Caret browsing row is a check row: it says whether it is on (R93: "with a check mark")').toMatch(/^(?:true|false)$/);
  return checked === 'true';
}

/** View → Caret browsing, with the mouse, as a person would. */
export async function clickCaretRow(page: Page): Promise<void> {
  const menu = await openViewMenu(page);
  const row = rowIn(menu, CARET_ROW);
  await expect(row, 'View has a row named "Caret browsing"').toBeVisible();
  await row.click();
  await expect(page.getByRole('menu'), 'the menu closes when a row is chosen').toBeHidden();
}

/** Makes the switch on or off through the View menu (nothing happens if it already is). */
export async function setCaret(page: Page, on: boolean): Promise<void> {
  if ((await caretTicked(page)) === on) return;
  await clickCaretRow(page);
  await expect.poll(() => caretTicked(page), { message: `View → Caret browsing should now be ${on ? 'ticked' : 'not ticked'}`, timeout: 5_000, intervals: [100, 200, 400] }).toBe(on);
}

export interface Shortcut {
  /** The keys as the sheet writes them ("F7", "Ctrl+Alt+K"). */
  labels: string[];
  /** The first of them, as Playwright presses it. */
  press: string;
  /** How many other rows of the sheet show the same key. */
  clashes: number;
}

/** Keys the research notes say never to bind (Chrome's own, Windows', and the AltGr trap), except F7, which R93 allows "if Chrome lets the viewer have it". */
export const RESERVED_KEYS = [
  'Ctrl+T', 'Ctrl+N', 'Ctrl+Shift+N', 'Ctrl+W', 'Ctrl+Shift+W', 'Ctrl+L', 'Ctrl+E', 'Ctrl+J', 'Ctrl+Shift+B', 'Ctrl+Shift+O', 'Ctrl+U', 'Ctrl+Shift+I',
  'Ctrl+Shift+J', 'Ctrl+Shift+C', 'Ctrl+Shift+M', 'Ctrl+Shift+A', 'F5', 'F6', 'F10', 'F12', 'Shift+F10', 'Alt+F', 'Alt+F4', 'Alt+Home', 'Ctrl+Space', 'Ctrl+Alt+Left', 'Ctrl+Alt+Right',
  'Ctrl+Alt+Up', 'Ctrl+Alt+Down',
].map((k) => k.toLowerCase());

/** Whether the key is a single key or Ctrl+Alt+key: the kind that never fires while the owner is typing (spec, Shortcuts). */
export const yieldsToTyping = (label: string): boolean => !/\bCtrl\b/.test(label) || /\bCtrl\b.*\bAlt\b|\bAlt\b.*\bCtrl\b/.test(label);

/** The key names the sheet writes (formatCombo) as Playwright's names for them. */
export function pressName(label: string): string {
  const parts = label.split('+');
  const key = label.endsWith('++') ? '+' : (parts.pop() ?? '');
  const mods = (label.endsWith('++') ? label.slice(0, -2).split('+').filter(Boolean) : parts).map((m) => (m === 'Ctrl' ? 'Control' : m));
  const named: Record<string, string> = { Plus: '+', Minus: '-', Esc: 'Escape', 'Page Down': 'PageDown', 'Page Up': 'PageUp', Space: ' ', 'Menu key': 'ContextMenu' };
  const k = named[key] ?? (key.length === 1 && !mods.includes('Shift') ? key.toLowerCase() : key);
  return [...mods, k].join('+');
}

/** "?" opens the shortcut sheet; this reads the keys on the row named like Caret browsing, and shuts the sheet. */
export async function caretShortcut(page: Page, testInfo?: TestInfo): Promise<Shortcut> {
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: /shortcuts/i });
  await expect(sheet, '"?" opens the shortcut sheet').toBeVisible({ timeout: 5_000 });
  const label = sheet.getByText(CARET_ROW).first();
  await expect(label, 'the shortcut sheet lists "Caret browsing" (R93: "It is listed in the shortcut sheet")').toBeVisible();
  const row = label.locator('xpath=ancestor::tr[1]').or(label.locator('xpath=ancestor::*[.//kbd][1]')).first();
  const labels = (await row.locator('kbd').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
  const all = (await sheet.locator('kbd').allInnerTexts()).map((t) => t.trim().toLowerCase());
  const clashes = all.filter((k) => k === labels[0]?.toLowerCase()).length - 1;
  if (testInfo) await snap(page, testInfo, '1a-shortcut-sheet');
  await page.keyboard.press('Escape');
  await expect(sheet, 'Esc shuts the shortcut sheet').toBeHidden();
  expect(labels.length, 'the sheet shows a key for Caret browsing (R93: "with a check mark and a shortcut")').toBeGreaterThan(0);
  return { labels, press: pressName(labels[0]), clashes };
}

// ---------------------------------------------------------------------------------------------------------------
// Pressing keys

/** One animation frame or two, but never longer than 300 ms (a tab in the background has no frames). */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((done) => {
        const limit = setTimeout(done, 300);
        let k = 0;
        const step = () => {
          if (++k >= count) {
            clearTimeout(limit);
            done();
          } else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    n,
  );
}

/** Presses `key` `times` times, one frame after each (a scroll or a repaint may follow a key). */
export async function press(page: Page, key: string, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press(key);
    await frames(page, 2);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Where the cursor is

export interface Caret {
  pageIndex: number;
  /** The char the cursor stands in front of (the index of the engine's text of that page). */
  index: number;
}

/**
 * Where the cursor is, read the way a person would: Shift+Right extends the selection from the cursor, so the selection starts where the
 * cursor was; Shift+Left takes the letter back. At the very end of the PDF there is no letter to the right, so it is Shift+Left, and the
 * selection ends where the cursor was. Returns null when neither key selects anything. A selection must not be on already.
 * Triage-proof by design: only the selection ranges of the page are read.
 */
export async function caretAt(page: Page): Promise<Caret | null> {
  const before = (await readSelection(page)).ranges.filter((r) => r.end > r.start);
  if (before.length > 0) throw new Error(`caretAt: a selection is on (${JSON.stringify(before)}); collapse it first, the probe would change it`);
  let at: Caret | null = null;
  await press(page, 'Shift+ArrowRight');
  let ranges = (await readSelection(page)).ranges.filter((r) => r.end > r.start);
  if (ranges.length > 0) {
    at = { pageIndex: ranges[0].pageIndex, index: ranges[0].start };
    await press(page, 'Shift+ArrowLeft');
  } else {
    await press(page, 'Shift+ArrowLeft');
    ranges = (await readSelection(page)).ranges.filter((r) => r.end > r.start);
    const last = ranges[ranges.length - 1];
    if (last) {
      at = { pageIndex: last.pageIndex, index: last.end };
      await press(page, 'Shift+ArrowRight');
    }
  }
  if ((await readSelection(page)).ranges.some((r) => r.end > r.start)) await press(page, 'Escape'); // "Esc collapses the selection back to the cursor"
  return at;
}

/** The selection as ranges with something in them (a collapsed range is not a selection). */
export async function selected(page: Page): Promise<CharRange[]> {
  return (await readSelection(page)).ranges.filter((r) => r.end > r.start);
}

// ---------------------------------------------------------------------------------------------------------------
// Lines, columns, words, plain runs: what the engine says the page is made of

export interface Line {
  n: number;
  /** The first and the last VISIBLE glyph of the line (char indices). */
  first: number;
  last: number;
  glyphs: Glyph[];
}

/** Lines of visible glyphs in char order: a new line starts when the vertical centre moves by more than half a font size. */
export function linesOf(glyphs: Glyph[], pick: (g: Glyph) => boolean = () => true): Line[] {
  const out: Line[] = [];
  let cy = Number.NaN;
  for (const g of glyphs) {
    if (!isVisible(g) || !pick(g)) continue;
    const y = g.box.y + g.box.height / 2;
    const cur = out[out.length - 1];
    if (!cur || Math.abs(y - cy) > 0.5 * g.fontSize) {
      out.push({ n: out.length, first: g.index, last: g.index, glyphs: [g] });
      cy = y;
    } else {
      cur.last = g.index;
      cur.glyphs.push(g);
    }
  }
  return out;
}

/**
 * The lines the cursor in front of char `index` can be on. The cursor at the very end of a line and at the very start of the next one
 * are different places on the screen but can be the same char index (the line break between them is not a letter), so a cursor in or next
 * to that gap counts for both lines.
 */
export function linesAt(lines: Line[], index: number): number[] {
  const out = new Set<number>();
  lines.forEach((l, i) => {
    if (index >= l.first && index <= l.last + 1) out.add(i);
  });
  for (let i = 0; i + 1 < lines.length; i++) {
    if (index > lines[i].last + 1 && index < lines[i + 1].first) {
      out.add(i);
      out.add(i + 1);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Where, across the page in points, the cursor in front of char `index` stands (the left edge of that glyph, else the right edge of the one before). */
export function xBefore(glyphs: Glyph[], index: number): number {
  const g = glyphs[index];
  if (g && !g.generated && g.box.width > 0) return g.box.x;
  const p = glyphs[index - 1];
  if (p && !p.generated && p.box.width > 0) return p.box.x + p.box.width;
  return Number.NaN;
}

/** The two columns of a page whose text reads left column first: lines by glyph centre left or right of the middle. */
export function columnsOf(glyphs: Glyph[], pageWidth: number): { left: Line[]; right: Line[]; all: Line[] } {
  const midX = pageWidth / 2;
  const side = (g: Glyph) => g.box.x + g.box.width / 2 < midX;
  const left = linesOf(glyphs, side);
  const right = linesOf(glyphs, (g) => !side(g));
  return { left, right, all: [...left, ...right] };
}

/** The first run of `n` chars in [from, to) that are all plain letters (one UTF-16 unit, no ligature, no break). Returns the first index. */
export function plainRun(glyphs: Glyph[], from: number, to: number, n: number): number {
  for (let i = from; i + n <= to; i++) {
    let ok = true;
    for (let j = i; j < i + n && ok; j++) ok = !glyphs[j].generated && /^\p{L}$/u.test(glyphs[j].text) && glyphs[j].box.width > 0;
    if (ok) return i;
  }
  throw new Error(`no run of ${n} plain letters between chars ${from} and ${to}`);
}

/**
 * `n` words in a row on one line, each only letters, one space between them: the first such run on the first of `lines[from..]` that has one.
 * Returns the line and the words.
 */
export function wordRun(glyphs: Glyph[], lines: Line[], from: number, n: number): { line: Line; words: Word[] } {
  const all = wordsOf(glyphs, 'en');
  for (const line of lines.slice(from)) {
    const words = all.filter((w) => w.start >= line.first && w.end <= line.last + 1 && /^\p{L}+$/u.test(w.text));
    for (let i = 0; i + n <= words.length; i++) {
      let ok = true;
      for (let j = i; j < i + n - 1 && ok; j++) ok = words[j + 1].start === words[j].end + 1 && glyphs[words[j].end]?.text === ' ';
      if (ok) return { line, words: words.slice(i, i + n) };
    }
  }
  throw new Error(`no ${n} plain words in a row on any line from line ${from}`);
}

/** `n` lines in a row (from `from`) that are long enough for the cursor to keep its place across them. */
export function longLines(lines: Line[], from: number, to: number, n: number, minGlyphs = 35): number {
  for (let i = from; i + n <= to; i++) if (lines.slice(i, i + n).every((l) => l.glyphs.length >= minGlyphs)) return i;
  throw new Error(`no ${n} long lines in a row between line ${from} and ${to}`);
}

// ---------------------------------------------------------------------------------------------------------------
// The mouse

/**
 * Clicks in front of glyph `g` (the left quarter of its box) or after it (the right quarter): where a person aims to put the cursor between
 * two letters. Waits a little afterwards so that two clicks in a row are never taken for a double-click.
 */
export async function clickAt(page: Page, pageIndex: number, g: Glyph, side: 'before' | 'after' = 'before'): Promise<{ x: number; y: number }> {
  const map = await pageMap(page, pageIndex);
  const p = map.toClient(g.box.x + g.box.width * (side === 'before' ? 0.25 : 0.75), g.box.y + g.box.height / 2);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(560);
  return p;
}

/** Where the char `index` is on the screen right now (client px), or null when it has no place (a line break). */
export async function whereIs(page: Page, pageIndex: number, glyphs: Glyph[], index: number): Promise<{ x: number; y: number } | null> {
  for (const i of [index, index - 1, index + 1, index - 2]) {
    if (!glyphs[i] || !isVisible(glyphs[i])) continue;
    const c = await th(page).eval((h, q) => h.glyphCenter(q.p, q.i), { p: pageIndex, i });
    if (Number.isFinite(c.x) && Number.isFinite(c.y)) return c;
  }
  return null;
}

/** Whether the glyph next to the cursor is inside the page list's visible area. */
export async function inView(page: Page, pageIndex: number, glyphs: Glyph[], index: number): Promise<boolean> {
  const at = await whereIs(page, pageIndex, glyphs, index);
  if (!at) return false;
  const r = await scrollerRect(page);
  return at.x >= r.x && at.x <= r.x + r.width && at.y >= r.y && at.y <= r.y + r.height;
}

// ---------------------------------------------------------------------------------------------------------------
// Is a cursor DRAWN? (pixels)

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A strip around the boundary in front of glyph `g`: 20 px wide, the glyph's height and 3 px more above and below. For upright pages. */
export function caretClip(map: PageMap, g: Glyph): Clip {
  const x = xBefore([g], 0);
  const top = map.toClient(x, g.box.y);
  const bottom = map.toClient(x, g.box.y + g.box.height);
  return { x: Math.round(top.x) - 10, y: Math.round(Math.min(top.y, bottom.y)) - 3, width: 20, height: Math.round(Math.abs(bottom.y - top.y)) + 6 };
}

export async function grabClip(page: Page, clip: Clip): Promise<Img> {
  return decodePng(await page.screenshot({ clip }));
}

export interface Band {
  /** A thin vertical band (at most 4 CSS px wide) where the two pictures differ over most of the strip's height. */
  present: boolean;
  /** Where its middle is, CSS px from the left of the strip. */
  centre: number | null;
  /** How wide it is, CSS px. */
  width: number | null;
  /** The share of the strip's height it covers. */
  coverage: number | null;
}

/**
 * The thin vertical band in which `a` (a picture with the cursor) differs from `b` (the same strip without it). A column counts when
 * at least `minCoverage` of its pixels differ by more than `delta` in some colour; neighbouring columns make one band.
 */
export function caretBand(a: Img, b: Img, clip: Clip, o: { delta?: number; minCoverage?: number } = {}): Band {
  const delta = o.delta ?? 40;
  const minCoverage = o.minCoverage ?? 0.4;
  const ratio = a.width / clip.width;
  const cover: number[] = [];
  for (let x = 0; x < a.width; x++) {
    let n = 0;
    for (let y = 0; y < a.height; y++) {
      const i = (y * a.width + x) * 4;
      if (Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2])) > delta) n++;
    }
    cover.push(n / a.height);
  }
  const runs: { from: number; to: number; coverage: number }[] = [];
  for (let x = 0; x < cover.length; x++) {
    if (cover[x] < minCoverage) continue;
    let end = x;
    while (end + 1 < cover.length && cover[end + 1] >= minCoverage) end++;
    runs.push({ from: x, to: end, coverage: Math.max(...cover.slice(x, end + 1)) });
    x = end;
  }
  const thin = runs.filter((r) => (r.to - r.from + 1) / ratio <= 4).sort((l, r) => r.coverage - l.coverage)[0];
  const shown = thin ?? runs.sort((l, r) => r.to - r.from - (l.to - l.from))[0];
  if (!shown) return { present: false, centre: null, width: null, coverage: null };
  return { present: thin !== undefined, centre: (shown.from + shown.to + 1) / 2 / ratio, width: (shown.to - shown.from + 1) / ratio, coverage: shown.coverage };
}

/** `count` pictures of the strip, `every` ms apart. */
export async function sampleClip(page: Page, clip: Clip, count: number, every: number): Promise<Img[]> {
  const out: Img[] = [];
  for (let i = 0; i < count; i++) {
    out.push(await grabClip(page, clip));
    await page.waitForTimeout(every);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// What a screen reader is told

export interface Announcement {
  text: string;
  /** 'polite', 'assertive', 'off', or null for an element that is no live region. */
  politeness: string | null;
}

/** Starts writing down every change of every live region (aria-live, role status, alert or log). Call before the key is pressed. */
export async function startLiveLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __live?: { text: string; politeness: string | null }[]; __liveOn?: boolean };
    w.__live = [];
    if (w.__liveOn === true) return;
    w.__liveOn = true;
    const SEL = '[aria-live], [role="status"], [role="alert"], [role="log"]';
    const politeness = (el: Element): string | null => {
      const a = el.getAttribute('aria-live');
      if (a !== null && a !== '') return a;
      const r = el.getAttribute('role');
      return r === 'alert' ? 'assertive' : r === 'status' || r === 'log' ? 'polite' : null;
    };
    const regionOf = (n: Node): Element | null => (n instanceof Element ? n : n.parentElement)?.closest(SEL) ?? null;
    new MutationObserver((records) => {
      const regions = new Set<Element>();
      for (const m of records) {
        for (const n of [m.target, ...Array.from(m.addedNodes)]) {
          const r = regionOf(n);
          if (r) regions.add(r);
          if (n instanceof Element) n.querySelectorAll(SEL).forEach((inner) => regions.add(inner));
        }
      }
      for (const r of regions) w.__live!.push({ text: r.textContent ?? '', politeness: politeness(r) });
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['aria-live', 'role'] });
  });
}

export async function liveLog(page: Page): Promise<Announcement[]> {
  return page.evaluate(() => (window as unknown as { __live?: Announcement[] }).__live ?? []);
}

/** Letters and digits only, lower case, accents off: what two spellings of one line have in common. */
export const letters = (s: string): string =>
  s
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();

// ---------------------------------------------------------------------------------------------------------------
// The quiet note on a scanned page

/**
 * A note about a scan: words about a scan (scan, scanned) and about what the cursor needs (caret, cursor, text). The spec gives no wording,
 * so this is any visible text that says both.
 */
export const SCAN_NOTE = /(?=[\s\S]*\bscan(?:ned)?\b)(?=[\s\S]*\b(?:caret|cursor|text)\b)/i;

/**
 * Counts, in every page this browser opens from now on, how many times such a note appears (a note that stays on screen counts once).
 * It runs from the first frame, so a note shown while the PDF opens is counted too. Call before `openViewer`.
 */
export async function watchScanNotes(context: BrowserContext): Promise<void> {
  await context.addInitScript((source) => {
    const w = window as unknown as { __note?: { shown: number; now: boolean } };
    if (w.__note !== undefined) return;
    w.__note = { shown: 0, now: false };
    const re = new RegExp(source, 'i');
    setInterval(() => {
      const now = document.body ? re.test(document.body.innerText) : false;
      if (now && !w.__note!.now) w.__note!.shown++;
      w.__note!.now = now;
    }, 40);
  }, SCAN_NOTE.source);
}

/** How many times the note has appeared in this tab, and whether it is on screen now. */
export const noteSeen = (page: Page): Promise<{ shown: number; now: boolean }> => page.evaluate(() => (window as unknown as { __note: { shown: number; now: boolean } }).__note);

// ---------------------------------------------------------------------------------------------------------------
// A PDF with a scanned page in the middle

export const CARET_MIXED = 'wt-caret-mixed.v1.pdf';
export const caretMixedUrl = served(CARET_MIXED);

async function writeOnce(name: string, build: () => Promise<Uint8Array>): Promise<string> {
  const path = join(WALKTHROUGH_DIR, name);
  const have = await stat(path).catch(() => null);
  if (have?.isFile()) return path;
  await mkdir(WALKTHROUGH_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, await build());
  await rename(tmp, path);
  return path;
}

/** Three Letter pages: text, a photograph of a page (a picture and no text), text. The two text pages are ten lines each. */
export async function ensureCaretMixed(): Promise<string> {
  return writeOnce(CARET_MIXED, async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const [w, h] = [612, 792];
    const textPage = (name: string) => {
      const page = doc.addPage([w, h]);
      for (let k = 1; k <= 10; k++) {
        page.drawText(`${name} page, line ${k}: reading begins here and goes on across the page.`, { x: 60, y: h - 80 - k * 30, size: 14, font, color: rgb(0.05, 0.05, 0.05) });
      }
    };
    textPage('Alpha');
    const [pw, ph] = [160, 208];
    const data = Buffer.alloc(pw * ph * 4);
    let seed = 4242;
    for (let p = 0; p < pw * ph; p++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = 90 + ((seed >> 8) % 120);
      data.set([v, v, v - 6, 255], p * 4);
    }
    const photo = doc.addPage([w, h]);
    photo.drawImage(await doc.embedJpg(jpeg.encode({ data, width: pw, height: ph }, 60).data), { x: 0, y: 0, width: w, height: h });
    textPage('Gamma');
    return doc.save();
  });
}
