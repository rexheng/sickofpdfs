import { passageSpans, windowsOf } from './paragraphs';

// Ranking by words (BM25). No network, no model: the same inputs always give the same order.
//
// `inMemoryRankPages` is the page ranker for a PDF that is not saved (a saved one uses the library's search).
// `scoreTexts` ranks a handful of passages against the question once the pages are chosen.

const STOP = new Set(
  ('a an and are as at be been but by can could did do does for from had has have how i if in into is it its of on or our ' +
    'over paper s so such than that the their then there these they this those to under up us was we were what when where ' +
    'which while who whom why will with would you your about also any each more most other some get got use used using give gives show shows').split(' '),
);

/** Lower-case words, stop words dropped, plural and -ing/-ed endings trimmed. Deterministic. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    let w = m[0];
    if (w.length < 2 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 5 && w.endsWith('est')) w = w.slice(0, -3);
    else if (w.length > 5 && w.endsWith('er')) w = w.slice(0, -2);
    else if (w.length > 6 && w.endsWith('ly')) w = w.slice(0, -2);
    else if (w.length > 7 && w.endsWith('ation')) w = w.slice(0, -5);
    out.push(w);
  }
  return out;
}

const K1 = 1.2;
const B = 0.75;

export interface Scored { index: number; score: number }

/** BM25 of each text against the query, over just these texts. Highest first; ties by position, so the order is stable. */
export function scoreTexts(query: string, texts: readonly string[]): Scored[] {
  const q = [...new Set(terms(query))];
  const docs = texts.map((t) => terms(t));
  const n = docs.length;
  const avg = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, n);
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) ?? 0) + 1);
  const out: Scored[] = docs.map((d, index) => {
    const tf = new Map<string, number>();
    for (const w of d) tf.set(w, (tf.get(w) ?? 0) + 1);
    let score = 0;
    for (const w of q) {
      const f = tf.get(w);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / Math.max(1, avg)));
    }
    return { index, score };
  });
  return out.sort((a, b) => b.score - a.score || a.index - b.index);
}

/** Ranks whole passages by their best three-sentence window. Highest first; ties by position. */
export function scorePassages(query: string, passages: readonly string[]): Scored[] {
  const windows: string[] = [];
  const owner: number[] = [];
  passages.forEach((p, i) => { for (const w of windowsOf(p)) { windows.push(w); owner.push(i); } });
  const best = new Array<number>(passages.length).fill(0);
  for (const s of scoreTexts(query, windows)) best[owner[s.index]] = Math.max(best[owner[s.index]], s.score);
  return best.map((score, index) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index);
}

/**
 * The page ranker for an unsaved PDF. Takes every page's text once; the returned function ranks pages for a query.
 * Matches the `rankPages` shape the retriever wants. A page scores by its best paragraphs (a rare word in one paragraph
 * beats the same word scattered through a long page), and pages with no matching word are left out.
 */
export function inMemoryRankPages(pages: readonly string[]): (query: string, limit: number) => Promise<{ pageIndex: number; rank: number }[]> {
  let index: { page: number; terms: string[] }[] | null = null;
  let df = new Map<string, number>();
  let avg = 1;
  const build = () => {
    index = [];
    pages.forEach((text, page) => { for (const s of passageSpans(text)) for (const w of windowsOf(s.text)) index!.push({ page, terms: terms(w) }); });
    df = new Map();
    for (const d of index) for (const w of new Set(d.terms)) df.set(w, (df.get(w) ?? 0) + 1);
    avg = index.reduce((s, d) => s + d.terms.length, 0) / Math.max(1, index.length);
  };
  return (query, limit) => {
    if (index === null) build();
    const q = [...new Set(terms(query))];
    const n = index!.length;
    const best = new Map<number, number[]>();
    for (const d of index!) {
      const tf = new Map<string, number>();
      for (const w of d.terms) tf.set(w, (tf.get(w) ?? 0) + 1);
      let score = 0;
      for (const w of q) {
        const f = tf.get(w);
        if (!f) continue;
        const idf = Math.log(1 + (n - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.terms.length) / Math.max(1, avg)));
      }
      if (score > 0) { const l = best.get(d.page) ?? []; l.push(score); best.set(d.page, l); }
    }
    return Promise.resolve([...best]
      .map(([pageIndex, l]) => { l.sort((a, b) => b - a); return { pageIndex, score: l[0] + 0.3 * (l[1] ?? 0) }; })
      .sort((a, b) => b.score - a.score || a.pageIndex - b.pageIndex)
      .slice(0, Math.max(0, limit))
      .map((s, i) => ({ pageIndex: s.pageIndex, rank: i })));
  };
}
