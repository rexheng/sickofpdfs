// Reading the page text of restored readings again (S17): how pages and the restore worker reach the indexer in the offscreen document
// (reindex.ts), and hear how far it is. A backup never holds page text, so until this is done, search finds nothing inside a restored PDF.
//
// A BroadcastChannel is shared by every page and worker of this extension and by nothing else (a web page or a content script runs in
// another origin). Messages carry fingerprints and counts only: no titles, no text.
//
//   → indexer  { type: 'reindex:request', ids }        read these readings' text again, if they need it (most important first)
//   → indexer  { type: 'reindex:ask' }                 say how far you are
//   ← indexer  { type: 'reindex:progress', progress }  after every reading, and in answer to an ask
export const REINDEX_CHANNEL = 'sop-reindex';

export interface ReindexProgress {
  /** True while readings are being read. */
  active: boolean;
  /** Readings finished in this round (read, or given up), and how many the round holds. */
  done: number;
  total: number;
  /** Readings whose text could not be read (no copy, a password, a damaged file). */
  failed: number;
}

export type ReindexMessage = { type: 'reindex:request'; ids: string[] } | { type: 'reindex:ask' } | { type: 'reindex:progress'; progress: ReindexProgress };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const SHA = /^[0-9a-f]{64}$/;
/** The most ids one request carries (a library far bigger than any this version keeps). */
export const MAX_REQUEST_IDS = 100_000;

/** A message that is well formed; null for anything else on the channel. */
export function asReindexMessage(x: unknown): ReindexMessage | null {
  if (!isRecord(x)) return null;
  switch (x.type) {
    case 'reindex:request':
      return Array.isArray(x.ids) && x.ids.length <= MAX_REQUEST_IDS ? { type: 'reindex:request', ids: x.ids.filter((id): id is string => typeof id === 'string' && SHA.test(id)) } : null;
    case 'reindex:ask':
      return { type: 'reindex:ask' };
    case 'reindex:progress': {
      const p = x.progress;
      if (!isRecord(p) || typeof p.active !== 'boolean' || !isCount(p.done) || !isCount(p.total) || !isCount(p.failed)) return null;
      return { type: 'reindex:progress', progress: { active: p.active, done: p.done, total: p.total, failed: p.failed } };
    }
    default:
      return null;
  }
}

function post(message: ReindexMessage): void {
  const channel = new BroadcastChannel(REINDEX_CHANNEL);
  channel.postMessage(message);
  channel.close();
}

/** Asks the indexer to read these readings' text again (it skips any that do not need it). In order: most important first. */
export function requestReindex(ids: readonly string[]): void {
  if (ids.length > 0) post({ type: 'reindex:request', ids: ids.slice(0, MAX_REQUEST_IDS) });
}

/** Calls `cb` with the indexer's progress whenever it changes, starting with where it is now. Returns the function that stops it. */
export function onReindexProgress(cb: (p: ReindexProgress) => void): () => void {
  const channel = new BroadcastChannel(REINDEX_CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const m = asReindexMessage(e.data);
    if (m?.type === 'reindex:progress') cb(m.progress);
  };
  channel.postMessage({ type: 'reindex:ask' } satisfies ReindexMessage);
  return () => channel.close();
}

// What the offscreen document and its indexing worker say to each other (reindex.ts, reindex-worker.ts):
//   worker → host   { type: 'reindex:port-request' }                 "give me a new port to the store worker"
//   host   → worker { type: 'reindex:port' } + the port
//   host   → worker { type: 'reindex:index', id }                    read this reading's text
//   worker → host   { type: 'reindex:indexed', id, outcome }         done: 'indexed', 'skipped' (it needs nothing) or 'failed'
export const WORKER_PORT_REQUEST = 'reindex:port-request';
export const WORKER_PORT = 'reindex:port';
export const WORKER_INDEX = 'reindex:index';
export const WORKER_INDEXED = 'reindex:indexed';

export type IndexOutcome = 'indexed' | 'skipped' | 'failed';

export const isWorkerMessage = (x: unknown, type: string): boolean => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === type;

/** "Indexing 3 of 12": the reading being read now, while a round runs. */
export const indexingWords = (p: ReindexProgress): string => `Indexing ${Math.min(p.done + 1, p.total)} of ${p.total}`;
