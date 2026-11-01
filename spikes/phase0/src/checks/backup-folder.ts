// P0-8 backup-folder check: spike.html?check=backup-folder
// No run(): the module installs page functions, which tests/p0-8-backup-folder.spec.ts calls with page.evaluate,
// and three buttons that call the same functions for the manual Windows run (checklist W-B1 to W-B3):
// - spikeBackupPick(): showDirectoryPicker({ mode: 'readwrite' }), writes backup-probe.txt into the folder and
//   stores the FileSystemDirectoryHandle in IndexedDB `spike-backup` (key 'backup-folder'). Needs a user gesture.
// - spikeBackupQuery(): the stored handle's queryPermission({ mode: 'readwrite' }): 'granted', 'prompt', 'denied'
//   or 'no-handle'.
// - spikeBackupRequestNoGesture(): waits for the page's transient user activation to lapse (Playwright's
//   page.evaluate sets one, and it lasts about 5 s), then calls requestPermission. Resolves to the error
//   ("SecurityError: …") or to the state it returned. Its details are left in window.__backupRequest.
// The headless test run cannot drive the directory picker (see the spec), so the page also takes a folder dropped
// on it. A dropped folder is a real handle from the same File System Access machinery: read is granted and
// readwrite is 'prompt', and it is stored under the key 'dropped-folder'. The tests use it where a handle from the
// picker is not available, and say so in their record.
//
// The functions return objects and strings, never throw: a test records the exact error text.

type Mode = 'read' | 'readwrite';
type Source = 'picked' | 'dropped';

/** lib.dom lacks the permission methods of the File System Access API. */
interface Handle extends FileSystemDirectoryHandle {
  queryPermission(d: { mode: Mode }): Promise<PermissionState>;
  requestPermission(d: { mode: Mode }): Promise<PermissionState>;
}

export interface PickResult {
  ok: boolean;
  /** navigator.userActivation.isActive when the picker was asked for. */
  activeAtCall: boolean;
  name?: string;
  /** queryPermission({ mode: 'readwrite' }) right after the pick. */
  permission?: PermissionState;
  wrote?: boolean;
  stored?: boolean;
  /** "Name: message" of the first thing that failed. */
  error?: string;
}
export interface InspectResult {
  present: boolean;
  name?: string;
  read?: PermissionState;
  readwrite?: PermissionState;
}
export interface RequestResult {
  /** queryPermission({ mode: 'readwrite' }) before the request. */
  before: PermissionState | 'no-handle';
  activeAtCall: boolean;
  /** The state requestPermission resolved to, "Name: message" if it threw, or 'pending' if it did not settle within the cap (the tests' path). */
  result: string;
  after?: PermissionState;
  ms: number;
}
export interface DropResult {
  name: string;
  read: PermissionState;
  readwrite: PermissionState;
  stored: boolean;
}

declare global {
  interface Window {
    spikeBackupPick(): Promise<PickResult>;
    spikeBackupQuery(): Promise<string>;
    spikeBackupInspect(source?: Source): Promise<InspectResult>;
    spikeBackupRequest(source?: Source): Promise<RequestResult>;
    spikeBackupRequestNoGesture(source?: Source): Promise<string>;
    /** Details of the last spikeBackupRequestNoGesture call. */
    __backupRequest?: RequestResult;
    /** Set when a folder was dropped on the page: its handle's states and whether it was stored. */
    __backupDropped?: DropResult | { error: string };
  }
}

const DB_NAME = 'spike-backup';
const STORE = 'handles';
const KEYS: Record<Source, string> = { picked: 'backup-folder', dropped: 'dropped-folder' };
const PROBE_FILE = 'backup-probe.txt';
const PROBE_TEXT = 'sickofpdfs backup probe';
const REQUEST_TIMEOUT_MS = 3000;
/** Chrome's transient user activation lasts about 5 s. */
const ACTIVATION_LAPSE_MS = 8000;

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, key);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function getHandle(source: Source): Promise<Handle | undefined> {
  const db = await openDb();
  try {
    return await new Promise<Handle | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEYS[source]);
      req.onsuccess = () => resolve(req.result as Handle | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

async function pick(): Promise<PickResult> {
  const out: PickResult = { ok: false, activeAtCall: navigator.userActivation.isActive };
  let handle: Handle;
  try {
    handle = await (window as unknown as { showDirectoryPicker(o: object): Promise<Handle> }).showDirectoryPicker({
      id: 'sop-backup',
      mode: 'readwrite',
    });
  } catch (e) {
    return { ...out, error: describe(e) };
  }
  out.name = handle.name;
  try {
    out.permission = await handle.queryPermission({ mode: 'readwrite' });
    const file = await handle.getFileHandle(PROBE_FILE, { create: true });
    const writable = await file.createWritable();
    await writable.write(PROBE_TEXT);
    await writable.close();
    out.wrote = true;
    await putHandle(KEYS.picked, handle);
    out.stored = true;
    out.ok = true;
  } catch (e) {
    out.error = describe(e);
  }
  return out;
}

async function inspect(source: Source = 'picked'): Promise<InspectResult> {
  const handle = await getHandle(source);
  if (!handle) return { present: false };
  return {
    present: true,
    name: handle.name,
    read: await handle.queryPermission({ mode: 'read' }),
    readwrite: await handle.queryPermission({ mode: 'readwrite' }),
  };
}

async function query(): Promise<string> {
  const r = await inspect('picked');
  return r.present ? r.readwrite! : 'no-handle';
}

/**
 * requestPermission({ mode: 'readwrite' }) on the stored handle, as the page is now (with or without activation).
 * `capMs` (default 3 s) is for the headless tests, where the permission prompt is never answered: the call then
 * reports 'pending'. The "Request permission" button passes null and waits for the person's answer to the prompt.
 */
async function request(source: Source = 'picked', capMs: number | null = REQUEST_TIMEOUT_MS): Promise<RequestResult> {
  const started = performance.now();
  const activeAtCall = navigator.userActivation.isActive;
  const handle = await getHandle(source);
  if (!handle) return { before: 'no-handle', activeAtCall, result: 'no-handle', ms: 0 };
  const before = await handle.queryPermission({ mode: 'readwrite' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    if (capMs !== null) timer = setTimeout(() => resolve('pending'), capMs);
  });
  let result: string;
  try {
    result = await Promise.race([handle.requestPermission({ mode: 'readwrite' }), pending]);
  } catch (e) {
    result = describe(e);
  } finally {
    clearTimeout(timer);
  }
  const after = await handle.queryPermission({ mode: 'readwrite' });
  return { before, activeAtCall, result, after, ms: Math.round(performance.now() - started) };
}

async function requestNoGesture(source: Source = 'picked'): Promise<string> {
  const lapseStarted = performance.now();
  while (navigator.userActivation.isActive) {
    if (performance.now() - lapseStarted > ACTIVATION_LAPSE_MS) {
      window.__backupRequest = { before: 'no-handle', activeAtCall: true, result: 'activation-did-not-lapse', ms: 0 };
      return window.__backupRequest.result;
    }
    await sleep(100);
  }
  const r = await request(source);
  window.__backupRequest = r;
  return r.result;
}

/** A folder dropped on the page: keep its handle in memory (for the tests) and in IndexedDB. */
function onDrop(event: DragEvent): void {
  event.preventDefault();
  // getAsFileSystemHandle must be called while the event is dispatched; the promise settles later.
  const items = [...(event.dataTransfer?.items ?? [])] as (DataTransferItem & { getAsFileSystemHandle(): Promise<Handle | null> })[];
  const first = items[0]?.getAsFileSystemHandle();
  void (async () => {
    try {
      const handle = await first;
      if (!handle || handle.kind !== 'directory') throw new Error('the drop carried no directory handle');
      await putHandle(KEYS.dropped, handle);
      window.__backupDropped = {
        name: handle.name,
        read: await handle.queryPermission({ mode: 'read' }),
        readwrite: await handle.queryPermission({ mode: 'readwrite' }),
        stored: true,
      };
    } catch (e) {
      window.__backupDropped = { error: describe(e) };
    }
  })();
}

function mountUi(): void {
  const app = document.getElementById('app');
  if (!app) return;
  const out = document.createElement('pre');
  out.id = 'backup-out';
  const show = (value: unknown) => {
    out.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  };
  const button = (label: string, action: () => Promise<unknown>) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    // The action starts inside the click, so it has the user's activation; a failure is shown, not thrown.
    b.addEventListener('click', () => void action().then(show, (e: unknown) => show(describe(e))));
    return b;
  };
  const note = document.createElement('p');
  note.textContent =
    'Pick backup folder: choose a folder; backup-probe.txt is written into it and the handle is stored. ' +
    'Check permission: queryPermission on the stored handle, for after a restart. ' +
    'Request permission: requestPermission, which can show the prompt. ' +
    'A folder dropped on this page is stored too (the tests use that).';
  app.append(
    button('Pick backup folder', pick),
    button('Check permission', () => inspect('picked')),
    button('Request permission', () => request('picked', null)), // no cap: shows the answer given in the prompt
    note,
    out,
  );
}

window.spikeBackupPick = pick;
window.spikeBackupQuery = query;
window.spikeBackupInspect = inspect;
window.spikeBackupRequest = request;
window.spikeBackupRequestNoGesture = requestNoGesture;
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', onDrop);
mountUi();
