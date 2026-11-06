// Finds the few passages a question needs, and the paragraph the owner marked.
//
// Pages are ranked first (the library's search for a saved PDF, BM25 in memory otherwise), then the paragraphs of the
// best pages are ranked against the question and the marked quote. The result never holds the whole document: at most
// 5 passages, each at most 300 tokens, within the budget you give. Same inputs, same bytes out, so the prompt cache holds.
import type { DocumentId } from '../ids';
import type { Anchor } from '../model/anchor';
import { MAX_PASSAGE_TOKENS, passageSpans, sentenceEnds, toPassage, tokensOf, windowsOf, type Span } from './paragraphs';
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

/** Turns texts into unit-length vectors (the extension's MiniLM worker). Cosine similarity is then a dot product. */
export interface PassageEmbedder { embed(texts: readonly string[]): Promise<Float32Array[]> }

export interface RetrieverOptions {
  /** How many passages at most (default 8), as far as the token budget allows. */
  maxPassages?: number;
  /**
   * Meaning search. With it, the best 20 paragraphs by words and the 20 nearest by meaning are fused (reciprocal rank
   * fusion). Without it, or when it fails, words only.
   */
  embedder?: PassageEmbedder;
  /**
   * How long to wait for vectors before falling back to words. Vectors that finish late are kept for the next question.
   * Null waits as long as it takes (a saved reading whose vectors are cached). Default 150 ms, the soft limit for a PDF
   * that is not saved, where vectors are made on the fly.
   */
  embedTimeoutMs?: number | null;
  /** Pages whose paragraphs are looked at when meaning search is on. Default 12; a saved reading with cached vectors can use every page. */
  candidatePages?: number;
  /** At most this many paragraphs are embedded for one question: the most word-relevant ones. Default 200. */
  embedPoolCap?: number;
  /** Optional store of paragraph vectors, kept for saved readings (local only). Keys are the paragraph text. */
  vectorCache?: VectorCache;
}

/** A place to keep paragraph vectors. The retriever also keeps its own small in-memory copy. */
export interface VectorCache {
  get(texts: readonly string[]): Promise<(Float32Array | null)[]>;
  put(entries: readonly { text: string; vector: Float32Array }[]): Promise<void>;
}

/** At most this many passages in a pack. The token budget usually stops it sooner. */
export const MAX_PASSAGES = 8;
/** Pages looked at in detail: more when meaning search can pick up what words miss. */
const PAGE_CANDIDATES = 6;
const PAGE_CANDIDATES_HYBRID = 12;
const FUSE_EACH = 20;
const RRF_K = 5;   // measured: a small constant keeps each list's best few near the top (plan slice B, p4b report)
export const EMBED_TIMEOUT_MS = 150;
const MEMORY_VECTORS = 3000;

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

const dot = (a: Float32Array, b: Float32Array): number => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/** A sentence next to a passage, added when it fits, so an answer that runs over two sentences stays whole. */
function expand(text: string, ends: readonly number[], span: Span, room: number, taken: readonly Span[]): Span {
  const bounds = [0, ...ends];
  const blank = (from: number, to: number) => text.slice(from, to).trim() === '';
  let { start, end } = span;
  const free = (from: number, to: number) => !taken.some((t) => t !== span && from < t.end && to > t.start);
  let left = Math.min(room, MAX_PASSAGE_TOKENS - tokensOf(end - start));
  const i = bounds.findLastIndex((x) => x <= span.start && blank(x, span.start));
  if (i >= 1) {
    const from = bounds[i - 1] + (text.slice(bounds[i - 1]).length - text.slice(bounds[i - 1]).trimStart().length);
    const cost = tokensOf(span.start - from);
    if (cost <= left && span.start - from > 0 && free(from, span.start)) { start = from; left -= cost; }
  }
  const j = bounds.findIndex((x) => x >= span.end && blank(span.end, x));
  if (j >= 0 && j + 1 < bounds.length) {
    const to = bounds[j + 1];
    const cost = tokensOf(to - span.end);
    if (cost <= left && to > span.end && free(span.end, to)) end = to;
  }
  return start === span.start && end === span.end ? span : { start, end, text: text.slice(start, end).trim() };
}

export function createPassageRetriever(src: PassageSource, opts: RetrieverOptions = {}): PassageRetriever {
  const memory = new Map<string, Float32Array>();
  const remember = (text: string, v: Float32Array) => {
    memory.delete(text); memory.set(text, v);
    while (memory.size > MEMORY_VECTORS) memory.delete(memory.keys().next().value as string);
  };

  /** Vectors for these texts: memory, then the store's cache, then the embedder (stored again afterwards). */
  async function vectorsFor(texts: readonly string[]): Promise<(Float32Array | null)[]> {
    const out: (Float32Array | null)[] = texts.map((t) => memory.get(t) ?? null);
    const missing = out.flatMap((v, i) => (v ? [] : [i]));
    if (missing.length > 0 && opts.vectorCache) {
      const got = await opts.vectorCache.get(missing.map((i) => texts[i])).catch(() => null);
      got?.forEach((v, k) => { if (v) { out[missing[k]] = v; remember(texts[missing[k]], v); } });
    }
    const todo = missing.filter((i) => !out[i]);
    if (todo.length > 0 && opts.embedder) {
      const vs = await opts.embedder.embed(todo.map((i) => texts[i]));
      const fresh: { text: string; vector: Float32Array }[] = [];
      todo.forEach((i, k) => { const v = vs[k]; if (v) { out[i] = v; remember(texts[i], v); fresh.push({ text: texts[i], vector: v }); } });
      if (fresh.length > 0) await opts.vectorCache?.put(fresh).catch(() => undefined);
    }
    return out;
  }

  return {
    async getPassages(docId, query, tokenBudget, o) {
      if (!(tokenBudget > 0) || src.pageCount <= 0 || query.trim() === '') return [];
      const hybrid = opts.embedder !== undefined;
      const ranked = await src.rankPages(query, hybrid ? (opts.candidatePages ?? PAGE_CANDIDATES_HYBRID) : PAGE_CANDIDATES);
      const seenPages = new Set<number>();
      const pages = ranked.filter((r) => r.pageIndex >= 0 && r.pageIndex < src.pageCount && !seenPages.has(r.pageIndex) && seenPages.add(r.pageIndex));
      const texts = await Promise.all(pages.map((p) => src.text(p.pageIndex)));
      const cands: Candidate[] = [];
      pages.forEach((p, i) => { for (const span of passageSpans(texts[i])) cands.push({ pageIndex: p.pageIndex, pageRank: i, span }); });
      const excluded = new Set((o?.exclude ?? []).map((p) => `${p.textSource}|${p.pageIndex}|${p.start}|${p.end}`));
      const usable = cands.filter((c) => !excluded.has(`${src.textSource(c.pageIndex)}|${c.pageIndex}|${c.span.start}|${c.span.end}`));
      // BM25 over the paragraphs, then a small lift for passages on pages the page ranker liked best (breaks ties well).
      const scoredAll = scorePassages(query, usable.map((c) => c.span.text))
        .map((s) => ({ ...s, score: s.score * (1 + 0.1 * (1 - usable[s.index].pageRank / Math.max(1, pages.length))) }))
        .sort((a, b) => b.score - a.score || a.index - b.index);
      const byWords = scoredAll.filter((s) => s.score > 0).map((s) => s.index);

      let order = byWords;
      if (hybrid && usable.length > 0) {
        // Embed the most word-relevant paragraphs (and, for the rest, whatever is already cached), then fuse the two top-20 lists.
        const pool = scoredAll.slice(0, opts.embedPoolCap ?? 200).map((s) => s.index);
        // Meaning is judged on three-sentence windows (a long paragraph's average blurs the one sentence that answers).
        const wins = pool.flatMap((idx, k) => windowsOf(usable[idx].span.text).map((w) => ({ k, w })));
        const poolTexts = wins.map((x) => x.w);
        const work = (async () => {
          const [qv] = await opts.embedder!.embed([query]);
          const vs = await vectorsFor(poolTexts);
          return { qv, vs };
        })();
        const wait = opts.embedTimeoutMs === undefined ? EMBED_TIMEOUT_MS : opts.embedTimeoutMs;
        work.catch(() => undefined);
        const done = await (wait === null ? work.catch(() => null) : withTimeout(work.catch(() => null), wait));
        if (done?.qv) {
          const best = new Array<number>(pool.length).fill(-Infinity);
          wins.forEach((x, j) => { const v = done.vs[j]; if (v) best[x.k] = Math.max(best[x.k], dot(done.qv, v)); });
          const near = pool
            .map((idx, k) => ({ idx, sim: best[k] }))
            .filter((x) => x.sim > -Infinity)
            .sort((a, b) => b.sim - a.sim || a.idx - b.idx)
            .slice(0, FUSE_EACH)
            .map((x) => x.idx);
          const fused = new Map<number, number>();
          [byWords.slice(0, FUSE_EACH), near].forEach((list) => list.forEach((idx, r) => fused.set(idx, (fused.get(idx) ?? 0) + 1 / (RRF_K + r + 1))));
          order = [...fused].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([idx]) => idx);
        }
      }

      const maxN = opts.maxPassages ?? MAX_PASSAGES;
      const picked: Candidate[] = [];
      let used = 0;
      for (const idx of order) {
        if (picked.length >= maxN) break;
        const c = usable[idx];
        const tokens = tokensOf(c.span.text.length);
        if (used + tokens > tokenBudget) continue;
        used += tokens;
        picked.push(c);
      }
      // Neighbour sentences, with what is left of the budget, best passages first.
      const pageText = new Map<number, { text: string; ends: number[] }>();
      pages.forEach((p, i) => pageText.set(p.pageIndex, { text: texts[i], ends: sentenceEnds(texts[i]) }));
      const out: Passage[] = picked.map((c, i) => {
        const pt = pageText.get(c.pageIndex)!;
        const same = picked.filter((x) => x.pageIndex === c.pageIndex).map((x) => x.span);
        const grown = expand(pt.text, pt.ends, c.span, tokenBudget - used, same);
        const extra = tokensOf(grown.text.length) - tokensOf(c.span.text.length);
        if (extra > 0) { used += extra; c.span = grown; }
        return toPassage(docId, c.pageIndex, src.textSource(c.pageIndex), c.span, i);
      });
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
