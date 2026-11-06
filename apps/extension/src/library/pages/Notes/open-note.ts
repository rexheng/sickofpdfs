// Opening the reading a note is on, from the Notes page or Home: at the note itself (TB5), as a note found with Ctrl+K opens.
// The saved copy opens with `?doc=<id>&note=<thread id>#page=<n>`, so the viewer shows the note's card and its passage, and
// the reader's last spot is not used. A reading with no saved copy opens from its link, at the note's page.
import type { ThreadRow } from '@sop/core';
import type { LibraryContextValue } from '../../app/context';
import { openReading } from '../../components/reading-actions';
import { openTargetInNewTab } from '../../../shared/palette';

export async function openNoteReading(thread: Pick<ThreadRow, 'id' | 'documentId' | 'pageIndex'>, { data, notify }: Pick<LibraryContextValue, 'data' | 'notify'>): Promise<void> {
  try {
    const source = await data.readingSource(thread.documentId);
    if (source === null) {
      notify({ text: 'This reading is no longer in your library.' });
      return;
    }
    if (source.doc.deletedAt !== null) {
      notify({ text: 'This reading is in Trash. Restore it to open it.' });
      return;
    }
    if (data.palette !== undefined) {
      const problem = await openTargetInNewTab({ kind: 'note', documentId: thread.documentId, threadId: thread.id, pageIndex: thread.pageIndex }, data.palette);
      if (problem !== null) notify({ text: problem });
      return;
    }
    // The sample library has no store to open a saved copy from: the reading opens as its row does.
    const opened = await openReading({ ...source, firstOpened: 0, lastOpened: 0, readingMs: 0, noteCount: 0 }, data.savedPdf);
    if (!opened) notify({ text: 'This PDF has no saved link or copy to open it from.' });
  } catch {
    notify({ text: 'That didn’t work. Try again.' });
  }
}
