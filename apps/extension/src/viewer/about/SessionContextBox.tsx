// "Your context" in the viewer: the reading's document note, written through the open document's notes, so the notes
// panel, the margin and every other tab see it at once and it is kept safe like any note.
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { findDocumentNote } from '../../library/about/about-data';
import { ContextField } from '../../library/about/ContextField';
import type { AnnotationSession } from '../annotations/session';

export function SessionContextBox({ session }: { session: AnnotationSession }) {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const state = useSyncExternalStore(subscribe, () => session.state());
  const note = findDocumentNote(state.threads, state.comments);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = useCallback(
    (text: string) => {
      const next = queue.current.then(async () => {
        const now = session.state();
        const current = findDocumentNote(now.threads, now.comments);
        if (current !== null) {
          await session.editComment(current.comment.id, text); // an empty box removes the note, as in a note card
          return;
        }
        if (text.trim() === '') return;
        const { commentId } = session.startThread({ kind: 'document' }, { highlight: null });
        session.typeDraft(commentId, text);
        await session.send(commentId);
      });
      queue.current = next.catch(() => {});
      return next;
    },
    [session],
  );
  const writable = state.mode === 'stored';
  return <ContextField stored={note?.comment.body ?? ''} save={save} disabled={!writable} disabledText="Your context can be added once this PDF is in your library." />;
}
