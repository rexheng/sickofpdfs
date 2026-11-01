// "Export library" (spec: "saves the same as a zip at any time"): the backup's layout as one zip, written as a stream.
//
// The zip holds `sickofpdfs-backup/` with `manifest.json`, `library.json`, `pdf/<sha[0..2]>/<sha>.pdf` and `notes/<title>-<sha8>.md`
// (the folder's layout, less the snapshots), so an unzipped export can be restored from like a backup folder. The pinned zip
// library (`client-zip`) stores the files as they are: PDFs are already compressed. It reads each PDF as a stream and writes the
// bytes out as it goes, so the library is never held in memory; the manifest is the last entry.
import { BACKUP_DIR, buildManifest, LIBRARY_PATH, MANIFEST_PATH, pdfPath, type LibraryDump } from '@sop/core';
import { makeZip } from 'client-zip';
import type { BlobStore } from '../store/blob-store';
import { documentsWithCopy, notesFiles } from './layout';

export interface ZipDeps {
  dump: LibraryDump;
  blobs: Pick<BlobStore, 'get'>;
  schemaVersion: number;
  appVersion: string;
  viewerBase: string;
  now(): number;
}

interface Entry {
  name: string;
  lastModified: Date;
  input: string | File;
  size?: number;
}

async function* entries(d: ZipDeps): AsyncGenerator<Entry> {
  const at = new Date(d.now());
  const inFolder = (path: string): string => `${BACKUP_DIR}/${path}`;

  // The copies the library holds. Their sizes go in the manifest, which is written last.
  const copies: { id: string; file: File }[] = [];
  const present: Record<string, number> = {};
  for (const doc of documentsWithCopy(d.dump)) {
    const file = await d.blobs.get(doc.id);
    if (file === null) continue;
    copies.push({ id: doc.id, file });
    present[doc.id] = file.size;
  }

  yield { name: inFolder(LIBRARY_PATH), lastModified: at, input: JSON.stringify(d.dump) };
  for (const n of notesFiles(d.dump, { viewerBase: d.viewerBase })) yield { name: inFolder(n.path), lastModified: at, input: n.markdown };
  for (const c of copies) yield { name: inFolder(pdfPath(c.id)), lastModified: new Date(c.file.lastModified), input: c.file, size: c.file.size };

  const manifest = buildManifest({ createdAt: d.now(), schemaVersion: d.schemaVersion, appVersion: d.appVersion, dump: d.dump, pdfs: present });
  yield { name: inFolder(MANIFEST_PATH), lastModified: at, input: JSON.stringify(manifest) };
}

/** The export as a byte stream. Pipe it to a file's writable stream. */
export function libraryZip(d: ZipDeps): ReadableStream<Uint8Array> {
  return makeZip(entries(d), { buffersAreUTF8: true });
}

/** The name suggested for the saved file: `sickofpdfs-library-2026-11-01.zip`. */
export function zipFileName(day: string): string {
  return `sickofpdfs-library-${day}.zip`;
}
