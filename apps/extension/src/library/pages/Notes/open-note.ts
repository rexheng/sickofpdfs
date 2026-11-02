// Opening the reading a note is on, from the Notes page or Home. It opens where the reading's link is, as the library's rows
// do (reading-actions.ts); the viewer finds the notes by the PDF's fingerprint. (S15's `?doc=` and `?note=` will open the
// saved copy at the note itself.)
import type { DocumentId } from '@sop/core';
import type { LibraryContextValue } from '../../app/context';
import { openReading } from '../../components/reading-actions';

export async function openNoteReading(documentId: DocumentId, { data, notify }: Pick<LibraryContextValue, 'data' | 'notify'>): Promise<void> {
  try {
    const source = await data.readingSource(documentId);
    if (source === null) {
      notify({ text: 'This reading is no longer in your library.' });
      return;
    }
    if (source.doc.deletedAt !== null) {
      notify({ text: 'This reading is in Trash. Restore it to open it.' });
      return;
    }
    const opened = await openReading({ ...source, firstOpened: 0, lastOpened: 0, readingMs: 0, noteCount: 0 }, data.savedPdf);
    if (!opened) notify({ text: 'This PDF has no saved link or copy to open it from.' });
  } catch {
    notify({ text: 'That didn’t work. Try again.' });
  }
}
