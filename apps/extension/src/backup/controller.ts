// The backup, as it runs in its own worker (worker.ts, started by the offscreen document): the one place that writes to the folder.
// A worker has its own thread, so none of the work below (turning the library into files, streaming PDFs out) can hold up a viewer tab,
// which shares a renderer process with the offscreen document.
//
//  - It answers requests from pages (rpc.ts): back up now, a folder was chosen or cleared, a reading was forgotten, finish the
//    removals waiting for a folder.
//  - It runs the schedule (schedule.ts): every night, and after a session with new notes.
//  - It keeps the status record (handle-store.ts) true, tells pages when it changes, and asks the service worker for the badge
//    while the folder waits for the owner's click or a run is on hold (R86).
//  - Gone for good means gone from backups (R82): when the store announces that a reading was deleted (Forget, a Trash purge after
//    30 days, an Undo of a save), its removal is queued for the chosen folder, and every run removes what is queued first, then
//    what is still waiting for folders the owner moved away from. Moving a reading to the Trash is not a delete and removes nothing.
//
// Rules this file keeps:
// - One run at a time. A run takes the Web Lock `sop-backup-run`; a second "back up now" answers "busy". A forgotten reading's removal
//   waits for the lock, so a run in progress is never cut through.
// - Writing never blocks a viewer. This runs on a worker's own thread; the library is read from the store worker in small pieces
//   (`exportChunk`, read-library.ts), so the store answers a viewer's request between two pieces; and the PDFs are streamed from file
//   storage to the folder in pieces. No viewer waits for any of it.
// - It never asks for permission (only a click can). A folder that is not `granted` puts the backup in `waiting` and shows the badge.
// - It says nothing in the console about what is written: no names, no titles, no ids.
import type { BackupCounts, Sha256 } from '@sop/core';
import { type BlobStore, openBlobStore } from '../store/blob-store';
import { createStoreClient } from '../store/client';
import { type HandleStore, openHandleStore } from './handle-store';
import { asRequest, RPC_CHANNEL, type RpcReply, type RpcRequest, type RunSummary, type ScrubSummary, STATUS_CHANNEL } from './rpc';
import { decide, type LastOutcome, NOTES_QUIET_MS } from './schedule';
import { scrubFolder, type ScrubOutcome } from './scrub';
import {
  badgeOf,
  type BackupStatus,
  type BadgeState,
  DROPPED_MESSAGE,
  type DroppedRemovals,
  emptyStatus,
  failureMessage,
  HELD_MESSAGES,
  sameBadge,
  UNREADABLE_SCRUB_MESSAGE,
  WAITING_MESSAGE,
} from './status';
import { currentTarget, retiredRecord, targetFrom, type BackupTarget } from './target';
import { type RunOutcome, runBackup } from './writer';
import { VIEWER_PATH } from '../shared/viewer-url';

/** The Web Lock one run (or one removal) holds. */
export const RUN_LOCK = 'sop-backup-run';
/** A read of a big library may take a while on a loaded computer; the store client waits this long before it gives up. */
const STORE_TIMEOUT_MS = 120_000;
/** The schedule is looked at this often even when no timer fires (a laptop that slept, a changed clock). */
const TICK_MS = 5 * 60_000;
/** The longest a single timer waits. */
const MAX_WAIT_MS = 6 * 60 * 60_000;
const MIN_WAIT_MS = 5000;
const PROGRESS_EVERY_MS = 400;
/** R88: a queued removal's raw id is kept at most this long. */
const SCRUB_EXPIRE_MS = 30 * 24 * 60 * 60_000;

/** Tables whose changes are the owner's notes: a marked passage, a thread, a comment. */
const NOTE_TABLES: ReadonlySet<string> = new Set(['marks', 'threads', 'comments']);

export interface ControllerOptions {
  /** A new port to the store worker (the offscreen document makes it and hands it over, host.ts). */
  openStorePort: () => Promise<MessagePort>;
  /** Show or clear the badge on the toolbar icon. A worker has no `chrome.*`, so the offscreen document sends the message (host.ts). */
  announceBadge: (badge: BadgeState) => void;
}

export interface BackupController {
  stop(): void;
}

let versionOf: Promise<string> | null = null;

/** The extension's version. A worker has no `chrome.runtime.getManifest`, so it reads its own `manifest.json`. */
function appVersion(): Promise<string> {
  versionOf ??= fetch(new URL('manifest.json', location.origin))
    .then((r) => r.json() as Promise<{ version?: unknown }>)
    .then((m) => (typeof m.version === 'string' ? m.version : '0'))
    .catch(() => '0');
  return versionOf;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function startBackupController(o: ControllerOptions): BackupController {
  const store = createStoreClient(o.openStorePort, STORE_TIMEOUT_MS);
  const rpc = new BroadcastChannel(RPC_CHANNEL);
  const statusChannel = new BroadcastChannel(STATUS_CHANNEL);
  let handlesPromise: Promise<HandleStore> | null = null;
  let blobsPromise: Promise<BlobStore> | null = null;
  let stopped = false;
  let dirtySince: number | null = null;
  let changedAt: number | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  const handlesOf = (): Promise<HandleStore> => (handlesPromise ??= openHandleStore());
  const blobsOf = (): Promise<BlobStore> =>
    (blobsPromise ??= openBlobStore().catch((e: unknown) => {
      blobsPromise = null;
      throw e;
    }));

  /** Changes the status record, tells the pages, and puts the badge right. */
  async function setStatus(change: (s: BackupStatus) => BackupStatus): Promise<BackupStatus> {
    const handles = await handlesOf();
    const seen: { before: BackupStatus | null } = { before: null };
    const next = await handles.updateStatus((s) => {
      seen.before = s;
      return change(s);
    });
    try {
      statusChannel.postMessage({ type: 'status' });
    } catch {
      // The channel is closed: the controller was stopped.
    }
    const before = seen.before === null ? null : badgeOf(seen.before);
    const after = badgeOf(next);
    if (before === null || !sameBadge(before, after)) o.announceBadge(after);
    return next;
  }

  // ---- removing readings that left for good (R75, R82) ----------------------------------------------------------------------------

  /**
   * Removes every reading in the chosen folder's pending list from it. The caller holds the lock. A reading stays pending while a file
   * that names it cannot be read (it is tried again at each run, and Settings names the file).
   */
  async function drainScrubs(target: BackupTarget): Promise<ScrubOutcome> {
    const handles = await handlesOf();
    await expire(handles);
    const queued = await handles.listScrubs();
    // N6: a reading that is back in the library (saved again) is not removed: its queued removal is dropped.
    const back = await backInLibrary(queued.map((p) => p.documentId));
    if (back.length > 0) await handles.removeScrubs(back);
    const pending = queued.filter((p) => !back.includes(p.documentId));
    if (pending.length === 0) {
      await setStatus((s) => (s.scrubsPending === 0 && s.unreadable.length === 0 ? s : { ...s, scrubsPending: 0, unreadable: [] }));
      return { ok: true, unreadable: [] };
    }
    const ids = pending.map((p) => p.documentId);
    const outcome = await scrubFolder(target, ids, handles);
    const done = outcome.ok && outcome.unreadable.length === 0;
    if (done) await handles.removeScrubs(ids); // R88: once drained, the raw ids go
    await setStatus((s) => ({ ...s, scrubsPending: done ? 0 : ids.length, unreadable: outcome.ok ? outcome.unreadable : s.unreadable }));
    return outcome;
  }

  /** The ids among `ids` that are in the library again (a document, or an alias of one). On a store error, none. */
  async function backInLibrary(ids: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const id of ids) {
      if ((await store.resolveFingerprint(id as Sha256).catch(() => null)) !== null) out.push(id);
    }
    return out;
  }

  /**
   * R88: raw ids wait at most 30 days. Older ones are dropped from the queue and from retired folders; a retired folder left with
   * nothing is dropped too, and Settings says so (`dropped`). A forgotten reading this computer wrote is still caught at the next run
   * through the store's forgotten list (writer.ts).
   */
  async function expire(handles: HandleStore): Promise<void> {
    const gone = await handles.expireScrubs(Date.now() - SCRUB_EXPIRE_MS);
    if (gone.length > 0) await setStatus((s) => ({ ...s, dropped: [...s.dropped, ...gone.map((g) => ({ ...g, reason: 'expired' as const, at: Date.now() }))] }));
  }

  /**
   * Tries the removals still waiting for folders the owner moved away from. Never asks for permission. The caller holds the lock.
   * R88: a folder that no longer exists is dropped with its list, and Settings says so plainly.
   */
  async function drainRetired(): Promise<{ left: number; dropped: number }> {
    const handles = await handlesOf();
    await expire(handles);
    let left = 0;
    const dropped: DroppedRemovals[] = [];
    for (const r of await handles.listRetired()) {
      const target = targetFrom(r.target, handles, retiredRecord(handles, r.id));
      const queued = r.scrubs.map((p) => p.documentId);
      const back = await backInLibrary(queued);
      if (back.length > 0) await handles.doneRetired(r.id, back);
      const ids = queued.filter((id) => !back.includes(id));
      if (target === null || ids.length === 0) continue;
      const outcome = await scrubFolder(target, ids);
      if (outcome.ok && outcome.unreadable.length === 0) await handles.doneRetired(r.id, ids);
      else if (!outcome.ok && outcome.kind === 'failed' && outcome.failure === 'gone') {
        await handles.doneRetired(r.id, ids);
        dropped.push({ folderName: r.target.name, count: ids.length, reason: 'gone', at: Date.now() });
      } else left += ids.length;
    }
    await setStatus((s) => (dropped.length === 0 ? s : { ...s, dropped: [...s.dropped, ...dropped] })); // the pages read the retired list again
    return { left, dropped: dropped.reduce((n, d) => n + d.count, 0) };
  }

  /** With no folder chosen there are no runs: the removals still waiting for old folders are tried on the schedule's tick instead. */
  async function drainRetiredWhileOff(): Promise<void> {
    const handles = await handlesOf();
    if ((await handles.listRetired()).length === 0) return;
    await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock) => {
      if (lock !== null) await drainRetired();
    });
  }

  /**
   * Queues a removal for the chosen folder after a delete. Nothing is queued when no folder is chosen: there is nothing to remove from.
   * R88: Forget and the Trash purge put the reading on the store's forgotten list, and its removal is always queued. An Undo of a save
   * does not: its removal is queued only when a run may already hold the reading (this computer wrote it there, or a run is going now).
   */
  async function queueScrub(documentIds: readonly string[]): Promise<void> {
    const handles = await handlesOf();
    if ((await handles.getTarget()) === null) return;
    const forgotten = new Set(await store.forgottenAmong(documentIds).catch(() => [...documentIds]));
    const known = await handles.getKnown();
    const running = (await handles.getStatus()).phase === 'running';
    const ids = documentIds.filter((id) => forgotten.has(id) || known.has(id) || running);
    if (ids.length === 0) return;
    for (const id of ids) await handles.addScrub(id, Date.now());
    const pending = (await handles.listScrubs()).length;
    await setStatus((s) => ({ ...s, scrubsPending: pending }));
  }

  async function scrubNow(documentId: string): Promise<ScrubSummary> {
    const handles = await handlesOf();
    const cur = await currentTarget(handles);
    if (cur === null) return { status: 'no-backup' };
    await handles.addScrub(documentId, Date.now());
    await setStatus((s) => ({ ...s, scrubsPending: Math.max(s.scrubsPending, 1) }));
    // Waits for a run in progress: the removal never cuts through a run.
    const outcome = await navigator.locks.request(RUN_LOCK, () => drainScrubs(cur.target));
    return summaryOf(outcome);
  }

  function summaryOf(outcome: ScrubOutcome): ScrubSummary {
    if (outcome.ok) return outcome.unreadable.length === 0 ? { status: 'removed' } : { status: 'pending', reason: 'unreadable', message: UNREADABLE_SCRUB_MESSAGE };
    if (outcome.kind === 'permission') {
      void setStatus((s) => ({ ...s, phase: s.phase === 'running' ? s.phase : 'waiting', message: WAITING_MESSAGE })).catch(() => {});
      return { status: 'pending', reason: 'permission', message: WAITING_MESSAGE };
    }
    return { status: 'pending', reason: 'failed', message: failureMessage(outcome.failure) };
  }

  /** "Change folder", "Turn off" and "Try now": the removals waiting for the chosen folder and for retired ones, now. */
  async function drainNow(): Promise<ScrubSummary> {
    const handles = await handlesOf();
    const cur = await currentTarget(handles);
    return await navigator.locks.request(RUN_LOCK, async () => {
      const outcome = cur === null ? ({ ok: true, unreadable: [] } as ScrubOutcome) : await drainScrubs(cur.target);
      const { left, dropped } = await drainRetired();
      if (!outcome.ok || outcome.unreadable.length > 0) return summaryOf(outcome);
      if (left > 0) return { status: 'pending', reason: 'failed', message: failureMessage('other') };
      return dropped > 0 ? { status: 'pending', reason: 'gone', message: DROPPED_MESSAGE } : { status: 'removed' };
    });
  }

  // ---- running a backup -----------------------------------------------------------------------------------------------------------

  async function finish(outcome: RunOutcome, at: number): Promise<RunSummary> {
    if (outcome.ok) {
      const counts: BackupCounts = outcome.manifest.counts;
      const notes = [
        outcome.missingPdfs > 0 ? `${plural(outcome.missingPdfs, 'PDF', 'PDFs')} couldn’t be copied because the copy in your library is missing.` : null,
        outcome.damagedPdfs > 0
          ? `${plural(outcome.damagedPdfs, 'PDF', 'PDFs')} in your library ${outcome.damagedPdfs === 1 ? 'looks' : 'look'} damaged, so ${outcome.damagedPdfs === 1 ? 'it was' : 'they were'} not copied. The backup keeps any good copy it already had.`
          : null,
      ].filter((m): m is string => m !== null);
      const message = notes.length > 0 ? notes.join(' ') : null;
      await setStatus((s) => ({ ...s, phase: 'idle', lastBackupAt: at, bytes: outcome.bytes, counts, held: null, message, progress: null }));
      return { ok: true, bytes: outcome.bytes, counts, wrote: outcome.wrote, missingPdfs: outcome.missingPdfs, damagedPdfs: outcome.damagedPdfs, at };
    }
    if (outcome.kind === 'permission') {
      await setStatus((s) => ({ ...s, phase: 'waiting', held: null, message: WAITING_MESSAGE, progress: null }));
      return { ok: false, reason: 'permission', message: WAITING_MESSAGE };
    }
    if (outcome.kind === 'held') {
      const { held } = outcome;
      await setStatus((s) => ({ ...s, phase: 'held', held, message: HELD_MESSAGES[held], progress: null }));
      return { ok: false, reason: 'held', message: HELD_MESSAGES[held] };
    }
    const message = failureMessage(outcome.failure);
    await setStatus((s) => ({ ...s, phase: 'failed', held: null, message, progress: null }));
    return { ok: false, reason: 'failed', message, ...(import.meta.env.MODE === 'test' ? { detail: outcome.detail } : {}) };
  }

  async function runNow(opts: { force?: boolean; now?: number }): Promise<RunSummary> {
    const handles = await handlesOf();
    const cur = await currentTarget(handles);
    if (cur === null) return { ok: false, reason: 'no-folder', message: 'No backup folder is chosen.' };
    const clock = (): number => opts.now ?? Date.now();
    return await navigator.locks.request(RUN_LOCK, { ifAvailable: true }, async (lock): Promise<RunSummary> => {
      if (lock === null) return { ok: false, reason: 'busy', message: 'A backup is already running.' };
      const at = clock();
      dirtySince = null;
      changedAt = null;
      await setStatus((s) => ({ ...s, phase: 'running', folderName: cur.target.name, lastAttemptAt: at, held: null, message: null, progress: { done: 0, total: 0 } }));
      try {
        // Readings that left for good first (R82), so a reading the owner removed is never in a file this run goes on to write.
        const scrubbed = await drainScrubs(cur.target);
        if (!scrubbed.ok && scrubbed.kind === 'permission') return await finish({ ok: false, kind: 'permission' }, at);
        await drainRetired();
        let lastProgress = 0;
        const outcome = await runBackup(
          cur.target,
          {
            store,
            blobs: await blobsOf(),
            handles,
            scrub: async (ids) => {
              for (const id of ids) await handles.addScrub(id, Date.now());
              return await drainScrubs(cur.target);
            },
            now: clock,
            appVersion: await appVersion(),
            viewerBase: new URL(VIEWER_PATH, location.origin).href,
            onProgress: (p) => {
              const t = Date.now();
              if (t - lastProgress < PROGRESS_EVERY_MS && p.done < p.total) return;
              lastProgress = t;
              void setStatus((s) => (s.phase === 'running' ? { ...s, progress: p } : s)).catch(() => {});
            },
          },
          { force: opts.force },
        );
        return await finish(outcome, at);
      } catch (error) {
        console.error('sickofpdfs: the backup stopped', error instanceof Error ? error.name : 'error');
        return await finish({ ok: false, kind: 'failed', failure: 'other', detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }, at);
      }
    });
  }

  // ---- the schedule ---------------------------------------------------------------------------------------------------------------

  function setWake(at: number | null): void {
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = null;
    if (at === null || stopped) return;
    const wait = Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, at - Date.now()));
    wakeTimer = setTimeout(() => void tick(), wait);
  }

  const outcomeOf = (st: BackupStatus): LastOutcome => (st.phase === 'failed' ? 'failed' : st.phase === 'held' ? 'held' : st.lastAttemptAt === null ? null : 'ok');

  /** Sets the next timer from the status record as it is now. */
  async function reschedule(): Promise<void> {
    const handles = await handlesOf();
    const st = await handles.getStatus();
    // Nothing is scheduled while there is no folder, while a run is on, or while the folder waits for a click.
    if (st.phase === 'off' || st.phase === 'running' || st.phase === 'waiting') return setWake(null);
    const d = decide({
      now: Date.now(),
      lastSuccessAt: st.lastBackupAt,
      lastAttemptAt: st.lastAttemptAt,
      lastOutcome: outcomeOf(st),
      notesDirtySince: dirtySince,
      notesChangedAt: changedAt,
    });
    setWake(d.run ? Date.now() + MIN_WAIT_MS : d.wakeAt);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const handles = await handlesOf();
      const cur = await currentTarget(handles);
      if (cur === null) return await drainRetiredWhileOff();
      const st = await handles.getStatus();
      if (st.phase === 'running') return;
      if (st.phase === 'waiting') {
        // The owner may have allowed the folder somewhere else; only a granted folder is run.
        if ((await cur.target.queryPermission()) === 'granted') await runNow({});
        return await reschedule();
      }
      const decision = decide({
        now: Date.now(),
        lastSuccessAt: st.lastBackupAt,
        lastAttemptAt: st.lastAttemptAt,
        lastOutcome: outcomeOf(st),
        notesDirtySince: dirtySince,
        notesChangedAt: changedAt,
      });
      if (decision.run) await runNow({});
      await reschedule();
    } catch (error) {
      console.error('sickofpdfs: the backup schedule failed', error instanceof Error ? error.name : 'error');
    }
  }

  const unsubscribe = store.onChange((c) => {
    // R82: a reading deleted from the library (Forget, a Trash purge, an Undo of a save) is removed from the backup too. Trash is an
    // upsert (the reading is kept for 30 days) and removes nothing. Each run also asks the store, so a lost event is caught there.
    if (c.table === 'documents' && c.op === 'delete') {
      queueScrub(c.ids).catch((error: unknown) => console.error('sickofpdfs: a backup removal was not queued', error instanceof Error ? error.name : 'error'));
      return;
    }
    if (!NOTE_TABLES.has(c.table)) return;
    const t = Date.now();
    dirtySince ??= t;
    changedAt = t;
    // Look again when the notes have been quiet for a minute.
    if (wakeTimer !== null) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => void tick(), NOTES_QUIET_MS + 1000);
  });

  const interval = setInterval(() => void tick(), TICK_MS);

  // ---- requests from pages ---------------------------------------------------------------------------------------------------------

  async function configure(now: number | undefined): Promise<RunSummary> {
    const handles = await handlesOf();
    const cur = await currentTarget(handles);
    if (cur === null) {
      await setStatus(() => emptyStatus());
      return { ok: false, reason: 'no-folder', message: 'Backup is off.' };
    }
    await setStatus((s) => ({ ...s, phase: s.phase === 'off' || s.phase === 'running' ? 'idle' : s.phase, folderName: cur.target.name, message: null, held: null }));
    return await runNow({ now });
  }

  async function answer(request: RpcRequest): Promise<RunSummary | ScrubSummary> {
    // The caller's clock is honoured in test builds only, so a test can run a backup "on" a given day.
    const now = import.meta.env.MODE === 'test' && 'now' in request ? request.now : undefined;
    switch (request.type) {
      case 'run':
        return await runNow({ force: request.force, now });
      case 'configure':
        return await configure(now);
      case 'scrub':
        return await scrubNow(request.documentId);
      case 'drain':
        return await drainNow();
    }
  }

  rpc.onmessage = (e: MessageEvent) => {
    const request = asRequest(e.data);
    if (request === null) return;
    answer(request)
      .catch((error: unknown): RunSummary | ScrubSummary => {
        const message = failureMessage('other');
        console.error('sickofpdfs: a backup request failed', error instanceof Error ? error.name : 'error');
        return request.type === 'scrub' || request.type === 'drain' ? { status: 'pending', reason: 'failed', message } : { ok: false, reason: 'failed', message };
      })
      .then((result) => {
        const reply: RpcReply = { type: 'reply', id: request.id, result };
        try {
          rpc.postMessage(reply);
        } catch {
          // The controller was stopped.
        }
      })
      .catch(() => {});
  };

  // ---- start ----------------------------------------------------------------------------------------------------------------------

  void (async () => {
    try {
      const handles = await handlesOf();
      const cur = await currentTarget(handles);
      const pending = (await handles.listScrubs()).length;
      if (cur === null) {
        if ((await handles.getStatus()).phase !== 'off') await setStatus(() => emptyStatus());
        else o.announceBadge({ attention: null });
        return await drainRetiredWhileOff();
      }
      // A run that was cut off when the browser closed is not running any more.
      await setStatus((s) => ({ ...s, phase: s.phase === 'running' || s.phase === 'off' ? 'idle' : s.phase, folderName: cur.target.name, progress: null, scrubsPending: pending }));
      if ((await cur.target.queryPermission()) !== 'granted') {
        await setStatus((s) => ({ ...s, phase: 'waiting', message: WAITING_MESSAGE }));
        return;
      }
      await tick();
    } catch (error) {
      console.error('sickofpdfs: the backup did not start', error instanceof Error ? error.name : 'error');
    }
  })();

  return {
    stop() {
      stopped = true;
      unsubscribe();
      clearInterval(interval);
      if (wakeTimer !== null) clearTimeout(wakeTimer);
      rpc.close();
      statusChannel.close();
      store.close();
      void handlesPromise?.then((h) => h.close());
    },
  };
}
