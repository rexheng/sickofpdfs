// The backup writer (contracts §5, Phase 3 S13). It runs in the offscreen document and writes the library into the folder the
// owner chose, inside a `sickofpdfs-backup` folder:
//
//   manifest.json   library.json   snapshots/library-<day>.json (the newest 7)   pdf/<sha[0..2]>/<sha>.pdf   notes/<title>-<sha8>.md
//
// Rules this file keeps:
// - Every file is written through `createWritable()` (fs.ts), so a half-written file never replaces a good one, and the manifest
//   is written last of all the files a run adds. A restore reads the manifest first, so a run that stopped early is never
//   taken for a whole backup. A PDF copy is written as `<sha>.pdf.part` and moved into place when it is whole, so a quit never
//   leaves a short or empty file under the real name.
// - Nothing is removed until the new files are in place. Removing comes last, so a run that stops leaves extra files, never missing ones.
// - PDF copies are made once per fingerprint (skipped when the size in the folder matches). They are streamed in pieces from the
//   library's file storage to the folder; a whole PDF is never held in memory.
// - It never asks for permission (only a click can): when the folder is not `granted` it stops and says so.
// - Gone for good means gone from backups (R82). Readings that left the library for good are removed from every file first: the
//   queue (drained by the controller before the run), and any the queue missed that the store's list of forgotten readings names.
// - It never loses the owner's backup (R86). A run holds, and changes nothing in the folder, when the folder's `library.json`
//   cannot be read, when the folder holds readings this library never wrote, when every reading of the last backup is gone (or
//   many at once), or when many notes are gone (at least 20, and at least half). Readings removed on purpose (the scrub list, the
//   store's forgotten list) never count as gone. "Back up anyway" (`force`) overrides every hold.
// - R87: no run, forced or not, ever deletes a reading's files unless the reading was removed on purpose (the scrub queue, the
//   store's forgotten list). "Back up anyway" backs up what the library has now and keeps the copies of a reading that is missing
//   without having been removed on purpose. A renamed reading's old notes file and the notes file of a reading with no notes go.
// - A PDF copy is checked against its fingerprint as it is written; a library copy that does not match never replaces the folder's.
// - Each run tidies what a run that stopped left behind: Chrome's `*.crswap` files older than a day, and `*.part` copies.
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
import { assertReachable, fileSize, list, openDir, PART_SUFFIX, readText, removeDirIfEmpty, removeFile, removeLeftovers, writeFile, writeFileViaPart } from './fs';
import type { HandleStore, KnownReadings } from './handle-store';
import { documentIds, documentsWithCopy, noteCounts, notesDocumentId, notesFiles, notesTag } from './layout';
import { readLibrary } from './read-library';
import type { ScrubOutcome } from './scrub';
import { classifyFailure, type FailureKind, type HeldReason } from './status';
import type { BackupTarget } from './target';

export interface RunDeps {
  store: Pick<StoreApi, 'exportLibrary' | 'exportChunk' | 'schemaVersion' | 'forgottenAmong'>;
  blobs: Pick<BlobStore, 'get'>;
  handles: Pick<HandleStore, 'getKnown' | 'setKnown' | 'listScrubs'>;
  /** Removes readings that left the library for good from the folder (R82): queues them and cleans the folder, under the caller's lock. */
  scrub(documentIds: string[]): Promise<ScrubOutcome>;
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
      /** Readings whose copy in the library does not match its fingerprint: the folder's copy was kept, or none was written. */
      damagedPdfs: number;
    }
  | { ok: false; kind: 'permission' }
  | { ok: false; kind: 'held'; held: HeldReason }
  | { ok: false; kind: 'failed'; failure: FailureKind; /** The error's name and message, for a test to read. Never shown to the owner. */ detail: string };

/** Readings that went missing at once before a run is held. Below this, or under a quarter of what was backed up, a run goes on (unless every one is gone). */
export const MANY_MISSING_MIN = 5;
/** Notes (live marks and comments) that went missing at once before a run is held, if that is also at least half of them. */
export const NOTES_MISSING_MIN = 20;
/** Chrome's swap files older than this are left over from a run that stopped. */
const SWAP_STALE_MS = 24 * 60 * 60 * 1000;
/** The most fingerprints asked about in one store call. */
const FORGOTTEN_QUERY = 5000;

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

/** True for a `library.json` that is there and holds something, but cannot be read. An empty file (a first run cut short) holds nothing. */
const isUnreadable = (text: string | null, dump: LibraryDump | null): boolean => text !== null && text.trim() !== '' && dump === null;

async function forgottenAmong(store: RunDeps['store'], ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += FORGOTTEN_QUERY) out.push(...(await store.forgottenAmong(ids.slice(i, i + FORGOTTEN_QUERY))));
  return out;
}

/** Why a run must hold, or null when it may go on. `counted` leaves out the readings removed on purpose. */
function holdFor(o: { unreadable: boolean; foreign: number; known: KnownReadings; counted: readonly string[]; have: ReadonlySet<string>; notesNow: ReadonlyMap<string, number> }): HeldReason | null {
  if (o.unreadable) return 'unreadable';
  if (o.foreign > 0) return 'other-library';
  const missing = o.counted.filter((id) => !o.have.has(id)).length;
  if (o.counted.length > 0 && missing === o.counted.length) return 'many-missing';
  if (missing >= MANY_MISSING_MIN && missing * 4 > o.counted.length) return 'many-missing';
  let before = 0;
  let after = 0;
  for (const id of o.counted) {
    const n = o.known.get(id);
    if (n === null || n === undefined) continue; // counted before notes were (an older record): left out
    before += n;
    after += o.notesNow.get(id) ?? 0;
  }
  const drop = before - after;
  if (drop >= NOTES_MISSING_MIN && drop * 2 >= before) return 'notes-missing';
  return null;
}

/** Every PDF copy in the folder: fingerprint to size in bytes. */
async function pdfCopies(root: FileSystemDirectoryHandle): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const base = await openDir(root, PDF_DIR);
  if (base === null) return out;
  for await (const [, handle] of base.entries()) {
    if (handle.kind !== 'directory') continue;
    for await (const [name, file] of handle.entries()) {
      if (file.kind !== 'file' || !name.endsWith('.pdf')) continue;
      const sha = name.slice(0, -'.pdf'.length);
      if (isSha(sha)) out.set(sha, (await file.getFile()).size);
    }
  }
  return out;
}

/**
 * The PDF copies of readings removed on purpose that are still in the folder (the scrub normally took them already). R87: a reading
 * that is missing without having been removed on purpose keeps its copy, whatever the run.
 */
async function removeGonePdfs(root: FileSystemDirectoryHandle, onPurpose: ReadonlySet<string>, have: ReadonlySet<string>): Promise<void> {
  for (const id of onPurpose) {
    if (!isSha(id) || have.has(id)) continue;
    await removeFile(root, pdfPath(id));
    await removeFile(root, `${pdfPath(id)}${PART_SUFFIX}`);
    await removeDirIfEmpty(root, `${PDF_DIR}/${id.slice(0, 2)}`);
  }
}

/**
 * Notes files of ours that no longer match a reading: the reading was renamed (the name has its title), has no notes now, or was
 * removed on purpose. R87: the notes file of a reading that is missing without having been removed on purpose stays.
 */
async function removeStaleNotes(root: FileSystemDirectoryHandle, wanted: ReadonlySet<string>, onPurpose: ReadonlySet<string>, have: ReadonlySet<string>): Promise<void> {
  for (const entry of await list(root, NOTES_DIR)) {
    if (entry.kind !== 'file' || wanted.has(entry.name) || notesTag(entry.name) === null) continue;
    const id = notesDocumentId((await readText(root, `${NOTES_DIR}/${entry.name}`)) ?? '');
    if (id !== null && (have.has(id) || onPurpose.has(id))) await removeFile(root, `${NOTES_DIR}/${entry.name}`);
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
    const notesNow = noteCounts(dump);

    let knownBefore = await deps.handles.getKnown();
    // The folder's own `library.json` says what it holds.
    let existingText = await readText(root, LIBRARY_PATH);
    let inFolder = readDump(existingText);

    // 1. Readings that left the library for good (R82) and are still named here: ones this computer wrote that the queue missed (an
    //    event lost when the browser quit), or ones in a folder chosen again after "Turn off". They are removed first, as the queue
    //    is. A folder that also holds another library's readings is not touched beyond what this computer wrote, unless the owner
    //    said "Back up anyway".
    const pending = new Set((await deps.handles.listScrubs()).map((p) => p.documentId));
    const inFolderIds = inFolder === null ? [] : [...documentIds(inFolder)];
    const candidates = [...new Set([...knownBefore.keys(), ...inFolderIds])].filter((id) => isSha(id) && !have.has(id));
    const gone = new Set(candidates.length === 0 ? [] : await forgottenAmong(deps.store, candidates));
    const othersBefore = inFolderIds.filter((id) => !have.has(id) && !knownBefore.has(id) && !gone.has(id) && !pending.has(id));
    const toScrub = [...gone].filter((id) => knownBefore.has(id) || othersBefore.length === 0 || options.force === true);
    if (toScrub.length > 0) {
      const scrubbed = await deps.scrub(toScrub);
      if (!scrubbed.ok) {
        return scrubbed.kind === 'permission' ? { ok: false, kind: 'permission' } : { ok: false, kind: 'failed', failure: scrubbed.failure, detail: 'the removal of a forgotten reading failed' };
      }
      knownBefore = await deps.handles.getKnown();
      existingText = await readText(root, LIBRARY_PATH);
      inFolder = readDump(existingText);
    }
    // Removed on purpose, and still waiting (a removal that could not finish): never "missing", never "another library's".
    const onPurpose = new Set<string>([...gone, ...pending, ...(await deps.handles.listScrubs()).map((p) => p.documentId)]);

    // 2. The holds (R86).
    const foreign = inFolder === null ? [] : [...documentIds(inFolder)].filter((id) => !have.has(id) && !knownBefore.has(id) && !onPurpose.has(id));
    if (options.force !== true) {
      const held = holdFor({
        unreadable: isUnreadable(existingText, inFolder),
        foreign: foreign.length,
        known: knownBefore,
        counted: [...knownBefore.keys()].filter((id) => !onPurpose.has(id)),
        have,
        notesNow,
      });
      if (held !== null) return { ok: false, kind: 'held', held };
    }
    // Readings the folder holds that this library does not (taken over by "Back up anyway") count as written by this computer from now on.
    const known: KnownReadings = new Map(knownBefore);
    for (const id of foreign) if (!known.has(id)) known.set(id, null);
    // Recorded before anything is written: a run that stops half way must still know it may have written these. The note counts of
    // the last good run stay until this run has finished.
    const during: KnownReadings = new Map(known);
    for (const id of have) if (!during.has(id)) during.set(id, notesNow.get(id) ?? 0);
    await deps.handles.setKnown(during);

    // 3. What a run that stopped left behind: Chrome's swap files older than a day, and PDF copies cut short (only a run writes those).
    await removeLeftovers(root, { swapsBefore: now - SWAP_STALE_MS, parts: [PDF_DIR] });

    // 4. PDF copies, once per fingerprint.
    const present: Record<string, number> = {};
    const withCopy = documentsWithCopy(dump);
    let missingPdfs = 0;
    let damagedPdfs = 0;
    let wrotePdfs = 0;
    let done = 0;
    for (const doc of withCopy) {
      const path = pdfPath(doc.id);
      const copy = await deps.blobs.get(doc.id);
      const inFolderSize = await fileSize(root, path);
      if (copy === null) {
        // The library has lost its copy; keep the one in the folder (an empty file is no copy: an older build's run cut short).
        if (inFolderSize === null || inFolderSize === 0) missingPdfs += 1;
        else present[doc.id] = inFolderSize;
      } else if (inFolderSize === copy.size) {
        present[doc.id] = inFolderSize;
      } else if (await writeFileViaPart(root, path, copy.stream(), doc.id)) {
        present[doc.id] = copy.size;
        wrotePdfs += 1;
      } else {
        // The library's copy does not match its fingerprint (damaged): a good copy in the folder is never replaced by it (N7).
        damagedPdfs += 1;
        if (inFolderSize !== null && inFolderSize > 0) present[doc.id] = inFolderSize;
      }
      done += 1;
      deps.onProgress?.({ done, total: withCopy.length });
    }
    // A reading whose copy is not stored here (a restore that has not copied it yet) keeps the copy that is in the folder. So does a
    // reading that is missing without having been removed on purpose (R87): its copy stays, and the manifest still lists it, so a
    // restore from an older snapshot can find it.
    const copies = await pdfCopies(root);
    for (const doc of dump.tables.documents) {
      if (doc.blobStored || !isSha(doc.id) || doc.id in present) continue;
      const size = copies.get(doc.id) ?? null;
      if (size !== null && size > 0) present[doc.id] = size;
    }
    for (const [sha, size] of copies) if (!have.has(sha) && !onPurpose.has(sha) && size > 0 && !(sha in present)) present[sha] = size;

    // 5. Notes as Markdown, one file for each reading that has notes. A file that is already right is left alone.
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

    // 6. The library, and today's snapshot of it.
    const json = JSON.stringify(dump);
    if (existingText !== json) await writeFile(root, LIBRARY_PATH, json);
    const names = (await list(root, SNAPSHOT_DIR)).filter((e) => e.kind === 'file').map((e) => e.name);
    const plan = planSnapshots(names, dayOf(now));
    const today = `${SNAPSHOT_DIR}/${plan.write}`;
    if ((await readText(root, today)) !== json) await writeFile(root, today, json);

    // 7. The manifest, last.
    const manifest = buildManifest({ createdAt: now, schemaVersion, appVersion: deps.appVersion, dump, pdfs: present });
    const manifestText = JSON.stringify(manifest);
    await writeFile(root, MANIFEST_PATH, manifestText);

    // 8. Only now, what no longer belongs.
    await removeGonePdfs(root, onPurpose, have);
    await removeStaleNotes(
      root,
      new Set(notes.map((n) => n.path.slice(NOTES_DIR.length + 1))),
      onPurpose,
      have,
    );
    for (const old of plan.remove) await removeFile(root, `${SNAPSHOT_DIR}/${old}`);

    let snapshotsBytes = 0;
    for (const name of plan.keep) snapshotsBytes += (await fileSize(root, `${SNAPSHOT_DIR}/${name}`)) ?? 0;
    // Everything that was to go is gone: from now on the folder holds only readings the library has, with their notes as they are now.
    await deps.handles.setKnown(new Map([...have].map((id) => [id, notesNow.get(id) ?? 0])));
    const pdfBytes = Object.values(present).reduce((a, b) => a + b, 0);
    const bytes = pdfBytes + notesBytes + snapshotsBytes + byteLength(json) + byteLength(manifestText);
    return { ok: true, manifest, bytes, wrote: { pdfs: wrotePdfs, notes: wroteNotes }, missingPdfs, damagedPdfs };
  } catch (error) {
    const failure = classifyFailure(error);
    return failure === 'permission' ? { ok: false, kind: 'permission' } : { ok: false, kind: 'failed', failure, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
