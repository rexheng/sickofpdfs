// "Your context" over the store, in the library's details and in the viewer's About panel: the reading's document note.
// Every key goes to the drafts journal at once (context-journal.ts), so a crash never loses what was typed; the words reach
// the store a moment after the last key, on blur, when the panel closes and when the page goes. Saves go one after the
// other, so a quick second save never makes a second note, and a new note is made with the ids its words were journaled under.
import type { CommentId, DocumentId, ThreadId } from '@sop/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AboutData, DocumentNote } from './about-data';
import { type ContextKeeper, type ContextTarget } from './context-journal';
import { ContextField } from './ContextField';

export interface ContextBoxProps {
  about: AboutData;
  documentId: DocumentId;
  keeper: ContextKeeper;
  /**
   * Bring back words an About box typed that never reached the store (this page's, or a tab's that is gone). The library
   * does; the viewer does not, because its notes session brings them back as a note box or an editor when the PDF opens.
   */
  recover: boolean;
}

export function ContextBox({ about, documentId, keeper, recover }: ContextBoxProps) {
  const [stored, setStored] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const note = useRef<DocumentNote | null>(null);
  const fresh = useRef<{ threadId: ThreadId; commentId: CommentId } | null>(null);
  const latest = useRef('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  /** What the words are for now: the note, or the ids its new note will have. */
  const target = useCallback((): ContextTarget => {
    if (note.current !== null) return { kind: 'edit', note: note.current };
    fresh.current ??= { threadId: crypto.randomUUID() as ThreadId, commentId: crypto.randomUUID() as CommentId };
    return { kind: 'new', ...fresh.current };
  }, []);

  useEffect(() => {
    let live = true;
    let first = true;
    const load = () =>
      void about.documentNote(documentId).then(
        async (n) => {
          if (!live) return;
          note.current = n;
          if (first) {
            first = false;
            latest.current = n?.comment.body ?? '';
            const back = recover ? await keeper.recover(documentId, n).catch(() => null) : null;
            if (!live) return;
            if (back !== null) {
              if (back.fresh !== null && note.current === null) fresh.current = back.fresh;
              latest.current = back.text;
              setRestored(back.text);
            }
          }
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
  }, [about, documentId, keeper, recover]);

  const typed = useCallback(
    (text: string) => {
      latest.current = text;
      keeper.typed(documentId, text, target());
    },
    [keeper, documentId, target],
  );

  const save = useCallback(
    (text: string) => {
      const next = queue.current.then(async () => {
        const before = target();
        const n = await about.saveDocumentNote(documentId, text, note.current, before.kind === 'new' ? before : null);
        note.current = n;
        if (n === null) fresh.current = null; // emptied: words typed next make a new note, with new ids
        keeper.saved(documentId, text, latest.current, before, n === null ? null : { kind: 'edit', note: n });
      });
      queue.current = next.catch(() => {});
      return next;
    },
    [about, documentId, keeper, target],
  );

  return <ContextField stored={stored} restored={restored} save={save} typed={typed} />;
}
