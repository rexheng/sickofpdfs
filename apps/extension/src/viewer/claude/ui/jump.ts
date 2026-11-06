// Where Claude's chips go (plan §4 F): "Page 4" jumps to the cited passage and flashes it; "Figure 3 · Page 5" jumps to the
// figure and selects it; a web source opens in a new tab, and only an https address does.
//
// Jumps go through the reader's jump history (Task 24), so Back returns to where they were reading, as a link in the PDF
// does. The cited words flash with the same band a search hit gets (hit-flash.tsx).
//
// A citation's `start` and `end` count characters of the page's text as Claude was given it (PageTextProvider.text(),
// slice B), which is not quite PDFium's char list: getPageText drops the joining hyphens and zero-width chars that
// PDFium keeps. So the range is mapped onto PDFium's chars (rawText) first, and checked against the quote. When it does
// not fit (recognised text, a page that changed), the quote's first words are searched on the page instead; when they
// are not found either, the page itself is shown.
import type { PageCitation, ThreadRow } from '@sop/core';
import { isOutlined, type PdfRect, pdfRectToNorm } from '@sop/viewer';
import type { NotesHost } from '../../annotations/wire';
import { figureRect, type FoundFigure } from '../../figures/anchors';
import { controllerOf } from '../../figures/registry';
import { hitFlash } from '../../hit-flash';
import { goToSpot } from '../../notes-panel/navigate';

export interface ClaudeJumper {
  /** Goes to the passage and flashes it. False when the page does not exist here. */
  toCitation(c: PageCitation): Promise<boolean>;
  /** Goes to the figure and selects it. False when no such figure is found. */
  toFigure(f: { label: string | null; pageIndex: number | null }): Promise<boolean>;
  /** The page of a figure by its label ("Figure 3"), from the figures found so far; null when not known yet. */
  figurePage(label: string): number | null;
}

/** The one jumper of the open document. The feature sets it; the chips read it when pressed. */
let current: ClaudeJumper | null = null;
export const claudeJump = {
  set(j: ClaudeJumper | null): void {
    current = j;
  },
  get(): ClaudeJumper | null {
    return current;
  },
};

/**
 * Opens a web source in a new tab. Only https addresses open (plan §4 F: reply links are allow-listed); the tab gets no
 * opener and no referrer, so the page cannot reach back into the viewer or learn which PDF was open.
 */
export function openWebSource(url: string): boolean {
  if (!isHttps(url)) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

export function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Words are compared without case, spacing or a line-end hyphen. */
const norm = (s: string): string => s.toLowerCase().replace(/-\s+/gu, '').replace(/\s+/gu, ' ').trim();

/**
 * The PDFium char index of each offset of `text` (getPageText), found by walking the raw chars beside it: a raw char
 * that is not the next text char was dropped by getPageText. `map[i]` is the char of text offset `i`; `map[text.length]`
 * is one past the last.
 */
export function textToCharIndex(raw: string, text: string): Int32Array {
  const map = new Int32Array(text.length + 1);
  let r = 0;
  for (let t = 0; t < text.length; t++) {
    const want = text[t];
    let look = r;
    // Skip the chars getPageText dropped; give up looking after a few, and keep the position (the texts differ there).
    while (look < raw.length && raw[look] !== want && look - r < 8) look++;
    if (look < raw.length && raw[look] === want) r = look;
    map[t] = r;
    r = Math.min(raw.length, r + 1);
  }
  map[text.length] = r;
  return map;
}

/** The union of rects, or null for none. */
function bounds(rects: readonly PdfRect[]): PdfRect | null {
  if (rects.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.width);
    y1 = Math.max(y1, r.y + r.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The first words of a quote, for a search: enough to be unique, short enough to sit on one page. */
function searchPhrase(quote: string): string {
  return quote.replace(/[“”"…]/gu, ' ').replace(/\s+/gu, ' ').trim().split(' ').slice(0, 8).join(' ');
}

export function createClaudeJumper(host: NotesHost): ClaudeJumper {
  const { pageText, pages } = host;

  /** PDFium's chars [start, start + count) for the citation, or null when the range does not hold its words. */
  async function charsOf(c: PageCitation): Promise<{ start: number; count: number } | null> {
    if (c.textSource !== pageText.source(c.pageIndex) || c.end <= c.start) return null;
    const [raw, text] = await Promise.all([pageText.rawText(c.pageIndex), pageText.text(c.pageIndex)]);
    const quote = norm(c.quote).slice(0, 40);
    const fits = (got: string) => quote === '' || norm(got).startsWith(quote.slice(0, Math.min(quote.length, norm(got).length)));
    if (c.end <= text.length && fits(text.slice(c.start, c.end))) {
      const map = textToCharIndex(raw, text);
      const start = map[c.start] ?? c.start;
      const end = map[c.end] ?? c.end;
      if (end > start) return { start, count: end - start };
    }
    // The offsets may already be PDFium chars (a source that has no dropped chars, or a later convention).
    if (c.end <= raw.length && fits(raw.slice(c.start, c.end))) return { start: c.start, count: c.end - c.start };
    return null;
  }

  async function foundByQuote(c: PageCitation): Promise<{ start: number; count: number } | null> {
    const phrase = searchPhrase(c.quote);
    if (phrase === '') return null;
    const hits = await pageText.search(c.pageIndex, phrase, { matchCase: false, wholeWord: false }).catch(() => []);
    const first = hits[0];
    if (first === undefined) return null;
    // The whole cited stretch when it fits on the page from there: the quote's length in chars, at most.
    const raw = await pageText.rawText(c.pageIndex).catch(() => '');
    const count = Math.max(first.count, Math.min(c.end - c.start, raw.length - first.start));
    return { start: first.start, count };
  }

  function show(pageIndex: number, x: number, y: number): boolean {
    const api = host.pageList.current;
    if (api === null || pages[pageIndex] === undefined) return false;
    goToSpot({ pageIndex, x, y }, { jumps: host.jumps, api, pages, scale: host.view.get().scale });
    return true;
  }

  function knownFigures(): FoundFigure[] {
    const out: FoundFigure[] = [];
    for (let page = 0; page < pages.length; page++) {
      const size = pages[page];
      const list = host.figures.peek(page);
      if (size === undefined || list === undefined) continue;
      for (const figure of list) if (isOutlined(figure)) out.push({ page, figure, rect: figureRect(figure, size) });
    }
    return out;
  }

  const sameLabel = (a: string | null, b: string | null) => a !== null && b !== null && norm(a) === norm(b);

  const jumper: ClaudeJumper = {
    async toCitation(c) {
      if (pages[c.pageIndex] === undefined) return false;
      // A citation of no text of the page: the words inside a figure (request.ts cites them as an empty range). It goes to the
      // figure on that page, selected, as its figure chip does.
      if (c.end <= c.start) return jumper.toFigure({ label: null, pageIndex: c.pageIndex });
      const chars = (await charsOf(c).catch(() => null)) ?? (await foundByQuote(c).catch(() => null));
      if (chars === null) return show(c.pageIndex, 0, 0);
      const where = bounds(await pageText.rects(c.pageIndex, chars.start, chars.count).catch((): PdfRect[] => []));
      const size = pages[c.pageIndex];
      const at = where !== null && size !== undefined ? pdfRectToNorm(where, size) : null;
      const shown = show(c.pageIndex, at?.[0] ?? 0, at?.[1] ?? 0);
      if (shown) hitFlash.show({ pageIndex: c.pageIndex, ranges: [chars] });
      return shown;
    },

    async toFigure({ label, pageIndex }) {
      // The page named first; its figures are found now if they were not yet.
      let found: FoundFigure | undefined;
      if (pageIndex !== null && pages[pageIndex] !== undefined) {
        const size = pages[pageIndex];
        const list = await host.figures.figures(pageIndex).catch(() => []);
        const outlined = list.filter((f) => isOutlined(f));
        const figure = outlined.find((f) => sameLabel(f.label, label)) ?? (label === null || outlined.length === 1 ? outlined[0] : undefined);
        if (figure !== undefined && size !== undefined) found = { page: pageIndex, figure, rect: figureRect(figure, size) };
      }
      found ??= label === null ? undefined : knownFigures().find((f) => sameLabel(f.figure.label, label));
      if (found === undefined) return pageIndex !== null && show(pageIndex, 0, 0);
      if (!show(found.page, found.rect[0], found.rect[1])) return false;
      controllerOf(host).select(found);
      return true;
    },

    figurePage(label) {
      return knownFigures().find((f) => sameLabel(f.figure.label, label))?.page ?? null;
    },
  };
  return jumper;
}

/** The page of a figure a reply is about: the thread's own figure when it carries that label, else one found by label. */
export function figurePageOf(label: string, thread: Pick<ThreadRow, 'anchor'> | null): number | null {
  const a = thread?.anchor;
  if (a?.kind === 'figure') {
    const own = a.figure.label;
    if (own === null || norm(own) === norm(label)) return a.page;
  }
  return claudeJump.get()?.figurePage(label) ?? null;
}
