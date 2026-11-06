// The document map: title, abstract, headings and figure list. It rides first in every request and is shared by every
// thread on the document, so it must be byte-identical for the same document (the cache breakpoint sits after it).
// Budget: 800 tokens (plan §3), counted the way the pack maths counts them.
import type { DocumentId } from '../ids';
import { cutSpan, paragraphSpans, toPassage, tokensOf } from './paragraphs';
import type { DocumentMap, Passage } from './types';

export type { DocumentMap } from './types';

export const MAP_MAX_TOKENS = 800;
const ABSTRACT_MAX_TOKENS = 250;
const CAPTION_CHARS = 160;
const SHORT_CAPTION_CHARS = 90;
const MAX_HEADING_CHARS = 100;
const FALLBACK_SCAN_PAGES = 200;

/** One outline entry with its page already worked out (the caller maps the viewer's link target to a page). */
export interface OutlineEntry { title: string; pageIndex: number | null; children: readonly OutlineEntry[] }
/** One line of a page with its font size, for the heading fallback. */
export interface SizedLine { text: string; size: number }
export interface MapFigure { label: string | null; caption: { text: string } | null }

export interface MapSource {
  documentId: DocumentId;
  pageCount: number;
  text(pageIndex: number): Promise<string>;
  textSource(pageIndex: number): string;
  /** The PDF's own title, if it has one. */
  metadataTitle?: string | null;
  /** The outline (bookmarks), if the PDF has one. */
  outline?(): Promise<readonly OutlineEntry[]>;
  /** Lines with their font sizes, for finding the title and headings when there is no outline. */
  lineSizes?(pageIndex: number): Promise<readonly SizedLine[]>;
  /** The detected figures of a page (Phase 2's PageFigure carries these). */
  figures?(pageIndex: number): Promise<readonly MapFigure[]>;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function trimTo(s: string, max: number): string {
  const t = clean(s);
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(' ', max - 1);
  return t.slice(0, cut > max * 0.5 ? cut : max - 1).replace(/[\s,;:.-]+$/, '') + '…';
}

// ---- Title ----

function usableTitle(t: string | null | undefined): string | null {
  if (!t) return null;
  const s = clean(t);
  if (s.length < 4 || s.length > 200) return null;
  if (/\.(pdf|docx?|tex|dvi|indd|ps)$/i.test(s) || /^(untitled|microsoft word|slide \d|document\d?$)/i.test(s) || /^[\w-]+\.\w{2,4}$/.test(s)) return null;
  return s;
}

const FURNITURE = /^(typeset|draft|arxiv|provided proper|preprint|under review|published as|accepted|proceedings|copyright|©|https?:|www\.|vol\.|\d+$)/i;

function titleFrom(src: MapSource, lines: readonly SizedLine[] | null, page0: string): string | null {
  const meta = usableTitle(src.metadataTitle);
  if (meta) return meta;
  if (lines && lines.length > 0) {
    const top = Math.max(...lines.map((l) => l.size));
    const big = lines.filter((l) => l.size >= top - 0.6 && !FURNITURE.test(l.text.trim()));
    const t = usableTitle(big.map((l) => l.text).join(' '));
    if (t) return t;
  }
  const firstLines = page0.split(/\r\n|\r|\n/).map(clean).filter((l) => l && !FURNITURE.test(l));
  const first = firstLines.find((l) => l.split(' ').length >= 3 && /^[A-Z\p{Lu}]/u.test(l) && !l.includes('@'));
  return usableTitle(first ?? null);
}

// ---- Abstract ----

function abstractFrom(src: MapSource, page: number, text: string): Passage | null {
  // The label can sit mid-paragraph in PDF text (it has no full stop), so find it by line.
  const m = /(?:^|[\r\n])[ \t]*abstract\b[ \t]*[.:—–-]*[ \t]*(?:\r\n|\r|\n)?/i.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const para = paragraphSpans(text).find((s) => s.end > from);
  if (!para) return null;
  const start = Math.max(from, para.start);
  const body = cutSpan({ start, end: para.end, text: text.slice(start, para.end) }).filter((s) => s.text.length >= 40)[0];
  if (!body) return null;
  let t = body.text;
  const maxChars = ABSTRACT_MAX_TOKENS * 4;
  if (t.length > maxChars) { const stop = t.lastIndexOf('. ', maxChars); t = t.slice(0, stop > maxChars * 0.5 ? stop + 1 : maxChars); }
  return toPassage(src.documentId, page, src.textSource(page), { start: body.start, end: body.start + t.length, text: t }, 0);
}

// ---- Headings ----

const NAMED = /^(abstract|introduction|background|related work|methods?|methodology|approach|experiments?|results?|discussion|conclusions?|limitations|acknowledg(e)?ments?|references|appendix|bibliography)$/i;
const NUMBERED = /^((\d{1,2}(\.\d{1,2}){0,2}\.?)|([A-Z]\.)|([IVX]{1,4}\.))\s+[A-Z][^.!?]{2,}$/;

function flattenOutline(items: readonly OutlineEntry[], depth: number, out: { text: string; pageIndex: number; depth: number }[]): void {
  for (const it of items) {
    const t = clean(it.title);
    if (t && it.pageIndex !== null) out.push({ text: trimTo(t, MAX_HEADING_CHARS), pageIndex: it.pageIndex, depth });
    flattenOutline(it.children, depth + 1, out);
  }
}

/** A numbered line is a heading when it is short and its main words are capitalised (or it is only a few words). */
function looksLikeHeading(l: string): boolean {
  const words = l.replace(/^[\dA-Z]{1,4}\.?[\d.]*\s+/, '').split(' ');
  if (words.length > 8) return false;
  if (words.length <= 4) return true;
  const big = words.filter((w) => w.length >= 4);
  return big.length > 0 && big.filter((w) => /^[A-Z]/.test(w)).length / big.length >= 0.6;
}

function headingsFromText(text: string, page: number, out: { text: string; pageIndex: number; depth: number }[]): void {
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const l = clean(raw);
    if (l.length < 3 || l.length > MAX_HEADING_CHARS) continue;
    if ((NUMBERED.test(l) && !/[,;]$/.test(l) && looksLikeHeading(l)) || NAMED.test(l.replace(/^[\dIVX.]+\s+/, ''))) {
      out.push({ text: l, pageIndex: page, depth: (l.match(/^\d+(\.\d+)*/)?.[0].split('.').length ?? 1) });
    }
  }
}

interface SizedHeading { text: string; pageIndex: number; size: number }

/** Lines set larger than the body text. Noisy on its own (text inside figures, maths), so `keepRepeatedSizes` filters them. */
function headingsFromSizes(lines: readonly SizedLine[], page: number, out: SizedHeading[]): void {
  const weight = new Map<number, number>();
  for (const l of lines) weight.set(Math.round(l.size * 2) / 2, (weight.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  let body = 0; let best = -1;
  for (const [size, w] of [...weight].sort((a, b) => a[0] - b[0])) if (w > best) { best = w; body = size; }
  for (const l of lines) {
    const t = clean(l.text);
    if (l.size < body * 1.12 || l.size > body * 2.2 || t.length < 3 || t.length > MAX_HEADING_CHARS) continue;
    if (/[.,;]$/.test(t) || /^\d+$/.test(t) || !/^[\p{Lu}\d]/u.test(t) || FURNITURE.test(t) || t.split(' ').length > 12) continue;
    if (t.split(' ').length === 1 && !NAMED.test(t)) continue;
    if (/[∗†‡·=+×÷<>]/.test(t) || (t.match(/\p{L}/gu)?.length ?? 0) < t.length * 0.7) continue;
    // Page one holds the title, authors and affiliations, all set large: only section-shaped lines count there.
    if (page === 0 && !NUMBERED.test(t) && !NAMED.test(t.replace(/^[\dIVX.]+\s+/, ''))) continue;
    out.push({ text: t, pageIndex: page, size: Math.round(l.size * 2) / 2 });
  }
}

/** A real heading level repeats through the document; one-off large lines are figure text or maths. */
function keepRepeatedSizes(found: readonly SizedHeading[]): { text: string; pageIndex: number; depth: number }[] {
  const count = new Map<number, number>();
  for (const h of found) count.set(h.size, (count.get(h.size) ?? 0) + 1);
  const sizes = [...count].filter(([, n]) => n >= 3).map(([s]) => s).sort((a, b) => b - a);
  return found.filter((h) => sizes.includes(h.size)).map((h) => ({ text: h.text, pageIndex: h.pageIndex, depth: Math.min(2, sizes.indexOf(h.size) + 1) }));
}

// ---- Figures ----

const CAPTION_START = /^(Figure|Fig\.?|Table|Algorithm|Chart)\s+([A-Z]?\d+[A-Za-z]?|[IVX]+)\s*[.:|]\s*\S/;

function normLabel(kind: string, id: string): string {
  const k = /^fig/i.test(kind) ? 'Figure' : kind[0].toUpperCase() + kind.slice(1).toLowerCase();
  return `${k} ${id}`;
}

function figuresFromText(text: string, page: number, out: { label: string; pageIndex: number; caption: string }[]): void {
  // A caption starts a line and runs to the end of its paragraph.
  const spans = paragraphSpans(text);
  for (const m of text.matchAll(/(^|[\r\n])[ \t]*((?:Figure|Fig\.?|Table|Algorithm|Chart)\s+(?:[A-Z]?\d+[A-Za-z]?|[IVX]+)\s*[.:|]\s*\S)/g)) {
    const at = m.index + m[1].length + (m[0].length - m[1].length - m[2].length);
    const span = spans.find((s) => s.end > at);
    const body = text.slice(at, span ? Math.max(span.end, at) : text.length);
    const c = CAPTION_START.exec(body);
    if (c) out.push({ label: normLabel(c[1], c[2]), pageIndex: page, caption: trimTo(body.slice(c[0].length - 1), CAPTION_CHARS) });
  }
}

// ---- The map ----

const mapTokens = (m: DocumentMap): number => {
  let t = 0;
  if (m.title) t += tokensOf(m.title.length + 8);
  if (m.abstract) t += tokensOf(m.abstract.text.length + 20);
  for (const h of m.headings) t += tokensOf(h.text.length + 20);
  for (const f of m.figures) t += tokensOf(f.label.length + f.caption.length + 20);
  return t;
};
export { mapTokens as documentMapTokens };

export async function buildDocumentMap(src: MapSource): Promise<DocumentMap> {
  if (src.pageCount <= 0) return { title: null, abstract: null, headings: [], figures: [] };
  const page0 = await src.text(0);
  const lines0 = src.lineSizes ? await src.lineSizes(0) : null;
  const title = titleFrom(src, lines0, page0);

  let abstract: Passage | null = abstractFrom(src, 0, page0);
  if (!abstract && src.pageCount > 1) abstract = abstractFrom(src, 1, await src.text(1));

  // Headings: the outline first. Without one, font sizes, then the shape of the text.
  let heads: { text: string; pageIndex: number; depth: number }[] = [];
  const outline = src.outline ? await src.outline() : [];
  flattenOutline(outline, 1, heads);
  const figs: { label: string; pageIndex: number; caption: string }[] = [];
  const scanPages = Math.min(src.pageCount, FALLBACK_SCAN_PAGES);
  const useOutline = heads.length > 0;
  const sizedHeads: SizedHeading[] = [];
  for (let p = 0; p < scanPages; p++) {
    const text = p === 0 ? page0 : await src.text(p);
    if (!useOutline) {
      const sized = src.lineSizes ? await src.lineSizes(p) : null;
      if (sized) headingsFromSizes(sized, p, sizedHeads);
      else headingsFromText(text, p, heads);
    }
    const detected = src.figures ? await src.figures(p) : [];
    let found = false;
    for (const f of detected) if (f.label && f.caption) { figs.push({ label: clean(f.label), pageIndex: p, caption: trimTo(f.caption.text.replace(/^[^:.]*[:.]\s*/, '') || f.caption.text, CAPTION_CHARS) }); found = true; }
    if (!found) figuresFromText(text, p, figs);
  }
  if (sizedHeads.length > 0) heads = keepRepeatedSizes(sizedHeads);
  if (title) heads = heads.filter((h) => clean(h.text) !== title);

  // Same label once only (the first caption wins), in reading order.
  const seen = new Set<string>();
  let figures = figs.filter((f) => !seen.has(f.label) && seen.add(f.label));
  const seenH = new Set<string>();
  let headings = heads.filter((h) => { const k = `${h.pageIndex}|${h.text}`; return !seenH.has(k) && seenH.add(k); });

  const build = (): DocumentMap => ({ title, abstract, headings: headings.map(({ text, pageIndex }) => ({ text, pageIndex })), figures });
  // Fit the budget: shorter captions, then only top-level headings, then drop from the end of the longer list.
  if (mapTokens(build()) > MAP_MAX_TOKENS) figures = figures.map((f) => ({ ...f, caption: trimTo(f.caption, SHORT_CAPTION_CHARS) }));
  if (mapTokens(build()) > MAP_MAX_TOKENS) { const top = headings.filter((h) => h.depth <= 1); if (top.length >= 4) headings = top; }
  while (mapTokens(build()) > MAP_MAX_TOKENS && (headings.length > 0 || figures.length > 0)) {
    if (headings.length >= figures.length) headings = headings.slice(0, -1); else figures = figures.slice(0, -1);
  }
  return build();
}

