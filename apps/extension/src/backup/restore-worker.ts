// The restore worker: a module worker the Settings page starts for one "Restore from backup" (restore-client.ts), and closes after it.
// It reads and parses the backup folder here, on a thread of its own, never on the page's main thread that viewer tabs share (backupfix
// N4); it holds the parsed backup until the owner says Restore, then merges it, copies the PDFs and asks for the text to be read again
// (restore.ts). A worker has no `chrome.*`: the page hands it ports to the store.
import { type BlobStore, openBlobStore } from '../store/blob-store';
import { createStoreClient } from '../store/client';
import { requestReindex } from './reindex-protocol';
import { applyBackup, previewBackup, type ReadBackup } from './restore';
import { type FromRestoreWorker, isMessage, type ToRestoreWorker } from './restore-protocol';

/** A big restore is one store transaction; on a loaded computer it may take a while. The client waits this long, then once more. */
const STORE_TIMEOUT_MS = 300_000;

const waiting: ((port: MessagePort) => void)[] = [];
const store = createStoreClient(
  () =>
    new Promise<MessagePort>((resolve) => {
      waiting.push(resolve);
      say({ type: 'restore:port-request' });
    }),
  STORE_TIMEOUT_MS,
);

let read: ReadBackup | null = null;
let busy = false;

function say(m: FromRestoreWorker): void {
  self.postMessage(m);
}

/** The words for a restore that stopped. Nothing about the backup's contents goes in them. */
function stoppedWords(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/^read-only:/.test(text)) return 'Update sickofpdfs first. Your library was saved by a newer version, so nothing was restored.';
  if (/^bad-input:/.test(text)) return 'This backup can’t be restored: its library file is damaged. Nothing was changed.';
  return 'The restore couldn’t reach your library, so nothing was changed. Try again.';
}

async function open(folder: FileSystemDirectoryHandle): Promise<void> {
  try {
    const answer = await previewBackup(folder, store);
    read = answer.read;
    say({ type: 'restore:preview', preview: answer.preview });
  } catch {
    say({ type: 'restore:preview', preview: { ok: false, reason: 'unreadable', message: 'Couldn’t reach your library. Close this and try again.' } });
  }
}

async function apply(): Promise<void> {
  const backup = read;
  if (backup === null || busy) return;
  busy = true;
  let blobs: BlobStore;
  try {
    blobs = await openBlobStore();
  } catch {
    busy = false;
    say({ type: 'restore:failed', message: 'This computer’s file storage can’t be opened, so nothing was restored. Try again.' });
    return;
  }
  try {
    const outcome = await applyBackup(backup, { store, blobs, now: () => Date.now(), onProgress: (progress) => say({ type: 'restore:progress', progress }) });
    read = null; // done with it: the memory goes back
    requestReindex(outcome.reindex);
    say({ type: 'restore:done', outcome });
  } catch (error) {
    say({ type: 'restore:failed', message: stoppedWords(error) });
  } finally {
    busy = false;
  }
}

self.onmessage = (e: MessageEvent) => {
  const data: unknown = e.data;
  const port = e.ports[0];
  if (isMessage<ToRestoreWorker>(data, 'restore:port') && port) waiting.shift()?.(port);
  else if (isMessage<Extract<ToRestoreWorker, { type: 'restore:open' }>>(data, 'restore:open')) void open(data.folder);
  else if (isMessage<ToRestoreWorker>(data, 'restore:apply')) void apply();
};
