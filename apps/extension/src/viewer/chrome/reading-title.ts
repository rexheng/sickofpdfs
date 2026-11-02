// What the tab and the header call the open PDF (TB4): the reading's real title once it is known, the file name until
// then. Three names for one paper (a 595-character tab title, the file name in the header, a clean title in the library)
// become one.
//
//   At open:    the PDF's own title (its document properties), when S4's junk rule passes it and it is short (80
//               characters at most); otherwise the file name. Only that field is read: the words of page 1 of a PDF that
//               is not saved never reach the tab title, and so never Chrome's history.
//   Once saved: the library's title, as the library shows it (S4's chooser picked it when it was saved; the owner may
//               have renamed it since), cut to 80 characters at a word.
import { cleanTitle, isJunkTitle, type DocumentId } from '@sop/core';
import { useEffect, useState, useSyncExternalStore, useCallback } from 'react';
import type { OpenedDocument } from '../open-document';
import type { SaveControllerImpl } from '../save/save-controller';
import { libraryStore } from '../use-store';

/** The longest title the tab and the header show. A PDF's own title longer than this is not trusted at open. */
export const TITLE_MAX = 80;

/** `title` cut to at most TITLE_MAX characters, at a word where it can be, with "…". */
export function capTitle(title: string): string {
  const t = title.trim();
  if (t.length <= TITLE_MAX) return t;
  const cut = t.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/** The title shown at open: the PDF's own title when it is clean and short, else null (the file name is shown). */
export function openTitle(doc: OpenedDocument): string | null {
  const info = doc.open.metadata.title;
  if (isJunkTitle(info, doc.loaded.displayName)) return null;
  const t = cleanTitle(info ?? '');
  return t.length > TITLE_MAX || isJunkTitle(t, doc.loaded.displayName) ? null : t;
}

export interface ReadingTitle {
  /** What the tab and the header show. */
  shown: string;
  /** The whole title (it may be longer than `shown`), for the header's tooltip; the file name when there is none. */
  full: string;
  /** The PDF's file name. */
  fileName: string;
}

/** The saved reading's id, while the save state is `saved`; null otherwise. */
function useSavedId(save: SaveControllerImpl | null): DocumentId | null {
  const subscribe = useCallback((cb: () => void) => save?.subscribe(cb) ?? (() => {}), [save]);
  return useSyncExternalStore(subscribe, () => (save?.state.kind === 'saved' ? save.state.documentId : null));
}

/** The library's title of reading `id` (null while unknown or untitled), read again when the library changes it. */
function useLibraryTitle(id: DocumentId | null): string | null {
  const [title, setTitle] = useState<{ id: DocumentId; title: string | null } | null>(null);
  useEffect(() => {
    if (id === null) return;
    let live = true;
    let stop = () => {};
    void libraryStore().then((store) => {
      if (store === null || !live) return;
      const read = () =>
        void store.getDocument(id).then(
          (row) => live && setTitle({ id, title: row?.title?.trim() || null }),
          () => {}, // the file name stays
        );
      read();
      stop = store.onChange((c) => {
        if (c.table === 'documents' && c.op === 'upsert' && c.ids.includes(id)) read();
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, [id]);
  return id !== null && title?.id === id ? title.title : null;
}

/** The open PDF's title for the tab and the header; null while no PDF is open. */
export function useReadingTitle(doc: OpenedDocument | null, save: SaveControllerImpl | null): ReadingTitle | null {
  const library = useLibraryTitle(useSavedId(doc === null ? null : save));
  if (doc === null) return null;
  const fileName = doc.loaded.displayName;
  const full = library ?? openTitle(doc) ?? fileName;
  return { shown: capTitle(full), full, fileName };
}
