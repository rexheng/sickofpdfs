// Helpers for the navigation and print walkthroughs (Tasks 24 and 27), written from the spec and the interface file only.
//
//  - nav-8: a small Letter document of 8 pages made here with pdf-lib, so these tests need nothing from the
//    implementation's own fixture script. Every page carries the page-number strips of book-400 (see BAR) so a test can
//    tell from pixels which page is on screen. Page 1 holds the links the walkthroughs click (a contents entry, a
//    citation that uses a NAMED destination as LaTeX/hyperref papers do, web and mail links, links with schemes that
//    must be inert, and a sentence that starts with a link). Pages 4 and 7 hold the next links of a chain of jumps.
//  - the rail: found the way a person finds it (a "Hide navigation pane" button, "Thumbnails" and "Outline" toggles,
//    and thumbnails that are small pictures with a page number beside them), not through the implementation's classes.
//  - the browser's history, and what a click on a link must not do (dialogs, new tabs, navigation).
//  - printing: window.print() is replaced by a recorder, because a script cannot drive Chrome's print preview. The
//    recorder looks at the print copy at the moment the viewer asks the browser to print, and the test then asks
//    Chromium for the PDF it would print (page.pdf with the print stylesheet) and checks that.
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { type PDFDict, PDFDocument, PDFName, PDFString, StandardFonts, rgb } from 'pdf-lib';
import { BAR, WALKTHROUGH_DIR, barBits } from './fixtures.spec-blind';
import { expect, rt, scrollerRect, settled } from './viewer.spec-blind';

// ---------------------------------------------------------------------------------------------------------------
// The navigation document
// ---------------------------------------------------------------------------------------------------------------

export const NAV_FILE = 'wt-nav.v1.pdf';
export const NAV_PAGES = 8;

/** A link on a page: its rectangle (page points, top-left origin, unrotated page) and where it goes. */
export interface NavLink {
  /** 0-based page index the link sits on. */
  page: number;
  x: number;
  top: number;
  w: number;
  h: number;
  /** The words printed under the link. */
  text: string;
  /** A GoTo destination: a 0-based page index and the point on it, in points from the page's top. */
  goes?: { page: number; top: number };
  /** A URI action. */
  url?: string;
}

/** Page points, top-left origin. Strips of the page-number bars sit at tops 24, 380 and 740 (x up to 348): nothing here touches them. */
export const NAV_LINKS = {
  /** A contents entry: "3.2 Experimental setup ........ 4". */
  contents: { page: 0, x: 72, top: 170, w: 230, h: 16, text: '3.2 Experimental setup ........ 4', goes: { page: 3, top: 300 } },
  /** A citation: its destination is a named one ("cite.ref12"), as hyperref writes them. Only "[12]" is the link. */
  citation: { page: 0, x: 72, top: 210, w: 30, h: 16, text: '[12] Ioffe and Szegedy, Batch normalization', goes: { page: 6, top: 500 } },
  web: { page: 0, x: 72, top: 250, w: 230, h: 16, text: 'https://example.org/', url: 'https://example.org/' },
  mail: { page: 0, x: 72, top: 290, w: 230, h: 16, text: 'mailto:owner@example.org', url: 'mailto:owner@example.org' },
  script: { page: 0, x: 72, top: 330, w: 230, h: 16, text: 'Run the script', url: 'javascript:alert(1)' },
  data: { page: 0, x: 72, top: 430, w: 230, h: 16, text: 'Open the data page', url: 'data:text/html,<h1>owned</h1>' },
  file: { page: 0, x: 72, top: 460, w: 230, h: 16, text: 'Open a local file', url: 'file:///etc/hosts' },
  chrome: { page: 0, x: 72, top: 490, w: 230, h: 16, text: 'Open the browser settings', url: 'chrome://settings/' },
  ftp: { page: 0, x: 72, top: 520, w: 230, h: 16, text: 'Open the ftp site', url: 'ftp://example.org/file.txt' },
  /** A sentence whose first words are a link: "Select this sentence" is the link, the rest of the line is plain text. */
  sentence: { page: 0, x: 72, top: 600, w: 100, h: 16, text: 'Select this sentence by dragging from the first words to the end of this line.', goes: { page: 2, top: 100 } },
  /** On page 4: the next link of the chain. */
  next: { page: 3, x: 72, top: 340, w: 230, h: 16, text: 'Next: the appendix on page 7', goes: { page: 6, top: 100 } },
  /** On page 7: the last link of the chain. */
  back: { page: 6, x: 72, top: 170, w: 230, h: 16, text: 'See also page 2', goes: { page: 1, top: 50 } },
} as const satisfies Record<string, NavLink>;
export type NavLinkId = keyof typeof NAV_LINKS;

/**
 * The end of the sentence line (page points): inside its last glyph, the full stop. In Helvetica 12 pt the sentence is 395.5 pt
 * wide, so it ends at 467.5. A drag must end ON the text: a pointer over the blank space after the line does not move the
 * selection's end, so where the selection stops there depends on the last text the pointer crossed.
 */
export const SENTENCE_END_X = 466;

const PAGE_H = BAR.pageHeight;

async function buildNav(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('Walkthrough navigation');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = Array.from({ length: NAV_PAGES }, () => doc.addPage([BAR.pageWidth, BAR.pageHeight]));
  const yOf = (top: number) => PAGE_H - top;

  pages.forEach((page, i) => {
    const n = i + 1;
    const bits = barBits(n);
    for (const top of BAR.tops) {
      page.drawRectangle({ x: BAR.x0 - 4, y: PAGE_H - top - BAR.size - 4, width: BAR.squares * BAR.size + 8, height: BAR.size + 8, color: rgb(1, 1, 1) });
      for (let k = 0; k < BAR.squares; k++) {
        if (k === 0 || k === BAR.squares - 1 || bits[k - 1] === true) {
          page.drawRectangle({ x: BAR.x0 + k * BAR.size, y: PAGE_H - top - BAR.size, width: BAR.size, height: BAR.size, color: rgb(0, 0, 0) });
        }
      }
    }
    page.drawText(`Page ${n}`, { x: 400, y: yOf(100), size: 40, font: bold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText(`Section on page ${n}`, { x: 400, y: yOf(560), size: 14, font: regular, color: rgb(0.2, 0.2, 0.2) });
  });

  // Where the links land: a heading you can see in a screenshot.
  pages[3].drawText('3.2 Experimental setup', { x: 72, y: yOf(318), size: 18, font: bold, color: rgb(0.05, 0.2, 0.6) });
  pages[6].drawText('[12] S. Ioffe and C. Szegedy. Batch normalization: accelerating deep network training.', { x: 72, y: yOf(512), size: 10, font: regular });
  pages[1].drawText('Chain end', { x: 400, y: yOf(70), size: 18, font: bold, color: rgb(0.05, 0.2, 0.6) });
  pages[2].drawText('Target of the sentence link', { x: 72, y: yOf(112), size: 14, font: bold, color: rgb(0.05, 0.2, 0.6) });

  /** Adds the link annotation and prints `label` (default: the link's words) in link blue under it. */
  const addLink = (link: NavLink, action: PDFDict, label: string | null = link.text) => {
    const page = pages[link.page];
    const rect = [link.x, yOf(link.top + link.h), link.x + link.w, yOf(link.top)];
    const annot = doc.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], A: action });
    page.node.addAnnot(doc.context.register(annot));
    // 12 pt text with its baseline 12 pt under the rectangle's top
    if (label !== null) page.drawText(label, { x: link.x, y: yOf(link.top + 12), size: 12, font: regular, color: rgb(0.05, 0.2, 0.7) });
  };

  const gotoPoint = (to: { page: number; top: number }) => doc.context.obj({ S: 'GoTo', D: [pages[to.page].ref, 'XYZ', 72, yOf(to.top), null] });
  const named = doc.context.obj({ S: 'GoTo', D: PDFString.of('cite.ref12') });
  // The named destination tree (catalog /Names /Dests) that "cite.ref12" is looked up in.
  doc.catalog.set(
    PDFName.of('Names'),
    doc.context.obj({ Dests: { Names: [PDFString.of('cite.ref12'), [pages[NAV_LINKS.citation.goes.page].ref, 'XYZ', 72, yOf(NAV_LINKS.citation.goes.top), null]] } }),
  );

  addLink(NAV_LINKS.contents, gotoPoint(NAV_LINKS.contents.goes));
  // The citation: only "[12]" is the link; the words after it are plain text.
  addLink(NAV_LINKS.citation, named, '[12]');
  pages[0].drawText('Ioffe and Szegedy, Batch normalization', { x: 72 + 34, y: yOf(NAV_LINKS.citation.top + 12), size: 12, font: regular });
  for (const id of ['web', 'mail', 'script', 'data', 'file', 'chrome', 'ftp'] as const) {
    const link: NavLink = NAV_LINKS[id];
    addLink(link, doc.context.obj({ S: 'URI', URI: PDFString.of(link.url!) }));
  }
  // The sentence: the link is a rectangle over its first words only; the whole line is black text.
  addLink(NAV_LINKS.sentence, gotoPoint(NAV_LINKS.sentence.goes), null);
  pages[0].drawText(NAV_LINKS.sentence.text, { x: 72, y: yOf(NAV_LINKS.sentence.top + 12), size: 12, font: regular, color: rgb(0, 0, 0) });
  addLink(NAV_LINKS.next, gotoPoint(NAV_LINKS.next.goes));
  addLink(NAV_LINKS.back, gotoPoint(NAV_LINKS.back.goes));
  return doc.save();
}

export async function ensureNav(): Promise<string> {
  const path = join(WALKTHROUGH_DIR, NAV_FILE);
  if ((await stat(path).catch(() => null))?.isFile()) return path; // names carry a version: a changed generator gets a new name
  await mkdir(WALKTHROUGH_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, await buildNav());
  await rename(tmp, path); // never serve half a file
  return path;
}
export const navUrl = `/f/walkthroughs/${NAV_FILE}`;

/** A real arXiv paper made with LaTeX and hyperref: 15 pages, a three-level outline, citation and section links with named destinations. */
export const ATTENTION = {
  url: '/f/classifier/learning/arxiv-1706.03762-attention.pdf',
  file: join(WALKTHROUGH_DIR, '..', 'classifier', 'learning', 'arxiv-1706.03762-attention.pdf'),
  pages: 15,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Pointing at the page
// ---------------------------------------------------------------------------------------------------------------

/**
 * Scrolls the page list (as a wheel would) until the point (x, y) of a page, in points from the page's top-left, is
 * well inside the window, and returns where it is on screen (CSS px).
 */
export async function bringIntoView(page: Page, pageIndex: number, x: number, y: number): Promise<{ x: number; y: number }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = await rt(page).clientPointOf({ pageIndex, x, y });
    const r = await scrollerRect(page);
    const margin = 70;
    if (Number.isFinite(p.y) && p.y >= r.y + margin && p.y <= r.y + r.height - margin) return p;
    await page.evaluate((dy) => {
      document.querySelector<HTMLElement>('[role="document"]')!.scrollTop += dy;
    }, p.y - (r.y + r.height / 2));
    await settled(() => rt(page).scrollTop(), 0.5, 1_500);
  }
  throw new Error(`could not bring page ${pageIndex + 1} (${x}, ${y}) into view`);
}

/** Where a person would press on a link: a little inside its left end, vertically centred. */
export async function linkSpot(page: Page, id: NavLinkId): Promise<{ x: number; y: number }> {
  const l: NavLink = NAV_LINKS[id];
  return bringIntoView(page, l.page, l.x + Math.min(l.w / 2, 45), l.top + l.h / 2);
}

export async function clickLink(page: Page, id: NavLinkId): Promise<void> {
  const p = await linkSpot(page, id);
  await page.mouse.click(p.x, p.y);
}

/** The point (x, y) of page `pageIndex` is inside the window: it is what a jump to that destination must show. */
export async function pointVisible(page: Page, pageIndex: number, y: number, x = 72): Promise<boolean> {
  const p = await rt(page).clientPointOf({ pageIndex, x, y });
  const r = await scrollerRect(page);
  return Number.isFinite(p.y) && p.y >= r.y - 4 && p.y <= r.y + r.height;
}

/** Makes the document 100% and puts the scroller `top` px down, as a person scrolling would. Returns where it stopped. */
export async function placeAt(page: Page, scrollTop: number): Promise<{ scrollTop: number; scale: number }> {
  await rt(page).setScale(1);
  await settled(() => rt(page).scale());
  await page.evaluate((top) => {
    document.querySelector<HTMLElement>('[role="document"]')!.scrollTop = top;
  }, scrollTop);
  const stopped = await settled(() => rt(page).scrollTop(), 0.5, 2_000);
  return { scrollTop: stopped, scale: await rt(page).scale() };
}

// ---------------------------------------------------------------------------------------------------------------
// The browser's history, and what must NOT happen
// ---------------------------------------------------------------------------------------------------------------

export interface HistoryInfo {
  length: number;
  state: unknown;
  hash: string;
  href: string;
}
export const historyInfo = (page: Page): Promise<HistoryInfo> =>
  page.evaluate(() => ({ length: history.length, state: history.state as unknown, hash: location.hash, href: location.href }));

/** The viewer's own two markers in a history state (interface file: `sopBase` and `sopJump`). */
export const isJumpState = (state: unknown): boolean => typeof state === 'object' && state !== null && ('sopJump' in state || 'sopBase' in state);

export interface Strays {
  /** alert(), confirm() and prompt() boxes, as "type: message". */
  dialogs: string[];
  /** Tabs or windows opened since. */
  opened: string[];
  /** Downloads started. */
  downloads: string[];
  /** The viewer's address without its #hash: it must not change. */
  address: () => string;
}

/** Starts watching for what a link must never do. Dialogs are dismissed so a bad link cannot hang the test. */
export function watchStrays(page: Page): Strays {
  const dialogs: string[] = [];
  const opened: string[] = [];
  const downloads: string[] = [];
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`);
    void d.dismiss().catch(() => {});
  });
  page.context().on('page', (p) => opened.push(p.url()));
  page.on('popup', (p) => opened.push(p.url()));
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  const strip = (u: string) => u.replace(/#.*$/, '');
  return { dialogs, opened, downloads, address: () => strip(page.url()) };
}

// ---------------------------------------------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------------------------------------------

const TOGGLE_ROLES = ['button', 'tab', 'radio', 'menuitemradio', 'switch', 'checkbox'] as const;
const anyRole = (page: Page, name: string | RegExp, exact: boolean): Locator =>
  TOGGLE_ROLES.map((role) => page.getByRole(role, { name, exact })).reduce((a, b) => a.or(b));

/** The rail's two toggles (interface file: "Thumbnails" and "Outline"; Outline is hidden when the PDF has no outline). */
export const railToggle = (page: Page, which: 'Thumbnails' | 'Outline'): Locator => anyRole(page, which, true);
/** The pill at the bottom of the rail (interface file: "Hide navigation pane"). It is on screen exactly when the rail is. */
export const hidePill = (page: Page): Locator => anyRole(page, /^hide navigation pane$/i, false);
export const outlineTree = (page: Page): Locator => page.getByRole('tree');
export const treeItem = (page: Page, title: string): Locator => page.getByRole('treeitem', { name: title, exact: true });

/** The viewer's own record of whether the rail is open (the snapshot's `railOpen`). */
export const railOpen = async (page: Page): Promise<boolean> => (await rt(page).snapshot()).railOpen;

export interface Thumb {
  /** The page number written beside the picture. */
  n: number;
  /** The picture, CSS px from the window's top-left. */
  rect: { x: number; y: number; width: number; height: number };
  /** The picture has the 2 px solid ring the interface file gives the current page. */
  ring: boolean;
  /** Its centre is really on screen: not scrolled out of the rail, not under the header. */
  onScreen: boolean;
}

/**
 * Every thumbnail the rail has in the page right now: a picture (canvas or img) with a bare page number as its label,
 * outside the page list and the header/toolbar. Found by what it looks like, not by class names.
 */
export function thumbs(page: Page): Promise<Thumb[]> {
  return page.evaluate(() => {
    const docEl = document.querySelector('[role="document"]');
    const isLabel = (el: Element) => el.childElementCount === 0 && /^\d{1,4}$/.test((el.textContent ?? '').trim()) && !(docEl?.contains(el) ?? false) && el.closest('[data-viewer-chrome]') === null;
    const hasRing = (el: Element) => {
      const s = getComputedStyle(el);
      return s.outlineStyle === 'solid' && parseFloat(s.outlineWidth) >= 2 && !/rgba\([^)]*,\s*0\)$/.test(s.outlineColor) && s.outlineColor !== 'transparent';
    };
    const area = (e: Element) => e.getBoundingClientRect().width * e.getBoundingClientRect().height;
    const found: Thumb[] = [];
    for (const label of Array.from(document.body.querySelectorAll('*')).filter(isLabel)) {
      const lr = label.getBoundingClientRect();
      if (lr.width === 0 || lr.height === 0) continue;
      let row: Element | null = label.parentElement;
      let pic: Element | null = null;
      while (row !== null && row !== document.body) {
        const pics = Array.from(row.querySelectorAll('canvas, img')).filter((p) => !(docEl?.contains(p) ?? false));
        if (pics.length > 0) {
          pic = pics.sort((a, b) => area(b) - area(a))[0] ?? null;
          break;
        }
        row = row.parentElement;
      }
      if (row === null || pic === null || row === document.body) continue;
      // A row has one label. More means this is the whole list, because this thumbnail's picture is not there yet.
      if (Array.from(row.querySelectorAll('*')).filter(isLabel).length !== 1) continue;
      const pr = pic.getBoundingClientRect();
      if (pr.width === 0 || pr.height === 0) continue;
      const cx = pr.left + pr.width / 2;
      const cy = pr.top + pr.height / 2;
      const theRow = row;
      const onScreen = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight && document.elementsFromPoint(cx, cy).some((e) => theRow.contains(e));
      const ring = [theRow, ...Array.from(theRow.querySelectorAll('*'))].some((e) => hasRing(e));
      found.push({ n: Number((label.textContent ?? '').trim()), rect: { x: pr.left, y: pr.top, width: pr.width, height: pr.height }, ring, onScreen });
    }
    return found.sort((a, b) => a.n - b.n);
  });
}

export async function thumb(page: Page, n: number): Promise<Thumb | undefined> {
  return (await thumbs(page)).find((t) => t.n === n);
}

/** Presses the middle of thumbnail `n`'s picture, as a person would. */
export async function clickThumb(page: Page, n: number): Promise<void> {
  const t = await thumb(page, n);
  if (!t) throw new Error(`there is no thumbnail for page ${n} to press`);
  await page.mouse.click(t.rect.x + t.rect.width / 2, t.rect.y + t.rect.height / 2);
}

/** Opens the rail with F4 if it is shut, and checks the "Hide navigation pane" pill appears. */
export async function openRail(page: Page): Promise<void> {
  if (!(await railOpen(page))) await page.keyboard.press('F4');
  await expectRailOpen(page, true);
}

async function expectRailOpen(page: Page, open: boolean): Promise<void> {
  await expect.poll(() => railOpen(page), { message: `the viewer's own record: the rail should be ${open ? 'open' : 'shut'}` }).toBe(open);
  if (open) await expect(hidePill(page), 'the rail shows its "Hide navigation pane" pill').toBeVisible();
  else await expect(hidePill(page), 'a shut rail shows nothing of itself').toBeHidden();
}
export { expectRailOpen };

// ---------------------------------------------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------------------------------------------

export interface PrintSnapshot {
  /** The sheets: one per <img> of #sop-print-root. */
  sheets: {
    /** How many pictures the sheet holds. */
    pictures: number;
    /** The sheet's CSS `page` name ("p-0"), '' when it has none. */
    pageName: string;
    /** The picture's CSS width and height as written (e.g. "8.5in"). */
    width: string;
    height: string;
    /** The picture's own pixel size (naturalWidth x naturalHeight), and whether it is decoded. */
    pixels: { w: number; h: number };
    decoded: boolean;
  }[];
  /** Every @page rule in the document. */
  pageRules: { name: string; size: string; margin: string }[];
  /** Open dialogs at the moment of printing. A progress dialog still open would print with the page. */
  dialogsOpen: number;
  /** Whether #sop-print-root existed. */
  hasRoot: boolean;
}

export interface PrintLog {
  calls: number;
  afterprint: number;
  snapshots: PrintSnapshot[];
}

/**
 * Runs inside every page of the context, before it loads (add it with context.addInitScript). Replaces
 * window.print() with a recorder that notes how the print copy looks the moment the viewer asks for printing and then
 * returns without showing anything, as the browser's own print() returns while its preview is open. The test later
 * dispatches `afterprint` (or lets page.pdf do it) to say the print is over. Serialised by Playwright: it must not
 * refer to anything outside its own body.
 */
export function installPrintRecorder(): void {
  if (location.protocol !== 'chrome-extension:') return;
  const log = { calls: 0, afterprint: 0, snapshots: [] as unknown[] };
  (window as unknown as { __sopPrintLog: typeof log }).__sopPrintLog = log;
  window.addEventListener('afterprint', () => {
    log.afterprint++;
  });
  window.print = () => {
    log.calls++;
    const root = document.getElementById('sop-print-root');
    const sheets = Array.from(root?.querySelectorAll('img') ?? []).map((img) => {
      const sheet = img.parentElement ?? img;
      const fromStyleAttr = /(?:^|;)\s*page\s*:\s*([\w-]+)/.exec(sheet.getAttribute('style') ?? '')?.[1] ?? '';
      return {
        pictures: sheet.querySelectorAll('img').length,
        pageName: getComputedStyle(sheet).getPropertyValue('page').trim().replace(/^auto$/, '') || fromStyleAttr,
        width: img.style.width,
        height: img.style.height,
        pixels: { w: img.naturalWidth, h: img.naturalHeight },
        decoded: img.complete && img.naturalWidth > 0,
      };
    });
    const pageRules: { name: string; size: string; margin: string }[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (rule.constructor.name === 'CSSPageRule') {
          const r = rule as CSSPageRule;
          pageRules.push({ name: r.selectorText, size: r.style.getPropertyValue('size'), margin: r.style.getPropertyValue('margin') });
        }
      }
    }
    log.snapshots.push({
      sheets,
      pageRules,
      dialogsOpen: document.querySelectorAll('[role="dialog"], [role="alertdialog"]').length,
      hasRoot: root !== null,
    });
  };
}

export async function useRecordingPrint(context: BrowserContext): Promise<void> {
  await context.addInitScript(installPrintRecorder);
}

export const printLog = (page: Page): Promise<PrintLog> => page.evaluate(() => (window as unknown as { __sopPrintLog: PrintLog }).__sopPrintLog);

/** The length in inches of a CSS length such as "8.5in", "612pt", "816px" or "21.59cm"; NaN for anything else. */
export function inches(css: string): number {
  const m = /^\s*(-?[\d.]+)\s*(in|pt|px|cm|mm)\s*$/.exec(css);
  if (!m) return Number.NaN;
  const v = Number(m[1]);
  return { in: v, pt: v / 72, px: v / 96, cm: v / 2.54, mm: v / 25.4 }[m[2] as 'in' | 'pt' | 'px' | 'cm' | 'mm'];
}

/** A `size: 612pt 792pt` descriptor as [width, height] in points; null if it is not two lengths. */
export function sizeInPoints(css: string): [number, number] | null {
  const parts = css.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [w, h] = parts.map((p) => inches(p) * 72);
  return w !== undefined && h !== undefined && Number.isFinite(w) && Number.isFinite(h) ? [w, h] : null;
}
