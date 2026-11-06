// What Claude reads for one question (the context pack, contract §6), built in the viewer tab from the open PDF. Nothing here
// sends anything: the turn runner decides whether the pack goes to Anthropic.
//
// A question sends (plan §3 budgets):
// - the document map (title, abstract, headings, figure list; at most 800 tokens), the same bytes for every thread on the PDF;
// - the paragraph the note is on (at most 300 tokens);
// - the passages local search ranks highest, by words and by meaning (slice B), within 3,500 tokens of document text in all;
// - for a figure, an area or "Explain this figure", or figures the question names ("Compare Figure 2 and 3"): the figure drawn
//   here as a picture, its caption, the exact text inside it and up to 3 paragraphs that mention it (slice C);
// - "Ask about the whole document": every page, up to a cap, always behind a cost question.
//
// Wiring to the viewer: the page text (PDFium, or OCR text later), the outline, the glyphs' font sizes and the detected figures are
// mapped to B's and C's structural types here. For a saved reading the pages are ranked with the library's own search (Phase 3),
// and the paragraph vectors are kept in the library's local-only `passage_vectors` table (schema v6) so the next question is quick.
import {
  buildDocumentMap, buildQuery, createPassageRetriever, documentMapTokens, estimate, focusPassage, hardBlockOnEveryPage, inMemoryRankPages, packWholeDocument,
  type Anchor, type ContextPack, type DocumentId, type DocumentMap, type FigurePack, type ModelChoice, type ModelRole, type OutlineEntry,
  type PageFigure, type Passage, type PassageEmbedder, type SizedLine, type VectorCache,
} from '@sop/core';
import type { DocHandle, FigureService, OutlineItem, PageGlyphs, PageSize, PageTextProvider, PdfBackend, PdfRect } from '@sop/viewer';
import type { StoreClient } from '../../store/client';
import { buildFigurePacks, figuresNamedIn, type FigurePackDeps, type FigureTarget } from './figure-pack';
import type { PassageEmbedRequest, PassageEmbedResponse } from './embed-passages.worker';

/** Document text in a default pack, in all (plan §3). */
export const DOC_TEXT_BUDGET = 3500;
/** "Ask about the whole document" stops before this many tokens of text (whole pages only), under the long-prompt price step. */
export const WHOLE_DOCUMENT_MAX_TOKENS = 90_000;
/** How long a question waits for meaning vectors before it goes with words only (p4b report: a few seconds; the owner waits for a stream anyway). */
export const EMBED_TIMEOUT_MS = 4000;
/** The name the passage vectors are kept under: the bundled MiniLM model (an embedding model, not a Claude model). */
export const VECTOR_MODEL = 'minilm-l6-v2-int8';

export type ContextStore = Pick<StoreClient, 'search' | 'getPassageVectors' | 'putPassageVectors'>;

export interface ContextHost {
  documentId: DocumentId;
  backend: PdfBackend;
  doc: DocHandle;
  /** OpenResult.pages. */
  pages: readonly PageSize[];
  pageText: PageTextProvider;
  figures: Pick<FigureService, 'figures'>;
  /** The PDF's own title (its information dictionary). */
  metadataTitle: string | null;
  /** The library store while the PDF is saved; null otherwise (pages are then ranked in memory). */
  store: ContextStore | null;
  /** Meaning search. Without it, words only. */
  embedder?: PassageEmbedder | null;
}

export interface PackRequest {
  /** The owner's words, without the @Claude mention. */
  question: string;
  /** The thread's anchor as placed in this file (or as stored when it could not be placed). */
  anchor: Anchor | null;
  role: ModelRole;
  model: ModelChoice;
  scope: 'passages' | 'whole-document';
  webSearch: boolean;
  /** "Explain this figure": the anchored figure is attached even when the words name none. */
  preset?: 'explain-figure' | 'whole-document';
  signal?: AbortSignal;
}

export interface BuiltPack {
  pack: ContextPack;
  figureLabels: string[];
  /** What leaves the computer, counted, for the status line and the confirm questions. */
  sent: { passages: number; figures: string[]; pages: number | null };
  /** The whole document did not fit: the last pages were left out. */
  truncated: boolean;
  /** False for a model that could not be priced exactly: the runner then asks before sending (cost.ts `decide`). */
  priceKnown: boolean;
}

export interface ContextBuilder {
  build(r: PackRequest): Promise<BuiltPack>;
  /** The figure-pack inputs, for the client tool `get_figure`. */
  readonly figureDeps: FigurePackDeps;
  /** The passage search, for the client tool `search_document`. */
  passages(query: string, tokenBudget: number, exclude?: readonly Passage[]): Promise<Passage[]>;
  /**
   * R91 for a PDF that is not in the library (R105, TB6 security 1): whether its pages, or the words of this pack, hold card, bank
   * or ID numbers, by the every-page check a save runs. Such a PDF would be saved without searchable text (D9), and Claude never
   * reads one, so nothing is sent. Every page is read once per open PDF; a page that cannot be read counts as no text.
   */
  privateNumbers(pack: ContextPack): Promise<boolean>;
  dispose(): void;
}

// ---- The viewer's structures as B's and C's types ----

/** The outline with each entry's page (a link to a web address, or to nothing, has none). */
export function outlineEntries(items: readonly OutlineItem[]): OutlineEntry[] {
  return items.map((it) => ({
    title: it.title,
    pageIndex: it.target?.kind === 'page' ? it.target.pageIndex : null,
    children: outlineEntries(it.children),
  }));
}

/** The page's lines with their font sizes (the middle size of the line's real glyphs), for the title and heading fallback. */
export function sizedLines(g: PageGlyphs): SizedLine[] {
  const out: SizedLine[] = [];
  let text = '';
  let sizes: number[] = [];
  const end = () => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t !== '' && sizes.length > 0) {
      const sorted = [...sizes].sort((a, b) => a - b);
      out.push({ text: t, size: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10 });
    }
    text = '';
    sizes = [];
  };
  for (const glyph of g.glyphs) {
    if (glyph.text === '\n' || glyph.text === '\r') {
      end();
      continue;
    }
    if (glyph.text === '￾' || glyph.text === '￿') continue;
    text += glyph.text;
    if (!glyph.generated && glyph.text.trim() !== '' && glyph.fontSize > 0) sizes.push(glyph.fontSize);
  }
  end();
  return out;
}

/** A NormRect (0–1 of the page) in points. */
function toPoints(r: readonly [number, number, number, number], page: Pick<PageSize, 'width' | 'height'>): PdfRect {
  return { x: r[0] * page.width, y: r[1] * page.height, width: (r[2] - r[0]) * page.width, height: (r[3] - r[1]) * page.height };
}

function iou(a: PdfRect, b: PdfRect): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const i = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.width * a.height + b.width * b.height - i;
  return u > 0 ? i / u : 0;
}

/** What a figure, area or pin note points at, as C's target. Null for a note on text, a page or the document. */
export async function figureTargetOf(anchor: Anchor | null, figures: (page: number) => Promise<PageFigure[]>, pages: readonly PageSize[]): Promise<FigureTarget | null> {
  if (anchor === null) return null;
  if (anchor.kind === 'area') {
    const page = pages[anchor.page];
    return page ? { kind: 'area', pageIndex: anchor.page, rect: toPoints(anchor.rect, page) } : null;
  }
  if (anchor.kind !== 'figure') return null;
  const page = pages[anchor.page];
  if (!page) return null;
  const rect = toPoints(anchor.rect, page);
  const found = (await figures(anchor.page).catch(() => [] as PageFigure[]))
    .map((f) => ({ f, score: iou(f.rect, rect) + (anchor.figure.label !== null && f.label === anchor.figure.label ? 0.25 : 0) }))
    .sort((a, b) => b.score - a.score)[0];
  // A part or a pin is stored as 0–1 of the figure's box: back to points on the page.
  const sub = anchor.sub;
  const mark: { rect?: PdfRect; point?: [number, number] } = {};
  if (sub?.rect) mark.rect = { x: rect.x + sub.rect[0] * rect.width, y: rect.y + sub.rect[1] * rect.height, width: (sub.rect[2] - sub.rect[0]) * rect.width, height: (sub.rect[3] - sub.rect[1]) * rect.height };
  if (sub?.point) mark.point = [rect.x + sub.point[0] * rect.width, rect.y + sub.point[1] * rect.height];
  const hasMark = mark.rect !== undefined || mark.point !== undefined;
  if (found && found.score >= 0.5) {
    return { kind: 'figure', pageIndex: anchor.page, figure: found.f, ...(hasMark ? { mark } : {}) };
  }
  // The detector does not find it here (a figure the owner drew): the picture of the box the note keeps.
  return { kind: 'area', pageIndex: anchor.page, rect };
}

// ---- Meaning: the MiniLM worker and the library's vector table ----

/** The meaning worker ends after this long with nothing to do (TB6 security 6): MiniLM and onnxruntime hold about 100 MB. */
export const EMBED_IDLE_MS = 60_000;

/**
 * B's `PassageEmbedder` on the bundled MiniLM model, in a worker of this tab. Started on the first question, and ended after a
 * minute with nothing waiting (the next question starts it again; the vectors are kept in the library, so nothing is lost).
 */
export function createWorkerEmbedder(o: { base?: string; createWorker?: () => Worker; timeoutMs?: number; idleMs?: number } = {}): PassageEmbedder & { dispose(): void; alive(): boolean } {
  let worker: Worker | null = null;
  let next = 1;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const waiting = new Map<number, { resolve(v: Float32Array[]): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const base = o.base ?? (typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('') : new URL('/', location.href).href);
  const stopIdle = () => {
    if (idle !== null) clearTimeout(idle);
    idle = null;
  };
  const fail = (e: Error) => {
    stopIdle();
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    waiting.clear();
    worker?.terminate();
    worker = null;
  };
  /** Nothing is waiting: the worker ends after the idle time, unless a new request comes first. */
  const restSoon = () => {
    stopIdle();
    if (waiting.size > 0 || worker === null) return;
    idle = setTimeout(() => {
      idle = null;
      if (waiting.size > 0) return;
      worker?.terminate();
      worker = null;
    }, o.idleMs ?? EMBED_IDLE_MS);
  };
  const start = (): Worker => {
    stopIdle();
    if (worker) return worker;
    const w = o.createWorker?.() ?? new Worker(new URL('./embed-passages.worker.ts', import.meta.url), { type: 'module', name: 'sop-claude-passages' });
    w.onmessage = (ev: MessageEvent<PassageEmbedResponse>) => {
      const got = waiting.get(ev.data.id);
      if (!got) return;
      waiting.delete(ev.data.id);
      clearTimeout(got.timer);
      if (ev.data.ok) got.resolve(ev.data.vectors);
      else got.reject(new Error(`meaning search: ${ev.data.error}`));
      restSoon();
    };
    w.onerror = () => fail(new Error('meaning search: the worker stopped'));
    worker = w;
    return w;
  };
  return {
    embed(texts) {
      if (texts.length === 0) return Promise.resolve([]);
      const w = start();
      const id = next++;
      return new Promise<Float32Array[]>((resolve, reject) => {
        // About 130 ms a text on one thread (p4b report), plus a cold start.
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error('meaning search: timed out'));
          restSoon();
        }, o.timeoutMs ?? 20_000 + texts.length * 400);
        waiting.set(id, { resolve, reject, timer });
        const msg: PassageEmbedRequest = { id, base, texts: [...texts] };
        w.postMessage(msg);
      });
    },
    dispose: () => fail(new Error('meaning search: closed')),
    alive: () => worker !== null,
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** B's `VectorCache` on the library's `passage_vectors` table (local only, schema v6). Texts are kept only as their SHA-256. */
export function storeVectorCache(store: Pick<StoreClient, 'getPassageVectors' | 'putPassageVectors'>, documentId: DocumentId): VectorCache {
  const CHUNK = 1000;
  return {
    async get(texts) {
      const out: (Float32Array | null)[] = [];
      for (let i = 0; i < texts.length; i += CHUNK) {
        const part = texts.slice(i, i + CHUNK);
        const hashes = await Promise.all(part.map(sha256Hex));
        out.push(...(await store.getPassageVectors(documentId, VECTOR_MODEL, hashes)));
      }
      return out;
    },
    async put(entries) {
      for (let i = 0; i < entries.length; i += CHUNK) {
        const part = entries.slice(i, i + CHUNK);
        const hashed = await Promise.all(part.map(async (e) => ({ hash: await sha256Hex(e.text), vector: e.vector })));
        await store.putPassageVectors(documentId, VECTOR_MODEL, hashed);
      }
    },
  };
}

// ---- Pages: the library's search for a saved reading ----

const STOP = new Set(
  ('a an and are as at be been but by can could did do does for from had has have how i if in into is it its of on or our over paper so ' +
    'such than that the their then there these they this those to under up us was we were what when where which while who whom why ' +
    'will with would you your about also any each more most other some get got use used using give gives show shows claude explain mean means').split(' '),
);

/** The words of a question worth searching for: no stop words, the longest (most telling) first, at most `max`. */
export function searchWords(query: string, max = 8): string[] {
  const seen = new Set<string>();
  const words: string[] = [];
  for (const m of query.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    const w = m[0].replace(/['-]+$/u, '');
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  return words.sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, max);
}

/**
 * The page ranker for a saved reading: Phase 3's `search` (the library's full-text index of the reading's pages). The index wants
 * every word of a query, which a question in plain words rarely meets, so each telling word is searched on its own and the pages are
 * scored by how many rare words they hold (fewer pages with a word = a rarer word). Deterministic for the same inputs.
 */
export function storeRankPages(store: Pick<StoreClient, 'search'>, documentId: DocumentId, pageCount: number): (query: string, limit: number) => Promise<{ pageIndex: number; rank: number }[]> {
  return async (query, limit) => {
    const words = searchWords(query);
    if (words.length === 0) return [];
    const per = Math.max(limit * 3, 20);
    const lists = await Promise.all(words.map((w) => store.search({ text: w, documentId, kinds: ['page'], limit: per }).catch(() => [])));
    const score = new Map<number, number>();
    lists.forEach((hits) => {
      const pages = hits.flatMap((h) => (h.kind === 'page' && h.documentId === documentId && h.pageIndex < pageCount ? [h.pageIndex] : []));
      if (pages.length === 0) return;
      const weight = Math.log(1 + pageCount / pages.length);
      pages.forEach((p, i) => score.set(p, (score.get(p) ?? 0) + weight * (1 + 1 / (i + 1))));
    });
    return [...score]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([pageIndex], rank) => ({ pageIndex, rank }));
  };
}

// ---- The builder ----

export function createContextBuilder(h: ContextHost): ContextBuilder {
  const pageCount = h.pages.length;
  // A page whose text the engine cannot read gives no text, never a failed question (the rest of the PDF still answers).
  const text = (i: number) => h.pageText.text(i).catch(() => '');
  const textSource = (i: number) => h.pageText.source(i);

  // Pages ranked in memory, built once from every page's text when the library cannot rank them.
  let memoryRank: Promise<(q: string, n: number) => Promise<{ pageIndex: number; rank: number }[]>> | null = null;
  const inMemory = (q: string, n: number) =>
    (memoryRank ??= Promise.all(Array.from({ length: Math.min(pageCount, 800) }, (_, i) => text(i))).then(inMemoryRankPages)).then((rank) => rank(q, n));

  const fromStore = h.store ? storeRankPages(h.store, h.documentId, pageCount) : null;
  const rankPages = async (q: string, n: number) => {
    const ranked = fromStore ? await fromStore(q, n).catch(() => []) : [];
    if (ranked.length >= Math.min(n, pageCount)) return ranked;
    // Too few pages hold the question's words: the rest come from the in-memory ranking (BM25), after the library's.
    const more = await inMemory(q, n);
    const have = new Set(ranked.map((r) => r.pageIndex));
    return [...ranked, ...more.filter((r) => !have.has(r.pageIndex))].slice(0, n).map((r, rank) => ({ ...r, rank }));
  };

  const retriever = createPassageRetriever(
    { pageCount, text, textSource, rankPages },
    {
      ...(h.embedder ? { embedder: h.embedder, embedTimeoutMs: EMBED_TIMEOUT_MS } : {}),
      ...(h.store && h.embedder ? { vectorCache: storeVectorCache(h.store, h.documentId), candidatePages: 12 } : {}),
    },
  );

  // The map is made once per open PDF: the same bytes for every thread, so the cached prefix is shared.
  let map: Promise<DocumentMap> | null = null;
  const documentMap = () =>
    (map ??= buildDocumentMap({
      documentId: h.documentId,
      pageCount,
      text,
      textSource,
      metadataTitle: h.metadataTitle,
      outline: async () => outlineEntries(await h.backend.getOutline(h.doc)),
      lineSizes: async (i) => sizedLines(await h.pageText.glyphs(i)),
      figures: async (i) => (await h.figures.figures(i)).map((f) => ({ label: f.label, caption: f.caption ? { text: f.caption.text } : null })),
    }).catch((e: unknown) => {
      map = null;
      throw e;
    }));

  // The page text the figure packs and the client tools read: the same provider, with a page that cannot be read giving no text.
  const pt = h.pageText;
  const safeText: PageTextProvider = {
    source: (i) => pt.source(i),
    text,
    glyphs: (i) => pt.glyphs(i),
    rects: (i, start, count) => pt.rects(i, start, count),
    search: (i, q, o) => pt.search(i, q, o),
  };
  const figureDeps: FigurePackDeps = {
    be: h.backend,
    doc: h.doc,
    pages: h.pages,
    text: safeText,
    figures: (i) => h.figures.figures(i),
    documentId: h.documentId,
  };

  // R91 over every page. A clean answer is kept (the pages of an open PDF do not change), but only when every page could be read:
  // a page that failed to read is read again next time, so a number on it is never missed for good.
  let everyPage: Promise<boolean> | null = null;
  const pagesHoldNumbers = () =>
    (everyPage ??= (async () => {
      const pages: string[] = [];
      let unread = false;
      for (let i = 0; i < pageCount; i++) {
        pages.push(
          await h.pageText.text(i).catch(() => {
            unread = true;
            return '';
          }),
        );
      }
      const found = hardBlockOnEveryPage(null, pages) !== null;
      if (unread && !found) everyPage = null;
      return found;
    })().catch((e: unknown) => {
      everyPage = null;
      throw e;
    }));

  return {
    figureDeps,
    passages: (query, tokenBudget, exclude) => retriever.getPassages(h.documentId, query, tokenBudget, exclude ? { exclude } : undefined),

    async privateNumbers(pack) {
      // The words that would go, first (cheap), then every page (as the save's check reads them). Without the filter's input
      // there is no "strong learning evidence" override: a PDF not in the library is judged as strictly as it can be.
      const words = [
        pack.map.title ?? '',
        pack.map.abstract?.text ?? '',
        ...pack.map.headings.map((x) => x.text),
        ...pack.map.figures.map((x) => `${x.label} ${x.caption}`),
        pack.focus?.text ?? '',
        ...pack.passages.map((p) => p.text),
        ...pack.figures.flatMap((f) => [f.caption?.text ?? '', f.insideText, ...f.mentions.map((m) => m.text)]),
      ].join('\n');
      if (hardBlockOnEveryPage(null, [words]) !== null) return true;
      return pagesHoldNumbers();
    },

    async build(r) {
      const docMap = await documentMap();
      const mapTokens = documentMapTokens(docMap);
      let focus: Passage | null = null;
      let passages: Passage[] = [];
      let figures: FigurePack[] = [];
      let truncated = false;
      let pagesSent: number | null = null;

      if (r.scope === 'whole-document') {
        const whole = await packWholeDocument({ documentId: h.documentId, pageCount, text, textSource }, WHOLE_DOCUMENT_MAX_TOKENS);
        passages = whole.passages;
        truncated = whole.truncated;
        pagesSent = whole.nextPage;
      } else {
        // Figures: the one the note is on (or Explain this figure), then those the question names, at most 4 (slice C).
        const targets: FigureTarget[] = [];
        const own = await figureTargetOf(r.anchor, (p) => h.figures.figures(p), h.pages);
        if (own) targets.push(own);
        const fromPage = r.anchor && 'page' in r.anchor ? r.anchor.page : r.anchor?.kind === 'text' ? r.anchor.start.page : 0;
        const named = await figuresNamedIn(figureDeps, r.question, { fromPage }).catch(() => []);
        for (const t of named) {
          const dup = targets.some((x) => x.kind === 'figure' && x.pageIndex === t.pageIndex && x.figure.index === t.figure.index);
          if (!dup) targets.push(t);
        }
        if (targets.length > 0) figures = await buildFigurePacks(figureDeps, targets, { role: r.role, ...(r.signal ? { signal: r.signal } : {}) });

        // Text: the note's paragraph, then the ranked passages (none twice), within 3,500 tokens with the map. A note on a figure or an
        // area gets the figure's own text (caption, inside text, mentions) instead.
        if (!own) {
          if (r.anchor) focus = await focusPassage(r.anchor, { documentId: h.documentId, text, textSource }).catch(() => null);
          const budget = DOC_TEXT_BUDGET - mapTokens - (focus?.tokens ?? 0);
          if (budget > 0) passages = await retriever.getPassages(h.documentId, buildQuery(r.question, r.anchor), budget, focus ? { exclude: [focus] } : undefined);
        }
      }

      const base: ContextPack = { map: docMap, focus, passages, figures, blocks: [], estimate: { inputTokens: 0, usd: 0 } };
      const e = estimate(base, r.role, r.model, { webSearch: r.webSearch, questionTokens: Math.ceil(r.question.length / 4) + 20 });
      const pack: ContextPack = { ...base, estimate: { inputTokens: e.inputTokens, usd: e.usd } };
      const figureLabels = figures.map((f) => f.label).filter((l): l is string => l !== null);
      return {
        pack,
        figureLabels,
        sent: { passages: (focus ? 1 : 0) + passages.length, figures: figureLabels, pages: pagesSent },
        truncated,
        priceKnown: e.priceKnown,
      };
    },

    dispose() {
      map = null;
      memoryRank = null;
      everyPage = null;
    },
  };
}
