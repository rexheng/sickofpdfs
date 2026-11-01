// Test builds only. `client.ts` imports this module when `import.meta.env.MODE === 'test'`, so a production build never contains it,
// and installs `globalThis.__sopBackup` on every extension page that uses the backup client (the library, and the viewer once its
// Forget dialog does). The real folder picker cannot be driven headless (Phase 0, P0-8), so a user test uses an OPFS folder in its
// place: it is a `FileSystemDirectoryHandle` too, and the writer cannot tell the two apart.
//
//   useFolder(name)      Makes the OPFS folder `name` the backup folder, as picking a folder does, and waits for the first backup (its result).
//                        { start: false } only chooses the folder.
//   useHandle(name)      Like useFolder, but stores the OPFS folder's own handle as the picked folder (the code path a real pick takes).
//   setPermission(p)     Makes the folder (a stand-in, or one picked through a faked picker) report 'prompt' (what Chrome says after a restart: the badge shows) or 'granted'.
//   allow()              What a click on "Allow" does. The stand-in folder is granted at once, as a granted prompt would.
//   run({ now, force })  Runs a backup now and waits for it. `now` is the time the run pretends it is (snapshots are named by its day).
//   status()             The status record: phase, last backup, size, counts, message.
//   whenIdle()           Waits until no backup is running.
//   forget(documentId)   What the Forget dialog calls after the library has forgotten the reading; waits for the answer.
//   files(name)          Every file in the folder: path (from the folder) to size in bytes.
//   readFile(path, name) A file's text, or null.
//   writeFile / removeFile   Change the folder behind the writer's back (a file from another computer, a snapshot to damage).
//   exportZip(file)      "Export library" into an OPFS file `file`; returns its size.
//   removeFolder(name)   Deletes the OPFS folder itself (what renaming the real folder in Explorer does to a handle that was picked): the writer must
//                        say "can't be found", never "nothing to remove".
//   turnOff()            Stops backing up.
//   clear(name)          Empties the folder `name`.
import type { DocumentId } from '@sop/core';
import { pathSegments } from '@sop/core';
import type { AllowOutcome, BackupClient, ForgetBackupResult } from './client';
import { exportZipTo, forgetFromBackups } from './client';
import { openDir, readText, removeFile as removeFileIn, writeFile as writeFileIn } from './fs';
import { openHandleStore } from './handle-store';
import { ask, newRequestId, type RunSummary } from './rpc';
import type { BackupStatus } from './status';

export interface BackupTestHooks {
  useFolder(name: string, o?: { permission?: 'granted' | 'prompt'; start?: boolean }): Promise<RunSummary | null>;
  useHandle(name: string): Promise<RunSummary | null>;
  setPermission(permission: 'granted' | 'prompt'): Promise<void>;
  allow(): Promise<AllowOutcome>;
  run(o?: { now?: number; force?: boolean }): Promise<RunSummary | null>;
  status(): Promise<BackupStatus>;
  whenIdle(timeoutMs?: number): Promise<BackupStatus>;
  forget(documentId: DocumentId): Promise<ForgetBackupResult>;
  files(name: string): Promise<Record<string, number>>;
  readFile(path: string, name: string): Promise<string | null>;
  writeFile(path: string, text: string, name: string): Promise<void>;
  removeFile(path: string, name: string): Promise<void>;
  exportZip(file: string): Promise<number>;
  removeFolder(name: string): Promise<void>;
  turnOff(): Promise<void>;
  clear(name: string): Promise<void>;
}

declare global {
  var __sopBackup: BackupTestHooks | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function opfsFolder(name: string, create = false): Promise<FileSystemDirectoryHandle | null> {
  const root = await navigator.storage.getDirectory();
  return openDir(root, name, create);
}

async function walk(dir: FileSystemDirectoryHandle, prefix: string, out: Record<string, number>): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'directory') await walk(handle, `${prefix}${name}/`, out);
    else out[`${prefix}${name}`] = (await handle.getFile()).size;
  }
}

export function installBackupTestHooks(client: BackupClient): void {
  const hooks: BackupTestHooks = {
    async useFolder(name, o = {}) {
      await opfsFolder(name, true);
      const h = await openHandleStore();
      try {
        await h.clearTarget();
        await h.setTarget({ kind: 'test-opfs', folder: name, permission: o.permission ?? 'granted', name, pickedAt: Date.now() });
        await h.updateStatus((s) => ({ ...s, phase: 'idle', folderName: name, lastBackupAt: null, lastAttemptAt: null, message: null }));
      } finally {
        h.close();
      }
      if (o.start === false) return null;
      return await ask<RunSummary>({ type: 'configure', id: newRequestId() }, 120_000);
    },

    async useHandle(name) {
      const dir = await opfsFolder(name, true);
      if (dir === null) throw new Error('the folder could not be made');
      const h = await openHandleStore();
      try {
        await h.clearTarget();
        await h.setTarget({ kind: 'folder', handle: dir, name, pickedAt: Date.now() });
        await h.updateStatus((s) => ({ ...s, phase: 'idle', folderName: name, lastBackupAt: null, lastAttemptAt: null, message: null }));
      } finally {
        h.close();
      }
      return await ask<RunSummary>({ type: 'configure', id: newRequestId() }, 120_000);
    },

    async setPermission(permission) {
      const h = await openHandleStore();
      try {
        const cur = await h.getTarget();
        if (cur === null) throw new Error('no backup folder is chosen');
        // A stand-in folder keeps its answer in `permission`; a folder picked through a faked picker keeps it in `testPermission`.
        await h.setTarget(cur.kind === 'test-opfs' ? { ...cur, permission } : { ...cur, testPermission: permission });
      } finally {
        h.close();
      }
    },

    allow: () => client.allow(),

    async run(o = {}) {
      // A run that is already going answers "busy": wait for it, then run.
      const deadline = Date.now() + 120_000;
      for (;;) {
        const reply = await ask<RunSummary>({ type: 'run', id: newRequestId(), ...(o.force === true ? { force: true } : {}), ...(o.now !== undefined ? { now: o.now } : {}) }, 120_000);
        if (reply === null || reply.ok || reply.reason !== 'busy' || Date.now() > deadline) return reply;
        await sleep(200);
      }
    },

    status: () => client.status(),

    async whenIdle(timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const s = await client.status();
        if (s.phase !== 'running') return s;
        if (Date.now() > deadline) throw new Error('the backup is still running');
        await sleep(100);
      }
    },

    forget: (documentId) => forgetFromBackups(documentId),

    async files(name) {
      const dir = await opfsFolder(name);
      const out: Record<string, number> = {};
      if (dir !== null) await walk(dir, '', out);
      return out;
    },

    async readFile(path, name) {
      const dir = await opfsFolder(name);
      return dir === null ? null : readText(dir, path);
    },

    async writeFile(path, text, name) {
      const dir = await opfsFolder(name, true);
      if (dir !== null) await writeFileIn(dir, path, text);
    },

    async removeFile(path, name) {
      const dir = await opfsFolder(name);
      if (dir !== null) await removeFileIn(dir, path);
    },

    async exportZip(file) {
      const root = await navigator.storage.getDirectory();
      const parts = pathSegments(file);
      const leaf = parts.pop();
      if (leaf === undefined) throw new Error('a file needs a name');
      const dir = (await openDir(root, parts.join('/'), true))!;
      const handle = await dir.getFileHandle(leaf, { create: true });
      await exportZipTo(await handle.createWritable());
      return (await handle.getFile()).size;
    },

    async removeFolder(name) {
      await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
    },

    turnOff: () => client.turnOff(),

    async clear(name) {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(name, { recursive: true }).catch(() => {});
      await root.getDirectoryHandle(name, { create: true });
    },
  };
  globalThis.__sopBackup = hooks;
}
