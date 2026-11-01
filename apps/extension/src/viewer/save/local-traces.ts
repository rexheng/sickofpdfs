// R67 (e): Undo and Forget clear everything this computer kept of a PDF outside the store, not only its rows there:
// - the drafts journal (draft-journal.ts), under the library id and under the file's fingerprint;
// - the save-pending records (save-pending.ts), under either;
// - the margin hint (`sop:notes.marginAtOpen`, margin-at-open.ts), for the file and for the library id.
// A PDF that is not saved leaves no trace (spec, "Local traces").
import type { DocumentId, Sha256 } from '@sop/core';
import { localDraftJournal } from '../annotations/draft-journal';
import { localPendingSaves } from '../annotations/save-pending';
import { rememberNotes } from '../notes/margin-at-open';

export function forgetLocalTraces(documentId: DocumentId, fingerprint: Sha256): void {
  const journal = localDraftJournal();
  const pending = localPendingSaves();
  for (const id of new Set<Sha256>([documentId, fingerprint])) {
    if (id.length === 0) continue;
    journal?.clear(id);
    pending?.clear(id);
    rememberNotes(id, false);
  }
}
