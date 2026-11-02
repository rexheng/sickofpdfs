/**
 * The annotation session: one in-memory model of one document's notes (Phase 2, S9).
 *
 * The rule that shapes everything: draw first, then write. Every change is applied to the in-memory model and
 * announced to subscribers at once. The store write follows, in order, one batch at a time.
 *
 * Where notes get lost, and what this file does about it:
 *
 * - Order of saves.
 *   1. Writes are a first-in first-out queue with one write in flight. A batch never overtakes an earlier one.
 *   2. Inside a batch, parents come first (marks, threads, then comments), because comments point at threads.
 *   3. Sending a note first flushes its draft, then writes the live rows. If the draft keeper still had a delayed
 *      save pending, that save could land after ours and turn the sent note back into a draft that nobody lists.
 *   4. Nothing is written while the save question is open, or when the PDF is memory-only. Those changes wait in
 *      the queue and are written, oldest first, the moment the PDF is saved. While a save is on its way they are also
 *      kept at once in the save-pending record (R67 a, save-pending.ts), so a tab that closes or crashes mid-save
 *      loses nothing. Rows made before the save carry the file's fingerprint as their document id, never ''.
 *   5. A batch the store keeps refusing is parked after its retries, so it cannot hold up the writes behind it. The
 *      text of its new comments is handed to the draft keeper as drafts, so it survives a reload, and `retryParked`
 *      sends it again.
 * - Saving (R67). Only real content saves: the first applied mark, or the first keystroke in a new note (b). The
 *   first-mark Undo goes as soon as there is anything else, in any tab (c); a save a note started has none (f).
 * - Undo.
 *   1. Undo and redo run inverse batches (undo.ts) and refuse to overwrite a newer edit from another tab.
 *   2. Undoing the save that a first mark caused ("Undo" on the status chip) deletes the document and every row of
 *      it in the store. The model then drops every row it had stored, and the mark that caused the save, even if that
 *      mark was still in the queue. What was never written, and what is still being typed, stays.
 *      Without that, a stale mark would be written back into a document the owner just un-saved.
 * - Tabs in step.
 *   1. A change event for this document reloads the rows. Events with this tab's own id are ignored.
 *   2. A reload merges. Rows we have not written yet are never dropped, and a reload that raced one of our own
 *      writes is thrown away and repeated.
 *   3. Drafts belong to the tab that started them. Nothing about a draft is published to other tabs.
 * - A stuck store or draft keeper never freezes marking. Only the in-memory part of an action is in the action chain;
 *   waiting for the store happens after it, with a limit.
 *
 * What this file assumes of its neighbours (each one is a decision for the merge, see the S9 report):
 * - S2 `writeAnnotations` upserts a thread or comment with `draftOfTab: null` over a stored draft and makes it live.
 *   Sending a note uses that, in one transaction with the highlight, and does not call `sendDraft`.
 * - S8 `change(row, thread)` stores the row exactly as given, `meta` included, and `restore` returns it unchanged.
 *   A root draft carries its thread and chosen highlight in `meta.sopDraft`, because `restore` returns comments only.
 * - S8 `drop(id)` is for notes that were never sent. It is not called after a send on a saved PDF.
 * - Task 30's `firstMark()` resolves once the save has finished or the question is on screen, and the controller
 *   reports every change of `state` through `subscribe`.
 */

import {
  planStyle as corePlanStyle,
  resolveAnchor as coreResolveAnchor,
  type Anchor,
  type AnchorContext,
  type AnnotationOp,
  type CharPos,
  type CharRange,
  type CommentId,
  type CommentRow,
  type DocumentId,
  type DraftKeeper,
  type EditDraft,
  type MarkColor,
  type MarkId,
  type MarkRow,
  type MarkStyle,
  type PlanStyleFn,
  type Resolution,
  type ResolveAnchorFn,
  type SaveController,
  type SaveState,
  type SessionStore,
  type StoreChange,
  type TabId,
  type TabPresence,
  type ThreadId,
  type ThreadRow,
} from './boundary';
import type { PendingSave, PendingSaves } from './save-pending';
import {
  anchorKey,
  createUndoStack,
  describeChange,
  opsFor,
  rowKey,
  type AnyRow,
  type Change,
  type RowChange,
  type Table,
} from './undo';

// ---------------------------------------------------------------- the public shape (contracts plan section 7)

/**
 * A batch of changes that the store keeps refusing. Its notes are safe as drafts; the card shows
 * "Couldn't save this note" with a Retry that calls `retryParked()`.
 */
export interface ParkedBatch {
  id: string;
  commentIds: CommentId[];
  threadIds: ThreadId[];
  markIds: MarkId[];
}

export interface AnnotationState {
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  drafts: CommentRow[];
  placement: Map<string /* mark or thread id */, Resolution>;
  active: ThreadId | null;
  focusedMark: MarkId | null;
  mode: 'stored' | 'pending-save' | 'memory-only' | 'view-only';
  /** Changes the store would not take after the retries. Empty when all is well. */
  parked: ParkedBatch[];
  /**
   * R54: edits of sent notes that are not sent yet, oldest first. After a reload these are the edits this tab adopted;
   * the card reopens its editor with this text. The live text (`comments`) stays as it is until the edit is sent.
   */
  editDrafts: SessionEditDraft[];
}

/** An unsent edit of a sent note (R54). */
export type SessionEditDraft = Pick<EditDraft, 'commentId' | 'threadId' | 'body'>;

export interface AnnotationSession {
  readonly tabId: TabId;
  /** Resolves when the stored rows are loaded and every one has a placement. Not part of the contract; tests and wiring use it. */
  readonly ready: Promise<void>;
  state(): AnnotationState;
  subscribe(cb: () => void): () => void;
  applyStyle(ranges: CharRange[], style: Exclude<MarkStyle, 'area'>, color: MarkColor | null): Promise<void>;
  /** An `area` anchor, or a part of a figure (`figure` with `sub.rect`): an Alt+drag inside a figure is stored relative to it. */
  addAreaMark(a: Extract<Anchor, { kind: 'area' | 'figure' }>): Promise<MarkId>;
  recolor(id: MarkId, c: MarkColor): Promise<void>;
  removeMark(id: MarkId): Promise<void>;
  startThread(a: Anchor, o: { highlight: MarkColor | null }): { threadId: ThreadId; commentId: CommentId };
  startReply(t: ThreadId): CommentId;
  typeDraft(id: CommentId, body: string): void;
  send(id: CommentId): Promise<void>;
  cancel(id: CommentId): Promise<void>;
  /**
   * Sends an edit of a sent note: the live text becomes `body`. If an edit was open (`typeEdit`), it is closed once the
   * new text is written. On a draft it is `typeDraft`.
   */
  editComment(id: CommentId, body: string): Promise<void>;
  /**
   * R54: opens the editor on a sent note of the owner. Returns the text the editor starts with: the unsent edit if there
   * is one (typed earlier, or restored after a reload), otherwise the live text. Null when the note cannot be edited
   * (a Claude reply, a draft, a note that is gone, or a view-only PDF). Nothing is stored until the first `typeEdit`.
   */
  startEdit(id: CommentId): string | null;
  /** R54: one keystroke of an edit. Like `typeDraft`: the text is saved by the draft keeper as a tab-owned edit draft. */
  typeEdit(id: CommentId, body: string): void;
  /** R54: the edit is thrown away. The live text never changed; the edit draft is closed in the store. */
  cancelEdit(id: CommentId): Promise<void>;
  removeComment(id: CommentId): Promise<void>;
  removeThread(id: ThreadId): Promise<void>;
  threadAt(r: CharRange): ThreadId | null;
  setActive(t: ThreadId | null): void;
  setFocusedMark(m: MarkId | null): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
  /** Sends every parked batch to the store once more. Whatever fails again is parked again. */
  retryParked(): Promise<void>;
  /** Looks for drafts whose tab is gone and takes them. Runs on open and when this tab becomes visible; wiring may call it too. */
  adoptDrafts(): Promise<void>;
  dispose(): void;
}

export interface SessionDeps {
  store: SessionStore | null;
  save: SaveController | null;
  anchors: AnchorContext;
  drafts: DraftKeeper;
  presence: TabPresence;
  makeTextAnchor(ranges: CharRange[]): Promise<Extract<Anchor, { kind: 'text' }>>;
  documentId(): DocumentId | null;
  incognito: boolean;
  now(): number;
  /** Defaults to S3's planStyle. */
  planStyle?: PlanStyleFn;
  /** Defaults to S3's resolveAnchor. */
  resolveAnchor?: ResolveAnchorFn;
  /** Waits between retries of a failing write; the batch is parked after this many retries. Default 250, 500, 1000, 2000, 4000 ms. */
  retryMs?: readonly number[];
  /** Told about failures that the session survives (a failed write that will be retried, a placement that threw). */
  onError?(e: unknown, where: string): void;
  /** Told what an undo or a redo did, in a few plain words ("Note removed", "Mark back"), for the snackbar. */
  onUndone?(what: string): void;
  /**
   * R67: the opened file's SHA-256. Rows made before the save lands carry it as their document id (never ''), and the
   * save-pending record is kept under it.
   */
  fingerprint?: string | null;
  /** R67 (a): where notes made while the save is on its way are kept (save-pending.ts). The viewer passes `localPendingSaves()`. */
  pending?: PendingSaves | null;
}

// ---------------------------------------------------------------- small helpers

type Mode = AnnotationState['mode'];
type TextAnchor = Extract<Anchor, { kind: 'text' }>;

/** The extra fields a root draft carries when it is saved, so that a restored draft can rebuild its card. */
interface DraftStash {
  thread: ThreadRow;
  highlight: MarkColor | null;
}
const STASH_KEY = 'sopDraft';

const DEFAULT_RETRY_MS: readonly number[] = [250, 500, 1000, 2000, 4000];
const REFRESH_ROUNDS = 4;
/** How long undo waits for the store to catch up, and how long a send waits for the draft keeper. */
const SYNC_WAIT_MS = 400;
const FLUSH_WAIT_MS = 2000;
/** A caller waiting for its change to be written gives up after this; the change itself keeps being retried. */
const SETTLE_WAIT_MS = 3000;
/** After the PDF is first stored, drafts of tabs that are gone are looked for once more, when the roll call has settled. */
const SECOND_ADOPT_MS = 1500;
/** After another tab's Forget, the held notes are put in the journal again this long after the first time. */
const HELD_AGAIN_MS = 1000;

function newId<T extends string>(): T {
  return String(crypto.randomUUID()) as T;
}

function blankSync(): { rev: number; hlc: string; deletedAt: null } {
  return { rev: 0, hlc: '', deletedAt: null };
}

function cmpPos(a: CharPos, b: CharPos): number {
  return a.page !== b.page ? a.page - b.page : a.index - b.index;
}

/** The page a row belongs to and where it sits on it (0 to 1), for ordering. */
function placeOf(a: Anchor): { pageIndex: number | null; sortKey: number | null } {
  switch (a.kind) {
    case 'text': {
      const onStart = a.rects.find((r) => r.page === a.start.page) ?? a.rects[0];
      return { pageIndex: a.start.page, sortKey: onStart?.rects[0]?.[1] ?? 0 };
    }
    case 'area':
    case 'figure':
      return { pageIndex: a.page, sortKey: a.rect[1] };
    case 'point':
      return { pageIndex: a.page, sortKey: a.point[1] };
    case 'page':
      return { pageIndex: a.page, sortKey: 0 };
    case 'document':
      return { pageIndex: null, sortKey: null };
  }
}

/**
 * Turns the selection's ranges into continuous runs. A run is one range, or ranges on neighbouring pages (a
 * selection that crosses a page break). Ranges on one page that overlap or touch are merged; a gap starts a new run.
 */
export function groupRanges(ranges: readonly CharRange[]): CharRange[][] {
  const valid = ranges.filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.pageIndex >= 0 && r.end > r.start);
  valid.sort((a, b) => a.pageIndex - b.pageIndex || a.start - b.start);
  const merged: CharRange[] = [];
  for (const r of valid) {
    const last = merged[merged.length - 1];
    if (last && last.pageIndex === r.pageIndex && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const runs: CharRange[][] = [];
  for (const r of merged) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run && last && r.pageIndex === last.pageIndex + 1) run.push(r);
    else runs.push([r]);
  }
  return runs;
}

// Ties keep the order rows were added in: sort is stable and the maps are in insertion order. Two notes made in the same
// millisecond (or under a test clock that does not move) therefore stay in the order they were written.
function byReading(a: { pageIndex: number | null; sortKey: number | null; createdAt: number }, b: typeof a): number {
  return (a.pageIndex ?? -1) - (b.pageIndex ?? -1) || (a.sortKey ?? -1) - (b.sortKey ?? -1) || a.createdAt - b.createdAt;
}

function byCreated(a: { createdAt: number }, b: typeof a): number {
  return a.createdAt - b.createdAt;
}

function readStash(row: CommentRow): DraftStash | null {
  const s = (row.meta as unknown as Record<string, unknown>)[STASH_KEY];
  if (!s || typeof s !== 'object') return null;
  const stash = s as Partial<DraftStash>;
  const t = stash.thread;
  const colour = stash.highlight;
  const goodColour = colour === null || colour === undefined || (Number.isInteger(colour) && colour >= 1 && colour <= 5);
  const goodThread = !!t && typeof t === 'object' && typeof t.id === 'string' && !!t.anchor && typeof t.anchor === 'object' && typeof t.anchor.kind === 'string';
  return goodThread && goodColour ? { thread: t, highlight: colour ?? null } : null;
}

// ---------------------------------------------------------------- the write queue

/** What a committed change hands back so the caller can wait for the store after it has let go of the action chain. */
interface Committed {
  batch: Batch | null;
  started: boolean;
}

interface Batch {
  id: string;
  ops: AnnotationOp[];
  /** Resolves when the next write attempt ends, whether it worked or not, or when the batch is discarded or parked. */
  firstAttempt: Promise<void>;
  attempted(): void;
  /** Failed attempts so far. */
  attempts: number;
  /** Set once a parked batch has had its one probe after a later write went through. */
  probed: boolean;
  /** The text of its new comments has been given to the draft keeper as drafts. */
  safe: boolean;
  /** Resolves once the batch is written, or dropped because the document was forgotten. Never while it is parked. */
  gone: Promise<void>;
  leave(): void;
}

function newBatch(ops: AnnotationOp[]): Batch {
  let leave = () => {};
  const gone = new Promise<void>((r) => (leave = r));
  const b: Batch = { id: newId<string>(), ops, firstAttempt: Promise.resolve(), attempted() {}, attempts: 0, probed: false, safe: false, gone, leave };
  renewAttempt(b);
  return b;
}

/** Gives a batch a fresh "first attempt" promise, for a retry. */
function renewAttempt(b: Batch): void {
  b.firstAttempt = new Promise<void>((r) => (b.attempted = r));
}

/** What a draft carries to be restored in its card (also written by About this PDF's context journal, S18). */
export function stashMeta(thread: ThreadRow, highlight: MarkColor | null): CommentRow['meta'] {
  return { [STASH_KEY]: { thread, highlight } } as unknown as CommentRow['meta'];
}

// ---------------------------------------------------------------- the session

export function createAnnotationSession(d: SessionDeps): AnnotationSession {
  const tabId = d.presence.tabId;
  const retryMs = d.retryMs ?? DEFAULT_RETRY_MS;
  const planStyleFn: PlanStyleFn = d.planStyle ?? corePlanStyle;
  const resolveFn: ResolveAnchorFn = d.resolveAnchor ?? coreResolveAnchor;
  const undo = createUndoStack();

  // The model. `marks`, `threads` and `comments` hold what is on screen: rows from the store plus rows we made.
  // `threads` also holds this tab's draft threads (draftOfTab set). `comments` holds sent comments only.
  const marks = new Map<MarkId, MarkRow>();
  const threads = new Map<ThreadId, ThreadRow>();
  const comments = new Map<CommentId, CommentRow>();
  const drafts = new Map<CommentId, CommentRow>();
  const placement = new Map<string, Resolution>();
  /** Highlights drawn for a note that has not been sent. In memory only until the note is sent or the mark is touched. */
  const pendingMarks = new Map<MarkId, ThreadId>();
  /** Root drafts: what the new thread was asked to highlight. */
  const rootDrafts = new Map<CommentId, { highlight: MarkColor | null }>();
  /** Drafts the keeper has been given at least once. An untouched empty draft is never saved. */
  const keeperHas = new Set<CommentId>();
  /**
   * Drafts this page sent or threw away. A later look for drafts never brings one back: the keeper can still hold a copy
   * for a moment after the send, and the note may have been emptied or deleted since.
   */
  const settledHere = new Set<CommentId>();
  /** R54: unsent edits of sent notes, by comment, in the order they began. What the editors show. */
  const edits = new Map<CommentId, SessionEditDraft>();
  let active: ThreadId | null = null;
  let focusedMark: MarkId | null = null;

  const listeners = new Set<() => void>();
  let snap: AnnotationState | null = null;
  let marksVersion = 0;
  let disposed = false;

  // Save state.
  let mode: Mode = 'memory-only';
  let lastSaveKind: SaveState['kind'] | null = null;
  /** The other tab forgot this document while ours still says "saved". Writes stop until it comes back. */
  let docGone = false;
  let docGoneTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rows made by the change that started the save. "Undo" on the chip removes them. */
  const savedTriggerKeys = new Set<string>();
  let kick: Promise<void> | null = null;
  /** R67 (c, f): the save this tab is starting gets no Undo (a note started it, or more was made before it began). */
  let kickNoUndo = false;
  /** R67 (b): typing started a save that has not been undone yet; keystrokes do not start another (a failed one is retried from the chip). */
  let typingSaved = false;
  /** R67 (b): the note whose first keystroke started this tab's save, while nothing else has been made. */
  let typedTrigger: CommentId | null = null;
  /** R67 (a): a save is on its way (or failed): what is made now is kept in the save-pending record. */
  let ownerSave = false;
  /** R67 (a): the save-pending record of this tab exists. */
  let pendingKept = false;
  /** R67 (a): the records of tabs that went have been looked for (once, when the save state is first known). */
  let pendingLooked = false;
  /** R67 (a): this page life, for its save-pending record (a tab keeps its id across reloads, R65). */
  const life = newId<string>();
  /** The second look for drafts of tabs that are gone (onBecameStored). */
  let secondAdopt: ReturnType<typeof setTimeout> | null = null;
  /**
   * TB4 ruling (Forget wins): the owner forgot this PDF in another tab while this tab held unsent notes. They stay here, in
   * memory, and their text is kept in the journal (`keepUnsaved`) until the PDF is saved again, the owner says No, or the
   * note goes. Nothing is saved on its own.
   */
  let heldAfterForget = false;
  let heldAgain: ReturnType<typeof setTimeout> | null = null;

  // The write queue.
  const queue: Batch[] = [];
  /** Batches the store kept refusing. They wait here for a Retry, and do not hold up the queue. */
  const parked: Batch[] = [];
  /** Comments whose text was handed to the keeper as a draft because their batch is parked. */
  const safeCopied = new Set<CommentId>();
  /** Keys of rows known to be in the store. */
  const persisted = new Set<string>();
  let inflight: Batch | null = null;
  let inflightDone: Promise<void> | null = null;
  let writeEpoch = 0;
  let pumping = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;

  let refreshing: Promise<void> | null = null;
  let refreshAgain = false;

  const resolveQueue = new Set<string>();
  let resolving: Promise<void> | null = null;

  let chain: Promise<unknown> = Promise.resolve();
  const cleanups: (() => void)[] = [];

  function report(e: unknown, where: string): void {
    try {
      d.onError?.(e, where);
    } catch {
      /* a failing logger must not break notes */
    }
  }

  // ------------------------------------------------------------ snapshot and subscription

  function state(): AnnotationState {
    if (snap) return snap;
    const threadList = [...threads.values()].sort(byReading);
    const liveThreads = new Set(threadList.map((t) => t.id));
    snap = {
      marks: [...marks.values()].sort(byReading),
      threads: threadList,
      comments: [...comments.values()].filter((c) => liveThreads.has(c.threadId)).sort(byCreated),
      drafts: [...drafts.values()].sort(byCreated),
      placement: new Map(placement),
      active,
      focusedMark,
      mode,
      parked: parked.map((b) => ({
        id: b.id,
        commentIds: b.ops.filter((o) => o.table === 'comments' && o.op !== 'soft-delete').map((o) => o.row.id as CommentId),
        threadIds: b.ops.filter((o) => o.table === 'threads' && o.op !== 'soft-delete').map((o) => o.row.id as ThreadId),
        markIds: b.ops.filter((o) => o.table === 'marks' && o.op !== 'soft-delete').map((o) => o.row.id as MarkId),
      })),
      // An edit of a note that is gone (deleted in another tab) is hidden; the keeper keeps it and it comes back with the note.
      editDrafts: [...edits.values()].filter((e) => comments.has(e.commentId)).map((e) => ({ ...e })),
    };
    return snap;
  }

  function emit(): void {
    snap = null;
    keepPending(); // R67 (a): while a save is on its way, every change is kept at once
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (e) {
        report(e, 'subscriber');
      }
    }
  }

  // ------------------------------------------------------------ save state

  function computeMode(): Mode {
    if (d.incognito) return 'view-only';
    if (!d.store || !d.save) return 'memory-only';
    switch (d.save.state.kind) {
      case 'incognito':
        return 'view-only';
      case 'memory-only':
        return 'memory-only';
      case 'saved':
        return docGone ? 'pending-save' : 'stored';
      default:
        return 'pending-save';
    }
  }

  /** The id rows are written under. */
  function currentDocId(): DocumentId | null {
    const s = d.save?.state;
    if (s && s.kind === 'saved') return s.documentId;
    return d.documentId();
  }

  /** The id a row is made under: the library id, or, before the save lands, the file's fingerprint (R67: never ''). */
  function stampId(): DocumentId {
    return (currentDocId() ?? d.fingerprint ?? '') as DocumentId;
  }

  function canWrite(): boolean {
    return !disposed && d.store !== null && mode === 'stored' && currentDocId() !== null;
  }

  function canRead(): boolean {
    return !disposed && d.store !== null && mode !== 'view-only' && currentDocId() !== null;
  }

  /** Resolves when the save state passes `test`. `cancel` stops listening if nobody needs the answer any more. */
  function waitForSaveState(test: (s: SaveState) => boolean): { done: Promise<void>; cancel(): void } {
    const save = d.save;
    if (!save || test(save.state)) return { done: Promise.resolve(), cancel() {} };
    let off = () => {};
    const done = new Promise<void>((resolve) => {
      off = save.subscribe((s) => {
        if (test(s)) {
          off();
          resolve();
        }
      });
    });
    return { done, cancel: () => off() };
  }

  /** A wait that gives up. A stuck store or keeper must never freeze marking, so every wait on one has a limit. */
  function within(p: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      Promise.resolve(p).then(
        () => (clearTimeout(t), resolve()),
        () => (clearTimeout(t), resolve()),
      );
    });
  }

  /**
   * R67 (c): there is more here than the mark that started the save (another mark, a note box, a typed note). Its Undo
   * goes, in this tab and in every other (the controller tells them), so Undo only ever removes the save and that mark.
   */
  /** A sent note, or a draft with text, is in this tab (R67 f tightened). */
  function holdsNoteText(): boolean {
    if (comments.size > 0) return true;
    for (const c of drafts.values()) if (c.body.trim() !== '') return true;
    return false;
  }

  /** Something here is not in the store and must not be lost: a draft with text, or a write still waiting. */
  function holdsUnwritten(): boolean {
    for (const c of drafts.values()) if (c.body.trim() !== '') return true;
    return queue.some((b) => b.ops.length > 0) || parked.some((b) => b.ops.length > 0);
  }

  function contentAdded(o: { content: boolean } = { content: true }): void {
    // N1 (re-check of R67): an empty note box ends the first-mark Undo, but it is not content. It does not stop a note that
    // was typed and erased from taking its save back, here or in another tab.
    if (o.content) {
      typedTrigger = null;
      if (kick) kickNoUndo = true;
    }
    try {
      d.save?.endUndo?.({ content: o.content });
    } catch (e) {
      report(e, 'endUndo');
    }
  }

  /**
   * Called by every change that creates rows. On a PDF that is not saved yet it asks the save controller to save it
   * ("your first mark saves it"). Returns whether this call started the save.
   */
  function startSaveIfNeeded(triggerKeys: string[], o: { note?: boolean; content?: boolean } = {}): boolean {
    const save = d.save;
    if (mode !== 'pending-save' || !save || kick) return false;
    const s = save.state;
    if (s.kind === 'asking') return false; // the question is already open
    for (const k of triggerKeys) savedTriggerKeys.add(k);
    // R67 (f), tightened: a save that carries any note text has no Undo: a note started it, or a sent note or a typed
    // draft is already here (a save that failed earlier and is started again by a mark or by Enter, for one).
    kickNoUndo = o.note === true || holdsNoteText();
    // R67 tightened (2): what started the save is save-pending at once, before the wait for "checking" to end. A PDF
    // judged not learning asks first, so nothing is kept for it until the owner says Yes.
    if (s.kind === 'checking' || s.kind === 'unsure') markOwnerSave();
    // R67 tightened (1): every other tab on this PDF, or on a copy still being identified, loses its first-mark Undo now.
    try {
      save.announce?.({ content: o.content !== false });
    } catch (e) {
      report(e, 'announce');
    }
    const rows = triggerKeys.length;
    kick = (async () => {
      try {
        // Identity is still being worked out; firstMark would do nothing yet.
        await waitForSaveState((x) => x.kind !== 'checking').done;
        const now = save.state;
        if (!disposed && (now.kind === 'unsure' || now.kind === 'not-learning')) {
          // A "not sure" PDF saves now: what is made from here on is save-pending (R67 a). A "not learning" one asks first.
          if (now.kind === 'unsure') markOwnerSave();
          await save.firstMark({ ...(kickNoUndo ? { undoable: false } : {}), rows, content: o.content !== false });
        } else if (!disposed && now.kind === 'saved') {
          // The PDF turned out to be saved already (another tab's save, or a copy of a saved one): what this change made
          // is more than that save's first mark, so its Undo goes everywhere (R67 tightened 1).
          contentAdded();
        }
        syncSaveState();
      } catch (e) {
        report(e, 'firstMark');
      } finally {
        kick = null;
      }
    })();
    return true;
  }

  /** Waits for the save question to be answered or the save to finish, but not past the point where the user must act. */
  async function afterKick(started: boolean): Promise<void> {
    const k = kick;
    if (!started || !k) return;
    const asking = waitForSaveState((s) => s.kind === 'asking');
    try {
      await Promise.race([k, asking.done]);
    } finally {
      asking.cancel();
    }
  }

  /** The save controller tells us when it changes. This also looks, in case a change went by without a call. */
  function syncSaveState(): void {
    const s = d.save?.state;
    if (s && s.kind !== lastSaveKind) onSaveState(s);
  }

  function onSaveState(s: SaveState): void {
    if (disposed) return;
    const prevKind = lastSaveKind;
    const prevMode = mode;
    lastSaveKind = s.kind;
    if (prevKind === 'saved' && s.kind !== 'saved' && s.kind !== 'incognito') {
      // The save was undone, or the PDF forgotten (here or in another tab, R67 d). The store has lost everything of this
      // document, and so have the journal and the save-pending records (forgetLocalTraces).
      clearDocGoneTimer();
      docGone = false;
      mode = computeMode();
      dropForgottenRows();
      emit();
      if (holdsUnwritten()) {
        // R67 tightened (1): what this tab made that the store never had survives another tab's Undo. Real content saves,
        // so it is saved again at once, with no Undo. The save controller alone tells an Undo ("Not sure") from the owner's
        // Forget (TB4 ruling, Forget wins): after a Forget in another tab nothing saves on its own; the notes stay here and
        // in the journal, and the next mark or letter asks first. After this tab's own Forget, nothing is kept.
        if (s.kind === 'unsure') startSaveIfNeeded([], { note: true });
        else if (d.save?.busy !== 'forget') keepAfterForget();
      }
      return;
    }
    if (s.kind === 'saved') docGone = false;
    mode = computeMode();
    if (mode === 'pending-save' && d.save?.busy === 'save') markOwnerSave(); // Save, Yes, or a learning PDF's own save
    // N2 (re-check of R67): a save finished for a tab that crashed may ask first (not learning). Its notes were already kept,
    // so the record stays while the question is open, and goes only on No (memory-only).
    if (mode === 'memory-only' || mode === 'view-only' || (s.kind === 'asking' && d.save?.busy !== 'save' && d.save?.resuming !== true)) {
      // The owner said No, or the question "Save this PDF?" is open: nothing of this PDF is kept anywhere but this tab.
      ownerSave = false;
      dropPending();
      if (mode === 'memory-only') releaseHeld(); // the owner said No: the notes held after a Forget leave the journal too
    }
    if (prevMode !== 'stored' && mode === 'stored') onBecameStored();
    if (prevMode !== mode) emit();
    if (s.kind !== 'checking') void lookForPending();
  }

  function onBecameStored(): void {
    ownerSave = false; // from here on the store and the keeper keep everything
    stopHolding(); // the keeper keeps the drafts again, in the store and the journal
    compactQueue();
    // Rows made before the save carry the file's fingerprint; the library id may differ (a stamped copy). Stamp them
    // before anything is handed on (finding 1: a draft handed over with the old id was refused and lost).
    patchDocIds();
    // Drafts that could not be saved until now are given to the keeper again.
    for (const c of drafts.values()) if (c.body !== '') pushDraft(c);
    for (const e of edits.values()) pushEdit(e.commentId, e.body);
    keepPending(); // the drafts are the keeper's now; the record keeps only the writes still waiting
    void pump();
    void refresh().then(adoptDraftsImpl);
    // A tab that went a moment ago may still have answered the first roll call; its drafts are taken a little later.
    if (secondAdopt === null) secondAdopt = setTimeout(() => void adoptDraftsImpl(), SECOND_ADOPT_MS);
  }

  // ------------------------------------------------------------ R67 (a): save-pending

  /** A save is on its way: from now on, and for what is already here, the session keeps a save-pending record. */
  function markOwnerSave(): void {
    if (ownerSave || mode !== 'pending-save') return;
    ownerSave = true;
    keepPending();
  }

  /** Writes this tab's save-pending record as the session holds things now, or removes it when it holds nothing. */
  function keepPending(): void {
    const pj = d.pending;
    const fp = d.fingerprint;
    if (!pj || !fp || disposed) return;
    const keeping = (mode === 'pending-save' && ownerSave) || (mode === 'stored' && pendingKept);
    if (!keeping) return;
    const ops: AnnotationOp[] = [];
    for (const b of [...queue, ...parked]) ops.push(...b.ops);
    const draftRows: CommentRow[] = [];
    const editRows: SessionEditDraft[] = [];
    if (mode === 'pending-save') {
      for (const c of drafts.values()) if (c.body.trim() !== '') draftRows.push(keeperRow(c));
      for (const e of edits.values()) editRows.push({ ...e });
    }
    if (ops.length === 0 && draftRows.length === 0 && editRows.length === 0) {
      dropPending();
      return;
    }
    const rec: PendingSave = { v: 1, fingerprint: fp, tab: tabId, life, at: d.now(), undoable: !kickNoUndo, ops, drafts: draftRows, edits: editRows };
    pendingKept = pj.put(rec);
  }

  function dropPending(): void {
    if (!pendingKept) return;
    pendingKept = false;
    if (d.pending && d.fingerprint) d.pending.remove({ fingerprint: d.fingerprint, tab: tabId, life });
  }

  /**
   * Once, when the save state is first known: the records of tabs that closed or crashed with a save on its way, for this
   * file (or, once the document exists, for its library id: a stamped copy). This tab takes them: their notes come back,
   * and if the PDF is still not saved, its save completes (the owner's own action started it).
   */
  async function lookForPending(): Promise<void> {
    const pj = d.pending;
    const fp = d.fingerprint;
    if (pendingLooked || !pj || !fp || disposed || !d.store || !d.save) return;
    if (mode !== 'pending-save' && mode !== 'stored') return;
    pendingLooked = true;
    let live: Set<TabId>;
    try {
      live = new Set(await d.presence.liveTabs());
    } catch (e) {
      report(e, 'liveTabs');
      return;
    }
    const taken: PendingSave[] = [];
    await pj
      .locked(() => {
        const keys = new Set<string>([fp]);
        const id = currentDocId();
        if (id) keys.add(id);
        for (const key of keys) {
          for (const rec of pj.list(key)) {
            if (disposed) return Promise.resolve();
            if (rec.life === life) continue; // this page's own
            if (rec.tab !== tabId && live.has(rec.tab)) continue; // that tab is open and still saving it
            adoptPending(rec);
            taken.push(rec);
          }
        }
        if (taken.length === 0) return Promise.resolve();
        kickNoUndo = true; // R67 tightened (3): a save finished on reopen never offers Undo
        // This page's own record holds them before the old ones go, so a crash in between loses nothing.
        if (mode === 'stored') {
          pendingKept = true;
          onBecameStoredAgain(); // the notes go to the keeper (its journal), the writes to this page's record
        } else {
          ownerSave = true;
          keepPending();
        }
        for (const rec of taken) pj.remove(rec);
        return Promise.resolve();
      })
      .catch((e: unknown) => report(e, 'pending.restore'));
    if (taken.length === 0 || disposed) return;
    if (mode !== 'stored') resumeSave();
    emit();
  }

  /** Puts a record's rows and notes into the model. What is already here (newer) is left as it is. */
  function adoptPending(rec: PendingSave): void {
    const ops = rec.ops.filter((op) => op && typeof op === 'object' && op.row && typeof op.row.id === 'string');
    const moved: string[] = [];
    for (const op of ops) {
      const table = op.table;
      const id = op.row.id;
      if (op.op === 'soft-delete') put(table, id, null);
      else put(table, id, op.row);
      if (op.op !== 'soft-delete' && table !== 'comments') moved.push(id);
    }
    if (ops.length > 0) queue.push(newBatch(ops));
    for (const r of rec.drafts) if (adoptDraftRow(r) && active === null) active = r.threadId;
    for (const e of rec.edits) if (!edits.has(e.commentId)) edits.set(e.commentId, { ...e });
    tidyAfterRemoval();
    resolveLater(moved);
  }

  /** Records taken while the PDF is already saved: their notes go to the keeper and their writes to the store now. */
  function onBecameStoredAgain(): void {
    patchDocIds();
    for (const c of drafts.values()) if (c.body !== '') pushDraft(c);
    for (const e of edits.values()) pushEdit(e.commentId, e.body);
    keepPending();
    void pump();
  }

  /**
   * Completes the save of a record whose tab went before it finished. It never offers Undo (R67 tightened 3); on a PDF
   * judged not learning it asks first. The chip says "Saving your notes…" until it lands.
   */
  function resumeSave(): void {
    const save = d.save;
    if (!save || kick) return;
    kick = (async () => {
      try {
        if (save.resumeSave) {
          await save.resumeSave();
          syncSaveState();
          return;
        }
        await waitForSaveState((x) => x.kind !== 'checking').done;
        const now = save.state;
        if (disposed || now.kind === 'saved' || now.kind === 'incognito' || now.kind === 'asking') return;
        await save.firstMark({ undoable: false });
        syncSaveState();
      } catch (e) {
        report(e, 'resumeSave');
      } finally {
        kick = null;
      }
    })();
  }

  /**
   * The store no longer has this document. Drop what it held: rows we know it had, and the mark that caused the save.
   * What was never written (changes still in the queue, notes still being typed) stays.
   */
  function dropForgottenRows(): void {
    stopHolding();
    const gone = new Set<string>([...persisted, ...savedTriggerKeys]);
    persisted.clear();
    savedTriggerKeys.clear();
    // R67: the next mark or keystroke is a first one again; nothing of this PDF is kept outside this tab until then.
    ownerSave = false;
    typingSaved = false;
    typedTrigger = null;
    kickNoUndo = false;
    dropPending();
    for (const k of gone) {
      const sep = k.indexOf(':');
      const table = k.slice(0, sep) as Table;
      const id = k.slice(sep + 1);
      if (table === 'marks') {
        marks.delete(id as MarkId);
        const owner = pendingMarks.get(id as MarkId);
        if (owner) {
          pendingMarks.delete(id as MarkId);
          setStashHighlight(owner, null);
        }
      } else if (table === 'threads') {
        const t = threads.get(id as ThreadId);
        if (t && t.draftOfTab === null) threads.delete(id as ThreadId);
      } else comments.delete(id as CommentId);
      placement.delete(id);
    }
    for (const list of [queue, parked]) {
      for (const b of [...list]) {
        b.ops = b.ops.filter((op) => !gone.has(rowKey(op.table, op.row.id)));
        if (b.ops.length === 0) {
          list.splice(list.indexOf(b), 1);
          b.attempted();
          b.leave();
        }
      }
    }
    safeCopied.clear(); // the store forgot the drafts along with everything else
    undo.prune((table, id) => gone.has(rowKey(table, id)));
    for (const [id, c] of comments) if (!threads.has(c.threadId)) comments.delete(id);
    if (active && !threads.has(active)) active = null;
    if (focusedMark && !marks.has(focusedMark)) focusedMark = null;
    marksVersion++;
  }

  /** TB4 ruling (Forget wins): an unsent note held after another tab's Forget is kept in the journal, never in the store. */
  function keepUnsavedDraft(c: CommentRow): void {
    try {
      if (c.body.trim() === '') {
        if (keeperHas.delete(c.id) || heldAfterForget) d.drafts.drop(c.id); // not a note any more: its journal copy goes
        return;
      }
      const stash = rootDrafts.get(c.id);
      const thread = stash ? threads.get(c.threadId) : undefined;
      d.drafts.keepUnsaved?.(keeperRow(c), thread ? { ...thread, documentId: stampId() } : undefined);
    } catch (e) {
      report(e, 'drafts.keepUnsaved');
    }
  }

  /** Another tab forgot the PDF while this tab held unsent notes: they stay, and the journal keeps their text. */
  function keepAfterForget(): void {
    heldAfterForget = true;
    const keepAll = (): void => {
      if (!heldAfterForget || disposed || mode !== 'pending-save') return;
      for (const c of drafts.values()) keepUnsavedDraft(c);
    };
    keepAll();
    // The forgetting tab clears the PDF's journal entries just after its delete, which may land after this: once more.
    if (heldAgain) clearTimeout(heldAgain);
    heldAgain = setTimeout(() => {
      heldAgain = null;
      keepAll();
    }, HELD_AGAIN_MS);
  }

  function stopHolding(): void {
    heldAfterForget = false;
    if (heldAgain) clearTimeout(heldAgain);
    heldAgain = null;
  }

  /** The owner said No: the notes held after a Forget stay in this tab only, as the question says. */
  function releaseHeld(): void {
    if (!heldAfterForget) return;
    stopHolding();
    for (const c of drafts.values()) {
      keeperHas.delete(c.id);
      try {
        d.drafts.drop(c.id);
      } catch (e) {
        report(e, 'drafts.drop');
      }
    }
  }

  /**
   * R96: notes that only this tab holds, which closing it would lose: a mark or a note made while the PDF is not saved and
   * no save is on its way (the owner said No, the question is open, there is no library, or another tab forgot the PDF).
   * A save on its way keeps them in the save-pending record (R67 a), so the tab can close without asking.
   */
  function holdsOnlyInMemory(): boolean {
    if (disposed || mode === 'stored' || mode === 'view-only') return false;
    if (mode === 'pending-save' && ownerSave && d.save?.state.kind !== 'asking') return false;
    if (marks.size > 0 || comments.size > 0 || queue.some((b) => b.ops.length > 0)) return true;
    for (const c of drafts.values()) if (c.body.trim() !== '') return true;
    return false;
  }

  /**
   * Before the first write of a PDF that was not saved when the notes were made: a row that was made and then removed
   * while nothing was stored never needs to exist in the store. Writing it would put text the owner deleted into the
   * database, the backup and sync, as a soft-deleted row. Undo history that points at such a row goes too.
   */
  function compactQueue(): void {
    // A batch being written right now may not be changed, and rows it touches are not candidates.
    const waiting = [...parked, ...queue].filter((b) => b !== inflight);
    const busy = new Set<string>();
    if (inflight) for (const op of inflight.ops) busy.add(rowKey(op.table, op.row.id));
    const first = new Map<string, AnnotationOp['op']>();
    const last = new Map<string, AnnotationOp['op']>();
    for (const b of waiting) {
      for (const op of b.ops) {
        const k = rowKey(op.table, op.row.id);
        if (!first.has(k)) first.set(k, op.op);
        last.set(k, op.op);
      }
    }
    const dead = new Set<string>();
    for (const [k, op] of first) if (op === 'upsert' && last.get(k) === 'soft-delete' && !persisted.has(k) && !busy.has(k)) dead.add(k);
    if (dead.size === 0) return;
    for (const list of [queue, parked]) {
      for (const b of [...list]) {
        if (b === inflight) continue;
        b.ops = b.ops.filter((op) => !dead.has(rowKey(op.table, op.row.id)));
        if (b.ops.length === 0) {
          list.splice(list.indexOf(b), 1);
          b.attempted();
          b.leave();
        }
      }
    }
    // A note that was parked had its text given to the keeper as a draft. It was deleted, so the draft goes too.
    for (const k of dead) {
      const id = k.slice('comments:'.length) as CommentId;
      if (k.startsWith('comments:') && safeCopied.delete(id)) {
        try {
          d.drafts.drop(id);
        } catch (e) {
          report(e, 'drafts.drop');
        }
      }
    }
    undo.prune((table, id) => dead.has(rowKey(table, id)));
  }

  function clearDocGoneTimer(): void {
    if (docGoneTimer) clearTimeout(docGoneTimer);
    docGoneTimer = null;
  }

  // ------------------------------------------------------------ the write queue

  function dirtyKeys(): Set<string> {
    const out = new Set<string>();
    for (const b of [...(inflight ? [inflight] : []), ...queue, ...parked]) {
      for (const op of b.ops) out.add(rowKey(op.table, op.row.id));
    }
    return out;
  }

  /** True when a change rests on a row that is stuck in a parked batch: it would only fail the same way. */
  function dependsOnParked(ops: AnnotationOp[]): boolean {
    if (parked.length === 0) return false;
    const keys = new Set<string>();
    const newThreads = new Set<string>();
    for (const b of parked) {
      for (const op of b.ops) {
        keys.add(rowKey(op.table, op.row.id));
        if (op.table === 'threads' && op.op !== 'soft-delete' && !persisted.has(rowKey('threads', op.row.id))) newThreads.add(op.row.id);
      }
    }
    return ops.some((op) => keys.has(rowKey(op.table, op.row.id)) || (op.table === 'comments' && newThreads.has((op.row as CommentRow).threadId)));
  }

  function enqueue(ops: AnnotationOp[]): Batch | null {
    if (ops.length === 0 || !d.store) return null; // with no store there is nothing to wait for, and nothing would ever drain
    const b = newBatch(ops);
    if (dependsOnParked(ops)) {
      parked.push(b);
      b.attempted();
      emit(); // the card for this change shows "couldn't save" too
    } else queue.push(b);
    if (parked.length > 0) compactQueue();
    keepPending();
    void pump();
    return b;
  }

  function scheduleRetry(attempts: number): void {
    if (retryTimer || disposed) return;
    const ms = retryMs[Math.min(attempts, retryMs.length) - 1] ?? 8000;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pump();
    }, ms);
  }

  /**
   * Gives up on a batch that failed every retry. It must not hold up the writes behind it: it waits in `parked`,
   * the card says it could not be saved, and the text of its new comments is handed to the draft keeper, which saves
   * it by a different road (saveDraft), so a reload brings it back in its card. Later changes that rest on its rows
   * wait with it, since they could only fail the same way.
   */
  async function parkBatch(b: Batch): Promise<void> {
    const at = queue.indexOf(b);
    if (at >= 0) queue.splice(at, 1);
    parked.push(b);
    failures = 0;
    const waiting: string[] = [];
    const newThreads = new Set<string>();
    const note = (x: Batch) => {
      for (const op of x.ops) {
        waiting.push(rowKey(op.table, op.row.id));
        if (op.table === 'threads' && op.op !== 'soft-delete' && !persisted.has(rowKey('threads', op.row.id))) newThreads.add(op.row.id);
      }
    };
    for (const x of parked) note(x);
    for (const later of [...queue]) {
      if (later === inflight) continue;
      const rests = later.ops.some((op) => waiting.includes(rowKey(op.table, op.row.id)) || (op.table === 'comments' && newThreads.has((op.row as CommentRow).threadId)));
      if (!rests) continue;
      queue.splice(queue.indexOf(later), 1);
      parked.push(later);
      later.attempted();
      note(later);
    }
    emit();
    await keepTextSafe(parked.filter((x) => !x.safe));
  }

  /** Hands the text of comments that exist only in a parked batch to the draft keeper, as drafts of this tab. */
  async function keepTextSafe(batches: Batch[]): Promise<void> {
    if (mode !== 'stored') return;
    let any = false;
    for (const b of batches) {
      b.safe = true;
      for (const op of b.ops) {
        // An edit of a note the store already has is left alone: its old text is stored, and a draft with the same id
        // would hide it.
        if (op.table !== 'comments' || op.op !== 'upsert' || persisted.has(rowKey('comments', op.row.id))) continue;
        const c = comments.get(op.row.id as CommentId);
        if (!c || c.author !== 'me') continue;
        const thread = threads.get(c.threadId);
        const threadIsNew = !!thread && !persisted.has(rowKey('threads', thread.id));
        const threadCopy: ThreadRow | undefined = thread && threadIsNew ? { ...thread, draftOfTab: tabId } : undefined;
        const isRoot = !!threadCopy && liveCommentsOf(c.threadId)[0]?.id === c.id;
        const meta = isRoot && threadCopy ? stashMeta(threadCopy, parkedHighlightFor(threadCopy)) : c.meta;
        try {
          d.drafts.change({ ...c, documentId: stampId(), draftOfTab: tabId, meta }, threadCopy);
          safeCopied.add(c.id);
          any = true;
        } catch (e) {
          report(e, 'drafts.change');
        }
      }
    }
    if (any) await within(d.drafts.flush(), FLUSH_WAIT_MS);
  }

  /** The colour of the highlight that was going to be written with this thread, if it is in a parked batch. */
  function parkedHighlightFor(thread: ThreadRow): MarkColor | null {
    if (thread.anchor.kind !== 'text') return null;
    const want = anchorKey(thread.anchor);
    for (const b of parked) {
      for (const op of b.ops) {
        if (op.table !== 'marks' || op.op !== 'upsert' || persisted.has(rowKey('marks', op.row.id))) continue;
        const m = op.row as MarkRow;
        if (m.style === 'highlight' && m.color !== null && anchorKey(m.anchor) === want) return m.color;
      }
    }
    return null;
  }

  /**
   * A write has just gone through, so the store is alive. A parked batch gets one more try: it may only have been
   * parked by an outage. If it fails again it stays parked until the owner presses Retry.
   */
  function probeParked(): void {
    const again = parked.filter((x) => !x.probed);
    if (again.length === 0) return;
    for (const x of again) {
      x.probed = true;
      x.attempts = retryMs.length; // one more failure and it is parked again
      renewAttempt(x);
      parked.splice(parked.indexOf(x), 1);
    }
    queue.unshift(...again);
    emit();
  }

  /** The owner's Retry: every parked batch goes to the store once more, oldest first. */
  function retryParkedImpl(): Committed | null {
    if (parked.length === 0) return null;
    const all = parked.splice(0);
    for (const x of all) {
      x.attempts = retryMs.length;
      x.probed = true;
      x.safe = false;
      renewAttempt(x);
    }
    queue.unshift(...all);
    emit();
    void pump();
    return { batch: all[all.length - 1] ?? null, started: false };
  }

  /** Writes queued batches, oldest first, one at a time. A batch that keeps failing is parked, not allowed to block. */
  async function pump(): Promise<void> {
    if (pumping) return;
    syncSaveState();
    pumping = true;
    try {
      while (queue.length > 0 && canWrite()) {
        const b = queue[0];
        const id = currentDocId()!;
        const ops: AnnotationOp[] = b.ops.map((op) => ({ ...op, row: { ...op.row, documentId: id } }));
        inflight = b;
        writeEpoch++;
        let finish!: () => void;
        inflightDone = new Promise<void>((r) => (finish = r));
        let outcome: 'ok' | 'retry' | 'park' | 'gone' = 'ok';
        try {
          await d.store!.writeAnnotations(ops, { tabId });
          // A batch can be emptied and removed while it was in flight (the document was forgotten); only pop our own.
          if (queue[0] === b) queue.shift();
          for (const op of ops) {
            persisted.add(rowKey(op.table, op.row.id));
            if (op.table === 'comments') {
              safeCopied.delete(op.row.id as CommentId); // it is live now, no longer a draft
              // The store has the comment as a sent row now (or deleted it): the keeper lets go of its draft and journal copy.
              try {
                d.drafts.sent?.(op.row.id as CommentId);
              } catch (e) {
                report(e, 'drafts.sent');
              }
            }
          }
          failures = 0;
          b.attempts = 0;
          b.leave();
        } catch (e) {
          if (!queue.includes(b)) outcome = 'gone'; // emptied and dropped while in flight (the document was forgotten)
          else {
            failures++;
            b.attempts++;
            report(e, 'writeAnnotations');
            outcome = b.attempts > retryMs.length ? 'park' : 'retry';
          }
        } finally {
          inflight = null;
          inflightDone = null;
          finish();
          b.attempted();
        }
        if (outcome === 'retry') {
          scheduleRetry(b.attempts);
          return;
        }
        if (outcome === 'park') await parkBatch(b);
        else if (outcome === 'ok') probeParked();
      }
    } finally {
      pumping = false;
    }
    if (queue.length === 0) patchDocIds();
    if (pendingKept && mode === 'stored') keepPending(); // the record goes once what it kept is written
  }

  /** Rows made before the document had an id carry a blank one in memory. Fix them once the id is known. */
  function patchDocIds(): void {
    const id = currentDocId();
    if (!id) return;
    let any = false;
    const restamp = <T extends { id: string; documentId: DocumentId }>(m: Map<T['id'], T>): void => {
      for (const row of [...m.values()]) {
        if (row.documentId === id) continue;
        m.set(row.id, { ...row, documentId: id });
        any = true;
      }
    };
    restamp(marks);
    restamp(threads);
    restamp(comments);
    restamp(drafts);
    if (any) emit();
  }

  async function settle(b: Batch | null, started: boolean): Promise<void> {
    await afterKick(started);
    if (b && canWrite()) await within(b.firstAttempt, SETTLE_WAIT_MS);
  }

  // ------------------------------------------------------------ applying changes to the model

  function put(table: Table, id: string, row: AnyRow | null): void {
    switch (table) {
      case 'marks':
        if (row) marks.set(id as MarkId, row as MarkRow);
        else marks.delete(id as MarkId);
        marksVersion++;
        break;
      case 'threads':
        if (row) threads.set(id as ThreadId, row as ThreadRow);
        else threads.delete(id as ThreadId);
        break;
      case 'comments':
        if (row) comments.set(id as CommentId, row as CommentRow);
        else comments.delete(id as CommentId);
        break;
    }
  }

  function read(table: Table, id: string): AnyRow | null {
    switch (table) {
      case 'marks':
        return marks.get(id as MarkId) ?? null;
      case 'threads': {
        const t = threads.get(id as ThreadId);
        return t && t.draftOfTab === null ? t : null;
      }
      case 'comments':
        return comments.get(id as CommentId) ?? null;
    }
  }

  function tidyAfterRemoval(): void {
    for (const [id, c] of comments) if (!threads.has(c.threadId)) comments.delete(id);
    if (active && !threads.has(active)) active = null;
    if (focusedMark && !marks.has(focusedMark)) focusedMark = null;
    for (const id of [...placement.keys()]) if (!marks.has(id as MarkId) && !threads.has(id as ThreadId)) placement.delete(id);
  }

  /** Puts a row we just made on screen where we know it is. A row made here fits these bytes. */
  function placeNow(id: string, anchor: Anchor): void {
    placement.set(id, { placed: true, by: 'stored', score: 1, anchor });
  }

  function triggerKeysOf(c: Change): string[] {
    return c.rows.filter((rc) => rc.after !== null).map((rc) => rowKey(rc.table, rc.id));
  }

  /** The common tail of a user action: memory, undo history, then the queue. */
  function commit(c: Change): Committed {
    if (c.rows.length === 0) return { batch: null, started: false };
    const ops = opsFor(c, 'first', d.now(), read);
    for (const rc of c.rows) {
      put(rc.table, rc.id, rc.after);
      if (rc.table === 'marks') {
        // A highlight that was only drawn for an unsent note is real from now on: it was sent or it was touched.
        const owner = pendingMarks.get(rc.id as MarkId);
        if (owner) {
          pendingMarks.delete(rc.id as MarkId);
          setStashHighlight(owner, null);
        }
      }
      if (rc.after && rc.table !== 'comments') placeNow(rc.id, (rc.after as MarkRow | ThreadRow).anchor);
    }
    tidyAfterRemoval();
    // A change that only removed a highlight nobody had saved yet leaves nothing to undo.
    if (ops.length > 0) undo.record(c);
    const started = startSaveIfNeeded(triggerKeysOf(c));
    if (!started && c.rows.some((rc) => rc.after !== null && !savedTriggerKeys.has(rowKey(rc.table, rc.id)))) contentAdded();
    emit(); // draw first
    const batch = enqueue(ops);
    return { batch, started };
  }

  /** Builds a Change row by row. Rows of a pending highlight count as not having existed before. */
  function builder(): { rec(table: Table, id: string, before: AnyRow | null, after: AnyRow | null): void; build(): Change } {
    const rows = new Map<string, RowChange>();
    return {
      rec(table, id, before, after) {
        const key = rowKey(table, id);
        const prior = rows.get(key);
        const was = prior ? prior.before : table === 'marks' && pendingMarks.has(id as MarkId) ? null : before;
        // before and after both null is a highlight that was only drawn: nothing to write, but memory must drop it.
        rows.set(key, { table, id, before: was, after });
      },
      build: () => ({ rows: [...rows.values()] }),
    };
  }

  // ------------------------------------------------------------ marks

  /** Marks as the style planner should see them: placed on these bytes, with the positions for these bytes. */
  function planningMarks(from: Map<MarkId, MarkRow>): MarkRow[] {
    const out: MarkRow[] = [];
    for (const m of from.values()) {
      if (m.anchor.kind !== 'text') continue;
      const r = placement.get(m.id);
      if (r && !r.placed) continue; // not found in this file: its positions mean nothing here
      out.push(r && r.placed && r.anchor.kind === 'text' ? { ...m, anchor: r.anchor } : m);
    }
    return out;
  }

  async function rangesFor(start: CharPos, end: CharPos): Promise<CharRange[]> {
    if (cmpPos(start, end) >= 0) return [];
    const out: CharRange[] = [];
    for (let p = start.page; p <= end.page; p++) {
      const s = p === start.page ? start.index : 0;
      const e = p === end.page ? end.index : (await d.anchors.text.text(p)).length;
      if (e > s) out.push({ pageIndex: p, start: s, end: e });
    }
    return out;
  }

  function newMark(style: MarkStyle, color: MarkColor | null, anchor: Anchor): MarkRow {
    const where = placeOf(anchor);
    const t = d.now();
    return {
      ...blankSync(),
      id: newId<MarkId>(),
      documentId: stampId(),
      style,
      color,
      anchor,
      pageIndex: where.pageIndex ?? 0,
      sortKey: where.sortKey ?? 0,
      author: 'me',
      createdAt: t,
      updatedAt: t,
    };
  }

  async function applyStyleImpl(ranges: CharRange[], style: Exclude<MarkStyle, 'area'>, color: MarkColor | null): Promise<Committed | null> {
    const runs = groupRanges(ranges);
    if (runs.length === 0) return null;
    const col: MarkColor | null = style === 'bold' ? null : (color ?? 1);

    for (let attempt = 0; attempt < 6; attempt++) {
      const seen = marksVersion;
      const b = builder();
      const work = new Map(marks);
      const anchorCache = new Map<string, Promise<TextAnchor | null>>();
      const anchorFor = (start: CharPos, end: CharPos): Promise<TextAnchor | null> => {
        const k = `${start.page}:${start.index}-${end.page}:${end.index}`;
        let p = anchorCache.get(k);
        if (!p) {
          p = rangesFor(start, end).then((rs) => (rs.length > 0 ? d.makeTextAnchor(rs) : null));
          anchorCache.set(k, p);
        }
        return p;
      };

      for (const run of runs) {
        const first = run[0];
        const last = run[run.length - 1];
        const target = { start: { page: first.pageIndex, index: first.start }, end: { page: last.pageIndex, index: last.end } };
        const plan = planStyleFn(planningMarks(work), target, style, col);
        for (const id of plan.remove) {
          const orig = work.get(id);
          if (!orig) continue;
          b.rec('marks', id, orig, null);
          work.delete(id);
        }
        for (const s of plan.shrink) {
          const orig = work.get(s.id);
          const anchor = await anchorFor(s.start, s.end);
          if (!orig || !anchor) continue;
          const where = placeOf(anchor);
          const next: MarkRow = { ...orig, anchor, pageIndex: where.pageIndex ?? orig.pageIndex, sortKey: where.sortKey ?? orig.sortKey, updatedAt: d.now() };
          b.rec('marks', s.id, orig, next);
          work.set(s.id, next);
        }
        for (const c of plan.create) {
          const anchor = await anchorFor(c.start, c.end);
          if (!anchor) continue;
          const next = newMark(c.style, c.style === 'bold' ? null : c.color, anchor);
          b.rec('marks', next.id, null, next);
          work.set(next.id, next);
        }
      }

      if (marksVersion !== seen) continue; // marks changed while the rects were measured: plan again
      if (disposed) return null;
      return commit(b.build());
    }
    report(new Error('marks kept changing; style not applied'), 'applyStyle');
    return null;
  }

  // ------------------------------------------------------------ threads and drafts

  /** The root draft that opened `threadId`, if the thread is still unsent. */
  function rootDraftOf(threadId: ThreadId): CommentRow | null {
    for (const c of drafts.values()) if (c.threadId === threadId && rootDrafts.has(c.id)) return c;
    return null;
  }

  function setStashHighlight(threadId: ThreadId, highlight: MarkColor | null): void {
    const root = rootDraftOf(threadId);
    if (!root) return;
    const stash = rootDrafts.get(root.id);
    if (stash) stash.highlight = highlight;
    if (keeperHas.has(root.id)) pushDraft(root);
  }

  /** A draft as the keeper saves it: this tab's, under the PDF's id, a new note's thread and highlight in its `meta`. */
  function keeperRow(c: CommentRow): CommentRow & { draftOfTab: TabId } {
    const stash = rootDrafts.get(c.id);
    const thread = stash ? threads.get(c.threadId) : undefined;
    const meta = stash && thread ? stashMeta({ ...thread, documentId: stampId() }, stash.highlight) : c.meta;
    return { ...c, documentId: stampId(), draftOfTab: tabId, meta };
  }

  /** Gives the keeper the draft's latest text, with its thread if it opened one. */
  function pushDraft(c: CommentRow): void {
    // While the PDF is not saved, the text is kept by the save-pending record (R67 a), or in this session only before
    // any save was asked for. It goes to the keeper the moment the PDF is saved.
    if (mode !== 'stored') {
      if (heldAfterForget && mode === 'pending-save') keepUnsavedDraft(c); // TB4 ruling: kept in the journal
      return;
    }
    const stash = rootDrafts.get(c.id);
    const thread = stash ? threads.get(c.threadId) : undefined;
    keeperHas.add(c.id);
    try {
      d.drafts.change(keeperRow(c), thread ? { ...thread, documentId: stampId() } : undefined);
    } catch (e) {
      report(e, 'drafts.change');
    }
  }

  function dropDraft(id: CommentId): void {
    settledHere.add(id);
    drafts.delete(id);
    rootDrafts.delete(id);
    keeperHas.delete(id);
    try {
      d.drafts.drop(id);
    } catch (e) {
      report(e, 'drafts.drop');
    }
  }

  /** Throws away an unsent note and the highlight that was drawn for it. */
  function cancelDraft(id: CommentId): void {
    const draft = drafts.get(id);
    if (!draft) return;
    const isRoot = rootDrafts.has(id);
    const wasTrigger = id === typedTrigger;
    if (wasTrigger) typedTrigger = null;
    dropDraft(id);
    if (isRoot) {
      for (const [mid, tid] of [...pendingMarks]) {
        if (tid === draft.threadId) {
          pendingMarks.delete(mid);
          marks.delete(mid);
          placement.delete(mid);
          marksVersion++;
        }
      }
      threads.delete(draft.threadId);
      placement.delete(draft.threadId);
    }
    tidyAfterRemoval();
    // R67 (b): the note whose typing saved the PDF was emptied and closed, and nothing else was made: the save goes, as
    // if the note box had never been typed in.
    if (wasTrigger && marks.size === 0 && threads.size === 0 && comments.size === 0 && drafts.size === 0 && edits.size === 0 && d.save?.withdraw) {
      void d.save.withdraw().catch((e: unknown) => report(e, 'withdraw'));
    }
    emit();
  }

  function startThreadImpl(a: Anchor, o: { highlight: MarkColor | null }): { threadId: ThreadId; commentId: CommentId } {
    const threadId = newId<ThreadId>();
    const commentId = newId<CommentId>();
    if (disposed || mode === 'view-only') return { threadId, commentId };
    const t = d.now();
    const docId = stampId();
    const where = placeOf(a);
    const thread: ThreadRow = {
      ...blankSync(),
      id: threadId,
      documentId: docId,
      anchor: a,
      pageIndex: where.pageIndex,
      sortKey: where.sortKey,
      placement: 'placed',
      draftOfTab: tabId,
      createdAt: t,
      updatedAt: t,
    };
    const root: CommentRow = {
      ...blankSync(),
      id: commentId,
      threadId,
      documentId: docId,
      author: 'me',
      body: '',
      draftOfTab: tabId,
      meta: {},
      createdAt: t,
      editedAt: null,
    };
    threads.set(threadId, thread);
    placeNow(threadId, a);
    drafts.set(commentId, root);
    const color = a.kind === 'text' ? o.highlight : null;
    rootDrafts.set(commentId, { highlight: color });
    const triggers: string[] = [];
    if (color !== null) {
      const mark = newMark('highlight', color, a);
      marks.set(mark.id, mark);
      marksVersion++;
      pendingMarks.set(mark.id, threadId);
      placeNow(mark.id, a);
      triggers.push(rowKey('marks', mark.id));
    }
    // R67 (b): an open, empty note box saves nothing; its first keystroke does (typeDraft). A PDF judged not learning
    // asks its question now, before any typing (asking is not saving).
    if (d.save?.state.kind === 'not-learning') startSaveIfNeeded(triggers, { content: false });
    contentAdded({ content: false }); // R67 (c): there is no Undo while a note box is open; an empty box is not content (N1)
    emit();
    return { threadId, commentId };
  }

  async function sendImpl(id: CommentId): Promise<Committed | null> {
    const draft = drafts.get(id);
    if (!draft) return null;
    if (draft.body.trim() === '') {
      cancelDraft(id);
      return null;
    }
    // Order matters here. Save the final text through the keeper and wait for it, so that no delayed draft save of
    // this comment can land after the live rows are written and turn them back into a draft.
    if (mode === 'stored') {
      pushDraft(draft);
      try {
        await within(d.drafts.flush(), FLUSH_WAIT_MS);
      } catch (e) {
        report(e, 'drafts.flush');
      }
    }
    const current = drafts.get(id);
    if (!current) return null; // cancelled or sent while we waited
    const t = d.now();
    const isRoot = rootDrafts.has(id);
    const b = builder();
    const sent: CommentRow = { ...current, draftOfTab: null, meta: {}, createdAt: t, editedAt: null };
    if (isRoot) {
      const thread = threads.get(current.threadId);
      if (!thread) return null;
      b.rec('threads', thread.id, null, { ...thread, draftOfTab: null, updatedAt: t });
      for (const [mid, tid] of pendingMarks) {
        if (tid === thread.id) {
          const m = marks.get(mid);
          if (m) b.rec('marks', mid, m, m); // before is null for a pending mark: this makes the highlight real
        }
      }
    }
    b.rec('comments', sent.id, null, sent);
    settledHere.add(id);
    drafts.delete(id);
    rootDrafts.delete(id);
    // When stored, the keeper's copy is now the live row; asking it to drop that could delete the sent note, so leave
    // it. Otherwise nothing of this draft is in the store and the keeper can let go of it.
    keeperHas.delete(id);
    if (mode !== 'stored') {
      try {
        d.drafts.drop(id);
      } catch (e) {
        report(e, 'drafts.drop');
      }
    }
    return commit(b.build());
  }

  // ------------------------------------------------------------ edits to sent notes

  function liveCommentsOf(threadId: ThreadId): CommentRow[] {
    return [...comments.values()].filter((c) => c.threadId === threadId).sort(byCreated);
  }

  /** Removes a thread and its comments. Marks are separate rows and stay. */
  function removeThreadChange(thread: ThreadRow, b: ReturnType<typeof builder>): void {
    b.rec('threads', thread.id, thread, null);
    for (const c of liveCommentsOf(thread.id)) {
      b.rec('comments', c.id, c, null);
      if (edits.has(c.id)) closeEdit(c.id); // the delete closes it in the store too
    }
    for (const dr of [...drafts.values()]) if (dr.threadId === thread.id) cancelDraft(dr.id);
  }

  function removeThreadImpl(id: ThreadId): Committed | null {
    const thread = threads.get(id);
    if (!thread) return null;
    if (thread.draftOfTab !== null) {
      const root = rootDraftOf(id);
      if (root) cancelDraft(root.id);
      return null;
    }
    const b = builder();
    removeThreadChange(thread, b);
    return commit(b.build());
  }

  function removeCommentImpl(id: CommentId): Committed | null {
    if (drafts.has(id)) {
      cancelDraft(id);
      return null;
    }
    const c = comments.get(id);
    if (!c) return null;
    const thread = threads.get(c.threadId);
    const all = liveCommentsOf(c.threadId);
    if (thread && all[0]?.id === c.id) return removeThreadImpl(thread.id); // the first comment is the thread
    const b = builder();
    b.rec('comments', c.id, c, null);
    if (edits.has(c.id)) closeEdit(c.id);
    return commit(b.build());
  }

  function editCommentImpl(id: CommentId, body: string): Committed | null {
    if (drafts.has(id)) {
      typeDraftImpl(id, body);
      return null;
    }
    const c = comments.get(id);
    if (edits.has(id)) {
      // The editor closes now. Until the new text is written, the keeper keeps it as the edit draft (R54), so a crash
      // before the write lands brings the editor back with this text.
      if (c && body.trim() !== '' && body !== c.body) pushEdit(id, body);
      edits.delete(id);
    }
    if (!c || c.author !== 'me' || body === c.body) return null; // the owner may delete a Claude reply but not rewrite it
    // Emptying a note removes the note and keeps its highlight.
    if (body.trim() === '') return removeCommentImpl(id);
    const b = builder();
    b.rec('comments', c.id, c, { ...c, body, editedAt: d.now() });
    return commit(b.build());
  }

  function typeDraftImpl(id: CommentId, body: string): void {
    const c = drafts.get(id);
    if (!c || disposed || c.body === body) return;
    const next = { ...c, body };
    drafts.set(id, next);
    const real = body.trim() !== '';
    const first = real && c.body.trim() === '';
    // R67 (b, f): real text in a note saves a PDF that is not saved yet, with no Undo. Not again once typing has started a
    // save (a failed one is retried from the chip), until that save is undone or forgotten.
    if (real && mode === 'pending-save' && !typingSaved && startSaveIfNeeded([], { note: true })) {
      typingSaved = true;
      if (first) typedTrigger = id;
    } else if (first) contentAdded();
    // An untouched empty draft is not worth saving. Once text has been saved, an emptied draft is saved too.
    if (body !== '' || keeperHas.has(id)) pushDraft(next);
    emit();
  }

  // ------------------------------------------------------------ R54: unsent edits of sent notes

  /** A sent note of the owner, which may be edited. Claude's replies are never rewritten. */
  function editableComment(id: CommentId): CommentRow | null {
    const c = comments.get(id);
    return c && c.author === 'me' && c.draftOfTab === null && editable() ? c : null;
  }

  /**
   * Gives the keeper the edit's text. Like drafts, only a stored PDF writes; otherwise the text stays in this session
   * and goes to the keeper the moment the PDF is saved (onBecameStored).
   */
  function pushEdit(id: CommentId, body: string): void {
    const c = comments.get(id);
    if (mode !== 'stored' || !c) return;
    try {
      d.drafts.changeEdit({ ...c, documentId: stampId() }, body);
    } catch (e) {
      report(e, 'drafts.changeEdit');
    }
  }

  /** The edit is over: forget it here and close it in the store (after any save of it that is on its way). */
  function closeEdit(id: CommentId): void {
    edits.delete(id);
    try {
      d.drafts.dropEdit(id);
    } catch (e) {
      report(e, 'drafts.dropEdit');
    }
  }

  function typeEditImpl(id: CommentId, body: string): void {
    const c = editableComment(id);
    if (!c) return;
    const had = edits.get(id);
    if (had && had.body === body) return;
    // A new edit goes to the end, so the list stays in the order the edits began.
    edits.set(id, { commentId: id, threadId: c.threadId, body });
    pushEdit(id, body);
    emit();
  }

  /** The edits the keeper restored (this tab's, and those it adopted from tabs that are gone). Typed text here wins. */
  function takeRestoredEdits(documentId: DocumentId): boolean {
    let list: EditDraft[];
    try {
      list = d.drafts.editDrafts(documentId);
    } catch (e) {
      report(e, 'drafts.editDrafts');
      return false;
    }
    let any = false;
    for (const e of list) {
      if (edits.has(e.commentId)) continue;
      edits.set(e.commentId, { commentId: e.commentId, threadId: e.threadId, body: e.body });
      any = true;
    }
    return any;
  }

  /** True once a batch has left the queue, written. A batch still queued, in flight or parked is not. */
  function written(b: Batch | null): boolean {
    return b === null || (inflight !== b && !queue.includes(b) && !parked.includes(b));
  }

  // ------------------------------------------------------------ undo and redo

  async function undoRedo(dir: 'undo' | 'redo'): Promise<Committed | null> {
    if (disposed || mode === 'view-only') return null;
    // Look at the store as it is now, so that we never undo over a newer edit made in another tab.
    if (canWrite()) {
      await within(
        (async () => {
          await untilIdle();
          await refresh();
        })(),
        SYNC_WAIT_MS,
      );
    }
    const change = dir === 'undo' ? undo.takeUndo(read) : undo.takeRedo(read);
    if (!change) return null;
    // Said before the rows change: whether a comment was a reply is read from the note as it stands now.
    const said = describeChange(change, dir, isReply);
    const ops = opsFor(change, dir, d.now(), read);
    const back: string[] = [];
    for (const rc of change.rows) {
      const target = dir === 'undo' ? rc.before : rc.after;
      put(rc.table, rc.id, target);
      if (target) {
        back.push(rc.id);
        placement.delete(rc.id);
      }
    }
    tidyAfterRemoval();
    const brought = ops.filter((o) => o.op !== 'soft-delete').map((o) => rowKey(o.table, o.row.id));
    const started = startSaveIfNeeded(brought);
    if (!started && brought.some((k) => !savedTriggerKeys.has(k))) contentAdded();
    emit();
    const batch = enqueue(ops);
    resolveLater(back);
    if (said !== null) d.onUndone?.(said);
    return { batch, started };
  }

  /** A comment that is not the first of its note: an older comment of the same note is live. */
  function isReply(row: CommentRow): boolean {
    for (const c of comments.values()) if (c.threadId === row.threadId && c.id !== row.id && c.createdAt < row.createdAt) return true;
    return false;
  }

  /** Waits until nothing is queued or in flight, or writing is not possible right now. */
  async function untilIdle(): Promise<void> {
    for (let i = 0; i < 50 && (queue.length > 0 || inflight) && canWrite() && failures === 0; i++) {
      if (inflightDone) await inflightDone;
      else await Promise.resolve();
      if (!inflight && queue.length > 0) await pump();
    }
  }

  // ------------------------------------------------------------ tabs in step

  function refresh(): Promise<void> {
    if (refreshing) {
      refreshAgain = true;
      return refreshing;
    }
    refreshing = (async () => {
      try {
        for (let round = 0; round < REFRESH_ROUNDS; round++) {
          refreshAgain = false;
          await refreshOnce();
          if (!refreshAgain || disposed) break;
        }
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function refreshOnce(): Promise<void> {
    const store = d.store;
    for (let i = 0; i < 5; i++) {
      const id = currentDocId();
      // While the document is gone from the store, a read would say "no notes" and wipe what is on screen.
      if (!store || !id || !canRead() || docGone) return;
      if (inflightDone) await inflightDone;
      const epoch = writeEpoch;
      let res: Awaited<ReturnType<SessionStore['listAnnotations']>>;
      try {
        res = await store.listAnnotations(id);
      } catch (e) {
        report(e, 'listAnnotations');
        return;
      }
      if (disposed) return;
      // One of our own writes started while we were reading. The read may not include it: read again.
      if (writeEpoch !== epoch || inflight) continue;
      mergeFromStore(res);
      return;
    }
    refreshAgain = true;
  }

  function mergeInto<T extends { id: string }>(
    local: Map<T['id'], T>,
    remote: readonly T[],
    table: Table,
    dirty: Set<string>,
    keepLocal: (row: T) => boolean,
    changedIds: string[],
  ): boolean {
    let changed = false;
    const remoteIds = new Set(remote.map((r) => r.id));
    for (const [id, row] of [...local]) {
      if (keepLocal(row) || dirty.has(rowKey(table, id)) || remoteIds.has(id)) continue;
      local.delete(id); // the other tab deleted it
      persisted.delete(rowKey(table, id));
      changedIds.push(id);
      changed = true;
    }
    for (const r of remote) {
      const key = rowKey(table, r.id);
      if (dirty.has(key)) continue; // our newer change is on its way
      persisted.add(key);
      const cur = local.get(r.id);
      if (!cur) {
        local.set(r.id, r);
        changedIds.push(r.id);
        changed = true;
      } else if (JSON.stringify(cur) !== JSON.stringify(r)) {
        local.set(r.id, r);
        if (anchorChanged(cur, r)) changedIds.push(r.id);
        changed = true;
      }
    }
    return changed;
  }

  function anchorChanged(a: object, b: object): boolean {
    const x = (a as { anchor?: Anchor }).anchor;
    const y = (b as { anchor?: Anchor }).anchor;
    return !!x && !!y && anchorKey(x) !== anchorKey(y);
  }

  function mergeFromStore(res: Awaited<ReturnType<SessionStore['listAnnotations']>>): void {
    const dirty = dirtyKeys();
    const moved: string[] = []; // rows that appeared, or whose anchor changed: they need a placement
    const a = mergeInto(marks, res.marks, 'marks', dirty, (m) => pendingMarks.has(m.id), moved);
    const b = mergeInto(threads, res.threads, 'threads', dirty, (t) => t.draftOfTab !== null, moved);
    const c = mergeInto(comments, res.comments, 'comments', dirty, () => false, moved);
    if (a) marksVersion++;
    const before = comments.size;
    tidyAfterRemoval();
    resolveLater(moved.filter((id) => marks.has(id as MarkId) || threads.has(id as ThreadId)));
    if (a || b || c || comments.size !== before) emit();
  }

  function onStoreChange(c: StoreChange): void {
    if (disposed || c.tabId === tabId) return; // our own echo
    const id = currentDocId();
    if (c.documentId && id && c.documentId !== id) return;
    switch (c.table) {
      case 'marks':
      case 'threads':
      case 'comments':
        if (canRead()) void refresh();
        break;
      case 'documents':
        if (!id || !c.ids.includes(id)) break;
        if (c.op === 'delete') suspectDocGone();
        else if (docGone) {
          clearDocGoneTimer();
          docGone = false;
          const was = mode;
          mode = computeMode();
          if (was !== mode) emit();
          if (mode === 'stored') onBecameStored();
        } else if (canRead()) void refresh();
        break;
      default:
        break;
    }
  }

  /**
   * The document row is gone: our own Undo or Forget, or another tab's. Writes stop at once (`docGone`). The save controller
   * decides what follows (TB4 ruling, Forget wins): it leaves "saved" once it knows whether this was an Undo or the owner's
   * Forget, and onSaveState then drops what the store lost. If it still says "saved" after a moment (a save or Undo of its
   * own was running and decides), every note is kept in memory and queued to be written again when the document is back;
   * nothing is written while it is gone.
   */
  function suspectDocGone(): void {
    if (docGone || docGoneTimer || d.save?.state.kind !== 'saved') return;
    docGone = true;
    mode = computeMode();
    emit();
    docGoneTimer = setTimeout(() => {
      docGoneTimer = null;
      if (disposed || !docGone || d.save?.state.kind !== 'saved') return;
      const rebuild: AnnotationOp[] = [];
      for (const m of marks.values()) if (!pendingMarks.has(m.id)) rebuild.push({ table: 'marks', op: 'upsert', row: m });
      for (const t of threads.values()) if (t.draftOfTab === null) rebuild.push({ table: 'threads', op: 'upsert', row: t });
      for (const c of comments.values()) rebuild.push({ table: 'comments', op: 'upsert', row: c });
      // `persisted` stays as it is: if this turns out to be our own Undo after all (a slow one), the rows in it are dropped.
      if (rebuild.length > 0) queue.unshift(newBatch(rebuild));
    }, 300);
  }

  async function adoptDraftsImpl(): Promise<void> {
    const id = currentDocId();
    // Drafts only exist in the store for a saved PDF; for any other the keeper is not asked.
    if (disposed || !id || mode !== 'stored') return;
    let rows: CommentRow[];
    try {
      rows = await d.drafts.restore(id);
    } catch (e) {
      report(e, 'drafts.restore');
      return;
    }
    let last: ThreadId | null = null;
    for (const r of rows) {
      if (disposed) break;
      if (adoptDraftRow(r)) {
        keeperHas.add(r.id);
        last = r.threadId;
      }
    }
    const restoredEdits = !disposed && takeRestoredEdits(id);
    if (last && active === null) active = last;
    if (last || restoredEdits) emit();
  }

  /** Puts a restored draft in its card: its new thread and the highlight it was to get come with it. False if not taken. */
  function adoptDraftRow(r: CommentRow): boolean {
    if (drafts.has(r.id) || comments.has(r.id) || settledHere.has(r.id) || r.deletedAt !== null) return false;
    const stash = readStash(r);
    const row: CommentRow = { ...r, draftOfTab: tabId, meta: stash ? {} : r.meta };
    if (stash) {
      const thread: ThreadRow = { ...stash.thread, draftOfTab: tabId };
      if (!threads.has(thread.id)) {
        threads.set(thread.id, thread);
        placeNow(thread.id, thread.anchor);
      }
      rootDrafts.set(row.id, { highlight: stash.highlight });
      if (stash.highlight !== null && thread.anchor.kind === 'text') {
        const mark = newMark('highlight', stash.highlight, thread.anchor);
        marks.set(mark.id, mark);
        marksVersion++;
        pendingMarks.set(mark.id, thread.id);
        placeNow(mark.id, thread.anchor);
      }
    }
    drafts.set(row.id, row);
    return true;
  }

  // ------------------------------------------------------------ placement

  function anchorOf(id: string): Anchor | null {
    return marks.get(id as MarkId)?.anchor ?? threads.get(id as ThreadId)?.anchor ?? null;
  }

  function resolveLater(ids: string[]): void {
    for (const id of ids) resolveQueue.add(id);
    if (!resolving && resolveQueue.size > 0) resolving = runResolve();
  }

  async function runResolve(): Promise<void> {
    try {
      while (resolveQueue.size > 0 && !disposed) {
        const batch = [...resolveQueue].slice(0, 8);
        for (const id of batch) resolveQueue.delete(id);
        const results = await Promise.all(
          batch.map(async (id) => {
            const anchor = anchorOf(id);
            if (!anchor) return null;
            try {
              return { id, key: anchorKey(anchor), res: await resolveFn(anchor, d.anchors) };
            } catch (e) {
              report(e, 'resolveAnchor');
              return null;
            }
          }),
        );
        let any = false;
        for (const r of results) {
          const now = r ? anchorOf(r.id) : null;
          if (!r || !now || anchorKey(now) !== r.key) continue; // the row changed meanwhile; whoever changed it asks again
          placement.set(r.id, r.res);
          any = true;
        }
        if (any && !disposed) emit();
      }
    } finally {
      resolving = null;
    }
  }

  // ------------------------------------------------------------ order of user actions

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Runs one user action in order with the others, then, after letting go of the chain, waits for the store.
   * Only the in-memory part is serialised. A slow or stuck store holds up the caller's promise, never the next action.
   */
  function mutate(where: string, fn: () => Promise<Committed | null> | Committed | null): Promise<void> {
    return serial(async () => {
      try {
        return await fn();
      } catch (e) {
        report(e, where);
        return null;
      }
    }).then((c) => (c ? settle(c.batch, c.started) : undefined));
  }

  const editable = () => !disposed && mode !== 'view-only';

  // ------------------------------------------------------------ start up

  async function init(): Promise<void> {
    lastSaveKind = d.save?.state.kind ?? null;
    mode = computeMode();
    if (d.store) cleanups.push(d.store.onChange(onStoreChange));
    if (d.save) cleanups.push(d.save.subscribe(onSaveState));
    if (typeof document !== 'undefined') {
      const onVisible = () => {
        if (document.visibilityState === 'visible') void adoptDraftsImpl();
      };
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisible));
    }
    if (typeof window !== 'undefined' && !d.incognito) {
      // R96: closing a tab whose notes are only in memory brings up the browser's "Leave site?" question.
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        if (!holdsOnlyInMemory()) return;
        e.preventDefault();
        e.returnValue = ''; // older Chrome needs it set as well
      };
      window.addEventListener('beforeunload', onBeforeUnload);
      cleanups.push(() => window.removeEventListener('beforeunload', onBeforeUnload));
    }
    if (mode === 'pending-save' && d.save?.busy === 'save') markOwnerSave(); // a save was already running (R67 a)
    if (d.save && d.save.state.kind !== 'checking') void lookForPending();
    if (canRead()) {
      await refresh();
      await adoptDraftsImpl();
    }
    while (resolving) await resolving;
    emit();
  }

  const ready = init().catch((e) => report(e, 'init'));

  return {
    tabId,
    ready,
    state,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    applyStyle: (ranges, style, color) => mutate('applyStyle', () => (editable() ? applyStyleImpl(ranges, style, color) : null)),

    addAreaMark(a) {
      const mark = newMark('area', null, a);
      return mutate('addAreaMark', () => {
        if (!editable()) return null;
        const b = builder();
        b.rec('marks', mark.id, null, mark);
        return commit(b.build());
      }).then(() => mark.id);
    },

    recolor: (id, c) =>
      mutate('recolor', () => {
        const m = marks.get(id);
        if (!editable() || !m || m.color === null || m.color === c) return null;
        const b = builder();
        b.rec('marks', id, m, { ...m, color: c, updatedAt: d.now() });
        return commit(b.build());
      }),

    removeMark: (id) =>
      mutate('removeMark', () => {
        const m = marks.get(id);
        if (!editable() || !m) return null;
        const b = builder();
        b.rec('marks', id, m, null);
        return commit(b.build());
      }),

    startThread(a, o) {
      try {
        return startThreadImpl(a, o);
      } catch (e) {
        report(e, 'startThread');
        return { threadId: newId<ThreadId>(), commentId: newId<CommentId>() };
      }
    },

    startReply(t) {
      const commentId = newId<CommentId>();
      const thread = threads.get(t);
      if (!editable() || !thread || thread.draftOfTab !== null) return commentId; // only a sent thread takes replies
      for (const dr of drafts.values()) if (dr.threadId === t && !rootDrafts.has(dr.id)) return dr.id; // already writing one
      const row: CommentRow = {
        ...blankSync(),
        id: commentId,
        threadId: t,
        documentId: stampId(),
        author: 'me',
        body: '',
        draftOfTab: tabId,
        meta: {},
        createdAt: d.now(),
        editedAt: null,
      };
      drafts.set(commentId, row);
      contentAdded({ content: false }); // R67 (c); an empty reply box is not content (N1)
      emit();
      return commentId;
    },

    typeDraft(id, body) {
      try {
        typeDraftImpl(id, body);
      } catch (e) {
        report(e, 'typeDraft');
      }
    },

    send: (id) => mutate('send', () => (editable() ? sendImpl(id) : null)),

    cancel: (id) =>
      mutate('cancel', () => {
        cancelDraft(id);
        return null;
      }),

    editComment(id, body) {
      let wasEditing = false;
      let done: Committed | null = null;
      // R54: the edit is over once the new text is written; the store closed it in that same write. Until then the keeper
      // keeps the edit draft, and a new edit of the note begins its own session, which waits for this write.
      const finish = (): void => {
        const newer = edits.get(id); // a new edit began while this one was written: it gets its own edit session
        try {
          d.drafts.dropEdit(id);
        } catch (e) {
          report(e, 'drafts.dropEdit');
        }
        if (newer) pushEdit(id, newer.body);
      };
      return mutate('editComment', () => {
        if (!editable()) return null;
        wasEditing = edits.has(id);
        done = editCommentImpl(id, body);
        if (wasEditing && done?.batch) {
          try {
            d.drafts.sentEdit?.(id);
          } catch (e) {
            report(e, 'drafts.sentEdit');
          }
        }
        if (wasEditing) emit();
        return done;
      }).then(() => {
        if (!wasEditing) return;
        const b = done?.batch ?? null;
        if (written(b)) return finish();
        // Finding 7: a write slower than settle()'s limit used to leave the keeper on a session the store had closed. Wait
        // for the write itself. A parked write waits for its Retry; the keeper keeps the text meanwhile.
        void b!.gone.then(() => {
          if (!disposed && written(b)) finish();
        });
      });
    },

    startEdit(id) {
      const c = editableComment(id);
      return c ? (edits.get(id)?.body ?? c.body) : null;
    },

    typeEdit(id, body) {
      try {
        typeEditImpl(id, body);
      } catch (e) {
        report(e, 'typeEdit');
      }
    },

    cancelEdit: (id) =>
      mutate('cancelEdit', () => {
        const had = edits.has(id);
        closeEdit(id);
        if (had) emit();
        return null;
      }),
    removeComment: (id) => mutate('removeComment', () => (editable() ? removeCommentImpl(id) : null)),
    removeThread: (id) => mutate('removeThread', () => (editable() ? removeThreadImpl(id) : null)),

    threadAt(r) {
      const lo: CharPos = { page: r.pageIndex, index: r.start };
      const hi: CharPos = { page: r.pageIndex, index: r.end };
      const empty = r.end <= r.start;
      let best: ThreadRow | null = null;
      for (const t of threads.values()) {
        if (t.anchor.kind !== 'text') continue;
        const res = placement.get(t.id);
        if (res && !res.placed) continue; // not placed in this file: never claim a selection
        const a: TextAnchor = res && res.placed && res.anchor.kind === 'text' ? res.anchor : t.anchor;
        const hit = empty ? cmpPos(a.start, lo) <= 0 && cmpPos(lo, a.end) < 0 : cmpPos(a.start, hi) < 0 && cmpPos(lo, a.end) < 0;
        if (hit && (!best || byCreated(best, t) <= 0)) best = t; // the most recent; on a tie, the one added last
      }
      return best ? best.id : null;
    },

    setActive(t) {
      const next = t === null || threads.has(t) ? t : active;
      if (next === active) return;
      active = next;
      emit();
    },

    setFocusedMark(m) {
      const next = m === null || marks.has(m) ? m : focusedMark;
      if (next === focusedMark) return;
      focusedMark = next;
      emit();
    },

    undo: () => {
      // Ctrl+Z right after the first mark is the chip's Undo (R62, R67): the save goes with the mark. When there is no Undo
      // to give after all (more was made, in any tab), it undoes the mark as usual.
      const save = d.save;
      const s = save?.state;
      if (save && s?.kind === 'saved' && s.undoable && savedTriggerKeys.size > 0 && !disposed) {
        return save.undo().then(
          () => (save.state.kind === 'saved' ? mutate('undo', () => undoRedo('undo')) : undefined),
          (e: unknown) => report(e, 'undo'),
        );
      }
      return mutate('undo', () => undoRedo('undo'));
    },
    redo: () => mutate('redo', () => undoRedo('redo')),
    retryParked: () => mutate('retryParked', () => retryParkedImpl()),
    adoptDrafts: () => adoptDraftsImpl(),

    dispose() {
      if (disposed) return;
      disposed = true;
      clearDocGoneTimer();
      stopHolding();
      if (secondAdopt) clearTimeout(secondAdopt);
      if (retryTimer) clearTimeout(retryTimer);
      for (const off of cleanups.splice(0)) off();
      listeners.clear();
      // Last chance for text typed a moment ago. The keeper also flushes on pagehide.
      try {
        void Promise.resolve(d.drafts.flush()).catch((e: unknown) => report(e, 'drafts.flush'));
      } catch (e) {
        report(e, 'drafts.flush');
      }
    },
  };
}
