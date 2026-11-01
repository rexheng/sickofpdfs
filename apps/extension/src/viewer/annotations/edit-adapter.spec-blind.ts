// Test support only: how the R54 tests talk to the session about an edit in progress.
//
// Ruling R54: editing an already-sent note must be crash-safe too. The edit text is stored as a tab-owned edit draft, keyed to
// the comment, that never syncs and is restored on reload. The contract additions are not written yet, so the NAMES below are
// guesses. They are all in this one file: when the implementer records the real names, change them here and nowhere else.
//
// Guessed session surface (the existing `editComment(id, body)` is the Enter path and is not a guess):
//   start (optional)  startEdit(commentId) | beginEdit | openEdit      opens the editor on a sent note
//   type              typeEdit(commentId, body) | typeEditDraft | editDraft | updateEditDraft     every keystroke, like typeDraft
//   cancel            cancelEdit(commentId) | discardEdit | cancelEditDraft                        Esc on an edit that is thrown away
//   restored text     state().edits | state().editDrafts   (a Map, an array of rows or an object, id -> text), or drafts in
//                     state().drafts whose meta says which comment they edit (meta.sopEditOf | meta.editOf)
import type { CommentId } from '../../../../../packages/core/src/ids';
import type { AnnotationSession } from './session';

type Fn = (...args: unknown[]) => unknown;
const NAMES = {
  start: ['startEdit', 'beginEdit', 'openEdit'],
  type: ['typeEdit', 'typeEditDraft', 'editDraft', 'updateEditDraft'],
  cancel: ['cancelEdit', 'discardEdit', 'cancelEditDraft'],
};

function find(session: AnnotationSession, names: string[]): Fn | undefined {
  const bag = session as unknown as Record<string, unknown>;
  const name = names.find((n) => typeof bag[n] === 'function');
  return name ? (bag[name] as Fn).bind(session) : undefined;
}
function need(session: AnnotationSession, what: string, names: string[]): Fn {
  const f = find(session, names);
  if (!f) throw new Error(`R54: the session has no method for "${what}" (guessed names: ${names.join(', ')}). Update edit-adapter.spec-blind.ts to the names the contract records.`);
  return f;
}

export const edit = {
  /** Opens the editor on a sent note, when the session has such a call (typing may open it by itself). */
  start(session: AnnotationSession, id: CommentId): void {
    find(session, NAMES.start)?.(id);
  },
  /** One keystroke of the edit. Like typeDraft: nothing waits for it. */
  type(session: AnnotationSession, id: CommentId, body: string): void {
    need(session, 'type into an edit draft', NAMES.type)(id, body);
  },
  /** The edit is thrown away. */
  cancel(session: AnnotationSession, id: CommentId): Promise<void> {
    return Promise.resolve(need(session, 'cancel an edit', NAMES.cancel)(id)) as Promise<void>;
  },
  /** Enter: the edit becomes the note's text. This is the session's existing method. */
  commit(session: AnnotationSession, id: CommentId, body: string): Promise<void> {
    return session.editComment(id, body);
  },
  /** The edit texts the session says are waiting, by comment id. */
  restored(state: unknown): Map<string, string> {
    const out = new Map<string, string>();
    const bag = state as Record<string, unknown>;
    const take = (id: unknown, v: unknown) => {
      const body = typeof v === 'string' ? v : v && typeof v === 'object' && 'body' in v ? String((v).body) : null;
      if (typeof id === 'string' && body !== null) out.set(id, body);
    };
    for (const key of ['edits', 'editDrafts']) {
      const v = bag[key];
      if (v instanceof Map) for (const [id, val] of v as Map<unknown, unknown>) take(id, val);
      else if (Array.isArray(v)) {
        for (const row of v as Record<string, unknown>[]) {
          const meta = (row['meta'] ?? {}) as Record<string, unknown>;
          take(row['editOf'] ?? row['commentId'] ?? meta['sopEditOf'] ?? meta['editOf'] ?? row['id'], row);
        }
      } else if (v && typeof v === 'object') for (const [id, val] of Object.entries(v)) take(id, val);
    }
    for (const row of (bag['drafts'] as Record<string, unknown>[] | undefined) ?? []) {
      const meta = (row['meta'] ?? {}) as Record<string, unknown>;
      const of = meta['sopEditOf'] ?? meta['editOf'];
      if (of) take(of, row);
    }
    return out;
  },
};
