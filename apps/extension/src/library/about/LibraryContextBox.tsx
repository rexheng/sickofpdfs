// "Your context" in the library: the reading's document note, read from and written to the store. Saves go one after the
// other, so a quick second save never makes a second note.
import type { DocumentId } from '@sop/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AboutData, DocumentNote } from './about-data';
import { ContextField } from './ContextField';

export function LibraryContextBox({ about, documentId }: { about: AboutData; documentId: DocumentId }) {
  const [stored, setStored] = useState<string | null>(null);
  const note = useRef<DocumentNote | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    let live = true;
    const load = () =>
      void about.documentNote(documentId).then(
        (n) => {
          if (!live) return;
          note.current = n;
          setStored(n?.comment.body ?? '');
        },
        () => live && setStored((s) => s ?? ''),
      );
    load();
    const stop = about.onReadingChange(documentId, load);
    return () => {
      live = false;
      stop();
    };
  }, [about, documentId]);

  const save = useCallback(
    (text: string) => {
      const next = queue.current.then(async () => {
        note.current = await about.saveDocumentNote(documentId, text, note.current);
      });
      queue.current = next.catch(() => {});
      return next;
    },
    [about, documentId],
  );

  return <ContextField stored={stored} save={save} />;
}
