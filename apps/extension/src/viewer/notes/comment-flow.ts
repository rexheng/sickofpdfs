// What Ctrl+Alt+M (and the toolbar's Comment button) does, before anything is drawn (spec "The Ctrl+Alt+M flow").
//
// - Text selected: a new note on it. A note adds no style and never changes a mark's colour (ruling R68): on words with
//   no style it shows a dotted underline, and on marked words it keeps their mark. A selection over an existing note
//   opens that note instead (the most recent, if several overlap), so notes never stack up as duplicates.
// - Nothing selected, pointer over a page: a note at that point.
// - Otherwise: a note on the page in view.
// - Ctrl+Alt+Shift+M: a note on the whole document.
//
// The session draws at once; the note's first comment starts as a draft and is written only when it is sent.
import type { Anchor, CharRange, CommentId, ThreadId } from '../annotations/boundary';
import type { NotesWiring } from './wiring';

/** A page point in points (unrotated, top-left origin), as PageListApi.pdfPointAt gives it. */
export interface PointerAt {
  pageIndex: number;
  x: number;
  y: number;
}

export interface CommentFlowDeps {
  wiring: NotesWiring;
  clearSelection(): void;
  /** The page in view (0-based). */
  currentPage(): number;
  /** A page's unrotated size in points. */
  pageSize(pageIndex: number): { width: number; height: number } | undefined;
}

/** The note to show: one that was there already, or a new one whose first comment is an empty draft. */
export type NoteTarget = { kind: 'existing'; threadId: ThreadId } | { kind: 'new'; threadId: ThreadId; commentId: CommentId; anchor: Anchor };

/**
 * What Ctrl+Alt+M acts on, read when the key is pressed: before the margin opens and the pages move, which can rebuild
 * the text layer and its selection.
 */
export interface CommentContext {
  /** The chars the selection covers, by page. */
  ranges: CharRange[];
  /** The page point under the pointer, while the pointer is over a page. */
  pointer: PointerAt | null;
}

/**
 * Steps around drawing the note. `before` runs once everything the note needs is read (its anchor is built), just
 * before it is drawn: the margin opens there, so the pages move only once, and the engine is not busy drawing them
 * while the anchor is measured. `after` runs in the same tick as the note is made, so the card is drawn active, with
 * its box focused, in one render.
 */
export interface OpenSteps {
  before(): void;
  after(target: NoteTarget): void;
}

export interface CommentFlow {
  /** Ctrl+Alt+M. Null when nothing could be made (a view-only PDF, or a second press while the first is still running). */
  comment(at: CommentContext, steps?: OpenSteps): Promise<NoteTarget | null>;
  /** Ctrl+Alt+Shift+M. */
  documentNote(steps?: OpenSteps): NoteTarget | null;
}

export function createCommentFlow(d: CommentFlowDeps): CommentFlow {
  const session = () => d.wiring.session;
  let busy = false;

  /** The most recent note whose passage overlaps the selection. */
  function existingOn(ranges: CharRange[]): ThreadId | null {
    const s = session();
    const created = new Map(s.state().threads.map((t) => [t.id, t.createdAt]));
    let best: ThreadId | null = null;
    for (const r of ranges) {
      const t = s.threadAt(r);
      if (t !== null && (best === null || (created.get(t) ?? 0) >= (created.get(best) ?? 0))) best = t;
    }
    return best;
  }

  function start(anchor: Anchor, steps?: OpenSteps): NoteTarget | null {
    const s = session();
    if (s.state().mode === 'view-only') return null;
    steps?.before();
    const { threadId, commentId } = s.startThread(anchor, { highlight: null });
    const target: NoteTarget = { kind: 'new', threadId, commentId, anchor };
    steps?.after(target);
    return target;
  }

  return {
    async comment(ctx, steps) {
      if (busy || session().state().mode === 'view-only') return null;
      const ranges = ctx.ranges.filter((r) => r.end > r.start);
      if (ranges.length > 0) {
        const existing = existingOn(ranges);
        if (existing !== null) {
          d.clearSelection();
          const target: NoteTarget = { kind: 'existing', threadId: existing };
          steps?.before();
          steps?.after(target);
          return target;
        }
        busy = true;
        try {
          const anchor = await d.wiring.makeTextAnchor(ranges);
          d.clearSelection(); // the note's passage shows where the selection was
          return start(anchor, steps);
        } finally {
          busy = false;
        }
      }
      const at = ctx.pointer;
      const size = at ? d.pageSize(at.pageIndex) : undefined;
      if (at && size && size.width > 0 && size.height > 0) {
        const u = Math.min(1, Math.max(0, at.x / size.width));
        const v = Math.min(1, Math.max(0, at.y / size.height));
        return start({ kind: 'point', page: at.pageIndex, point: [u, v] }, steps);
      }
      return start({ kind: 'page', page: d.currentPage() }, steps);
    },

    documentNote(steps) {
      if (busy) return null;
      return start({ kind: 'document' }, steps);
    },
  };
}
