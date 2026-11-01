// The quiet sign on a sent note that says whether it is kept (TB2 critics: "no lost notes" only helps if the owner can
// see it is true). Pure: it reads the annotation session's state.
import type { NoteKept } from '@sop/ui';
import type { ThreadId } from '../annotations/boundary';
import type { AnnotationState } from '../annotations/session';

/**
 * Whether a note's sent text is kept:
 * - 'saved': in the library (the session writes to the store);
 * - 'pending': not yet: the PDF is being saved, or waits for the owner's answer;
 * - 'tab': only in this tab until it closes (the PDF is not saved);
 * - 'failed': the library would not take it after its retries ("Try again" sends it once more).
 * Null in a view-only tab.
 */
export function keptOf(s: AnnotationState, threadId: ThreadId): NoteKept | null {
  if (s.mode === 'view-only') return null;
  if (s.parked.length > 0) {
    const ids = new Set(s.comments.filter((c) => c.threadId === threadId).map((c) => c.id));
    if (s.parked.some((b) => b.threadIds.includes(threadId) || b.commentIds.some((id) => ids.has(id)))) return 'failed';
  }
  return s.mode === 'stored' ? 'saved' : s.mode === 'pending-save' ? 'pending' : 'tab';
}
