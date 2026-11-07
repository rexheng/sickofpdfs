// The upgrade rule (no lost notes, Phase 7–8 plan 7.3). When the engine's version changes, saved pages read by the older version
// are read again in the background, after every page that has no text yet. The new text replaces the old only on a page that has
// no note on it; a page with a mark or a thread keeps its old text (and its notes stay exactly where they are), and `keptOld`
// counts it. Re-anchoring notes onto new text (rewriting their textSource) is left for when a second engine version ships.
import type { Anchor, DocumentId, MarkRow, ThreadRow } from '@sop/core';

/** The pages an anchor sits on. */
function pagesOf(a: Anchor): number[] {
  switch (a.kind) {
    case 'text': {
      const out: number[] = [];
      for (let p = a.start.page; p <= a.end.page; p++) out.push(p);
      return out;
    }
    case 'document':
      return [];
    default:
      return [a.page];
  }
}

/** The pages of a reading that hold a note (a live mark or thread). */
export async function pagesWithNotes(
  store: { listAnnotations(id: DocumentId): Promise<{ marks: MarkRow[]; threads: ThreadRow[] }> },
  documentId: DocumentId,
): Promise<Set<number>> {
  const { marks, threads } = await store.listAnnotations(documentId);
  const pages = new Set<number>();
  for (const row of [...marks, ...threads]) for (const p of pagesOf(row.anchor)) pages.add(p);
  return pages;
}
