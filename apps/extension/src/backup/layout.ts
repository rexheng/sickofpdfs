// What goes in the backup folder, worked out from the library dump. Pure: no folder, no clock, no storage.
// The writer (writer.ts) and "Export library" (zip.ts) both build their files from this, so the zip has the folder's layout.
import { exportMarkdown, isSha, notesPath, type DocumentRow, type LibraryDump, type LocationRow } from '@sop/core';

/** One document's notes as a Markdown file in `notes/` (contracts §5). */
export interface NotesFile {
  documentId: string;
  /** `notes/<title-slug>-<sha[0..8]>.md` */
  path: string;
  markdown: string;
}

export interface LayoutOptions {
  /** The viewer page's address without a query, for links back to a PDF that has no web link (`chrome.runtime.getURL('viewer.html')`). */
  viewerBase: string;
}

const live = (r: { deletedAt?: number | null }): boolean => r.deletedAt == null;

function groupBy<T extends { documentId: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.documentId);
    if (list) list.push(r);
    else out.set(r.documentId, [r]);
  }
  return out;
}

/** Where a PDF came from on the web: its newest web location's canonical link. Never a file path. */
function sourceLinkOf(locations: readonly LocationRow[] | undefined): string | null {
  let best: LocationRow | null = null;
  for (const l of locations ?? []) if (l.kind === 'url' && (best === null || l.lastSeen > best.lastSeen)) best = l;
  return best?.canonical ?? null;
}

/**
 * The Markdown files for the documents that have notes. A document in Trash has none (its notes are in `library.json`, and
 * come back with it); a document whose notes are all deleted has none either. Drafts are not in a dump, and the export
 * leaves deleted rows out.
 */
export function notesFiles(dump: LibraryDump, o: LayoutOptions): NotesFile[] {
  const marks = groupBy(dump.tables.marks.filter(live));
  const threads = groupBy(dump.tables.threads.filter(live));
  const comments = groupBy(dump.tables.comments);
  const locations = groupBy(dump.tables.locations);
  const out: NotesFile[] = [];
  for (const doc of dump.tables.documents) {
    if (!isSha(doc.id) || !live(doc)) continue;
    const m = marks.get(doc.id) ?? [];
    const t = threads.get(doc.id) ?? [];
    if (m.length === 0 && t.length === 0) continue;
    out.push({
      documentId: doc.id,
      path: notesPath(doc.title, doc.id),
      markdown: exportMarkdown(
        { id: doc.id, title: doc.title, authors: doc.authors, doi: doc.doi, arxivId: doc.arxivId, sourceLink: sourceLinkOf(locations.get(doc.id)), viewerBase: o.viewerBase },
        m,
        t,
        comments.get(doc.id) ?? [],
      ),
    });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The documents of a dump that are saved PDFs the library keeps a copy of. */
export const documentsWithCopy = (dump: LibraryDump): DocumentRow[] => dump.tables.documents.filter((d) => isSha(d.id) && d.blobStored);

/** The ids of every document in a dump, in Trash or not. */
export const documentIds = (dump: LibraryDump): Set<string> => new Set(dump.tables.documents.map((d) => d.id));

/** The tag in a notes file name, `<slug>-<tag>.md`: the first 8 characters of the document's fingerprint. Null for any other name. */
export const notesTag = (fileName: string): string | null => /-([0-9a-f]{8})\.md$/.exec(fileName)?.[1] ?? null;

/**
 * The document a notes file belongs to, read from its front matter (`sickofpdfs: documentId: "<sha>"`), or null when the text
 * is not one of ours. A file is deleted only when this says it is ours, so a note the owner keeps in `notes/` is safe.
 */
export function notesDocumentId(markdown: string): string | null {
  const head = markdown.slice(0, 4096);
  const id = /^sickofpdfs:\s*\n\s+documentId: "([0-9a-f]{64})"/m.exec(head)?.[1];
  return id ?? null;
}
