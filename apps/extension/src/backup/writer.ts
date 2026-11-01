// The backup writer (contracts §5, Phase 3 S13). It runs in the offscreen document and writes the library into the folder the
// owner chose, inside a `sickofpdfs-backup` folder:
//
//   manifest.json   library.json   snapshots/library-<day>.json (the newest 7)   pdf/<sha[0..2]>/<sha>.pdf   notes/<title>-<sha8>.md
//
// Rules this file keeps:
// - Every file is written through `createWritable()` (fs.ts), so a half-written file never replaces a good one, and the manifest
//   is written last of all the files a run adds. A restore reads the manifest first, so a run that stopped early is never
//   taken for a whole backup.
// - Nothing is removed until the new files are in place. Removing comes last, so a run that stops leaves extra files, never missing ones.
// - PDF copies are made once per fingerprint (skipped when the size in the folder matches). They are streamed in pieces from the
//   library's file storage to the folder; a whole PDF is never held in memory.
// - It never asks for permission (only a click can): when the folder is not `granted` it stops and says so.
// - It never loses the owner's backup. Two guards stop a run that would write into the wrong place or shrink the backup by
//   mistake (`HeldReason`): a folder that holds readings this library never wrote, and a library that has lost most of the readings
//   it had at the last backup. A held run changes nothing in the folder. "Back up anyway" (`force`) overrides both.
// - It removes a reading's files (its PDF copy and its notes file) only when this computer wrote them there (`known`) and the
//   library no longer has the reading. A file it did not write is never removed. Old snapshots are not edited by a run; the
//   Forget flow does that (scrub.ts), because a snapshot is there to hold what was lost.
// - It holds no API key and no secret: it reads the library through `exportLibrary` only, and the import boundary keeps the secrets store out of this folder.
// - It logs nothing about what it writes (no names, no titles), and says nothing about an unsaved PDF: it has no way to see one.
import {
  BACKUP_DIR,
  buildManifest,
  dayOf,
  isSha,
  LIBRARY_PATH,
  MANIFEST_PATH,
  NOTES_DIR,
  parseLibraryDump,
  PDF_DIR,
  pdfPath,
  planSnapshots,
  SNAPSHOT_DIR,
  type BackupManifest,
  type LibraryDump,
} from '@sop/core';
import type { BlobStore } from '../store/blob-store';
import type { StoreApi } from '../store/store-api';
import { assertReachable, fileSize, list, openDir, readText, removeDirIfEmpty, removeFile, writeFile } from './fs';
import type { HandleStore } from './handle-store';
import { documentIds, documentsWithCopy, notesDocumentId, notesFiles, notesTag } from './layout';
import { readLibrary } from './read-library';
import { classifyFailure, type FailureKind, type HeldReason } from './status';
import type { BackupTarget } from './target';

export interface RunDeps {
  store: Pick<StoreApi, 'exportLibrary' | 'exportChunk' | 'schemaVersion'>;
  blobs: Pick<BlobStore, 'get'>;
  handles: Pick<HandleStore, 'getKnown' | 'setKnown'>;
  now(): number;
  appVersion: string;
  viewerBase: string;
  /** Called as PDF copies are checked. */
  onProgress?(p: { done: number; total: number }): void;
}

export interface RunOptions {
  /** "Back up anyway": ignore the two guards, and take over a folder that holds another library's readings. */
  force?: boolean;
}

export type RunOutcome =
  | {
      ok: true;
      manifest: BackupManifest;
      /** The size of the backup in the folder. */
      bytes: number;
      wrote: { pdfs: number; notes: number };
      /** Readings whose PDF copy is neither in the library's storage nor in the folder. */
      missingPdfs: number;
    }
  | { ok: false; kind: 'permission' }
  | { ok: false; kind: 'held'; held: HeldReason }
  | { ok: false; kind: 'failed'; failure: FailureKind; /** The error's name and message, for a test to read. Never shown to the owner. */ detail: string };

/** Readings that went missing at once before a run is held. Below this, or under a quarter of what was backed up, a run goes on. */
export const MANY_MISSING_MIN = 5;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** `library.json` as a folder holds it, or null when it is missing or cannot be read. */
function readDump(text: string | null): LibraryDump | null {
  if (text === null) return null;
  try {
    return parseLibraryDump(text);
  } catch {
    return null;
  }
}

/** The PDF copies in the folder that belong to readings this computer wrote there and the library no longer has. */
async function removeGonePdfs(root: FileSystemDirectoryHandle, known: ReadonlySet<string>, have: ReadonlySet<string>): Promise<void> {
  const base = await openDir(root, PDF_DIR);
  if (base === null) return;
  for await (const [shard, handle] of base.entries()) {
    if (handle.kind !== 'directory') continue;
    for await (const [name, file] of handle.entries()) {
      if (file.kind !== 'file' || !name.endsWith('.pdf')) continue;
      const sha = name.slice(0, -'.pdf'.length);
      if (isSha(sha) && known.has(sha) && !have.has(sha)) await removeFile(root, `${PDF_DIR}/${shard}/${name}`);
    }
    await removeDirIfEmpty(root, `${PDF_DIR}/${shard}`);
  }
}

/** Notes files of ours that no longer match a reading: the reading is gone, was renamed (the name has its title), or has no notes now. */
async function removeStaleNotes(root: FileSystemDirectoryHandle, wanted: ReadonlySet<string>, known: ReadonlySet<string>, have: ReadonlySet<string>): Promise<void> {
  for (const entry of await list(root, NOTES_DIR)) {
    if (entry.kind !== 'file' || wanted.has(entry.name) || notesTag(entry.name) === null) continue;
    const id = notesDocumentId((await readText(root, `${NOTES_DIR}/${entry.name}`)) ?? '');
    if (id !== null && (known.has(id) || have.has(id))) await removeFile(root, `${NOTES_DIR}/${entry.name}`);
  }
}

/**
 * One backup. The caller holds the backup lock (controller.ts), so two runs never overlap.
 * Never throws: every failure is an outcome.
 */
export async function runBackup(target: BackupTarget, deps: RunDeps, options: RunOptions = {}): Promise<RunOutcome> {
  try {
    if ((await target.queryPermission()) !== 'granted') return { ok: false, kind: 'permission' };
    const parent = await target.directory();
    await assertReachable(parent);
    const root = await parent.getDirectoryHandle(BACKUP_DIR, { create: true });
    const now = deps.now();

    const dump = await readLibrary(deps.store);
    const schemaVersion = await deps.store.schemaVersion();
    const have = documentIds(dump);
    const knownBefore = await deps.handles.getKnown();

    // The guards. The folder's own `library.json` says what it holds.
    const existingText = await readText(root, LIBRARY_PATH);
    const inFolder = readDump(existingText);
    const foreign = inFolder === null ? [] : [...documentIds(inFolder)].filter((id) => !have.has(id) && !knownBefore.has(id));
    if (options.force !== true) {
      if (foreign.length > 0) return { ok: false, kind: 'held', held: 'other-library' };
      const missing = [...knownBefore].filter((id) => !have.has(id)).length;
      if (missing >= MANY_MISSING_MIN && missing * 4 > knownBefore.size) return { ok: false, kind: 'held', held: 'many-missing' };
    }
    // Readings the folder holds that this library does not (taken over by "Back up anyway") count as written by this computer from now on.
    const known = new Set([...knownBefore, ...foreign]);
    // Recorded before anything is written: a run that stops half way must still know it may have written these.
    await deps.handles.setKnown(new Set([...known, ...have]));

    // 1. PDF copies, once per fingerprint.
    const present: Record<string, number> = {};
    const withCopy = documentsWithCopy(dump);
    let missingPdfs = 0;
    let wrotePdfs = 0;
    let done = 0;
    for (const doc of withCopy) {
      const path = pdfPath(doc.id);
      const copy = await deps.blobs.get(doc.id);
      const inFolderSize = await fileSize(root, path);
      if (copy === null) {
        // The library has lost its copy; keep the one in the folder.
        if (inFolderSize === null) missingPdfs += 1;
        else present[doc.id] = inFolderSize;
      } else if (inFolderSize === copy.size) {
        present[doc.id] = inFolderSize;
      } else {
        await writeFile(root, path, copy.stream());
        present[doc.id] = copy.size;
        wrotePdfs += 1;
      }
      done += 1;
      deps.onProgress?.({ done, total: withCopy.length });
    }
    // A reading whose copy is not stored here (a restore that has not copied it yet) keeps the copy that is in the folder.
    for (const doc of dump.tables.documents) {
      if (doc.blobStored || !isSha(doc.id) || doc.id in present) continue;
      const size = await fileSize(root, pdfPath(doc.id));
      if (size !== null) present[doc.id] = size;
    }

    // 2. Notes as Markdown, one file for each reading that has notes. A file that is already right is left alone.
    const notes = notesFiles(dump, { viewerBase: deps.viewerBase });
    let wroteNotes = 0;
    let notesBytes = 0;
    for (const n of notes) {
      if ((await readText(root, n.path)) !== n.markdown) {
        await writeFile(root, n.path, n.markdown);
        wroteNotes += 1;
      }
      notesBytes += byteLength(n.markdown);
    }

    // 3. The library, and today's snapshot of it.
    const json = JSON.stringify(dump);
    if (existingText !== json) await writeFile(root, LIBRARY_PATH, json);
    const names = (await list(root, SNAPSHOT_DIR)).filter((e) => e.kind === 'file').map((e) => e.name);
    const plan = planSnapshots(names, dayOf(now));
    const today = `${SNAPSHOT_DIR}/${plan.write}`;
    if ((await readText(root, today)) !== json) await writeFile(root, today, json);

    // 4. The manifest, last.
    const manifest = buildManifest({ createdAt: now, schemaVersion, appVersion: deps.appVersion, dump, pdfs: present });
    const manifestText = JSON.stringify(manifest);
    await writeFile(root, MANIFEST_PATH, manifestText);

    // 5. Only now, what no longer belongs.
    await removeGonePdfs(root, known, have);
    await removeStaleNotes(
      root,
      new Set(notes.map((n) => n.path.slice(NOTES_DIR.length + 1))),
      known,
      have,
    );
    for (const old of plan.remove) await removeFile(root, `${SNAPSHOT_DIR}/${old}`);

    let snapshotsBytes = 0;
    for (const name of plan.keep) snapshotsBytes += (await fileSize(root, `${SNAPSHOT_DIR}/${name}`)) ?? 0;
    // Everything that was to go is gone: from now on the folder holds only readings the library has.
    await deps.handles.setKnown(have);
    const pdfBytes = Object.values(present).reduce((a, b) => a + b, 0);
    const bytes = pdfBytes + notesBytes + snapshotsBytes + byteLength(json) + byteLength(manifestText);
    return { ok: true, manifest, bytes, wrote: { pdfs: wrotePdfs, notes: wroteNotes }, missingPdfs };
  } catch (error) {
    const failure = classifyFailure(error);
    return failure === 'permission' ? { ok: false, kind: 'permission' } : { ok: false, kind: 'failed', failure, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
