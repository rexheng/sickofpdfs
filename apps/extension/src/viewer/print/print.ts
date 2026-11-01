// Print (Ctrl+P). Chrome would print the viewer's own page, so Ctrl+P prints a copy instead: every page is drawn by
// PDFium at 200 dpi into an image, and the images go into a print-only element (#sop-print-root) that print.css shows
// in place of the viewer. Each sheet has the size and orientation of its own page (CSS named pages), so a deck with an
// A4 landscape page and a rotated page prints as it is. Marks are not in the copy yet (Phase 2 adds them to the sheets).
//
// Memory: pages are drawn one at a time. Each becomes a PNG blob behind an object URL, so no more than one full bitmap
// is alive at once, and the URLs are revoked when the copy is disposed (after printing, or on Cancel).
import type { DocHandle, PageSize, PdfBackend } from '@sop/viewer';
import type { ViewerContext } from '../commands';

/** The resolution of the print copy. */
export const PRINT_DPI = 200;

const POINTS_PER_INCH = 72;
/** renderTile's limits (a side, and all pixels); a page that would pass them is printed at a lower resolution. */
const MAX_SIDE_PX = 16_384;
const MAX_AREA_PX = 2 ** 26;
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
  /** Removes the copy and frees its images. Safe to call twice. */
  dispose(): void;
}

export interface PrintOptions {
  dpi: typeof PRINT_DPI;
  /** Aborting stops the work, frees what was made and rejects with an AbortError. */
  signal: AbortSignal;
  /** Called after each page is ready, with the number of pages ready and the total. */
  onProgress(done: number, total: number): void;
}

const abortError = () => new DOMException('Printing was cancelled.', 'AbortError');

/** Page `index` drawn upright (the page's own /Rotate, no view rotation) with its annotations. */
function renderPage(backend: PdfBackend, doc: DocHandle, index: number, size: { width: number; height: number }, o: PrintOptions): Promise<ImageBitmap> {
  const drawn = backend.renderTile(doc, { pageIndex: index, scale: printScale(size, o.dpi), viewRotation: 0, withAnnotations: true }, o.signal);
  drawn.catch(() => {}); // the loop awaits it and handles a failure; this only stops an early one being reported as unhandled
  return drawn;
}

/** The bitmap as a PNG. The bitmap is closed. */
async function encodePng(bitmap: ImageBitmap): Promise<Blob> {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('The canvas has no 2d context.');
    context.drawImage(bitmap, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
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
 * last one is turned into a PNG, so at most two bitmaps are alive at once.
 */
export async function preparePrintCopy(backend: PdfBackend, doc: DocHandle, pages: PageSize[], o: PrintOptions): Promise<PrintCopy> {
  const urls: string[] = [];
  const revoke = () => {
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
  };
  const { css, pageNames } = printPageRules(pages);
  const sizes = pages.map(printedSize);
  const root = document.createElement('div');
  root.id = PRINT_ROOT_ID;
  let drawing: Promise<ImageBitmap> | null = pages.length > 0 ? renderPage(backend, doc, 0, sizes[0], o) : null;
  try {
    for (const [index, size] of sizes.entries()) {
      const bitmap = await drawing!;
      drawing = index + 1 < pages.length ? renderPage(backend, doc, index + 1, sizes[index + 1], o) : null;
      const url = URL.createObjectURL(await encodePng(bitmap));
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
      o.onProgress(index + 1, pages.length);
    }
  } catch (error) {
    revoke();
    // The page being drawn ahead is not wanted: close its bitmap when it arrives.
    void drawing?.then((bitmap) => bitmap.close(), () => {});
    throw error;
  }
  const style = document.createElement('style');
  style.id = PRINT_STYLE_ID;
  style.textContent = css;
  document.head.append(style);
  document.body.append(root);
  let disposed = false;
  return {
    root,
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
 * Ctrl+P and File → Print: the progress dialog, then the pages, then Chrome's print dialog. The copy is removed when
 * printing is over (afterprint), or when the next one starts.
 */
export async function printDocument(ctx: ViewerContext): Promise<void> {
  if (preparing) return;
  preparing = true;
  disposeActive();
  const { pageCount, pages, doc } = ctx.opened.open;
  const controller = new AbortController();
  const cancel = () => {
    controller.abort();
    ctx.ui.printProgress(null); // the dialog goes at once, not when the page being drawn is done
  };
  const progress = (done: number) => {
    if (!controller.signal.aborted) ctx.ui.printProgress({ done, total: pageCount, cancel });
  };
  progress(0);
  try {
    const copy = await preparePrintCopy(ctx.backend, doc, pages, {
      dpi: PRINT_DPI,
      signal: controller.signal,
      onProgress: progress,
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
  } catch {
    ctx.ui.printProgress(null);
    // Cancel is the person's choice: nothing to say.
    if (!controller.signal.aborted) ctx.ui.showNote('Couldn’t get the pages ready to print. Try again.');
  } finally {
    preparing = false;
  }
}
