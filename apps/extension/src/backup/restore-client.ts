// "Restore from backup", as the Settings page sees it (S17). The page shows the folder picker (it needs the owner's click), then hands
// the folder to a restore worker of its own (restore-worker.ts), which reads, checks and parses the backup off the page's main thread
// and, once the owner says Restore, merges it into the library and copies the PDFs. The page only shows what the worker says.
//
// The last restore's counts are kept in `chrome.storage.local` (`restore.last`): Settings shows them, and the Notes page says how many
// readings removed here were left out (R88) until the owner says OK. They are counts and a time, nothing else. This file never reaches
// the secrets store.
import { openStorePort } from '../store/transport';
import type { RestoreOutcome, RestorePreview, RestoreProgress } from './restore';
import { type FromRestoreWorker, isMessage, type ToRestoreWorker } from './restore-protocol';

/** lib.dom does not have the folder picker. */
type DirectoryPicker = (options: { id: string; mode: 'read'; startIn: 'documents' }) => Promise<FileSystemDirectoryHandle>;

export type PickOutcome = { kind: 'picked'; folder: FileSystemDirectoryHandle } | { kind: 'cancelled' } | { kind: 'unsupported' };

/**
 * Shows Chrome's folder picker, for reading only. Call it straight from a click. It opens where the backup folder was last chosen (the
 * same picker id as Settings → Backup), so the owner usually only has to press Select.
 */
export async function pickBackupFolder(): Promise<PickOutcome> {
  const show = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (show === undefined) return { kind: 'unsupported' };
  try {
    return { kind: 'picked', folder: await show.call(globalThis, { id: 'sop-backup', mode: 'read', startIn: 'documents' }) };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return { kind: 'cancelled' };
    throw error;
  }
}

export type ApplyAnswer = { ok: true; outcome: RestoreOutcome } | { ok: false; message: string };

export interface RestoreSession {
  /** What the backup holds, or why it cannot be restored. */
  readonly preview: Promise<RestorePreview>;
  /** Restores it. Resolves when the readings, notes and PDFs are in; page text is read afterwards, in the background. */
  apply(onProgress: (p: RestoreProgress) => void): Promise<ApplyAnswer>;
  /** Stops the worker (Cancel, or done). */
  close(): void;
}

const LOST_WORKER = 'The restore stopped before it finished. Nothing you had was deleted. Try again.';

/** Starts a restore worker on `folder` and asks it what the backup holds. */
export function openRestore(folder: FileSystemDirectoryHandle): RestoreSession {
  const worker = new Worker(new URL('./restore-worker.ts', import.meta.url), { type: 'module', name: 'sop-restore' });
  const send = (m: ToRestoreWorker, transfer: Transferable[] = []): void => worker.postMessage(m, transfer);
  let onPreview: ((p: RestorePreview) => void) | null = null;
  let onApply: ((a: ApplyAnswer) => void) | null = null;
  let onProgress: ((p: RestoreProgress) => void) | null = null;
  let closed = false;

  const preview = new Promise<RestorePreview>((resolve) => {
    onPreview = resolve;
  });
  const lost = (): void => {
    onPreview?.({ ok: false, reason: 'unreadable', message: LOST_WORKER });
    onApply?.({ ok: false, message: LOST_WORKER });
    onPreview = null;
    onApply = null;
  };

  worker.onerror = () => lost();
  worker.onmessage = (e: MessageEvent) => {
    const m: unknown = e.data;
    if (isMessage<FromRestoreWorker>(m, 'restore:port-request')) {
      openStorePort().then(
        (port) => (closed ? port.close() : send({ type: 'restore:port' }, [port])),
        () => {
          // The service worker did not hand out a port: the worker's store client waits, then says the library can't be reached.
        },
      );
    } else if (isMessage<Extract<FromRestoreWorker, { type: 'restore:preview' }>>(m, 'restore:preview')) {
      onPreview?.(m.preview);
      onPreview = null;
    } else if (isMessage<Extract<FromRestoreWorker, { type: 'restore:progress' }>>(m, 'restore:progress')) {
      onProgress?.(m.progress);
    } else if (isMessage<Extract<FromRestoreWorker, { type: 'restore:done' }>>(m, 'restore:done')) {
      onApply?.({ ok: true, outcome: m.outcome });
      onApply = null;
    } else if (isMessage<Extract<FromRestoreWorker, { type: 'restore:failed' }>>(m, 'restore:failed')) {
      onApply?.({ ok: false, message: m.message });
      onApply = null;
    }
  };
  send({ type: 'restore:open', folder });

  return {
    preview,
    apply(progress) {
      onProgress = progress;
      const answer = new Promise<ApplyAnswer>((resolve) => {
        onApply = resolve;
      });
      send({ type: 'restore:apply' });
      return answer;
    },
    close() {
      if (closed) return;
      closed = true;
      worker.terminate();
      lost();
    },
  };
}

// ---- the last restore -----------------------------------------------------------------------------------------------------

export const LAST_RESTORE_KEY = 'restore.last';

export type RestoreRecord = Omit<RestoreOutcome, 'reindex'> & {
  /** The owner said OK to the Notes page's line about readings left out. */
  leftOutSeen: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const n = (v: unknown): number => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);

function asRestoreRecord(v: unknown): RestoreRecord | null {
  if (!isRecord(v) || !isRecord(v.added) || !isRecord(v.pdfs) || typeof v.at !== 'number') return null;
  return {
    at: v.at,
    added: { readings: n(v.added.readings), notes: n(v.added.notes), marks: n(v.added.marks), comments: n(v.added.comments) },
    updated: n(v.updated),
    forgotten: n(v.forgotten),
    skipped: n(v.skipped),
    pdfs: { copied: n(v.pdfs.copied), missing: n(v.pdfs.missing), damaged: n(v.pdfs.damaged), failed: n(v.pdfs.failed) },
    leftOutSeen: v.leftOutSeen === true,
  };
}

/** The last restore made on this computer, or null. */
export async function lastRestore(): Promise<RestoreRecord | null> {
  try {
    return asRestoreRecord((await chrome.storage.local.get(LAST_RESTORE_KEY))[LAST_RESTORE_KEY]);
  } catch {
    return null;
  }
}

/** Keeps a finished restore's counts (no ids, no titles). */
export async function keepLastRestore(o: RestoreOutcome): Promise<RestoreRecord> {
  // Counts only: the readings' ids stay with the indexer.
  const record: RestoreRecord = { at: o.at, added: o.added, updated: o.updated, forgotten: o.forgotten, skipped: o.skipped, pdfs: o.pdfs, leftOutSeen: o.forgotten === 0 };
  try {
    await chrome.storage.local.set({ [LAST_RESTORE_KEY]: record });
  } catch {
    // Not kept: Settings still shows it while the page is open.
  }
  return record;
}

/** "OK" on the Notes page's line about readings left out. */
export async function leftOutSeen(): Promise<void> {
  const cur = await lastRestore();
  if (cur === null || cur.leftOutSeen) return;
  await chrome.storage.local.set({ [LAST_RESTORE_KEY]: { ...cur, leftOutSeen: true } }).catch(() => {});
}

/** Calls `cb` with the last restore now and whenever it changes (another tab restored, or said OK). Returns the function that stops it. */
export function onLastRestore(cb: (r: RestoreRecord | null) => void): () => void {
  let stopped = false;
  void lastRestore().then((r) => {
    if (!stopped) cb(r);
  });
  const listen = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area === 'local' && LAST_RESTORE_KEY in changes && !stopped) cb(asRestoreRecord(changes[LAST_RESTORE_KEY]?.newValue));
  };
  try {
    chrome.storage.onChanged.addListener(listen);
  } catch {
    // no storage events here
  }
  return () => {
    stopped = true;
    try {
      chrome.storage.onChanged.removeListener(listen);
    } catch {
      // nothing to stop
    }
  };
}
