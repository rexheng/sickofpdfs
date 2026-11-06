// Where Claude's chips go (plan §4 F): "Page 4" jumps to the cited passage and lights the cited sentence; "Figure 3 · Page 5"
// jumps to the figure and selects it; a web source opens in a new tab, and only an https address does. A jump stays in the
// reading, and the thread it came from stays open.
//
// Jumps go through the reader's jump history (Task 24), so Back returns to where they were reading, as a link in the PDF
// does. The cited words light with the same band a search hit gets (hit-flash.tsx), and it fades in about 2 s.
//
// A citation's `start` and `end` count characters of the page's text as Claude was given it (PageTextProvider.text(),
// slice B), which is not quite PDFium's char list: getPageText drops the joining hyphens and zero-width chars that
// PDFium keeps. So the range is mapped onto PDFium's chars (rawText) first, and checked against the quote. When it does
// not fit (recognised text, a page that changed), the quote's first words are searched on the page instead; when they
// are not found either, the page itself is shown.
//
// Claude cites a whole passage (a paragraph; for page 1 often the title, the authors and the abstract together), but its
// sentence says which part it means. So only one sentence lights (TB6, student 4 and visual 9): of the passage's sentences,
// the one that shares the most words with the reply's sentence the chip ends, else the passage's first; and at most 3
// lines of it.
import type { PageCitation } from '@sop/core';
import { type Glyph, isOutlined, type PdfRect, pdfRectToNorm } from '@sop/viewer';
import type { NotesHost } from '../../annotations/wire';
import { figureRect, type FoundFigure } from '../../figures/anchors';
import { controllerOf } from '../../figures/registry';
import { hitFlash } from '../../hit-flash';
import { goToSpot } from '../../notes-panel/navigate';
import { notesPanel } from '../../notes-panel/panel-state';
import { type ClaudeJumper, norm } from './jump-target';

export { type ClaudeJumper, claudeJump, figurePageOf, isHttps, openWebSource } from './jump-target';

/** The id of a margin card is this and its thread's id (notes/NotesLayer.tsx). */
const MARGIN_CARD = 'note-card-';

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

  /** The sentence of the passages to light: the best match for the reply's sentence, at most MAX_LIT_LINES lines of it. */
  async function litSentence(pageIndex: number, ranges: readonly { start: number; count: number }[], sentence: string): Promise<{ start: number; count: number }> {
    const [raw, page] = await Promise.all([pageText.rawText(pageIndex), pageText.glyphs(pageIndex)]);
    const want = stemsOf(sentence);
    let best: Span | null = null;
    let bestScore = 0;
    for (const r of ranges) {
      for (const span of sentencesIn(raw, r.start, r.start + r.count, page.glyphs)) {
        best ??= span; // the first sentence, when none shares a word
        const got = stemsOf(plainRaw(raw.slice(span.start, span.end)));
        let score = 0;
        for (const w of want) if (got.has(w)) score++;
        if (score > bestScore) {
          best = span;
          bestScore = score;
        }
      }
    }
    const span = best ?? { start: ranges[0]?.start ?? 0, end: (ranges[0]?.start ?? 0) + (ranges[0]?.count ?? 0) };
    const end = capLines(page.glyphs, span.start, span.end, MAX_LIT_LINES);
    return { start: span.start, count: Math.max(1, trimEnd(raw, span.start, end) - span.start) };
  }

  /**
   * The thread a chip was pressed in stays open where the owner can read it (TB6, student 4). A card in the margin sits
   * beside its own passage, so a jump to another page leaves it behind: then the thread opens in the Notes panel, still
   * active, beside the cited passage. A card already in the panel stays as it is.
   */
  function keepThreadInView(chip: HTMLElement): void {
    const card = chip.closest<HTMLElement>(`[id^="${MARGIN_CARD}"]`);
    const id = card?.id.slice(MARGIN_CARD.length) ?? null;
    if (card === null || id === null || notesPanel.isOpen()) return;
    // After the jump has scrolled (two frames: the scroll, then the cards placed beside the pages).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const view = host.pageList.current?.viewportHeight() ?? window.innerHeight;
        const box = card.isConnected ? card.getBoundingClientRect() : null;
        const top = (chip.ownerDocument.querySelector('[role="document"]')?.getBoundingClientRect().top ?? 0);
        if (box !== null && box.bottom > top + 48 && box.top < top + view - 48) return; // still in view
        const thread = host.session.state().threads.find((t) => t.id === id);
        if (thread === undefined) return;
        host.session.setActive(thread.id);
        notesPanel.setOpen(true);
      }),
    );
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
    async toCitation(c, o = {}) {
      if (pages[c.pageIndex] === undefined) return false;
      // A citation of no text of the page: the words inside a figure (request.ts cites them as an empty range). It goes to the
      // figure on that page, selected, as its figure chip does.
      if (c.end <= c.start) return jumper.toFigure({ label: null, pageIndex: c.pageIndex });
      const passages = [c, ...(o.also ?? []).filter((a) => a.pageIndex === c.pageIndex && a.end > a.start)];
      const ranges: { start: number; count: number }[] = [];
      for (const p of passages) {
        const chars = (await charsOf(p).catch(() => null)) ?? (await foundByQuote(p).catch(() => null));
        if (chars !== null) ranges.push(chars);
      }
      if (ranges.length === 0) return show(c.pageIndex, 0, 0);
      const lit = await litSentence(c.pageIndex, ranges, o.sentence ?? '').catch(() => ranges[0] ?? null);
      if (lit === null) return show(c.pageIndex, 0, 0);
      const where = bounds(await pageText.rects(c.pageIndex, lit.start, lit.count).catch((): PdfRect[] => []));
      const size = pages[c.pageIndex];
      const at = where !== null && size !== undefined ? pdfRectToNorm(where, size) : null;
      const shown = show(c.pageIndex, at?.[0] ?? 0, at?.[1] ?? 0);
      if (shown) {
        hitFlash.show({ pageIndex: c.pageIndex, ranges: [lit] });
        if (o.from !== undefined) keepThreadInView(o.from);
      }
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

// ---- the cited sentence ---------------------------------------------------------------------------------------------

/** At most this many lines of a cited sentence light (visual 9: a whole block lit 13 lines). */
export const MAX_LIT_LINES = 3;

interface Span {
  start: number;
  end: number;
}

/** "e.g." and "et al." do not end a sentence, nor does an initial ("H. C. Sant'Anna"). */
const NOT_AN_END = new Set(['e.g', 'i.e', 'al', 'fig', 'figs', 'eq', 'eqs', 'cf', 'vs', 'sec', 'no', 'dr', 'mr', 'ms', 'resp', 'approx', 'ref', 'refs', 'ch', 'vol', 'pp']);
const SPACE = /[\s\uFFFE]/u;

/**
 * The sentences of raw[from, to), as PDFium char ranges without their outer spaces. A sentence ends at ".", "?" or "!"
 * (and any closing quote or bracket after it) followed by a space or a line break. A line break also ends one where the
 * text changes size or leaves a gap above the next line: a title, the authors and a heading are not one sentence with the
 * paragraph after them.
 */
export function sentencesIn(raw: string, from: number, to: number, glyphs: readonly Glyph[] = []): Span[] {
  const out: Span[] = [];
  const end = Math.min(to, raw.length);
  let start = from;
  const push = (a: number, b: number) => {
    while (a < b && SPACE.test(raw[a] ?? '')) a++;
    while (b > a && SPACE.test(raw[b - 1] ?? '')) b--;
    if (b > a) out.push({ start: a, end: b });
  };
  for (let i = from; i < end; i++) {
    const ch = raw[i];
    if (ch === '\n' && blockBreak(glyphs, i)) {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;
    let j = i + 1;
    while (j < end && /["”’)\]]/u.test(raw[j] ?? '')) j++;
    if (j < end && !SPACE.test(raw[j] ?? '')) continue;
    if (ch === '.') {
      const word = /([\p{L}.]+)$/u.exec(raw.slice(Math.max(start, i - 12), i))?.[1]?.toLowerCase() ?? '';
      if (NOT_AN_END.has(word) || /^\p{L}$/u.test(word)) continue;
    }
    push(start, j);
    start = j;
  }
  push(start, end);
  return out;
}

/** The real glyph nearest char `i`, looking one way (a generated space or line break has no box). */
function realGlyph(glyphs: readonly Glyph[], i: number, step: 1 | -1): Glyph | null {
  for (let k = i + step, n = 0; k >= 0 && k < glyphs.length && n < 8; k += step, n++) {
    const g = glyphs[k];
    if (g !== undefined && !g.generated && g.box.width > 0 && g.box.height > 0) return g;
  }
  return null;
}

/** At a line break: the line after it is set at another size, or a gap of more than half a line lies between them. */
function blockBreak(glyphs: readonly Glyph[], i: number): boolean {
  const a = realGlyph(glyphs, i, -1);
  const b = realGlyph(glyphs, i, 1);
  if (a === null || b === null || a.fontSize <= 0 || b.fontSize <= 0) return false;
  const size = Math.max(a.fontSize, b.fontSize);
  if (size / Math.min(a.fontSize, b.fontSize) > 1.15) return true;
  const across = isAcross(a);
  const step = across ? Math.abs(b.box.y + b.box.height / 2 - (a.box.y + a.box.height / 2)) : Math.abs(b.box.x + b.box.width / 2 - (a.box.x + a.box.width / 2));
  return step > 1.75 * size;
}

/** Text that runs across the page, not down it (angle 0 or 180, give or take 45°). */
const isAcross = (g: Glyph): boolean => Math.abs(((g.angle + 45) % 180) - 45) < 45;

/** Raw chars as words: a joined line-end hyphen joins its word again, and line breaks are spaces. */
const plainRaw = (s: string): string => s.replace(/\uFFFE\s*/gu, '').replace(/[\r\n]+/gu, ' ');

/** Words too common to tell two sentences apart. */
const STOP = new Set(
  'the and for are but not you all any can her was one our out has had his how its may new now see two who did get him let say she too use with that this from they will have been were what when your which their there these those than then them into also more most some such only over very just like each other about would could should because while where after before being does doing'.split(' '),
);

/** A sentence's words, for comparing: lower case, common words left out, each cut to its first 6 letters. */
export function stemsOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (w.length >= 3 && !STOP.has(w)) out.add(w.slice(0, 6));
  return out;
}

/**
 * Where a range stops so that it covers at most `max` lines: the char that starts line `max + 1`, or `to`. A line ends at
 * PDFium's own line break, or where the text jumps to another line (across, for text that runs down the page).
 */
export function capLines(glyphs: readonly Glyph[], from: number, to: number, max: number): number {
  let lines = 0;
  let broke = true;
  let last: Glyph | null = null;
  for (let i = from; i < to; i++) {
    const g = glyphs[i];
    if (g === undefined) break;
    if (g.generated || g.box.width <= 0 || g.box.height <= 0) {
      if (g.text === '\n' || g.text === '\r') broke = true;
      continue;
    }
    let fresh = broke;
    if (!fresh && last !== null) {
      const [a, b, size] = isAcross(g) ? [g.box.y + g.box.height / 2, last.box.y + last.box.height / 2, Math.max(g.box.height, last.box.height)] : [g.box.x + g.box.width / 2, last.box.x + last.box.width / 2, Math.max(g.box.width, last.box.width)];
      fresh = Math.abs(a - b) > 0.75 * size;
    }
    if (fresh) {
      lines++;
      if (lines > max) return i;
    }
    broke = false;
    last = g;
  }
  return to;
}

/** The end of a range with the spaces and line breaks before it left out. */
function trimEnd(raw: string, from: number, to: number): number {
  let b = to;
  while (b > from && SPACE.test(raw[b - 1] ?? '')) b--;
  return b;
}
