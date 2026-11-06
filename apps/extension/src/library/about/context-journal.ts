// "Your context" never loses a key (R92 with the no-lost-text rules). Every key typed in the About box is written at once,
// synchronously, to the R65 drafts journal (viewer/annotations/draft-journal.ts), keyed as the viewer's own drafts are:
// - a new context (no document note yet): `sop-draft:c:<comment id>`, a comment entry that carries the whole draft row and its
//   new whole-document thread, as the draft keeper writes before the store has confirmed a draft;
// - a change to the existing context: `sop-draft:e:<comment id>`, an edit entry of that sent note (R54).
// The entry goes once the store has the same words. Until then, after a crash:
// - the viewer brings it back when the PDF opens (its draft keeper adopts entries of tabs that are gone, and of its own tab
//   after a reload): a new context as a whole-document note box with the text, a change as the note's editor with the text;
// - the library's About box brings it back when it opens for that reading (`recover`), if no live tab owns it.
// Entries are owned by a tab id, as the viewer's are: the library page holds one of its own through the same tab presence, so a
// viewer tab never adopts words while the library page that typed them is still open, and the other way round.
// The library adopts only entries an About box wrote (edit ids marked "-ctx-", or a comment entry with its whole row and a
// whole-document thread): words typed in a note card belong to the viewer's own restore.
// R101 (TB5 code and security critic, finding 3): words older than the note itself (it was changed since, by a restore, the viewer
// or later sync) never replace it. They are set aside for "Recovered notes" (draft-journal.ts), and the box shows the newer note.
import type { CommentId, CommentRow, DocumentId, TabId, ThreadId, ThreadRow } from '@sop/core';
import { type DraftJournal, type JournalCommentEntry, type JournalEditEntry, localDraftJournal, noteIsNewer } from '../../viewer/annotations/draft-journal';
import { stashMeta } from '../../viewer/annotations/session';
import { createTabPresence, type TabPresence } from '../../viewer/annotations/tab-presence';
import type { DocumentNote } from './about-data';

/** What the words are for: the reading's context note, or the ids its new note will be made with. */
export type ContextTarget = { kind: 'edit'; note: DocumentNote } | { kind: 'new'; threadId: ThreadId; commentId: CommentId };

export interface RecoveredContext {
  text: string;
  /** For words of a context that did not exist yet: the ids to make it with (the journal's own). */
  fresh: { threadId: ThreadId; commentId: CommentId } | null;
}

export interface ContextKeeper {
  readonly tabId: TabId;
  /** One key: the words are in the journal when this returns. Empty words take this box's copy away (nothing to keep). */
  typed(this: void, documentId: DocumentId, text: string, target: ContextTarget): void;
  /**
   * The store now has `saved`, written for `before`; `after` is what the words are for now (a new context is now a note; a
   * context emptied away is none). The copy goes, unless newer words (`latest`) were typed meanwhile: those are journaled now.
   */
  saved(this: void, documentId: DocumentId, saved: string, latest: string, before: ContextTarget, after: ContextTarget | null): void;
  /** Words an About box typed for this reading that never reached the store, from this page or a tab that is gone. */
  recover(this: void, documentId: DocumentId, note: DocumentNote | null): Promise<RecoveredContext | null>;
}

/**
 * Edit sessions of an About box: they sort by when they began, as the viewer's own do (the store keeps the newest session of a
 * tab), and carry a mark the viewer's sessions never have.
 */
const EDIT_MARK = '-ctx-';
const newEditId = (): string => `${Date.now().toString(36).padStart(10, '0')}${EDIT_MARK}${crypto.randomUUID()}`;

export function createContextKeeper(o: { journal: DraftJournal | null; tabId: TabId; liveTabs: () => Promise<TabId[]> }): ContextKeeper {
  const { journal, tabId } = o;
  const editIds = new Map<CommentId, string>();
  const editIdFor = (id: CommentId): string => {
    let e = editIds.get(id);
    if (e === undefined) editIds.set(id, (e = newEditId()));
    return e;
  };
  /** Removes an entry this page owns; another tab's entry is left to that tab. */
  const removeOwn = (kind: 'comment' | 'edit', id: CommentId): void => {
    const j = journal?.get(kind, id);
    if (j && j.tab === tabId) journal?.remove(kind, id);
  };

  const write = (documentId: DocumentId, text: string, target: ContextTarget): void => {
    if (journal === null) return;
    const at = Date.now();
    if (target.kind === 'edit') {
      const entry: JournalEditEntry = {
        v: 1,
        kind: 'edit',
        documentId,
        commentId: target.note.comment.id,
        threadId: target.note.thread.id,
        editId: editIdFor(target.note.comment.id),
        tab: tabId,
        body: text,
        at,
        pending: true,
      };
      journal.put(entry);
      return;
    }
    const thread: ThreadRow = {
      id: target.threadId,
      documentId,
      anchor: { kind: 'document' },
      pageIndex: null,
      sortKey: null,
      placement: 'placed',
      draftOfTab: tabId,
      createdAt: at,
      updatedAt: at,
      deletedAt: null,
      rev: 0,
      hlc: '',
    };
    const row: CommentRow & { draftOfTab: TabId } = {
      id: target.commentId,
      threadId: target.threadId,
      documentId,
      author: 'me',
      body: text,
      draftOfTab: tabId,
      // As the viewer's own new notes carry it: the restored draft's whole-document thread, so its note box can be drawn.
      meta: stashMeta(thread, null),
      createdAt: at,
      editedAt: null,
      deletedAt: null,
      rev: 0,
      hlc: '',
    };
    const entry: JournalCommentEntry = { v: 1, kind: 'comment', documentId, commentId: target.commentId, threadId: target.threadId, tab: tabId, body: text, at, pending: true, row, thread };
    journal.put(entry);
  };

  const forget = (target: ContextTarget): void => {
    if (target.kind === 'edit') removeOwn('edit', target.note.comment.id);
    else removeOwn('comment', target.commentId);
  };

  return {
    tabId,
    typed(documentId, text, target) {
      if (text.trim() === '') forget(target); // emptying the box deletes words on purpose; the stored note stays until saved
      else write(documentId, text, target);
    },
    saved(documentId, saved, latest, before, after) {
      if (before.kind === 'new' && after?.kind !== 'new') removeOwn('comment', before.commentId); // the new note exists now
      const now = after ?? before;
      if (latest === saved || latest.trim() === '') forget(now);
      else write(documentId, latest, now);
    },
    async recover(documentId, note) {
      if (journal === null) return null;
      return journal.locked(documentId, async () => {
        const live = new Set(await o.liveTabs().catch(() => [] as TabId[]));
        const ours = (tab: TabId) => tab === tabId || !live.has(tab);
        for (const j of journal.list(documentId)) {
          if (j.closing === true || !j.pending || !ours(j.tab)) continue;
          if (note !== null && j.kind === 'edit' && j.commentId === note.comment.id && j.editId.includes(EDIT_MARK)) {
            if (j.body === note.comment.body) {
              journal.remove('edit', j.commentId); // it was saved after all
              continue;
            }
            if (noteIsNewer(note.comment, j.at)) {
              // R101: the note changed after these words were typed. They are kept for "Recovered notes", never saved over it.
              if (journal.keepAside?.(`${j.commentId}.${j.editId}`, { kind: 'edit', body: j.body, at: j.at }) === true) journal.remove('edit', j.commentId);
              continue;
            }
            journal.put({ ...j, tab: tabId }); // this page owns it now
            editIds.set(j.commentId, j.editId);
            return { text: j.body, fresh: null };
          }
          if (note === null && j.kind === 'comment' && j.row !== undefined && j.thread?.anchor.kind === 'document') {
            journal.put({ ...j, tab: tabId, row: { ...j.row, draftOfTab: tabId }, thread: { ...j.thread, draftOfTab: tabId } });
            return { text: j.body, fresh: { threadId: j.threadId, commentId: j.commentId } };
          }
        }
        return null;
      });
    },
  };
}

let libraryPresence: TabPresence | null = null;

/** The library page's keeper: its own tab id, held through the tab presence for as long as the page lives. */
export function libraryContextKeeper(): ContextKeeper {
  libraryPresence ??= createTabPresence();
  const presence = libraryPresence;
  return createContextKeeper({ journal: localDraftJournal(), tabId: presence.tabId, liveTabs: () => presence.liveTabs() });
}
