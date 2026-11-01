// Re-anchoring: where is a stored note drawn in the PDF that is open now? (contracts §2, spec "Re-anchoring on open")
//
// This only decides where a note is drawn. It reads the stored anchor and never rewrites it: the returned anchor is a
// view for the bytes that are open, kept in memory by the caller.
//
// Text, in this order (Hypothesis's order: position, then quote, then a context-aware fuzzy match):
//  1. 'stored'    the stored position, if the quote still reads the same there;
//  2. 'same-page' the exact quote on the stored page, when the text around it still agrees (a stamp or an edit above
//                 shifted the char indices; nothing the owner can see has moved);
//  3. 'fuzzy'     any other match across the document, nearest pages first: a quote of at least FUZZY_MIN_QUOTE chars
//                 that scores at least FUZZY_MIN_SCORE (Hypothesis's score: the quote counts 50, the text before and
//                 after it 20 each, nearness 2) and is clearly better than every other place it could be.
// A placement by 'fuzzy' is a close match, not the same words in the same place: the card says "Moved". Anything that
// scores less, or that two places fit equally well, is not placed. It goes to "Couldn't place" and is never drawn on
// look-alike text (Hypothesis issue 7571: a fuzzy fallback re-attached a note to a different paragraph that held the
// same sentence).
//
// Figures stay put while the image hash, the caption quote or the picture's dHash (distance up to DHASH_MATCH_MAX)
// still match on the stored page; otherwise they follow their caption, then their image (research 06 §5).
import type { PageTextProvider } from '../../../viewer/src/text/page-text';
import type { Anchor, CharPos, NormRect } from '../model/anchor';
import type { PageFigure } from '../model/figures';
import { DHASH_MATCH_MAX, hammingHex } from './dhash';
import { buildTextAnchor } from './quote';
import { foldText, type Folded } from './text-fold';
import { search as approxSearch, textMatchScore } from './vendor/match-quote';

/** A fuzzy match must score at least this. */
export const FUZZY_MIN_SCORE = 0.8;
/** A fuzzy match needs a quote of at least this many chars (folded: line breaks and marks that are not text do not count). */
export const FUZZY_MIN_QUOTE = 12;

export type PlacedBy = 'stored' | 'same-page' | 'fuzzy' | 'figure-match' | 'caption' | 'image';

export type Resolution =
  | { placed: true; by: PlacedBy; score: number; anchor: Anchor /* positions and rects for these bytes */ }
  | { placed: false; reason: 'quote-not-found' | 'below-threshold' | 'figure-not-found' | 'no-text' };

export interface AnchorContext {
  pageCount: number;
  text: PageTextProvider;
  figures(pageIndex: number): Promise<PageFigure[]>;
  dHash(pageIndex: number, rect: NormRect): Promise<string>;
  /**
   * Optional, S3's addition. The size in points of a page's unrotated crop box. With it a figure that is followed to
   * another place gets the rect of the figure found there (PageFigure.rect is in points, anchors are 0–1). Without it
   * such a figure keeps its stored rect on the new page.
   */
  pageSize?(pageIndex: number): { width: number; height: number } | null;
  /**
   * Optional, S3's addition. The rects to draw chars [start, start + count) of a page with: the mark geometry, 0–1 of
   * the crop box, one per line. When a text anchor is placed anywhere but 'stored', the old rects no longer apply; with
   * this they are made again for these bytes, without it they are left empty, which the contract defines as "compute
   * on open".
   */
  normRects?(pageIndex: number, start: number, count: number): Promise<NormRect[]>;
}

// ---- Hypothesis's score (vendored match-quote.ts), weights unchanged ----
const W_QUOTE = 50;
const W_PREFIX = 20;
const W_SUFFIX = 20;
const W_POSITION = 2;
const W_SUM = W_QUOTE + W_PREFIX + W_SUFFIX + W_POSITION;

/**
 * Text before or after a quote that scores less than this against the stored context counts as not agreeing at all.
 * Hypothesis adds a little for any side that looks a bit like the stored one, and unrelated English scores 0.25 to 0.4
 * against any 32 chars. That chance score let a quote with one agreeing side and one unrelated side reach the 0.8 floor
 * (issue 7571). With this, a side either agrees or counts nothing, and the best a candidate with a disagreeing side can
 * score is 72 ÷ 92 = 0.78, always under the floor.
 */
const CONTEXT_CHANCE = 0.5;

/** An exact quote whose surroundings agree this well is "the same words in the same place", so no "Moved" label. */
const SAME_PAGE_MIN_SCORE = 0.95;
/** The best place must beat the next one by this much, or the choice is a guess. */
const AMBIGUITY_MARGIN = 0.03;
/**
 * The most errors the approximate search allows, as a share of the quote. The score floor is 0.8 and the quote carries
 * at most 50 of its 92 points, so a quote that is off by more than about a third cannot reach it whatever surrounds it.
 */
const MAX_ERROR_SHARE = 0.4;
/** Hypothesis's own cap on the errors allowed. */
const MAX_ERRORS = 256;
/** A quote longer than this many pages is never searched for fuzzily. */
const MAX_FUZZY_SPAN = 4;
/** Pages whose text is fetched at once. */
const PAGES_AT_ONCE = 8;
/** Exact copies of one quote looked at on one page. */
const MAX_EXACT_PER_PAGE = 64;

type TextAnchor = Extract<Anchor, { kind: 'text' }>;
type FigureAnchor = Extract<Anchor, { kind: 'figure' }>;

export interface ResolveOptions {
  /** Stops the search between pages. */
  signal?: AbortSignal;
}

/** Where `a` is drawn in the PDF that `ctx` reads. See the file's header for the rules. */
export async function resolveAnchor(a: Anchor, ctx: AnchorContext, o: ResolveOptions = {}): Promise<Resolution> {
  switch (a.kind) {
    case 'text':
      return resolveText(a, ctx, o);
    case 'figure':
      return resolveFigure(a, ctx, o);
    case 'area':
      return resolveArea(a, ctx);
    case 'point':
    case 'page':
      return a.page >= 0 && a.page < ctx.pageCount ? stay(a) : { placed: false, reason: 'figure-not-found' };
    case 'document':
      return stay(a);
    default:
      return { placed: false, reason: 'quote-not-found' };
  }
}

function stay(a: Anchor): Resolution {
  return { placed: true, by: 'stored', score: 1, anchor: structuredClone(a) };
}

// =====================================================================================================================
// Text
// =====================================================================================================================

interface Found {
  by: 'stored' | 'same-page' | 'fuzzy';
  score: number;
  start: CharPos;
  end: CharPos;
}
type Located = ({ placed: true } & Found) | { placed: false; reason: 'quote-not-found' | 'below-threshold' | 'no-text' };

/** A run of pages read as one text, joined with '\n' like a quote that crosses pages. */
interface Win {
  first: number;
  /** Raw offset of each page's first char in `raw`. */
  starts: number[];
  lens: number[];
  raw: string;
  folded: Folded;
}

interface Candidate {
  win: Win;
  /** Folded offsets, end exclusive, with no space at either end. */
  s: number;
  e: number;
  errors: number;
  score: number;
}

class Reader {
  private readonly raws = new Map<number, Promise<string>>();
  private readonly cleans = new Map<number, Promise<string>>();
  private readonly wins = new Map<string, Promise<Win>>();
  constructor(
    readonly ctx: AnchorContext,
    private readonly signal: AbortSignal | undefined,
  ) {}

  /** The page's chars, index-aligned when the provider can (rawText), else its text as it is. */
  raw(index: number): Promise<string> {
    this.check();
    let hit = this.raws.get(index);
    if (!hit) {
      const t = this.ctx.text;
      hit = typeof t.rawText === 'function' ? t.rawText(index) : t.text(index);
      this.raws.set(index, hit);
    }
    return hit;
  }

  /** getPageText: much cheaper to read than the aligned text, and the same once folded. For searching, not for positions. */
  clean(index: number): Promise<string> {
    this.check();
    let hit = this.cleans.get(index);
    if (!hit) {
      hit = this.ctx.text.text(index);
      this.cleans.set(index, hit);
    }
    return hit;
  }

  /** The text of chars [start, start + count) of a page, without the marks that are not text. */
  async range(index: number, start: number, count: number): Promise<string> {
    this.check();
    const t = this.ctx.text;
    if (typeof t.rangeText === 'function') return t.rangeText(index, start, count);
    return (await this.raw(index)).slice(start, start + count);
  }

  /** Pages [first, first + span) read as one text: the aligned one ('raw'), or the cheap one for searching ('clean'). */
  window(first: number, span: number, kind: 'raw' | 'clean'): Promise<Win> {
    const key = `${kind}:${first}:${span}`;
    let hit = this.wins.get(key);
    if (!hit) {
      hit = (async () => {
        const texts = await Promise.all(Array.from({ length: span }, (_, k) => (kind === 'raw' ? this.raw(first + k) : this.clean(first + k))));
        const starts: number[] = [];
        let at = 0;
        for (const t of texts) {
          starts.push(at);
          at += t.length + 1;
        }
        const raw = texts.join('\n');
        return { first, starts, lens: texts.map((t) => t.length), raw, folded: foldText(raw) };
      })();
      this.wins.set(key, hit);
    }
    return hit;
  }

  check(): void {
    if (this.signal?.aborted) throw new DOMException('Re-anchoring was stopped', 'AbortError');
  }
}

function posIn(win: Win, rawOffset: number): CharPos {
  let k = win.starts.length - 1;
  while (k > 0 && win.starts[k] > rawOffset) k--;
  // An offset on the '\n' that joins two pages belongs to the end of the earlier page.
  return { page: win.first + k, index: Math.min(rawOffset - win.starts[k], win.lens[k]) };
}

/** First folded offset whose source char is at or after `rawOffset`. */
function foldedAt(f: Folded, rawOffset: number): number {
  let lo = 0;
  let hi = f.src.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.src[mid] < rawOffset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Moves a folded range in to the first and last char that are not a space; null if nothing is left. */
function trimmed(f: Folded, s: number, e: number): [number, number] | null {
  while (s < e && f.text[s] === ' ') s++;
  while (e > s && f.text[e - 1] === ' ') e--;
  return e > s ? [s, e] : null;
}

function foundAt(win: Win, s: number, e: number): { start: CharPos; end: CharPos } {
  const last = posIn(win, win.folded.src[e - 1]);
  return { start: posIn(win, win.folded.src[s]), end: { page: last.page, index: last.index + 1 } };
}

interface Wanted {
  quote: string;
  prefix: string;
  suffix: string;
  /** Where the stored start is in the folded text of the stored page, for "nearness"; null when that page is not there. */
  hintF: number | null;
  pageCount: number;
}

/** Hypothesis's score for the text at [s, e) of a window, with `pageDistance` pages between it and the stored page. */
function scoreAt(win: Win, s: number, e: number, errors: number, w: Wanted, pageDistance: number): { score: number; noPosition: number } {
  const text = win.folded.text;
  const quoteScore = Math.max(0, 1 - errors / w.quote.length);
  const agree = (score: number) => (score >= CONTEXT_CHANCE ? score : 0);
  const prefixScore = w.prefix ? agree(textMatchScore(text.slice(Math.max(0, s - w.prefix.length), s), w.prefix)) : 1;
  const suffixScore = w.suffix ? agree(textMatchScore(text.slice(e, e + w.suffix.length), w.suffix)) : 1;
  let positionScore: number;
  if (pageDistance === 0 && w.hintF !== null) positionScore = 1 - Math.min(1, Math.abs(s - w.hintF) / Math.max(1, text.length));
  else positionScore = 1 - Math.min(1, pageDistance / Math.max(1, w.pageCount));
  const base = W_QUOTE * quoteScore + W_PREFIX * prefixScore + W_SUFFIX * suffixScore;
  return { score: (base + W_POSITION * positionScore) / W_SUM, noPosition: (base + W_POSITION) / W_SUM };
}

function exactAt(text: string, q: string): number[] {
  const at: number[] = [];
  for (let from = text.indexOf(q); from !== -1 && at.length < MAX_EXACT_PER_PAGE; from = text.indexOf(q, from + 1)) at.push(from);
  return at;
}

/** The nearest pages first: c, c + 1, c - 1, c + 2, c - 2, … inside [0, count). */
function nearestFirst(c: number, count: number): number[] {
  const out: number[] = [];
  const centre = Math.max(0, Math.min(count - 1, c));
  for (let d = 0; out.length < count; d++) {
    if (centre + d < count) out.push(centre + d);
    if (d > 0 && centre - d >= 0) out.push(centre - d);
    if (centre + d >= count && centre - d < 0) break;
  }
  return out;
}

/** The stored position, the exact quote on the same page, then a fuzzy match across the document. */
async function locate(a: TextAnchor, rd: Reader, scope: 'document' | 'page'): Promise<Located> {
  const ctx = rd.ctx;
  const q = foldText(a.quote.quote).text;
  if (q.length === 0) return { placed: false, reason: 'quote-not-found' };
  const span = Math.max(1, a.end.page - a.start.page + 1);
  const home = a.start.page;
  const homeOk = home >= 0 && home + span <= ctx.pageCount;
  const w: Wanted = {
    quote: q,
    prefix: foldText(a.quote.prefix, { trim: false }).text,
    suffix: foldText(a.quote.suffix, { trim: false }).text,
    hintF: null,
    pageCount: ctx.pageCount,
  };

  // 1. The stored position. Reads only the text of the stored range.
  if (homeOk && sameSource(a, ctx)) {
    const parts = await Promise.all(
      Array.from({ length: span }, (_, k) => {
        const from = k === 0 ? a.start.index : 0;
        return rd.range(home + k, from, k === span - 1 ? Math.max(0, a.end.index - from) : Number.MAX_SAFE_INTEGER);
      }),
    );
    if (foldText(parts.join('\n')).text === q) return { placed: true, by: 'stored', score: 1, start: { ...a.start }, end: { ...a.end } };
  }

  // 2. The exact quote on the stored page, when the text around it still agrees.
  let exactCandidates = 0;
  if (homeOk) {
    const win = await rd.window(home, span, 'raw');
    w.hintF = foldedAt(win.folded, win.starts[0] + a.start.index);
    let best: { s: number; score: number; noPosition: number } | null = null;
    for (const s of exactAt(win.folded.text, q)) {
      exactCandidates++;
      const r = scoreAt(win, s, s + q.length, 0, w, 0);
      if (!best || r.score > best.score) best = { s, ...r };
    }
    if (best && best.noPosition >= SAME_PAGE_MIN_SCORE) {
      const at = foundAt(win, best.s, best.s + q.length);
      return { placed: true, by: 'same-page', score: best.noPosition, ...at };
    }
  }
  if (scope === 'page') return { placed: false, reason: exactCandidates > 0 ? 'below-threshold' : 'quote-not-found' };

  // 3. A fuzzy match anywhere in the document. Searched on getPageText, which is cheap to read; the winner's chars are
  //    then read in full to get its char indices.
  if (q.length < FUZZY_MIN_QUOTE || span > MAX_FUZZY_SPAN || ctx.pageCount < span) {
    return { placed: false, reason: exactCandidates > 0 ? 'below-threshold' : 'quote-not-found' };
  }
  const maxErrors = Math.min(MAX_ERRORS, Math.floor(q.length * MAX_ERROR_SHARE));
  const firsts = nearestFirst(home, ctx.pageCount - span + 1);
  const all: Candidate[] = [];
  let textSeen = false;
  for (let i = 0; i < firsts.length; i += PAGES_AT_ONCE) {
    rd.check();
    const wins = await Promise.all(firsts.slice(i, i + PAGES_AT_ONCE).map((f) => rd.window(f, span, 'clean')));
    for (const win of wins) {
      if (win.folded.text.length > 0) textSeen = true;
      all.push(...candidatesIn(win, w, maxErrors, Math.abs(win.first - home)));
    }
  }
  if (!textSeen) return { placed: false, reason: 'no-text' };
  if (all.length === 0) return { placed: false, reason: 'quote-not-found' };

  // Best score first; on a tie the nearer page.
  all.sort((x, y) => y.score - x.score || Math.abs(x.win.first - home) - Math.abs(y.win.first - home));
  const best = all[0];
  if (best.score < FUZZY_MIN_SCORE) return { placed: false, reason: 'below-threshold' };
  const rival = all.find((c) => c !== best && c.score >= FUZZY_MIN_SCORE && !samePlace(c, best));
  if (rival && best.score - rival.score < AMBIGUITY_MARGIN) return { placed: false, reason: 'below-threshold' };

  // The winner's chars, with the marks that are not text still in them: its char indices.
  const rawWin = await rd.window(best.win.first, span, 'raw');
  if (rawWin.folded.text === best.win.folded.text) return { placed: true, by: 'fuzzy', score: best.score, ...foundAt(rawWin, best.s, best.e) };
  // A provider whose two texts disagree once folded: look again in the aligned one.
  const again = candidatesIn(rawWin, w, maxErrors, Math.abs(rawWin.first - home)).sort((x, y) => y.score - x.score)[0];
  if (!again || again.score < FUZZY_MIN_SCORE) return { placed: false, reason: 'below-threshold' };
  return { placed: true, by: 'fuzzy', score: again.score, ...foundAt(rawWin, again.s, again.e) };
}

function samePlace(x: Candidate, y: Candidate): boolean {
  return x.win === y.win && x.s < y.e && y.s < x.e;
}

function sameSource(a: TextAnchor, ctx: AnchorContext): boolean {
  const source = typeof ctx.text.source === 'function' ? ctx.text.source(a.start.page) : 'pdfium';
  return (a.textSource ?? 'pdfium') === source;
}

/** The best places for the quote in one window: up to two rounds, the second after hiding the first round's matches. */
function candidatesIn(win: Win, w: Wanted, maxErrors: number, pageDistance: number): Candidate[] {
  const text = win.folded.text;
  if (text.length === 0) return [];
  const out: Candidate[] = [];
  let hay = text;
  for (let round = 0; round < 2; round++) {
    const matches = approxSearch(hay, w.quote, maxErrors);
    if (matches.length === 0) break;
    const found: Candidate[] = [];
    for (const m of matches) {
      const t = trimmed(win.folded, m.start, m.end);
      if (!t) continue;
      found.push({ win, s: t[0], e: t[1], errors: m.errors, score: scoreAt(win, t[0], t[1], m.errors, w, pageDistance).score });
    }
    found.sort((x, y) => y.score - x.score);
    // Keep the best of any matches that overlap each other.
    for (const c of found) if (!out.some((k) => samePlace(k, c))) out.push(c);
    if (matches[0].errors === 0) break;
    // Hide this round's matches, so the next round finds the next-best place.
    let hidden = hay;
    for (const m of matches) hidden = hidden.slice(0, m.start) + '￿'.repeat(m.end - m.start) + hidden.slice(m.end);
    hay = hidden;
  }
  return out;
}

async function resolveText(a: TextAnchor, ctx: AnchorContext, o: ResolveOptions): Promise<Resolution> {
  const rd = new Reader(ctx, o.signal);
  const found = await locate(a, rd, 'document');
  if (!found.placed) return found;
  if (found.by === 'stored') return { placed: true, by: 'stored', score: 1, anchor: structuredClone(a) };

  const pages: number[] = [];
  for (let p = found.start.page; p <= found.end.page; p++) pages.push(p);
  const texts = new Map<number, string>();
  await Promise.all(pages.map(async (p) => texts.set(p, await rd.raw(p))));
  const rects = await rectsFor(ctx, found.start, found.end, (p) => texts.get(p)?.length ?? 0);
  const source = typeof ctx.text.source === 'function' ? ctx.text.source(found.start.page) : 'pdfium';
  const anchor = buildTextAnchor({
    text: (p) => texts.get(p) ?? '',
    start: found.start,
    end: found.end,
    rects,
    textSource: source === 'pdfium' && a.textSource === undefined ? undefined : source,
  });
  return { placed: true, by: found.by, score: found.score, anchor };
}

/** The rects for a placed range, page by page: from the context's mark geometry, or else nothing ("compute on open"). */
async function rectsFor(ctx: AnchorContext, start: CharPos, end: CharPos, lengthOf: (page: number) => number): Promise<{ page: number; rects: NormRect[] }[]> {
  const out: { page: number; rects: NormRect[] }[] = [];
  if (!ctx.normRects) return out;
  try {
    for (let page = start.page; page <= end.page; page++) {
      const from = page === start.page ? start.index : 0;
      const to = page === end.page ? end.index : lengthOf(page);
      if (to > from) out.push({ page, rects: await ctx.normRects(page, from, to - from) });
    }
  } catch {
    return [];
  }
  return out;
}

// =====================================================================================================================
// Figures and areas
// =====================================================================================================================

function toNorm(r: { x: number; y: number; width: number; height: number }, size: { width: number; height: number }): NormRect {
  const clip = (v: number) => Math.max(0, Math.min(1, v));
  return [clip(r.x / size.width), clip(r.y / size.height), clip((r.x + r.width) / size.width), clip((r.y + r.height) / size.height)];
}

async function dHashAt(ctx: AnchorContext, page: number, rect: NormRect): Promise<string | null> {
  try {
    return await ctx.dHash(page, rect);
  } catch {
    return null;
  }
}

async function figuresOn(ctx: AnchorContext, page: number): Promise<PageFigure[]> {
  if (page < 0 || page >= ctx.pageCount) return [];
  try {
    return await ctx.figures(page);
  } catch {
    return [];
  }
}

/** The caption quote as a text anchor on the page where it was stored. */
function captionAsText(c: NonNullable<FigureAnchor['figure']['captionQuote']>): TextAnchor {
  return {
    kind: 'text',
    quote: { quote: c.quote, prefix: c.prefix, suffix: c.suffix },
    start: { ...c.position },
    end: { page: c.position.page, index: c.position.index + c.quote.length },
    rects: [],
  };
}

async function resolveFigure(a: FigureAnchor, ctx: AnchorContext, o: ResolveOptions): Promise<Resolution> {
  if (a.page < 0 || a.page >= ctx.pageCount) return { placed: false, reason: 'figure-not-found' };
  const fp = a.figure;
  const rd = new Reader(ctx, o.signal);

  // 1. Stays put while the image, the caption or the picture still matches on the stored page.
  const here = await figuresOn(ctx, a.page);
  if (fp.imageSha256 && here.some((f) => f.imageSha256 === fp.imageSha256)) return { placed: true, by: 'figure-match', score: 1, anchor: structuredClone(a) };
  if (fp.captionQuote && Math.abs(fp.captionQuote.position.page - a.page) <= 1) {
    const there = await locate(captionAsText(fp.captionQuote), rd, 'page');
    if (there.placed) return { placed: true, by: 'figure-match', score: 1, anchor: structuredClone(a) };
  }
  if (fp.dHash) {
    const now = await dHashAt(ctx, a.page, a.rect);
    if (now !== null) {
      const distance = hammingHex(now, fp.dHash);
      if (distance <= DHASH_MATCH_MAX) return { placed: true, by: 'figure-match', score: 1 - distance / 64, anchor: structuredClone(a) };
    }
  }

  // 2. Follows its caption.
  if (fp.captionQuote) {
    const moved = await locate(captionAsText(fp.captionQuote), rd, 'document');
    if (moved.placed) {
      const figs = await figuresOn(ctx, moved.start.page);
      const own =
        figs.find((f) => f.caption && f.caption.start < moved.end.index && moved.start.index < f.caption.end) ??
        (fp.label ? figs.find((f) => f.label === fp.label) : undefined);
      if (own) return { placed: true, by: 'caption', score: moved.by === 'fuzzy' ? moved.score : 1, anchor: await movedFigure(a, own, moved.start.page, ctx, moved.start) };
    }
  }

  // 3. Follows its image, nearest pages first. A label that disagrees rules a figure out.
  if (fp.imageSha256) {
    for (const page of nearestFirst(a.page, ctx.pageCount)) {
      if (page === a.page) continue;
      rd.check();
      const hit = (await figuresOn(ctx, page)).find((f) => f.imageSha256 === fp.imageSha256 && (!fp.label || !f.label || f.label === fp.label));
      if (hit) return { placed: true, by: 'image', score: 1, anchor: await movedFigure(a, hit, page, ctx, null) };
    }
  }
  return { placed: false, reason: 'figure-not-found' };
}

/** `a` on the figure `f` of `page`: its box, hashes and caption position come from the figure found there. */
async function movedFigure(a: FigureAnchor, f: PageFigure, page: number, ctx: AnchorContext, captionAt: CharPos | null): Promise<FigureAnchor> {
  const size = ctx.pageSize?.(page) ?? null;
  const rect: NormRect = size && size.width > 0 && size.height > 0 ? toNorm(f.rect, size) : [...a.rect];
  const fresh = size ? await dHashAt(ctx, page, rect) : null;
  const fp = a.figure;
  const figure: FigureAnchor['figure'] = {
    ...fp,
    label: f.label ?? fp.label,
    imageSha256: f.imageSha256 ?? fp.imageSha256,
    dHash: fresh ?? fp.dHash,
    objectIndices: f.objectIndices.length > 0 ? [...f.objectIndices] : fp.objectIndices,
  };
  if (fp.captionQuote) {
    const position = f.caption ? { page, index: f.caption.start } : captionAt;
    if (position) figure.captionQuote = { ...fp.captionQuote, position };
  }
  const moved: FigureAnchor = { kind: 'figure', page, rect, figure };
  if (a.sub) moved.sub = structuredClone(a.sub);
  return moved;
}

/** An area has no words to follow: it stays where it is while the picture under it still looks the same. */
async function resolveArea(a: Extract<Anchor, { kind: 'area' }>, ctx: AnchorContext): Promise<Resolution> {
  if (a.page < 0 || a.page >= ctx.pageCount) return { placed: false, reason: 'figure-not-found' };
  // An area made without a hash cannot be checked; its page and rect are all there is.
  if (!a.dHash) return stay(a);
  const now = await dHashAt(ctx, a.page, a.rect);
  if (now === null) return stay(a);
  const distance = hammingHex(now, a.dHash);
  if (distance <= DHASH_MATCH_MAX) return { placed: true, by: 'stored', score: 1 - distance / 64, anchor: structuredClone(a) };
  return { placed: false, reason: 'figure-not-found' };
}
