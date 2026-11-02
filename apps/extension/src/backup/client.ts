// The backup, as a page sees it (the library's Settings, the library's top bar, the viewer's Forget dialog).
//
// A page reads the status record (`sop-handles`) itself and asks the writer in the offscreen document to act (rpc.ts). The two
// things that need the owner's click happen here, in the page: showing the folder picker, and asking Chrome to allow the folder again.
// This file never reaches the secrets store, and nothing in it writes into the backup folder.
import { dayOf } from '@sop/core';
import { openBlobStore } from '../store/blob-store';
import { connectStore } from '../store/client';
import { VIEWER_PATH } from '../shared/viewer-url';
import { announceBackupBadge } from './badge';
import { openHandleStore, type HandleStore, type StoredTarget } from './handle-store';
import { ask, newRequestId, type RunSummary, type RpcRequest, RPC_CHANNEL, type ScrubSummary, STATUS_CHANNEL } from './rpc';
export { FORGOTTEN_BACKUP_PENDING, FORGOTTEN_EVERYWHERE, FORGOTTEN_LIBRARY_ONLY, forgetFromBackups, type ForgetBackupResult } from './forget';
import { readLibrary } from './read-library';
import { emptyStatus, type BackupStatus } from './status';
import { type BackupTarget, canPickFolder, currentTarget, pickFolder, retiredRecord, sameFolder, targetFrom } from './target';
import { libraryZip, zipFileName } from './zip';

export type ChooseOutcome = 'chosen' | 'cancelled' | 'unsupported';
export type AllowOutcome = 'allowed' | 'refused' | 'no-folder';
export type ExportOutcome = 'saved' | 'cancelled' | 'unsupported';
/**
 * `done`: nothing is waiting any more. `waiting`: a folder could not be reached or allowed; it is tried again at each backup.
 * `dropped`: an old folder no longer exists, so its waiting removal was given up (R88; Settings says so).
 */
export type RemovalsOutcome = 'done' | 'waiting' | 'dropped';

export interface BackupClient {
  /** The status record, with the folders that still have removals waiting for them (`retired`). */
  status(): Promise<BackupStatus>;
  /** Calls `cb` now and whenever the status changes. Returns the function that stops it. */
  onStatus(cb: (status: BackupStatus) => void): () => void;
  /**
   * Shows Chrome's folder picker. Call it straight from a click. The same folder picked again keeps what it holds and its waiting
   * removals. Another folder starts its first backup at once; the old folder's waiting removals are finished first, or kept with it.
   */
  chooseFolder(): Promise<ChooseOutcome>;
  /** Asks Chrome to allow the folder again. Call it straight from a click. A granted folder backs up at once. */
  allow(): Promise<AllowOutcome>;
  /** Starts a backup now (not waited for: watch the status). `force` is "Back up anyway". */
  backUpNow(o?: { force?: boolean }): void;
  /**
   * Stops backing up. Call it straight from a click: the removals waiting for the folder are finished first (Chrome is asked for the
   * folder if it needs to be), or kept with it and tried again later. Files already in the folder stay there.
   */
  turnOff(): Promise<void>;
  /** "Try now": finishes the removals waiting for any folder, asking Chrome for each one. Call it straight from a click. */
  finishRemovals(): Promise<RemovalsOutcome>;
  /** "OK" on the line about removals that were given up: clears it. */
  clearDropped(): Promise<void>;
  /** "Export library": saves the same as a zip, to a file the owner picks. Call it straight from a click. */
  exportZip(): Promise<ExportOutcome>;
}

/** How long a page waits for the writer to finish waiting removals before it goes on (they are kept and tried again either way). */
const DRAIN_WAIT_MS = 20_000;

/** Posts a request and does not wait: the answer comes as a status change. */
function post(request: RpcRequest): void {
  const channel = new BroadcastChannel(RPC_CHANNEL);
  channel.postMessage(request);
  channel.close();
}

let handles: Promise<HandleStore> | null = null;
const handlesOf = (): Promise<HandleStore> => (handles ??= openHandleStore());

/** lib.dom does not have the save-file picker. */
type SavePicker = (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

/** Streams the library as a zip into `sink`. */
export async function exportZipTo(sink: WritableStream<Uint8Array>): Promise<void> {
  const [store, blobs] = await Promise.all([connectStore(), openBlobStore()]);
  try {
    const [dump, schemaVersion] = await Promise.all([readLibrary(store), store.schemaVersion()]);
    const zip = libraryZip({
      dump,
      blobs,
      schemaVersion,
      appVersion: chrome.runtime.getManifest().version,
      viewerBase: chrome.runtime.getURL(VIEWER_PATH),
      now: () => Date.now(),
    });
    await zip.pipeTo(sink);
  } finally {
    store.close();
  }
}

/** The status, with the folders that still have removals waiting for them. */
async function readStatus(h: HandleStore): Promise<BackupStatus> {
  const [status, retired] = await Promise.all([h.getStatus(), h.listRetired()]);
  return { ...status, retired: retired.map((r) => ({ id: r.id, folderName: r.target.name, count: r.scrubs.length })) };
}

/** Asks Chrome for a folder when it is not granted. Needs the click that is still fresh. Never throws: false when it is not granted. */
async function askForFolder(target: BackupTarget | null): Promise<boolean> {
  if (target === null) return false;
  try {
    if ((await target.queryPermission()) === 'granted') return true;
    return (await target.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Before the chosen folder changes ("Change folder", "Turn off"): the removals waiting for it are done now, asking Chrome for the folder
 * inside the click when it needs to be. If that cannot finish, `changeTarget` keeps the old folder and its list, and each run tries again.
 */
async function finishRemovalsFor(h: HandleStore): Promise<void> {
  const cur = await currentTarget(h);
  if (cur === null || (await h.listScrubs()).length === 0) return;
  await askForFolder(cur.target);
  await ask<ScrubSummary>({ type: 'drain', id: newRequestId() }, DRAIN_WAIT_MS);
}

/**
 * Makes `next` the backup folder, as a pick does (the page then asks the writer to `configure`). Picking the folder that is chosen now
 * again keeps what it holds, what was written there and its waiting removals, so it is never taken for another library's backup.
 * Exported for the test hooks, which pick an OPFS folder in its place.
 */
export async function adoptFolder(next: StoredTarget): Promise<void> {
  const h = await handlesOf();
  const cur = await h.getTarget();
  const same = cur !== null && (await sameFolder(cur, next));
  if (!same) await finishRemovalsFor(h);
  await h.changeTarget(next, { same, at: Date.now() });
  await h.updateStatus((s) =>
    same ? { ...s, phase: 'idle', folderName: next.name, held: null, message: null, progress: null } : { ...emptyStatus(), phase: 'idle', folderName: next.name },
  );
  announceBackupBadge({ attention: null });
}

export const backupClient: BackupClient = {
  async status() {
    return readStatus(await handlesOf());
  },

  onStatus(cb) {
    let stopped = false;
    const channel = new BroadcastChannel(STATUS_CHANNEL);
    const read = (): void => {
      void handlesOf()
        .then((h) => readStatus(h))
        .then((s) => {
          if (!stopped) cb(s);
        })
        .catch(() => {});
    };
    channel.onmessage = read;
    read();
    return () => {
      stopped = true;
      channel.close();
    };
  },

  async chooseFolder() {
    if (!canPickFolder()) return 'unsupported';
    const picked = await pickFolder(); // first: the picker needs the click that is still fresh
    if (picked === null) return 'cancelled';
    await adoptFolder(picked);
    post({ type: 'configure', id: newRequestId() });
    return 'chosen';
  },

  async allow() {
    const cur = await currentTarget(await handlesOf());
    if (cur === null) return 'no-folder';
    // This is the only call that may prompt, and it must come from a click.
    const state = await cur.target.requestPermission();
    if (state !== 'granted') return 'refused';
    const h = await handlesOf();
    await h.updateStatus((s) => (s.phase === 'waiting' ? { ...s, phase: 'idle', message: null } : s));
    announceBackupBadge({ attention: null });
    post({ type: 'run', id: newRequestId() });
    return 'allowed';
  },

  backUpNow(o = {}) {
    post({ type: 'run', id: newRequestId(), ...(o.force === true ? { force: true } : {}) });
  },

  async turnOff() {
    const h = await handlesOf();
    await finishRemovalsFor(h);
    await h.changeTarget(null, { same: false, at: Date.now() });
    announceBackupBadge({ attention: null });
    post({ type: 'configure', id: newRequestId() });
  },

  async finishRemovals() {
    const h = await handlesOf();
    for (const r of await h.listRetired()) await askForFolder(targetFrom(r.target, h, retiredRecord(h, r.id)));
    const cur = await currentTarget(h);
    if (cur !== null && (await h.listScrubs()).length > 0) await askForFolder(cur.target);
    const reply = await ask<ScrubSummary>({ type: 'drain', id: newRequestId() }, DRAIN_WAIT_MS);
    if (reply?.status === 'removed') return 'done';
    return reply?.status === 'pending' && reply.reason === 'gone' ? 'dropped' : 'waiting';
  },

  async clearDropped() {
    await (await handlesOf()).updateStatus((s) => ({ ...s, dropped: [] }));
    const channel = new BroadcastChannel(STATUS_CHANNEL); // every page reads the status again
    channel.postMessage({ type: 'status' });
    channel.close();
  },

  async exportZip() {
    const show = (globalThis as { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
    if (show === undefined) return 'unsupported';
    let file: FileSystemFileHandle;
    try {
      file = await show.call(globalThis, { suggestedName: zipFileName(dayOf(Date.now())), types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }] });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
      throw error;
    }
    await exportZipTo(await file.createWritable());
    return 'saved';
  },
};

export type { RunSummary };

// Test builds only: the stand-in folder and the checks the user tests make (test-hooks.ts). A production build drops this line.
if (import.meta.env.MODE === 'test') {
  void import('./test-hooks').then((m) => m.installBackupTestHooks(backupClient));
}
