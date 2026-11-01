// Where a backup goes: a folder the owner picked (a `FileSystemDirectoryHandle`), seen through one small interface so the
// writer, the scrub and the zip never care whether it is a real folder or, in a test build, an OPFS folder that stands in.
//
// Permission. Chrome keeps a picked folder's permission per site and may ask again after a restart (Phase 0, W-B1). Only a
// click can ask: `requestPermission` is refused without a user gesture (P0-8c). So the writer only ever calls
// `queryPermission`; when it does not say `granted` it stops, tells the owner, and the owner's click on "Allow" calls
// `requestPermission` (client.ts).
import { openHandleStore, type FolderTarget, type HandleStore, type StoredTarget, type TestFolderTarget } from './handle-store';

export interface BackupTarget {
  readonly kind: StoredTarget['kind'];
  /** The folder's name, for Settings. */
  readonly name: string;
  /** What Chrome says about writing to the folder now. Never prompts. */
  queryPermission(): Promise<PermissionState>;
  /** Asks the owner. Needs a click (a user gesture); throws `SecurityError` without one. */
  requestPermission(): Promise<PermissionState>;
  /** The folder itself. The backup goes in a `sickofpdfs-backup` folder inside it. */
  directory(): Promise<FileSystemDirectoryHandle>;
}

/** lib.dom does not have the permission methods of the File System Access API. */
interface PermissionedHandle extends FileSystemDirectoryHandle {
  queryPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(d: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

function folderTarget(stored: FolderTarget): BackupTarget {
  const handle = stored.handle as PermissionedHandle;
  return {
    kind: 'folder',
    name: stored.name,
    queryPermission: () => handle.queryPermission({ mode: 'readwrite' }),
    requestPermission: () => handle.requestPermission({ mode: 'readwrite' }),
    directory: () => Promise.resolve(handle),
  };
}

/** Test builds only. The permission the stand-in reports is kept in `sop-handles`, so a test can lose it and an "Allow" click can win it back. */
function testTarget(stored: TestFolderTarget, handles: HandleStore): BackupTarget {
  return {
    kind: 'test-opfs',
    name: stored.name,
    async queryPermission() {
      const current = await handles.getTarget();
      return current?.kind === 'test-opfs' ? current.permission : 'denied';
    },
    async requestPermission() {
      const current = await handles.getTarget();
      if (current?.kind !== 'test-opfs') return 'denied';
      await handles.setTarget({ ...current, permission: 'granted' });
      return 'granted';
    },
    async directory() {
      return (await navigator.storage.getDirectory()).getDirectoryHandle(stored.folder, { create: true });
    },
  };
}

/** The target for a stored one, or null when this build cannot use it (a test folder in a production build). */
export function targetFrom(stored: StoredTarget, handles: HandleStore): BackupTarget | null {
  if (stored.kind === 'folder') return folderTarget(stored);
  return import.meta.env.MODE === 'test' ? testTarget(stored, handles) : null;
}

/** The chosen folder as a target, or null when none is chosen. */
export async function currentTarget(handles?: HandleStore): Promise<{ target: BackupTarget; stored: StoredTarget } | null> {
  const store = handles ?? (await openHandleStore());
  const stored = await store.getTarget();
  if (stored === null) return null;
  const target = targetFrom(stored, store);
  return target === null ? null : { target, stored };
}

/** What the folder picker is, as far as this file needs it. */
type DirectoryPicker = (options: { id: string; mode: 'readwrite'; startIn: 'documents' }) => Promise<FileSystemDirectoryHandle>;

/** True where the browser can show the folder picker. */
export const canPickFolder = (): boolean => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/**
 * Shows Chrome's folder picker (needs a click) and returns the folder as a stored target. Null when the owner cancels.
 * The picker is asked for read and write, so a picked folder is `granted` at once.
 */
export async function pickFolder(): Promise<FolderTarget | null> {
  const show = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (show === undefined) throw new DOMException('This browser cannot pick a folder.', 'NotSupportedError');
  try {
    const handle = await show.call(globalThis, { id: 'sop-backup', mode: 'readwrite', startIn: 'documents' });
    return { kind: 'folder', handle, name: handle.name, pickedAt: Date.now() };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null; // the owner closed the picker
    throw error;
  }
}
