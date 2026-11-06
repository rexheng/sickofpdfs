// The sums and word-work behind "Explain this figure" (plan Phase 4 slice C, research 06 section 7). Pure: no engine, no
// canvas. render-region.ts (the picture) and figure-pack.ts (the text pack) use it.
//
// - Image tokens: ceil(width / 28) x ceil(height / 28), the high-resolution tier's formula (06 section 7.1).
// - Scale: clamp(18 / smallest font, 150 dpi, 300 dpi), lowered until the picture fits its token budget.
// - Inside text: the exact words inside the figure, tagged by where they sit, so Claude need not read 6 pt ticks.
// - Mentions: up to 3 short passages that name the figure's label, first mention and same-page mentions first.
// - Labels: "Figure 2 and 3", "Fig. 4a", "Table III" in a question become labels to attach.
import type { Passage } from './types';

/** A rectangle in points, y down (the same shape as the viewer's PdfRect; core does not import the viewer). */
export interface Box { x: number; y: number; width: number; height: number }
/** The few fields of a text run this file reads (the viewer's TextRun has them). */
export interface RunLike { text: string; rect: Box; fontSize: number }

// ---- Budgets (plan section 3 and research 06 section 7.1, 7.4) ----

/** One image patch is 28 x 28 px; a patch costs one token. */
export const IMAGE_PATCH_PX = 28;
/** The long edge the API accepts without shrinking the picture. */
export const MAX_IMAGE_EDGE_PX = 2576;
export const MIN_DPI = 150;
export const MAX_DPI = 300;
/** The size small text should reach on screen, in px, for Claude to read it (06 section 7.1 step 2). */
export const LEGIBLE_FONT_PX = 18;
/** Image budgets by role (contract maxTokens). */
export const IMAGE_BUDGET = { default: 1600, thinkHarder: 3200, scan: 4784 } as const;
/** A second, enlarged crop for a small mark: its own budget. */
export const DETAIL_BUDGET = 1000;
/** A mark smaller than this share of the figure also gets its own enlarged crop. */
export const SMALL_MARK_SHARE = 0.25;
/** Padding around a figure's box, in points. */
export const FIGURE_PADDING_PT = 4;
/** "Compare Figure 2 and 3": at most this many figures up front, at this many image tokens each, and at most this many images. */
export const FIGURE_LIMITS = { figures: 4, tokensEach: 1200, images: 20 } as const;
/** Mentions per figure and the longest one, in tokens (ceil(chars / 4)). */
export const MAX_MENTIONS = 3;
export const MENTION_MAX_TOKENS = 200;
/** The inside text is cut here (tokens), so a dense table cannot fill the request. */
export const INSIDE_TEXT_MAX_TOKENS = 600;
/** Text smaller than this is not read as text (page marks, hairline artefacts). */
export const MIN_FONT_PT = 3;
/** A photograph: image objects cover more than this share of the region (06 section 7.1 step 4). */
export const PHOTO_COVERAGE = 0.6;

const tokensOf = (chars: number) => Math.ceil(chars / 4);

// ---- Picture size ----

/** What the high-resolution tier charges for a picture of this size in pixels. */
export function visualTokens(widthPx: number, heightPx: number): number {
  return Math.ceil(widthPx / IMAGE_PATCH_PX) * Math.ceil(heightPx / IMAGE_PATCH_PX);
}

/** Pixels per point wanted for the smallest text inside (null: no text, 200 dpi), and never above the native pixels of a raster region. */
export function wantedScale(smallestFontPt: number | null, nativePxPerPt?: number | null): number {
  const lo = MIN_DPI / 72;
  const hi = MAX_DPI / 72;
  const wanted = smallestFontPt === null ? 200 / 72 : Math.min(hi, Math.max(lo, LEGIBLE_FONT_PX / smallestFontPt));
  return nativePxPerPt && nativePxPerPt > 0 ? Math.min(wanted, nativePxPerPt) : wanted;
}

export interface FittedScale { scale: number; width: number; height: number; tokens: number }

/**
 * The largest scale at or below `wanted` where the picture costs at most `maxTokens` and its long edge is at most 2,576 px.
 * Width and height are the pixels renderTile makes: round(points x scale).
 */
export function fitScale(widthPt: number, heightPt: number, wanted: number, maxTokens: number, maxEdge = MAX_IMAGE_EDGE_PX): FittedScale {
  const w = Math.max(1, widthPt);
  const h = Math.max(1, heightPt);
  let scale = Math.min(wanted, (maxEdge - 0.5) / Math.max(w, h));
  const dims = (s: number) => ({ width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) });
  let d = dims(scale);
  let tokens = visualTokens(d.width, d.height);
  if (tokens > maxTokens) {
    scale *= Math.sqrt(maxTokens / tokens);
    d = dims(scale);
    tokens = visualTokens(d.width, d.height);
  }
  for (let guard = 0; guard < 400 && (tokens > maxTokens || Math.max(d.width, d.height) > maxEdge); guard++) {
    scale *= 0.99;
    d = dims(scale);
    tokens = visualTokens(d.width, d.height);
  }
  return { scale, ...d, tokens };
}

/** PNG keeps rendered text sharp; JPEG (quality 0.9) for photographs and scans (06 section 7.1 step 4). */
export function chooseFormat(o: { photoCoverage: number; scan?: boolean; format?: 'auto' | 'png' | 'jpeg' }): 'png' | 'jpeg' {
  if (o.format === 'png' || o.format === 'jpeg') return o.format;
  return o.scan === true || o.photoCoverage > PHOTO_COVERAGE ? 'jpeg' : 'png';
}

/** Each image must stay under this many raw bytes (5 MB of base64, with room to spare). */
export const MAX_IMAGE_BYTES = 3_750_000;

// ---- Geometry ----

const centre = (r: Box) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
export const contains = (outer: Box, x: number, y: number) => x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
export function intersect(a: Box, b: Box): Box | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

/** The box grown by `pad` on every side and cut to the page. */
export function padAndClip(r: Box, pad: number, page: { width: number; height: number }): Box {
  const x0 = Math.max(0, r.x - pad);
  const y0 = Math.max(0, r.y - pad);
  const x1 = Math.min(page.width, r.x + r.width + pad);
  const y1 = Math.min(page.height, r.y + r.height + pad);
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** Whether the mark is small enough to deserve its own enlarged crop. */
export function isSmallMark(mark: Box, figure: Box): boolean {
  return (mark.width * mark.height) / Math.max(1, figure.width * figure.height) < SMALL_MARK_SHARE;
}

/** A run is inside the region when its centre is. */
export function runsInside<T extends RunLike>(runs: readonly T[], region: Box): T[] {
  return runs.filter((r) => {
    const c = centre(r.rect);
    return contains(region, c.x, c.y);
  });
}

/** The smallest font in the region that is at least 3 pt, or null when it holds no text. */
export function smallestFont(sizes: Iterable<number>): number | null {
  let min: number | null = null;
  for (const s of sizes) if (s >= MIN_FONT_PT && (min === null || s < min)) min = s;
  return min;
}

// ---- Text inside the figure ----

export type InsideTag = 'left, rotated' | 'below' | 'inside';
const TAG_ORDER: InsideTag[] = ['below', 'left, rotated', 'inside'];

/**
 * The words inside the region, exact, in reading order, tagged by where they sit: `[below]` an x axis, `[left, rotated]`
 * a y axis, `[inside]` labels and legend. Words in `skip` (the caption) are left out. Cut at INSIDE_TEXT_MAX_TOKENS.
 */
export function insideTextOf(runs: readonly RunLike[], region: Box, skip?: Box | null): string {
  const groups = new Map<InsideTag, { x: number; y: number; text: string }[]>();
  const seen = new Set<string>();
  for (const run of cleanRuns(runsInside(runs, region))) {
    const text = run.text;
    const c = centre(run.rect);
    if (skip && contains(skip, c.x, c.y)) continue;
    const relX = (c.x - region.x) / Math.max(1, region.width);
    const relY = (c.y - region.y) / Math.max(1, region.height);
    const tall = run.rect.height > 2 * run.rect.width && text.length > 2;
    const tag: InsideTag = tall && relX < 0.2 ? 'left, rotated' : relY > 0.86 && !tall ? 'below' : 'inside';
    const key = `${tag}|${text}|${Math.round(c.x)}|${Math.round(c.y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = groups.get(tag) ?? [];
    list.push({ x: c.x, y: c.y, text });
    groups.set(tag, list);
  }
  const parts: string[] = [];
  for (const tag of TAG_ORDER) {
    const list = groups.get(tag);
    if (!list?.length) continue;
    // A band of words reads left to right; a column (the y axis) reads top to bottom; the rest by rows.
    if (tag === 'left, rotated') list.sort((a, b) => a.y - b.y);
    else if (tag === 'below') list.sort((a, b) => a.x - b.x);
    else list.sort((a, b) => Math.round(a.y / 6) - Math.round(b.y / 6) || a.x - b.x);
    parts.push(`[${tag}] ${list.map((i) => i.text).join(', ')}`);
  }
  let out = parts.join('; ');
  const maxChars = INSIDE_TEXT_MAX_TOKENS * 4;
  if (out.length > maxChars) out = `${out.slice(0, maxChars - 1).trimEnd()}…`;
  return out;
}

/** Text without the chars PDFium uses for "no character" (U+FFFD to U+FFFF, controls), on one line. */
function cleanRun(run: RunLike): RunLike {
  // eslint-disable-next-line no-control-regex
  return { ...run, text: run.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd-\uffff\u00ad\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ') };
}

/** The runs cleaned, split pieces joined, and those with no letter or digit dropped. Used for the words inside and around a figure. */
export function cleanRuns(runs: readonly RunLike[]): RunLike[] {
  return mergeFragments(runs.map(cleanRun))
    .map((r) => ({ ...r, text: r.text.trim() }))
    .filter((r) => /[\p{L}\p{N}]/u.test(r.text));
}

/**
 * Sideways text comes out of PDFium a letter at a time, and a tick label can split in two ("Conventiona" and "l"). Runs that
 * follow each other in text order, touch, and are one or two chars long are joined, so each word is one item.
 */
function mergeFragments(runs: readonly RunLike[]): RunLike[] {
  const out: RunLike[] = [];
  for (const r of runs) {
    const a = out.at(-1);
    if (a && (a.text.trim().length <= 2 || r.text.trim().length <= 2) && touches(a, r)) {
      const x0 = Math.min(a.rect.x, r.rect.x);
      const y0 = Math.min(a.rect.y, r.rect.y);
      const x1 = Math.max(a.rect.x + a.rect.width, r.rect.x + r.rect.width);
      const y1 = Math.max(a.rect.y + a.rect.height, r.rect.y + r.rect.height);
      out[out.length - 1] = { ...a, text: a.text + r.text, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    } else out.push(r);
  }
  return out;
}

function touches(a: RunLike, b: RunLike): boolean {
  const size = Math.max(a.fontSize, b.fontSize, 1);
  const ca = centre(a.rect);
  const cb = centre(b.rect);
  const gapX = Math.max(0, Math.max(a.rect.x, b.rect.x) - Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width));
  const gapY = Math.max(0, Math.max(a.rect.y, b.rect.y) - Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height));
  const sameLine = Math.abs(ca.y - cb.y) < size * 0.6 && gapX < size * 0.4;
  const sameColumn = Math.abs(ca.x - cb.x) < size * 0.6 && gapY < size * 0.4;
  return sameLine || sameColumn;
}

// ---- Labels ----

export type LabelKind = 'Figure' | 'Table' | 'Algorithm';
const KEYWORD = /\b(Figures?|Figs?\.?|Tables?|Tabs?\.?|Algorithms?|Algs?\.?)(?=\s*(?:\d|[IVXL]))/gi;
const NUMBER = /^\s*(\d{1,3}|[IVXL]{2,6}(?![A-Za-z])|[IVX](?![A-Za-z]|\s+[a-z]))(?:\s*\(?[a-z]\)?(?![A-Za-z]))?/;
const JOIN = /^\s*(?:,|;|&|\band\b|\bor\b|\bvs\.?|\bversus\b|\bwith\b|\bto\b|-|–|—)\s*/i;
const RANGE = /^\s*(?:\bto\b|-|–|—)\s*/i;

function kindOf(word: string): LabelKind {
  const w = word.toLowerCase();
  return w.startsWith('fig') ? 'Figure' : w.startsWith('tab') ? 'Table' : 'Algorithm';
}

const ROMAN: Record<string, number> = { I: 1, V: 5, X: 10, L: 50 };
function romanValue(s: string): number | null {
  if (!/^[IVXL]+$/.test(s)) return null;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const v = ROMAN[s[i]];
    const next = ROMAN[s[i + 1] ?? ''] ?? 0;
    total += v < next ? -v : v;
  }
  return total;
}
function romanOf(n: number): string {
  const table: [number, string][] = [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

/**
 * The figure, table and algorithm labels a question names, in the order it names them, once each, as the captions
 * write them: "Compare Figure 2 and 3" gives ["Figure 2", "Figure 3"]; "Fig. 4a" gives ["Figure 4"]; "Table III" gives ["Table III"].
 */
export function figureLabelsIn(question: string): string[] {
  const out: string[] = [];
  const add = (l: string) => { if (!out.includes(l)) out.push(l); };
  for (const m of question.matchAll(KEYWORD)) {
    const kind = kindOf(m[1]);
    let rest = question.slice(m.index + m[0].length);
    let previous: string | null = null;
    let rangeJoin = false;
    for (let n = 0; n < 8; n++) {
      const num = NUMBER.exec(rest);
      if (!num) break;
      const id = num[1];
      if (rangeJoin && previous !== null) {
        const a = /^\d+$/.test(previous) ? Number(previous) : romanValue(previous);
        const b = /^\d+$/.test(id) ? Number(id) : romanValue(id);
        if (a !== null && b !== null && b > a && b - a <= 4) {
          for (let k = a + 1; k < b; k++) add(`${kind} ${/^\d+$/.test(id) ? k : romanOf(k)}`);
        }
      }
      add(`${kind} ${id}`);
      previous = id;
      rest = rest.slice(num[0].length);
      const join = JOIN.exec(rest);
      if (!join) break;
      rangeJoin = RANGE.test(join[0]);
      rest = rest.slice(join[0].length);
      // "Figure 2 and the table" ends the list: the next item must be a number again.
      if (!NUMBER.test(rest)) break;
    }
  }
  return out;
}

// ---- Mentions ----

/** The words a text uses for a label: "Figure 3" is also "Fig. 3", "Figs. 2 and 3" and "Figures 2, 3". */
export function mentionPattern(label: string): RegExp | null {
  const m = /^(Figure|Table|Algorithm)\s+(\S+)$/.exec(label.trim());
  if (!m) return null;
  const word = m[1] === 'Figure' ? 'Fig(?:ure)?s?' : m[1] === 'Table' ? 'Tab(?:le)?s?' : 'Alg(?:orithm)?s?';
  const id = m[2].replace(/[.\-\\^$*+?()|[\]{}]/g, '\\$&');
  // Optional earlier items of a list ("Figures 2 and 3"), then the id, not followed by more digits.
  return new RegExp(`\\b${word}\\.?\\s*(?:[\\dIVXL]+\\s*(?:,|and|&)\\s*)*${id}(?![0-9A-Za-z]*[0-9])(?![IVXL])`, 'g');
}

/** A sentence that opens like a caption: "Figure 2:", "Fig. 3.", "Table 1 |". */
const CAPTION_START = /^\s*(?:Fig(?:ure)?s?|Tab(?:le)?s?|Algorithm)\.?\s*\S+\s*[:.|]/;
const SENTENCE_END = /[.!?]["')\]]?\s+(?=[A-Z([“"])|\n\s*\n/g;

function sentenceBounds(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    out.push({ start, end });
    start = end;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

export interface MentionWindow { start: number; end: number }

/**
 * Sentence-aligned windows of one page's text that name the label, each at most 200 tokens: the sentence, plus the
 * sentence before it when there is room. A window that is the caption itself (it opens with the label, or lies inside the
 * caption's text) is left out.
 */
export function mentionsInPage(text: string, label: string, captionText?: string | null): MentionWindow[] {
  const pattern = mentionPattern(label);
  if (!pattern) return [];
  const sentences = sentenceBounds(text);
  const maxChars = MENTION_MAX_TOKENS * 4;
  const out: MentionWindow[] = [];
  let last = -1;
  for (const m of text.matchAll(pattern)) {
    const at = m.index;
    const i = sentences.findIndex((s) => at >= s.start && at < s.end);
    if (i < 0 || i === last) continue;
    last = i;
    const s = sentences[i];
    const own = text.slice(s.start, s.end);
    // The caption names itself: "Figure 3: ..." or "Figure 3. ...".
    if (m.index - s.start < 3 && /^[:.|—–-]/.test(text.slice(at + m[0].length).trimStart())) continue;
    if (captionText && captionText.length > 20 && captionText.includes(own.trim().slice(0, 40))) continue;
    let start = s.start;
    let end = s.end;
    if (end - start > maxChars) {
      // A long sentence: keep the part around the label.
      start = Math.max(s.start, at - Math.floor(maxChars / 3));
      end = Math.min(s.end, start + maxChars);
    } else if (i > 0 && end - sentences[i - 1].start <= maxChars && !CAPTION_START.test(text.slice(sentences[i - 1].start, sentences[i - 1].end))) {
      start = sentences[i - 1].start;
    }
    const w = trimWindow(text, start, end);
    if (isProse(text.slice(w.start, w.end))) out.push(w);
  }
  return out;
}

/** Running text, not the numbers and tick labels of a figure that happen to sit beside its label: at least half the words are words. */
export function isProse(t: string): boolean {
  const words = t.split(/\s+/).filter(Boolean);
  const real = words.filter((w) => /^[\p{L}][\p{L}'’-]{2,}[.,;:!?)]*$/u.test(w));
  return real.length >= 5 && real.length / words.length >= 0.5;
}

function trimWindow(text: string, start: number, end: number): MentionWindow {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
}

/** A mention as a Passage of the contract (rank is its place in the pack, from 0). */
export function toPassage(p: { documentId: Passage['documentId']; pageIndex: number; textSource: string; text: string; start: number; end: number }, rank: number): Passage {
  const text = p.text.slice(p.start, p.end);
  return { documentId: p.documentId, pageIndex: p.pageIndex, start: p.start, end: p.end, textSource: p.textSource, text, rank, tokens: tokensOf(text.length) };
}
