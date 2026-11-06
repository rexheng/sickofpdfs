// R103: an earlier version of a saved web page whose marks and notes moved to its newer version says so when it is open: "Your
// notes moved to the newer version", with a button that opens it. It also shows at once when the move happens while this
// version is open in a tab (the library's change event). A quiet notice over the top of the pages; it never takes the focus.
import type { DocumentId } from '@sop/core';
import { Banner } from '@sop/ui';
import { useEffect, useState } from 'react';
import { openTargetInNewTab } from '../../shared/palette/open-hit';
import { webPageOf } from '../../store/reading-flags';
import type { SaveControllerImpl } from '../save/save-controller';
import { libraryStore } from '../use-store';
import styles from '../forms/FormBanner.module.css';

export const NOTES_MOVED = 'Your notes moved to the newer version.';
export const OPEN_NEWER = 'Open the newer version';

/** The newer version this reading's notes moved to, while it is the saved reading here; null otherwise. */
export function useNotesMoved(save: SaveControllerImpl | null): { newer: DocumentId | null; dismiss(this: void): void } {
  const [state, setState] = useState<{ for: DocumentId; newer: DocumentId } | null>(null);
  const [dismissed, setDismissed] = useState<DocumentId | null>(null);
  useEffect(() => {
    if (save === null) return;
    let live = true;
    let stopChanges: (() => void) | null = null;
    const check = async (): Promise<void> => {
      const id = save.documentId();
      if (id === null) return;
      const store = await libraryStore();
      if (store === null || !live) return;
      const doc = await store.getDocument(id).catch(() => null);
      const to = webPageOf(doc?.saveReasons)?.notesMovedTo ?? null;
      const there = to === null ? null : await store.getDocument(to as DocumentId).catch(() => null);
      if (live) setState(there === null ? null : { for: id, newer: there.id });
      stopChanges ??= store.onChange((c) => {
        if (c.table === 'documents' && c.ids.includes(id)) void check();
      });
    };
    void check();
    const stop = save.subscribe(() => void check());
    return () => {
      live = false;
      stop();
      stopChanges?.();
    };
  }, [save]);
  const id = save?.documentId() ?? null;
  const newer = state !== null && state.for === id && dismissed !== id ? state.newer : null;
  return { newer, dismiss: () => setDismissed(id) };
}

export function NotesMovedBanner({ newer, onDismiss }: { newer: DocumentId; onDismiss(this: void): void }) {
  const open = () => {
    void libraryStore().then(async (store) => {
      if (store !== null) await openTargetInNewTab({ kind: 'reading', documentId: newer }, store);
    });
  };
  return (
    <div className={styles.place}>
      <div className={styles.banner}>
        <Banner message={NOTES_MOVED} actions={[{ label: OPEN_NEWER, onClick: open }]} onDismiss={onDismiss} />
      </div>
    </div>
  );
}
