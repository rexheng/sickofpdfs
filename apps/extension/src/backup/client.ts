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
import { openHandleStore, type HandleStore } from './handle-store';
import { newRequestId, type RunSummary, type RpcRequest, RPC_CHANNEL, STATUS_CHANNEL } from './rpc';
export { FORGOTTEN_BACKUP_PENDING, FORGOTTEN_EVERYWHERE, FORGOTTEN_LIBRARY_ONLY, forgetFromBackups, type ForgetBackupResult } from './forget';
import { readLibrary } from './read-library';
import { emptyStatus, type BackupStatus } from './status';
import { canPickFolder, currentTarget, pickFolder } from './target';
import { libraryZip, zipFileName } from './zip';

export type ChooseOutcome = 'chosen' | 'cancelled' | 'unsupported';
export type AllowOutcome = 'allowed' | 'refused' | 'no-folder';
export type ExportOutcome = 'saved' | 'cancelled' | 'unsupported';

export interface BackupClient {
  /** The status record. */
  status(): Promise<BackupStatus>;
  /** Calls `cb` now and whenever the status changes. Returns the function that stops it. */
  onStatus(cb: (status: BackupStatus) => void): () => void;
  /** Shows Chrome's folder picker. Call it straight from a click. A new folder starts its first backup at once. */
  chooseFolder(): Promise<ChooseOutcome>;
  /** Asks Chrome to allow the folder again. Call it straight from a click. A granted folder backs up at once. */
  allow(): Promise<AllowOutcome>;
  /** Starts a backup now (not waited for: watch the status). `force` is "Back up anyway". */
  backUpNow(o?: { force?: boolean }): void;
  /** Stops backing up. Files already in the folder stay there. */
  turnOff(): Promise<void>;
  /** "Export library": saves the same as a zip, to a file the owner picks. Call it straight from a click. */
  exportZip(): Promise<ExportOutcome>;
}

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

export const backupClient: BackupClient = {
  async status() {
    return (await handlesOf()).getStatus();
  },

  onStatus(cb) {
    let stopped = false;
    const channel = new BroadcastChannel(STATUS_CHANNEL);
    const read = (): void => {
      void handlesOf()
        .then((h) => h.getStatus())
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
    const h = await handlesOf();
    await h.clearTarget(); // a new folder starts from nothing: what was written to the old one is not in it
    await h.setTarget(picked);
    await h.updateStatus(() => ({ ...emptyStatus(), phase: 'idle', folderName: picked.name }));
    announceBackupBadge(false);
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
    announceBackupBadge(false);
    post({ type: 'run', id: newRequestId() });
    return 'allowed';
  },

  backUpNow(o = {}) {
    post({ type: 'run', id: newRequestId(), ...(o.force === true ? { force: true } : {}) });
  },

  async turnOff() {
    await (await handlesOf()).clearTarget();
    announceBackupBadge(false);
    post({ type: 'configure', id: newRequestId() });
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
