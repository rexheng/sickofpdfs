// What travels on a store port, and the store worker's side of it.
//
//   request  { id, method, args, key? }          id: the sender's number for the reply; key: optional, unique per request
//   response { id, ok: true, value } | { id, ok: false, error: { name, message } }
//
// The worker runs requests one at a time, in the order they arrive (one owner, serialised), whichever port they come
// from. A request that carries a `key` runs at most once per worker: a replay of a request that is still waiting or
// running gets the same answer when it is done, and a replayed write that already succeeded gets its stored answer. That
// is what lets a client reconnect and replay without doing a write twice or out of order.
import { ANNOTATION_METHODS } from './annotations';
import { BACKUP_API_METHODS, BACKUP_READ_METHODS } from './backup-api';
import { LIBRARY_API_METHODS, LIBRARY_READ_METHODS } from './library-api';
import { LOOKUPS_API_METHODS, LOOKUPS_READ_METHODS } from './lookups-api';
import { PAGE_FIGURES_METHODS } from './page-figures';
import { PASSAGE_VECTORS_API_METHODS, PASSAGE_VECTORS_READ_METHODS } from './passage-vectors';
import { RESTORE_API_METHODS, RESTORE_READ_METHODS } from './restore-api';
import { SETTINGS_API_METHODS, SETTINGS_READ_METHODS } from './settings-api';
import { LIBRARY_METHODS, type StoreApi } from './store-api';
import { TAGS_API_METHODS, TAGS_READ_METHODS } from './tags-api';

/** Every method a store port serves. */
export const STORE_METHODS = [...LIBRARY_METHODS, ...ANNOTATION_METHODS, ...PAGE_FIGURES_METHODS, ...LIBRARY_API_METHODS, ...BACKUP_API_METHODS, ...RESTORE_API_METHODS, ...SETTINGS_API_METHODS, ...TAGS_API_METHODS, ...LOOKUPS_API_METHODS, ...PASSAGE_VECTORS_API_METHODS] as const;
export type StoreMethod = (typeof STORE_METHODS)[number];

// Every StoreApi method must be served: this line stops compiling when one is missing from the lists above.
const SERVES_EVERY_METHOD: [Exclude<keyof StoreApi, StoreMethod>] extends [never] ? true : never = true;
void SERVES_EVERY_METHOD;

const METHOD_SET: ReadonlySet<string> = new Set<string>(STORE_METHODS);

/** Methods that only read. Their answers are not kept for replays (running a read again is harmless). */
const READ_METHODS: ReadonlySet<string> = new Set<StoreMethod>([
  'schemaVersion',
  'stats',
  'resolveFingerprint',
  'getDocument',
  'countDocumentsWithPageCount',
  'findStampAlias',
  'listAliases',
  'listLocations',
  'documentAtLink',
  'searchPages',
  'listAnnotations',
  'listDrafts',
  'listDraftThreads',
  'listEditDrafts',
  'getPageFigures',
  ...LIBRARY_READ_METHODS,
  ...BACKUP_READ_METHODS,
  ...RESTORE_READ_METHODS,
  ...SETTINGS_READ_METHODS,
  ...TAGS_READ_METHODS,
  ...LOOKUPS_READ_METHODS,
  ...PASSAGE_VECTORS_READ_METHODS,
]);

export interface StoreRequest {
  id: number | string;
  method: StoreMethod;
  args: unknown[];
  /** Unique per request across every client (the client's random id plus its request number). Used to drop replays. */
  key?: string;
}

export interface StoreErrorPayload {
  name: string;
  message: string;
}

/** A response without its id: what a request comes to. */
export type StoreAnswer = { ok: true; value: unknown } | { ok: false; error: StoreErrorPayload };
export type StoreResponse = StoreAnswer & { id: number | string };

export function isStoreRequest(x: unknown): x is StoreRequest {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    (typeof r.id === 'number' || typeof r.id === 'string') &&
    typeof r.method === 'string' &&
    METHOD_SET.has(r.method) &&
    Array.isArray(r.args) &&
    (r.key === undefined || typeof r.key === 'string')
  );
}

export function isStoreResponse(x: unknown): x is StoreResponse {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== 'number' && typeof r.id !== 'string') return false;
  if (r.ok === true) return 'value' in r;
  if (r.ok !== false || typeof r.error !== 'object' || r.error === null) return false;
  const e = r.error as Record<string, unknown>;
  return typeof e.name === 'string' && typeof e.message === 'string';
}

/** An error as plain data. The message keeps its leading code (`read-only: …`), which is how callers tell errors apart. */
export function errorPayload(e: unknown): StoreErrorPayload {
  if (e instanceof Error) return { name: e.name || 'Error', message: e.message };
  return { name: 'Error', message: String(e) };
}

/** The error a client rejects with for a failed response. */
export function errorFromPayload(p: StoreErrorPayload): Error {
  const error = new Error(p.message);
  error.name = p.name;
  return error;
}

/** How many answered writes are kept, so a replay of one is answered without running it again. */
const KEPT_ANSWERS = 512;

interface Waiting {
  port: MessagePort;
  id: number | string;
}

interface Entry {
  waiting: Waiting[];
  answer: StoreAnswer | null;
}

/**
 * The worker's side of every store port. `getApi` opens the database (once; it may be retried after a failure).
 * `attach` serves one more port. All ports share one queue, so requests run one at a time in arrival order.
 */
export function createStoreServer(getApi: () => Promise<StoreApi>): { attach(port: MessagePort): void } {
  let queue: Promise<void> = Promise.resolve();
  const byKey = new Map<string, Entry>();
  const kept: string[] = [];

  const reply = (to: Waiting, answer: StoreAnswer): void => {
    try {
      to.port.postMessage({ id: to.id, ...answer });
    } catch (e) {
      // The value could not be copied to the other side: say so instead of leaving the caller waiting.
      try {
        to.port.postMessage({ id: to.id, ok: false, error: errorPayload(e) });
      } catch {
        // The port is gone; nobody is waiting.
      }
    }
  };

  const run = async (request: StoreRequest, entry: Entry): Promise<void> => {
    let answer: StoreAnswer;
    try {
      const api = await getApi();
      const method = Reflect.get(api, request.method) as (...args: unknown[]) => Promise<unknown>;
      answer = { ok: true, value: await method.apply(api, request.args) };
    } catch (e) {
      answer = { ok: false, error: errorPayload(e) };
    }
    entry.answer = answer;
    const waiting = entry.waiting;
    entry.waiting = [];
    for (const w of waiting) reply(w, answer);
    if (request.key === undefined) return;
    // A read, or a write that failed (and so changed nothing), may run again. A write that succeeded is kept for a while.
    if (!answer.ok || READ_METHODS.has(request.method)) {
      byKey.delete(request.key);
      return;
    }
    kept.push(request.key);
    while (kept.length > KEPT_ANSWERS) byKey.delete(kept.shift()!);
  };

  const receive = (port: MessagePort, message: unknown): void => {
    if (!isStoreRequest(message)) {
      const id = (message as { id?: unknown } | null)?.id;
      if (typeof id === 'number' || typeof id === 'string') {
        reply({ port, id }, { ok: false, error: { name: 'StoreError', message: 'bad-request: unknown store method or arguments' } });
      }
      return;
    }
    const to = { port, id: message.id };
    if (message.key !== undefined) {
      const seen = byKey.get(message.key);
      if (seen) {
        if (seen.answer) reply(to, seen.answer);
        else seen.waiting.push(to);
        return;
      }
    }
    const entry: Entry = { waiting: [to], answer: null };
    if (message.key !== undefined) byKey.set(message.key, entry);
    queue = queue.then(() => run(message, entry));
  };

  return {
    attach(port) {
      port.onmessage = (e: MessageEvent) => receive(port, e.data);
    },
  };
}
