// The online lookups (S12, decision D10: off until the owner turns them on). A queue that runs in the offscreen document. While the setting
// `lookups.online` is on, it asks arXiv or Crossref for the title, authors and year of a saved reading that has a DOI or an arXiv id, and
// fills only what is empty (fill.ts, and again inside the store).
//
// What leaves the computer, and when:
// - Only the id of a saved reading: `https://export.arxiv.org/api/query?id_list=<arXiv id>&max_results=1` or
//   `https://api.crossref.org/works/<DOI>`. No title, text, file name, link, cookie or referrer (arxiv.ts, crossref.ts, http.ts).
// - Only while the switch is on. It is read from the library right before every request. A change of the setting stops the queue at once:
//   the request on its way is cancelled and every timer is cleared. Switching it on starts it again.
// - Only for a saved reading (a row of `documents`, not in Trash) whose text is in the library (not `index_text` 0), that the owner did not
//   save against the filter's "not learning" (R102, Nov 6: such a reading never goes online), and which was saved
//   more than `SETTLE_MS` ago, so a save that is taken back (Undo lasts 10 s) is never asked about. The store decides this (store/lookups-api.ts).
// - Which readings: those that lack a title, authors or a year, and each reading saved while this runs (one check, whether or not it lacks
//   anything). An older reading that lacks nothing is not asked about, so a big library is not sent out again at every browser start.
// - At most one arXiv call every 3 seconds, one Crossref call a second, and never two at once.
// - A failure is quiet. The queue waits (30 s, then twice as long each time, up to 30 min; or as long as the server asks) and tries again,
//   a reading at most 3 times per source in one browser session. An answer of "no such paper" is not a failure and is not asked again.
//   Nothing is shown to the owner and nothing is logged.
//
// It remembers nothing on disk about what it asked: the readings it has tried live in memory only, so forgetting a reading leaves no trace here.
import type { DocumentId } from '@sop/core';
import type { StoreChange } from '../store/change-bus';
import { createStoreClient, type StoreClient } from '../store/client';
import type { LookupItem } from '../store/lookups-api';
import { ARXIV_GAP_MS, arxivUrl, parseArxiv } from './arxiv';
import { CROSSREF_GAP_MS, crossrefUrl, parseCrossref } from './crossref';
import { cleanFound, fillFor, type Found } from './fill';
import { ask } from './http';

/** The synced setting that switches the lookups on (contracts §5). Off until the owner turns it on. */
export const LOOKUPS_SETTING = 'lookups.online';

type Source = 'arxiv' | 'crossref';

interface Job {
  source: Source;
  url: string;
  accept: string;
}

/** What has been tried for one reading in this browser session. */
interface Tried {
  arxiv: boolean;
  crossref: boolean;
  /** Failures (network, 429, 5xx) so far, per source. */
  failed: Record<Source, number>;
}

export interface Timing {
  /** Wait before the first pass after the offscreen document starts, so the library is open first. */
  startDelayMs: number;
  /** The first back-off after a failure; it doubles with every failure in a row. */
  backoffMs: number;
  /** The longest back-off. */
  maxBackoffMs: number;
  /** A reading is given up on, for this source, after this many failures in a session. */
  maxFailures: number;
  /** The least wait between two calls to a source. */
  gapMs: Record<Source, number>;
}

export const DEFAULT_TIMING: Timing = {
  startDelayMs: 4000,
  backoffMs: 30_000,
  maxBackoffMs: 30 * 60_000,
  maxFailures: 3,
  gapMs: { arxiv: ARXIV_GAP_MS, crossref: CROSSREF_GAP_MS },
};

export interface QueueOptions {
  /** A new port to the store worker (the offscreen document makes it, host.ts). */
  openStorePort: () => Promise<MessagePort>;
  timing?: Partial<Timing>;
}

export interface LookupQueue {
  stop(): void;
}

/** A busy computer may take a while to answer the store; the client waits this long before it gives up. */
const STORE_TIMEOUT_MS = 60_000;

const ACCEPT: Record<Source, string> = { arxiv: 'application/atom+xml, application/xml;q=0.9', crossref: 'application/json' };

export function startLookupQueue(o: QueueOptions): LookupQueue {
  const timing: Timing = { ...DEFAULT_TIMING, ...o.timing, gapMs: { ...DEFAULT_TIMING.gapMs, ...o.timing?.gapMs } };
  const store: StoreClient = createStoreClient(o.openStorePort, STORE_TIMEOUT_MS);

  /** The switch, as last read. False until the library says it is on. */
  let on = false;
  /** Bumped every time the queue must stop what it is doing: a pass that sees a new number ends without sending anything. */
  let generation = 0;
  let passing = false;
  /** Someone asked for a pass while one was running. */
  let again = false;
  let pending: { timer: ReturnType<typeof setTimeout>; at: number } | null = null;
  let inFlight: AbortController | null = null;
  const sleepers = new Set<() => void>();
  let closed = false;
  /** Counts the reads of the setting, so only the newest one decides. */
  let switchReads = 0;

  /** Readings saved from now on are checked once even when they lack nothing; older ones only when they lack something. */
  const startedAt = Date.now();
  const tried = new Map<DocumentId, Tried>();
  /** Readings with nothing left to ask in this session: given to the store as ones to skip. */
  const done = new Set<DocumentId>();
  const lastCall: Record<Source, number> = { arxiv: 0, crossref: 0 };
  let failuresInARow = 0;
  /** No request before this time (a back-off). */
  let notBefore = 0;

  // ---- starting and stopping ----

  function clearTimers(): void {
    if (pending !== null) clearTimeout(pending.timer);
    pending = null;
    for (const wake of [...sleepers]) wake();
    sleepers.clear();
  }

  /** Ends everything now: the request on its way is cancelled, every timer is cleared, and a pass that is running ends. */
  function halt(): void {
    generation += 1;
    inFlight?.abort();
    inFlight = null;
    clearTimers();
  }

  /** Asks for a pass in `delayMs`. An earlier ask is never pushed later. */
  function schedule(delayMs: number): void {
    if (closed || !on) return;
    const at = Date.now() + Math.max(0, delayMs);
    if (pending !== null) {
      if (pending.at <= at) return;
      clearTimeout(pending.timer);
    }
    const timer = setTimeout(
      () => {
        pending = null;
        void pass();
      },
      Math.max(0, at - Date.now()),
    );
    pending = { timer, at };
  }

  /** Waits `ms`, or less if the queue is halted. */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  /** Reads the switch and starts or stops to match it. Any change of the setting halts first, so nothing is sent while the answer is on its way. */
  async function applySwitch(): Promise<void> {
    halt();
    on = false;
    const mine = ++switchReads;
    let value: unknown;
    try {
      value = await store.getSetting(LOOKUPS_SETTING);
    } catch {
      return; // the library is not open; the next change of the setting or the next start tries again
    }
    if (closed || mine !== switchReads || value !== true) return; // a newer change decides
    on = true;
    schedule(0);
  }

  // ---- what to ask ----

  const triedOf = (id: DocumentId): Tried => {
    let t = tried.get(id);
    if (t === undefined) {
      t = { arxiv: false, crossref: false, failed: { arxiv: 0, crossref: 0 } };
      tried.set(id, t);
    }
    return t;
  };

  /** The next thing to ask about this reading: arXiv first (it answers all three), then Crossref. Null when nothing is left. */
  function jobFor(item: LookupItem): Job | null {
    const t = triedOf(item.id);
    if (!t.arxiv) {
      const url = arxivUrl(item.arxivId);
      if (url !== null) return { source: 'arxiv', url, accept: ACCEPT.arxiv };
      t.arxiv = true; // not an id arXiv knows
    }
    if (!t.crossref) {
      const url = crossrefUrl(item.doi);
      if (url !== null) return { source: 'crossref', url, accept: ACCEPT.crossref };
      t.crossref = true;
    }
    return null;
  }

  function parse(job: Job, item: LookupItem, body: string): Found | null {
    try {
      return job.source === 'arxiv' ? parseArxiv(body, item.arxivId ?? '') : parseCrossref(body, item.doi ?? '');
    } catch {
      return null;
    }
  }

  /** The back-off after the `n`th failure in a row. */
  const backoff = (n: number): number => Math.min(timing.maxBackoffMs, timing.backoffMs * 2 ** Math.min(n - 1, 16)) * (1 + Math.random() * 0.1);

  function failed(item: LookupItem, job: Job, retryAfterMs: number | null): void {
    const t = triedOf(item.id);
    failuresInARow += 1;
    t.failed[job.source] += 1;
    if (t.failed[job.source] >= timing.maxFailures) t[job.source] = true;
    const wait = Math.min(timing.maxBackoffMs * 2, Math.max(retryAfterMs ?? 0, backoff(failuresInARow)));
    notBefore = Date.now() + wait;
    schedule(wait);
  }

  /** One request, its answer, and the fill. Returns when it is finished or the queue was halted. */
  async function askAbout(item: LookupItem, job: Job, gen: number): Promise<void> {
    const controller = new AbortController();
    inFlight = controller;
    lastCall[job.source] = Date.now();
    let status: number;
    let text: string | null;
    let retryAfterMs: number | null;
    try {
      ({ status, text, retryAfterMs } = await ask(job.url, job.accept, controller.signal));
    } catch {
      if (gen === generation) failed(item, job, null); // a halt is not a failure
      return;
    } finally {
      if (inFlight === controller) inFlight = null;
    }
    if (gen !== generation) return;

    if (status === 429 || status === 408 || status >= 500) {
      failed(item, job, retryAfterMs);
      return;
    }
    // The server answered: whatever it said, the back-off is over, and this source is not asked about this reading again.
    failuresInARow = 0;
    notBefore = 0;
    triedOf(item.id)[job.source] = true;
    if (status !== 200 || text === null) return; // no such paper (404), a refusal (400), or an answer too big to read
    const found = parse(job, item, text);
    if (found === null) return; // not what was asked about: the other source, if the reading has one, is asked next
    done.add(item.id); // answered: nothing more to ask
    const fill = fillFor(item, cleanFound(found, Date.now()));
    if (fill !== null) await store.lookupFill(item.id, fill);
  }

  /** Works through the readings that could be filled in, one request at a time, until there are none or the queue is halted. */
  async function pass(): Promise<void> {
    if (closed || !on) return;
    if (passing) {
      again = true;
      return;
    }
    passing = true;
    const gen = generation;
    try {
      while (gen === generation && !closed) {
        const wait = notBefore - Date.now();
        if (wait > 0) {
          schedule(wait);
          return;
        }
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return; // the 'online' event asks for a pass
        // The switch is read from the library right before the reading is chosen and the request sent.
        if ((await store.getSetting(LOOKUPS_SETTING)) !== true) {
          if (gen === generation) {
            halt();
            on = false;
          }
          return;
        }
        if (gen !== generation) return;
        const { item, waitMs } = await store.lookupNext([...done], startedAt);
        if (gen !== generation) return;
        if (item === null) {
          if (waitMs !== null) schedule(waitMs + 250); // a reading saved a moment ago is still settling: look again when it has
          return;
        }
        const job = jobFor(item);
        if (job === null) {
          done.add(item.id);
          continue;
        }
        const gap = lastCall[job.source] + timing.gapMs[job.source] - Date.now();
        if (gap > 0) {
          await sleep(gap);
          continue; // the reading is chosen again after the pause: it may have been forgotten, or the switch turned off
        }
        await askAbout(item, job, gen);
      }
    } catch {
      // The library did not answer (it is starting, or busy). Try again later, quietly.
      if (gen === generation) schedule(60_000);
    } finally {
      passing = false;
      if (again) {
        again = false;
        schedule(0);
      }
    }
  }

  // ---- what wakes it ----

  const onChange = (c: StoreChange): void => {
    if (c.table === 'settings' && c.ids.includes(LOOKUPS_SETTING)) {
      void applySwitch();
    } else if (on && c.table === 'documents' && c.op === 'upsert') {
      // A reading was saved or changed. A pass tells whether it is ready, or when it will be (the store knows when it has settled).
      schedule(500);
    }
  };
  const stopListening = store.onChange(onChange);
  const onOnline = (): void => schedule(0);
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);

  const starting = setTimeout(() => void applySwitch(), timing.startDelayMs);

  return {
    stop() {
      closed = true;
      clearTimeout(starting);
      halt();
      on = false;
      stopListening();
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
      store.close();
    },
  };
}
