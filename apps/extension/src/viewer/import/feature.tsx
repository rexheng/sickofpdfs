// Import on open as a viewer feature (slice 8.4): App.tsx mounts it with one line. It has no look of its own; it runs when a
// saved PDF is open and tells what it did in the snackbar ("Added 6 notes from this PDF", with Undo).
//
// Saved PDFs only. A PDF that is not saved (not sure, not learning, kept in this tab) is never imported: the file's annotations
// are drawn as they are, in that tab, and nothing is written. If the PDF becomes saved while it is open, the import runs then.
import { useEffect } from 'react';
import type { NotesHost, ViewerFeature } from '../annotations/wire';
import { libraryStore } from '../use-store';
import { importOnOpen } from './import-annotations';

const plural = (n: number): string => (n === 1 ? '1 note' : `${n} notes`);

/** The snackbar's words. */
export const importedText = (n: number): string => `Added ${plural(n)} from this PDF.`;

function ImportView({ host }: { host: NotesHost }) {
  useEffect(() => {
    let alive = true;
    let running = false;
    let done = false;
    const run = async (): Promise<void> => {
      const save = host.save;
      if (!alive || running || done || !save || save.state.kind !== 'saved') return;
      const documentId = save.state.documentId;
      running = true;
      try {
        await host.notesSettled();
        const store = await libraryStore();
        if (!store || !alive || save.state.kind !== 'saved') return;
        const outcome = await importOnOpen(host, store, documentId, () => alive && save.state.kind === 'saved');
        done = true;
        if (outcome) {
          host.showNote(importedText(outcome.notes), {
            label: 'Undo',
            run: () => void outcome.undo().catch(() => host.showNote('Couldn’t take those notes away. Your notes are safe.')),
          });
        }
      } catch (e) {
        // The library said no: nothing was hidden, so the file's own drawing still shows. Try again on the next open.
        console.warn('sickofpdfs: import on open', e instanceof Error ? e.message : String(e));
      } finally {
        running = false;
      }
    };
    const off = host.save?.subscribe((s) => {
      if (s.kind !== 'saved') done = false; // saved again later (after Forget or Undo of a save): import afresh
      void run();
    });
    void run();
    return () => {
      alive = false;
      off?.();
    };
  }, [host]);
  return null;
}

export const importPdfFeature: ViewerFeature = {
  id: 'import-pdf',
  View: ImportView,
};
