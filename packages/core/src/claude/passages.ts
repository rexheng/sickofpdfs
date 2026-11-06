// Finds the few passages a question needs, and the paragraph the owner marked.
//
// Pages are ranked first (the library's search for a saved PDF, BM25 in memory otherwise), then the paragraphs of the
// best pages are ranked against the question and the marked quote. The result never holds the whole document: at most
// 5 passages, each at most 300 tokens, within the budget you give. Same inputs, same bytes out, so the prompt cache holds.
import type { DocumentId } from '../ids';
import type { Anchor } from '../model/anchor';
import { passageSpans, toPassage, tokensOf, type Span } from './paragraphs';
import { scorePassages } from './rank';
import type { Passage } from './types';

export type { Passage } from './types';

export interface PassageRetriever {
  getPassages(docId: DocumentId, query: string, tokenBudget: number, o?: { exclude?: readonly Passage[] }): Promise<Passage[]>;
}

export interface PassageSource {
  pageCount: number;
  text(pageIndex: number): Promise<string>;
  textSource(pageIndex: number): string;
  rankPages(query: string, limit: number): Promise<{ pageIndex: number; rank: number }[]>;
}

export interface RetrieverOptions {
  /** How many passages at most. The plan says 5; the measurement script tries more. */
  maxPassages?: number;
  /**
   * Optional re-ranker (Phase 3's small model, when it is already loaded). Gets the question and the best candidates and
   * returns one score per candidate, higher is better. If it is slow (over 150 ms) or throws, BM25 order stands.
   */
  rerank?: (query: string, candidates: readonly string[]) => Promise<number[] | null>;
}

/** At most this many passages in a default pack (plan §3). */
export const MAX_PASSAGES = 5;
/** Pages looked at in detail. */
const PAGE_CANDIDATES = 6;
const RERANK_CANDIDATES = 12;
export const RERANK_TIMEOUT_MS = 150;

/** What to rank by: the question and the marked quote together (plan slice B). */
export function buildQuery(question: string, anchor: Anchor | null): string {
  const quote = anchor === null ? '' : anchorQuote(anchor);
  return quote ? `${question}\n${quote}` : question;
}

function anchorQuote(a: Anchor): string {
  if (a.kind === 'text') return a.quote.quote;
  if (a.kind === 'figure') return a.figure.captionQuote?.quote ?? '';
  return '';
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([p, timeout]); } finally { if (timer !== undefined) clearTimeout(timer); }
}

interface Candidate { pageIndex: number; pageRank: number; span: Span }

export function createPassageRetriever(src: PassageSource, opts: RetrieverOptions = {}): PassageRetriever {
  return {
    async getPassages(docId, query, tokenBudget, o) {
      if (!(tokenBudget > 0) || src.pageCount <= 0 || query.trim() === '') return [];
      const ranked = await src.rankPages(query, PAGE_CANDIDATES);
      const seenPages = new Set<number>();
      const pages = ranked.filter((r) => r.pageIndex >= 0 && r.pageIndex < src.pageCount && !seenPages.has(r.pageIndex) && seenPages.add(r.pageIndex));
      const texts = await Promise.all(pages.map((p) => src.text(p.pageIndex)));
      const cands: Candidate[] = [];
      pages.forEach((p, i) => { for (const span of passageSpans(texts[i])) cands.push({ pageIndex: p.pageIndex, pageRank: i, span }); });
      const excluded = new Set((o?.exclude ?? []).map((p) => `${p.textSource}|${p.pageIndex}|${p.start}|${p.end}`));
      const usable = cands.filter((c) => !excluded.has(`${src.textSource(c.pageIndex)}|${c.pageIndex}|${c.span.start}|${c.span.end}`));
      // BM25 over the paragraphs, then a small lift for passages on pages the page ranker liked best (breaks ties well).
      const scored = scorePassages(query, usable.map((c) => c.span.text))
        .filter((s) => s.score > 0)
        .map((s) => ({ ...s, score: s.score * (1 + 0.1 * (1 - usable[s.index].pageRank / Math.max(1, pages.length))) }))
        .sort((a, b) => b.score - a.score || a.index - b.index);

      let order = scored.map((s) => s.index);
      if (opts.rerank && order.length > 1) {
        const head = order.slice(0, RERANK_CANDIDATES);
        const scores = await withTimeout(opts.rerank(query, head.map((i) => usable[i].span.text)).catch(() => null), RERANK_TIMEOUT_MS);
        if (scores && scores.length === head.length && scores.every((x) => Number.isFinite(x))) {
          const re = head.map((idx, k) => ({ idx, k, s: scores[k] })).sort((a, b) => b.s - a.s || a.k - b.k).map((x) => x.idx);
          order = [...re, ...order.slice(RERANK_CANDIDATES)];
        }
      }

      const out: Passage[] = [];
      let used = 0;
      for (const idx of order) {
        if (out.length >= (opts.maxPassages ?? MAX_PASSAGES)) break;
        const c = usable[idx];
        const tokens = tokensOf(c.span.text.length);
        if (used + tokens > tokenBudget) continue;
        used += tokens;
        out.push(toPassage(docId, c.pageIndex, src.textSource(c.pageIndex), c.span, out.length));
      }
      return out;
    },
  };
}

// ---- The marked paragraph ----

export interface FocusSource {
  documentId: DocumentId;
  text(pageIndex: number): Promise<string>;
  textSource(pageIndex: number): string;
}

function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Where a quote sits in the page text. The page text's offsets are not char indices, so the quote is searched for, near the hint. */
function findQuote(text: string, quote: string, prefix: string, hint: number): number {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return -1;
  const tries = [words, words.slice(0, 8)];
  for (const w of tries) {
    const re = new RegExp(w.map(escapeRe).join('\\s+'), 'g');
    let best = -1;
    let bestScore = -Infinity;
    for (const m of text.matchAll(re)) {
      const before = text.slice(Math.max(0, m.index - prefix.length), m.index);
      const agree = prefix && before.replace(/\s+/g, ' ').endsWith(prefix.replace(/\s+/g, ' ').slice(-12)) ? 1e6 : 0;
      const score = agree - Math.abs(m.index - hint);
      if (score > bestScore) { bestScore = score; best = m.index; }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** The anchor's paragraph (at most 300 tokens): the piece that holds the start of the marked text. Null for an area or when the quote is not found. */
export async function focusPassage(anchor: Anchor, src: FocusSource): Promise<Passage | null> {
  let page: number; let quote: string; let prefix: string; let hint: number;
  if (anchor.kind === 'text') { page = anchor.start.page; quote = anchor.quote.quote; prefix = anchor.quote.prefix; hint = anchor.start.index; }
  else if (anchor.kind === 'figure' && anchor.figure.captionQuote) { const c = anchor.figure.captionQuote; page = c.position.page; quote = c.quote; prefix = c.prefix; hint = c.position.index; }
  else return null;
  const text = await src.text(page);
  const at = findQuote(text, quote, prefix, hint);
  if (at < 0) return null;
  const spans = passageSpans(text);
  const span = spans.find((s) => at >= s.start && at < s.end) ?? spans.filter((s) => s.start <= at).pop() ?? null;
  return span ? toPassage(src.documentId, page, src.textSource(page), span, 0) : null;
}
