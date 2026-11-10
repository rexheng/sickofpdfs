// Print (Ctrl+P). Chrome would print the viewer's own page, so Ctrl+P prints a copy instead: every chosen page is drawn
// by PDFium at 200 dpi into an image, and the images go into a print-only element (#sop-print-root) that print.css
// shows in place of the viewer. Each sheet has the size and orientation of its own page (CSS named pages), so a deck with
// an A4 landscape page and a rotated page prints as it is. Ctrl+P first asks which pages (All, This page, or Pages such
// as 3–7) and, when the document has marks, whether they print too (R99); only the chosen pages are drawn, and the
// marks are painted on each page's picture before it is saved (print-marks.ts, S17).
//
// Memory: pages are drawn one at a time. Each becomes a blob behind an object URL, so no more than two full bitmaps are
// alive at once, and the URLs are revoked when the copy is disposed (after printing, or on Cancel). A page is a PNG, so
// text stays crisp, except a scan (one picture over the page), which is a JPEG: a scan's PNG is 1 to 2 MB.
import type { DocHandle, PageSize, PdfBackend } from '@sop/viewer';
import type { ViewerContext } from '../commands';
import { createMarkPainter, type MarkPainter, type MarksToPrint, marksToPrint } from './print-marks';
import { pageAtPosition, positionOfPage } from '@sop/core/page-order';

/** The resolution of the print copy. */
export const PRINT_DPI = 200;

const POINTS_PER_INCH = 72;
/** renderTile's limits (a side, and all pixels); a page that would pass them is printed at a lower resolution. */
const MAX_SIDE_PX = 16_384;
const MAX_AREA_PX = 2 ** 26;
/** A page whose single picture covers at least this share of it is a scan. */
const SCAN_IMAGE_SHARE = 0.8;
/** The JPEG quality of a scan. */
const SCAN_JPEG_QUALITY = 0.9;
/** The look at a page's objects (does it hold one picture?) stops here; a scan has a handful. */
const SCAN_PROBE = { maxObjects: 200, budgetMs: 10 };
/** Used for a page with no usable size, so the sheet is never zero-sized. */
const FALLBACK_SIZE = { width: 612, height: 792 };

export const PRINT_ROOT_ID = 'sop-print-root';
export const PRINT_STYLE_ID = 'sop-print-pages';

/** Two decimals are far below a printer's resolution, and keep the rules short (595.2756… becomes 595.28). */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The page as it is printed, in points: width and height swap for /Rotate 90 and 270. */
export function printedSize(page: PageSize): { width: number; height: number } {
  const turned = page.rotation % 180 !== 0;
  const width = round2(turned ? page.height : page.width);
  const height = round2(turned ? page.width : page.height);
  return width > 0 && height > 0 ? { width, height } : FALLBACK_SIZE;
}

/**
 * One `@page p-N { size: <w>pt <h>pt; margin: 0 }` per distinct printed size, in the order the sizes first appear, and
 * the page name of every sheet. A sheet with `page: p-N` is printed on a sheet of paper of that size. (`size: landscape`
 * is not used: Chrome then falls back to the default paper size.)
 */
export function printPageRules(pages: PageSize[]): { css: string; pageNames: string[] } {
  const names = new Map<string, string>();
  const rules: string[] = [];
  const pageNames = pages.map((page) => {
    const { width, height } = printedSize(page);
    const key = `${width}x${height}`;
    let name = names.get(key);
    if (name === undefined) {
      name = `p-${names.size}`;
      names.set(key, name);
      rules.push(`@page ${name} { size: ${width}pt ${height}pt; margin: 0 }`);
    }
    return name;
  });
  return { css: rules.join('\n'), pageNames };
}

/** Device px per point for a printed page: `dpi`, or less when the bitmap would pass the engine's limits. */
function printScale(size: { width: number; height: number }, dpi: number): number {
  const wanted = dpi / POINTS_PER_INCH;
  const bySide = MAX_SIDE_PX / Math.max(size.width, size.height);
  const byArea = Math.sqrt(MAX_AREA_PX / (size.width * size.height));
  // A hair under the limit: the engine rounds each side to whole pixels.
  return Math.min(wanted, bySide * 0.999, byArea * 0.999);
}

export interface PrintCopy {
  /** `#sop-print-root`, in the page: one `.sop-print-sheet` per page, each holding the page's image. */
  root: HTMLElement;
  /** How many bold marks were printed in a simpler style because the engine could not give their outlines (0 usually). */
  simplerBold: number;
  /** Removes the copy and frees its images. Safe to call twice. */
  dispose(): void;
}

export interface PrintOptions {
  dpi: typeof PRINT_DPI;
  /** Aborting stops the work, frees what was made and rejects with an AbortError. */
  signal: AbortSignal;
  /** Called after each page is ready, with the number of pages ready and the total. */
  onProgress(done: number, total: number): void;
  /** The marks to paint on the pages (print-marks.ts). Without it the copy is the plain pages. */
  marks?: MarksToPrint | null;
  /** The pages to print, 0-based, in order (R99: All, This page, or Pages). Without it, every page. */
  only?: readonly number[];
}

/** The longest list of pages the Pages box takes ("1-3, 5" has two parts). */
const MAX_PARTS = 200;

/**
 * The pages typed in the print step's Pages box (R99), 0-based, in order, each once: "3-7", "3–7", "3 to 7", "1, 4, 9"
 * and mixes of them, as Chrome's print dialog takes them. An empty box means every page. Null when something in it is
 * not a page of this document (0, a page past the end, a word), so the step can say so instead of printing the wrong
 * pages.
 */
export function pagesToPrint(text: string, pageCount: number): number[] | null {
  const parts = text.split(/[,;]/u).map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return Array.from({ length: pageCount }, (_, i) => i);
  if (parts.length > MAX_PARTS) return null;
  const chosen = new Set<number>();
  for (const part of parts) {
    const m = /^(\d+)(?:\s*(?:-|\u2013|\u2014|to)\s*(\d+))?$/iu.exec(part);
    if (m === null) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    const [from, to] = a <= b ? [a, b] : [b, a];
    if (from < 1 || to > pageCount) return null;
    for (let page = from; page <= to; page++) chosen.add(page - 1);
  }
  return [...chosen].sort((x, y) => x - y);
}

const abortError = () => new DOMException('Printing was cancelled.', 'AbortError');

/**
 * Is the page one picture and nothing else drawn (a scan)? Its objects are exactly one image covering most of the page,
 * plus text (a scan's invisible OCR layer) and form wrappers; a path or shading means a page made of drawing, which
 * stays a PNG. Any trouble with the question means "no": a PNG is always right.
 */
async function isScan(backend: PdfBackend, doc: DocHandle, index: number, page: PageSize): Promise<boolean> {
  try {
    const { objects, truncated } = await backend.listPageObjects(doc, index, SCAN_PROBE);
    if (truncated || objects.some((o) => o.type === 'path' || o.type === 'shading' || o.type === 'unknown')) return false;
    const images = objects.filter((o) => o.type === 'image');
    return images.length === 1 && images[0].bounds.width * images[0].bounds.height >= SCAN_IMAGE_SHARE * page.width * page.height;
  } catch {
    return false;
  }
}

interface DrawnPage {
  bitmap: ImageBitmap;
  scan: boolean;
  index: number;
}

/** Page `index` drawn upright (the page's own /Rotate, no view rotation) with its annotations, and whether it is a scan. */
function drawPage(backend: PdfBackend, doc: DocHandle, index: number, page: PageSize, size: { width: number; height: number }, o: PrintOptions): Promise<DrawnPage> {
  const drawn = (async () => {
    const scan = await isScan(backend, doc, index, page);
    const bitmap = await backend.renderTile(doc, { pageIndex: index, scale: printScale(size, o.dpi), viewRotation: 0, withAnnotations: true }, o.signal);
    return { bitmap, scan, index };
  })();
  drawn.catch(() => {}); // the loop awaits it and handles a failure; this only stops an early one being reported as unhandled
  return drawn;
}

/** The page as a PNG, or as a JPEG for a scan, with its marks painted on when there is a painter. The bitmap is closed as soon as the canvas holds it. */
async function encodePage({ bitmap, scan, index }: DrawnPage, marks: MarkPainter | null): Promise<Blob> {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The canvas has no 2d context.');
    context.drawImage(bitmap, 0, 0);
    bitmap.close(); // the canvas holds the page now; the bitmap is not kept through the marks and the encoding
    await marks?.paint(index, context, canvas);
    return await canvas.convertToBlob(scan ? { type: 'image/jpeg', quality: SCAN_JPEG_QUALITY } : { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

/**
 * Resolves once the image has been read. It is not decoded here (img.decode() would): a decoded page is about 15 MB,
 * and a long document would hold every one of them until it was printed. Chrome decodes a page when it prints it.
 */
function loaded(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    image.addEventListener('load', () => resolve(), { once: true });
    image.addEventListener('error', () => reject(new Error('A page of the print copy did not load.')), { once: true });
  });
}

/**
 * Draws every page and puts the copy in the document, ready for window.print(). Nothing is added to the document until
 * every page is ready, so a cancelled or failed run leaves nothing behind. The engine draws the next page while the
 * last one is encoded, so at most two bitmaps are alive at once.
 */
export async function preparePrintCopy(backend: PdfBackend, doc: DocHandle, pages: PageSize[], o: PrintOptions): Promise<PrintCopy> {
  const urls: string[] = [];
  const revoke = () => {
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  };
  // The pages that print (R99): their indices in the document, and their sizes, sheet by sheet.
  const only = (o.only ?? pages.map((_, i) => i)).filter((i) => i >= 0 && i < pages.length);
  const chosen = only.map((i) => pages[i]);
  const { css, pageNames } = printPageRules(chosen);
  const sizes = chosen.map(printedSize);
  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  const marks = o.marks ? createMarkPainter({ backend, doc, pages, marks: o.marks, signal: o.signal }) : null;
  const draw = (sheet: number) => drawPage(backend, doc, only[sheet], chosen[sheet], sizes[sheet], o);
  let drawing: Promise<DrawnPage> | null = only.length > 0 ? draw(0) : null;
  try {
    for (const [index, size] of sizes.entries()) {
      const drawn = await drawing!;
      drawing = index + 1 < only.length ? draw(index + 1) : null;
      const url = URL.createObjectURL(await encodePage(drawn, marks));
      urls.push(url);
      const image = new Image();
      image.alt = '';
      image.style.width = `${size.width / POINTS_PER_INCH}in`;
      image.style.height = `${size.height / POINTS_PER_INCH}in`;
      const ready = loaded(image);
      image.src = url;
      await ready;
      const sheet = document.createElement('div');
      sheet.className = 'sop-print-sheet';
      sheet.style.setProperty('page', pageNames[index]);
      sheet.style.width = image.style.width;
      sheet.style.height = image.style.height;
      sheet.append(image);
      root.append(sheet);
      if (o.signal.aborted) throw abortError();
      o.onProgress(index + 1, only.length);
    }
  } catch (error) {
    revoke();
    // The page being drawn ahead is not wanted: close its bitmap when it arrives.
    void drawing?.then((next) => next.bitmap.close(), () => {});
    throw error;
  } finally {
    marks?.dispose();
  }
  const simplerBold = marks?.simplerBold() ?? 0;
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = css;
  document.head.append(style);
  document.body.append(root);
  let disposed = false;
  return {
    root,
    simplerBold,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.remove();
      style.remove();
      revoke();
    },
  };
}

/** The copy that is in the page now (from the moment window.print() is called until afterprint). */
let active: { copy: PrintCopy; forget(): void } | null = null;
/** Pages are being prepared: a second Ctrl+P waits for this one. */
let preparing = false;

/** Lets the page repaint (the progress dialog closing) before the print dialog freezes it. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Removes the copy in the page, if there is one. */
function disposeActive(): void {
  active?.forget();
  active = null;
}

/**
 * Ctrl+P and File → Print: the print step (which pages, and the marks when the document has some: R99), the progress
 * dialog over the chosen pages only, then Chrome's print dialog. The copy is removed when printing is over
 * (afterprint), or when the next one starts.
 */
export async function printDocument(ctx: ViewerContext): Promise<void> {
  if (preparing) return;
  preparing = true;
  disposeActive();
  const { pageCount, pages, doc } = ctx.opened.open;
  const controller = new AbortController();
  let withMarks = false;
  try {
    const found = ctx.printMarks ? marksToPrint(ctx.printMarks, pageCount) : null;
    // R108: the step counts pages as they are shown ("This page", "Pages 3–7"), and they print in that order. The
    // answer's positions become the file's pages here; the file itself is never changed.
    const order = ctx.store.get().pageOrder;
    const answer = await ctx.ui.askPrint({ pageCount, currentPage: positionOfPage(order, ctx.store.get().currentPage), marks: found !== null });
    if (answer === null) return; // Cancel, Escape or a click away: nothing is printed
    withMarks = found !== null && answer.withMarks;
    const total = answer.pages.length;
    const cancel = () => {
      controller.abort();
      ctx.ui.printProgress(null); // the dialog goes at once, not when the page being drawn is done
    };
    const progress = (done: number) => {
      if (!controller.signal.aborted) ctx.ui.printProgress({ done, total, cancel });
    };
    progress(0);
    const copy = await preparePrintCopy(ctx.backend, doc, pages, {
      dpi: PRINT_DPI,
      signal: controller.signal,
      onProgress: progress,
      marks: withMarks ? found : null,
      only: answer.pages.map((position) => pageAtPosition(order, position)),
    });
    const onAfterPrint = () => disposeActive();
    window.addEventListener('afterprint', onAfterPrint, { once: true });
    active = {
      copy,
      forget: () => {
        window.removeEventListener('afterprint', onAfterPrint);
        copy.dispose();
      },
    };
    ctx.ui.printProgress(null);
    await nextTask();
    window.print();
    // After the print dialog, so it is not behind it.
    if (copy.simplerBold > 0) ctx.ui.showNote('Some bold marks were printed in a simpler style');
  } catch {
    ctx.ui.printProgress(null);
    // Cancel is the person's choice: nothing to say.
    if (!controller.signal.aborted) ctx.ui.showNote(withMarks ? 'Couldn’t get the pages ready to print. Try again, or print without marks.' : 'Couldn’t get the pages ready to print. Try again.');
  } finally {
    preparing = false;
  }
}
