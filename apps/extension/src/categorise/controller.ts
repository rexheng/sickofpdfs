// The auto categoriser (spec R92), as it runs in its own worker (worker.ts, started by the offscreen document). For every reading the
// library holds it makes a meaning vector with the bundled MiniLM model, finds course codes, suggests the owner's own tags, and groups
// readings into topics. Everything is written back through the store (store/tags-api.ts); nothing else is stored anywhere.
//
// Rules this file keeps:
// - Local only. The model and the runtime are files of the extension (viewer/filter/load-embedder.ts refuses any other folder). No fetch of
//   an address outside the extension, no message to a service, no log of a title or a text.
// - Only saved readings. The work list is the store's own (`categoriseQueue`, the readings' change events), so a PDF that was never saved
//   is never seen here. A reading in Trash, or forgotten while its vector was being made, keeps nothing (`putEmbedding` refuses it).
// - A reading whose owner keeps its text out of the library (a private PDF saved by choice) is not touched at all: the store never offers it.
// - It never slows a viewer. It runs on a thread of its own, one reading at a time, waits at least three times as long as a reading took
//   before the next, waits while other tabs are writing to the library, and frees the model after a minute of nothing to do.
// - It gives its memory back (TB5 code and security critic, finding 6). Freeing the model leaves the runtime's WebAssembly memory in
//   the worker, so after a minute with nothing to do it says so (`onIdle`) and the offscreen document ends the worker. The host starts
//   a new one at the next change that matters (`mattersToCategoriser`). Nothing is lost: every bit of state is in the store.
// - Topics are refreshed once after every back-fill (TB5 experience critic, finding 4), so a library whose topics were never made (Chrome
//   closed before the refresh after a burst of saves) gets them at the next start. The owner's tag suggestions are refreshed then too.
// - The owner always wins (the store keeps that rule): a tag taken off a reading, a renamed tag, an owner's tag are never changed here.
import {
  clusterTopics,
  EMBEDDING_MODEL,
  embeddingInput,
  findCourseCodeLabels,
  suggestTags,
  titleFromFileName,
  withoutNames,
  type Doc,
  type DocumentId,
  type Subject,
} from '@sop/core';
import { CATEGORISER_TAB } from '../store/change-bus';
import { createStoreClient, type StoreClient } from '../store/client';
import type { CategoriseInput } from '../store/tags-api';
import { mattersToCategoriser, VECTOR_PAGES } from './changes';
import { loadFields, loadSubjects } from './load-subjects';
import type { Embedder } from '../viewer/filter/embedder';
import { loadEmbedder } from '../viewer/filter/load-embedder';

/** A read of a big library may take a while on a loaded computer; the store client waits this long before it gives up. */
const STORE_TIMEOUT_MS = 120_000;

export interface Timing {
  /** A reading that changed is looked at this long after the change, so its page text has landed. */
  settleMs: number;
  /** The wait before the first back-fill of readings made before this feature. */
  startDelayMs: number;
  /** Waits this long after the last change by another tab before starting work. */
  quietMs: number;
  /** The least wait between two readings. */
  minGapMs: number;
  /** After a reading that took W ms, wait this many times W. */
  gapFactor: number;
  /** The model is freed after this long with nothing to do. */
  idleDisposeMs: number;
  /** Topics and suggestions are refreshed this long after the last reading was done. */
  refreshDelayMs: number;
}

export const DEFAULT_TIMING: Timing = { settleMs: 3000, startDelayMs: 5000, quietMs: 1500, minGapMs: 250, gapFactor: 3, idleDisposeMs: 60_000, refreshDelayMs: 2500 };

export interface ControllerOptions {
  /** A new port to the store worker (the offscreen document makes it and hands it over, host.ts). */
  openStorePort: () => Promise<MessagePort>;
  /** The folder the model and runtime are in, ending in "/". */
  assetBase: string;
  timing?: Partial<Timing>;
  /** Replaces the model loader (a test's). */
  loadEmbedder?: (base: string) => Promise<Embedder>;
  /**
   * Nothing to do for `idleDisposeMs` and the model is freed: the controller has stopped, and the worker can end (host.ts ends it, and
   * starts a new one at the next change that matters). Without it the controller just sleeps until the next change.
   */
  onIdle?: () => void;
}

export interface CategoriseController {
  stop(): void;
}

/** The most readings clustered at once (the newest). The grouping takes memory and time that grow with the square of this. */
const CORPUS_LIMIT = 1500;
/** Readings asked for from the store's back-fill list at a time. */
const QUEUE_BATCH = 20;
/** Readings whose suggestions are written in one store call. */
const SUGGEST_CHUNK = 40;
/** A reading that fails this many times is left alone until the extension restarts. */
const MAX_FAILURES = 3;
/** A reading just saved may still be waiting for its page text: look again this many times (settleMs apart) before using what is there. */
const MAX_TEXT_WAITS = 8;
/** Pages of text the vector is made from (the store's INPUT_PAGES). */
const TEXT_PAGES = VECTOR_PAGES;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The channel a test build reports timings on (production builds have none: `import.meta.env.MODE` is fixed at build time). */
export const TIMING_CHANNEL = 'sop-categorise-timing';

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The words of a file name or link as a title, when the reading has none. */
function fallbackTitle(input: CategoriseInput): string | null {
  for (const place of [...input.paths, ...input.urls]) {
    const name = place.split(/[?#]/)[0]?.split(/[\\/]/).pop() ?? '';
    const title = titleFromFileName(name);
    if (title !== null) return title;
  }
  return null;
}

/** The course codes of a reading: its links first, then its folders, then its first page. */
function courseCodesOf(input: CategoriseInput): string[] {
  const codes: string[] = [];
  for (const url of input.urls) codes.push(...findCourseCodeLabels({ url }));
  for (const path of input.paths) codes.push(...findCourseCodeLabels({ path }));
  // A reading whose text the owner keeps out of the library has no page text to read here.
  // R92c: the title of the page the PDF was opened from counts too (kept on this computer, never sent anywhere).
  if (input.pageTitle !== null) codes.push(...findCourseCodeLabels({ pageTitle: input.pageTitle }));
  if (input.indexText) codes.push(...findCourseCodeLabels({ firstPageText: input.pageTexts[0] ?? '' }));
  // One per code, whatever the case: the first (most specific) source's spelling wins.
  const seen = new Set<string>();
  return codes.filter((c) => !seen.has(c.toUpperCase()) && seen.add(c.toUpperCase()));
}

export function startCategoriseController(o: ControllerOptions): CategoriseController {
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing };
  const store: StoreClient = createStoreClient(o.openStorePort, STORE_TIMEOUT_MS);
  const load = o.loadEmbedder ?? loadEmbedder;

  let stopped = false;
  let embedder: Promise<Embedder> | null = null;
  let lastEmbedAt = 0;
  /** Readings to look at, with the time they are due. */
  const pending = new Map<string, number>();
  const failures = new Map<string, number>();
  const textWaits = new Map<string, number>();
  /** The bundled academic subjects (R92b), loaded when the first topics are made. */
  let subjects: Subject[] | null = null;
  let backfillDue = Date.now() + timing.startDelayMs;
  let backfillDone = false;
  /** Topics and suggestions need doing at this time (null: nothing to do). */
  let topicsDue: number | null = null;
  let suggestionsDue: number | null = null;
  const suggestFor = new Set<string>();
  let suggestAll = false;
  /** The last time another tab (or the owner) changed the library. */
  let lastForeignChange = 0;
  /** The last time there was work: a reading, a refresh, or a change that matters. The worker ends `idleDisposeMs` after it. */
  let lastWorkAt = Date.now();
  let wake: (() => void) | null = null;
  const timings = import.meta.env.MODE === 'test' ? new BroadcastChannel(TIMING_CHANNEL) : null;
  /** Test builds only: says how long a step took. Carries numbers and a step name, never a title or a text. */
  const report = (step: 'reading' | 'topics' | 'suggestions', fields: Record<string, number>): void => {
    timings?.postMessage({ step, at: Date.now(), ...fields });
  };

  const poke = (): void => {
    wake?.();
    wake = null;
  };

  const stopListening = store.onChange((c) => {
    const now = Date.now();
    if (c.tabId === CATEGORISER_TAB) return; // its own write
    lastForeignChange = now;
    if (mattersToCategoriser(c)) lastWorkAt = now;
    if (c.table === 'documents' || c.table === 'page_text') {
      if (c.op === 'upsert' && c.documentId !== undefined) {
        if (mattersToCategoriser(c)) pending.set(c.documentId, now + timing.settleMs);
      } else if (c.op === 'upsert') {
        // Many readings at once with no single id (a restore, later a sync): look through the library again.
        backfillDone = false;
        backfillDue = now + timing.settleMs;
      } else if (c.op === 'delete') {
        // A reading left the library: topics and suggestions may change.
        topicsDue = now + timing.refreshDelayMs;
        suggestAll = true;
        suggestionsDue = now + timing.refreshDelayMs;
      }
    } else if (c.table === 'reading_tags' || c.table === 'tags' || c.table === 'auto_tag_removed') {
      // The owner changed tags: the 3-reading rule may be met (or not) now.
      suggestAll = true;
      suggestionsDue = now + timing.refreshDelayMs * 2;
    }
    poke();
  });

  async function embedderNow(): Promise<Embedder> {
    embedder ??= load(o.assetBase).catch((e: unknown) => {
      embedder = null; // tried again at the next reading
      throw e;
    });
    return embedder;
  }

  async function disposeEmbedder(): Promise<void> {
    const current = embedder;
    embedder = null;
    if (current === null) return;
    try {
      await (await current).dispose();
    } catch {
      // Already gone.
    }
  }

  /** Does the work for one reading. Returns how long the model took, in ms (0 when it did not run). */
  async function understand(id: DocumentId): Promise<number> {
    const began = performance.now();
    const input = await store.categoriseInput(id);
    if (input === null) return 0; // forgotten, in Trash, or never saved: nothing is read
    // Just saved: the page text is still arriving. Wait for the first pages, so the vector is made once, from the whole opening.
    const needed = Math.min(TEXT_PAGES, input.pageCount);
    if (input.indexText && input.hasText && input.pagesPresent < needed && (textWaits.get(id) ?? 0) < MAX_TEXT_WAITS) {
      textWaits.set(id, (textWaits.get(id) ?? 0) + 1);
      pending.set(id, Date.now() + timing.settleMs);
      return 0;
    }
    textWaits.delete(id);
    const title = input.title ?? fallbackTitle(input);
    const text = embeddingInput(title, input.indexText ? input.pageTexts : []);
    const textHash = await sha256Hex(text.text);
    let ms = 0;
    const current = input.embedding;
    const upToDate = current !== null && current.model === EMBEDDING_MODEL && current.textHash === textHash && current.pagesUsed === input.pagesPresent;
    // A reading with no title, no text and no readable name has nothing to understand: it is left alone until the extension restarts.
    if (text.text.trim() === '' && current === null) failures.set(id, MAX_FAILURES);
    if (!upToDate && text.text.trim() !== '') {
      const started = performance.now();
      const vector = await (await embedderNow()).embed(text.text);
      ms = performance.now() - started;
      lastEmbedAt = Date.now();
      await store.putEmbedding(id, {
        model: EMBEDDING_MODEL,
        vector,
        textHash,
        abstract: withoutNames(text.abstract, input.authors),
        pagesUsed: input.pagesPresent,
      });
      topicsDue = Date.now() + timing.refreshDelayMs;
    }
    await store.applyCourseTags(id, courseCodesOf(input));
    // R92c: a reading looked at again by newer rules (no new vector) still needs the topics made again once.
    topicsDue ??= Date.now() + timing.refreshDelayMs;
    suggestFor.add(id);
    suggestionsDue = Date.now() + timing.refreshDelayMs;
    report('reading', { embedded: ms > 0 ? 1 : 0, embedMs: Math.round(ms), totalMs: Math.round(performance.now() - began), chars: text.text.length });
    return ms;
  }

  async function refreshTopics(): Promise<void> {
    const began = performance.now();
    const corpus = await store.categoriseCorpus(CORPUS_LIMIT);
    // The authors' names never name a topic: they are taken out of the words topic names are picked from.
    const docs: Doc[] = corpus.map((d) => ({ id: d.id, vector: d.vector, text: { title: withoutNames(d.title, d.authors), abstract: d.abstract } }));
    await sleep(0); // the clustering is one burst on this thread; let a waiting message through first
    subjects ??= loadSubjects();
    const topics = clusterTopics(docs, { subjects, fields: loadFields() });
    const clustered = performance.now();
    await store.applyTopics(topics.map((t) => ({ key: t.key, docIds: t.docIds, name: t.name })));
    report('topics', { docs: docs.length, topics: topics.length, clusterMs: Math.round(clustered - began), totalMs: Math.round(performance.now() - began) });
  }

  async function refreshSuggestions(): Promise<void> {
    const began = performance.now();
    const everything = suggestAll;
    const only = new Set(suggestFor);
    suggestAll = false;
    suggestFor.clear();
    const [corpus, tagged] = await Promise.all([store.categoriseCorpus(CORPUS_LIMIT), store.categoriseTagged()]);
    const ownerOf = new Map<string, Set<string>>(); // tag id -> readings that carry it as the owner's
    for (const t of tagged) ownerOf.set(t.tagId, new Set(t.documentIds));
    const items: { documentId: DocumentId; tagIds: string[] }[] = [];
    let work = 0;
    for (const d of corpus) {
      if (!everything && !only.has(d.id)) continue;
      const doc: Doc = { id: d.id, vector: d.vector, text: { title: d.title, abstract: d.abstract } };
      const candidates = tagged
        .filter((t) => !ownerOf.get(t.tagId)?.has(d.id))
        .map((t) => ({ tag: t.tagId, vectors: t.vectors }));
      items.push({ documentId: d.id, tagIds: suggestTags(doc, candidates, new Set(d.removed)) });
      if (++work % 100 === 0) await sleep(0);
    }
    for (let i = 0; i < items.length; i += SUGGEST_CHUNK) {
      await store.applySuggestions(items.slice(i, i + SUGGEST_CHUNK));
      await sleep(timing.minGapMs);
    }
    report('suggestions', { docs: items.length, totalMs: Math.round(performance.now() - began) });
  }

  /** The next reading due: one a change event named, else one from the store's list of readings without a current vector. */
  async function nextReading(now: number): Promise<DocumentId | null> {
    for (const [id, due] of [...pending].sort((a, b) => a[1] - b[1])) {
      if (due <= now) {
        pending.delete(id);
        if ((failures.get(id) ?? 0) < MAX_FAILURES) return id as DocumentId;
      }
    }
    if (!backfillDone && now >= backfillDue) {
      const ids = (await store.categoriseQueue(QUEUE_BATCH)).filter((id) => (failures.get(id) ?? 0) < MAX_FAILURES);
      if (ids.length === 0) {
        backfillDone = true;
        // Once after every back-fill: the topics (and suggestions) may never have been made, or a reading may have left meanwhile.
        topicsDue ??= now + timing.refreshDelayMs;
        suggestAll = true;
        suggestionsDue ??= now + timing.refreshDelayMs;
        return null;
      }
      for (const id of ids.slice(1)) if (!pending.has(id)) pending.set(id, now);
      return ids[0] ?? null;
    }
    return null;
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const now = Date.now();
        // Other tabs are writing: wait for quiet.
        if (now - lastForeignChange < timing.quietMs) {
          await sleep(timing.quietMs - (now - lastForeignChange) + 50);
          continue;
        }
        const id = await nextReading(now);
        if (id !== null) {
          lastWorkAt = Date.now();
          let ms = 0;
          try {
            ms = await understand(id);
            failures.delete(id);
          } catch (e) {
            failures.set(id, (failures.get(id) ?? 0) + 1);
            // Names what failed, never the reading: no title, no text, no link.
            console.warn('sickofpdfs: the categoriser could not read a reading', e instanceof Error ? e.message.slice(0, 120) : 'unknown error');
          }
          await sleep(Math.max(timing.minGapMs, ms * timing.gapFactor));
          continue;
        }
        const later = Date.now();
        if (topicsDue !== null && later >= topicsDue && pending.size === 0) {
          topicsDue = null;
          lastWorkAt = later;
          await refreshTopics();
          continue;
        }
        if (suggestionsDue !== null && later >= suggestionsDue && pending.size === 0) {
          suggestionsDue = null;
          lastWorkAt = later;
          await refreshSuggestions();
          continue;
        }
        // Nothing to do: free the model after a while, then sleep until a change, or until the next thing is due.
        if (embedder !== null && later - lastEmbedAt > timing.idleDisposeMs) await disposeEmbedder();
        const dues = [...pending.values(), ...(backfillDone ? [] : [backfillDue]), ...(topicsDue === null ? [] : [topicsDue]), ...(suggestionsDue === null ? [] : [suggestionsDue])];
        // Nothing due at all, for a minute: the worker can end and give its memory back (the host starts it again when needed).
        if (o.onIdle !== undefined && dues.length === 0 && embedder === null && later - lastWorkAt >= timing.idleDisposeMs) {
          finish();
          o.onIdle();
          return;
        }
        const next = dues.length > 0 ? Math.max(100, Math.min(...dues) - later) : timing.idleDisposeMs;
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, Math.min(next, timing.idleDisposeMs));
        });
      } catch (e) {
        console.warn('sickofpdfs: the categoriser paused', e instanceof Error ? e.message.slice(0, 120) : 'unknown error');
        await sleep(5000);
      }
    }
  }

  function finish(): void {
    if (stopped) return;
    stopped = true;
    stopListening();
    poke();
    void disposeEmbedder();
    store.close();
  }

  void loop();

  return { stop: finish };
}
