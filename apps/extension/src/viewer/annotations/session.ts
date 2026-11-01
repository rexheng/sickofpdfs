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
 *      the queue and are written, oldest first, the moment the PDF is saved.
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
import {
  anchorKey,
  createUndoStack,
  opsFor,
  rowKey,
  type AnyRow,
  type Change,
  type RowChange,
  type Table,
} from './undo';

// ---------------------------------------------------------------- the public shape (contracts plan section 7)

export interface AnnotationState {
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  drafts: CommentRow[];
  placement: Map<string /* mark or thread id */, Resolution>;
  active: ThreadId | null;
  focusedMark: MarkId | null;
  mode: 'stored' | 'pending-save' | 'memory-only' | 'view-only';
}

export interface AnnotationSession {
  readonly tabId: TabId;
  /** Resolves when the stored rows are loaded and every one has a placement. Not part of the contract; tests and wiring use it. */
  readonly ready: Promise<void>;
  state(): AnnotationState;
  subscribe(cb: () => void): () => void;
  applyStyle(ranges: CharRange[], style: Exclude<MarkStyle, 'area'>, color: MarkColor | null): Promise<void>;
  addAreaMark(a: Extract<Anchor, { kind: 'area' }>): Promise<MarkId>;
  recolor(id: MarkId, c: MarkColor): Promise<void>;
  removeMark(id: MarkId): Promise<void>;
  startThread(a: Anchor, o: { highlight: MarkColor | null }): { threadId: ThreadId; commentId: CommentId };
  startReply(t: ThreadId): CommentId;
  typeDraft(id: CommentId, body: string): void;
  send(id: CommentId): Promise<void>;
  cancel(id: CommentId): Promise<void>;
  editComment(id: CommentId, body: string): Promise<void>;
  removeComment(id: CommentId): Promise<void>;
  removeThread(id: ThreadId): Promise<void>;
  threadAt(r: CharRange): ThreadId | null;
  setActive(t: ThreadId | null): void;
  setFocusedMark(m: MarkId | null): void;
  undo(): Promise<void>;
  redo(): Promise<void>;
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
  /** Told about failures that the session survives (a failed write that will be retried, a placement that threw). */
  onError?(e: unknown, where: string): void;
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

const WRITE_RETRY_MS = [250, 500, 1000, 2000, 4000, 8000];
const REFRESH_ROUNDS = 4;
/** How long undo waits for the store to catch up, and how long a send waits for the draft keeper. */
const SYNC_WAIT_MS = 400;
const FLUSH_WAIT_MS = 2000;
/** A caller waiting for its change to be written gives up after this; the change itself keeps being retried. */
const SETTLE_WAIT_MS = 3000;

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
  ops: AnnotationOp[];
  /** Resolves when the first write attempt ends, whether it worked or not, or when the batch is discarded. */
  firstAttempt: Promise<void>;
  attempted(): void;
}

function newBatch(ops: AnnotationOp[]): Batch {
  let attempted!: () => void;
  const firstAttempt = new Promise<void>((r) => (attempted = r));
  return { ops, firstAttempt, attempted };
}

// ---------------------------------------------------------------- the session

export function createAnnotationSession(d: SessionDeps): AnnotationSession {
  const tabId = d.presence.tabId;
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

  // The write queue.
  const queue: Batch[] = [];
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
    };
    return snap;
  }

  function emit(): void {
    snap = null;
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
   * Called by every change that creates rows. On a PDF that is not saved yet it asks the save controller to save it
   * ("your first mark saves it"). Returns whether this call started the save.
   */
  function startSaveIfNeeded(triggerKeys: string[]): boolean {
    const save = d.save;
    if (mode !== 'pending-save' || !save || kick) return false;
    const s = save.state;
    if (s.kind === 'asking') return false; // the question is already open
    for (const k of triggerKeys) savedTriggerKeys.add(k);
    kick = (async () => {
      try {
        // Identity is still being worked out; firstMark would do nothing yet.
        await waitForSaveState((x) => x.kind !== 'checking').done;
        const now = save.state;
        if (!disposed && (now.kind === 'unsure' || now.kind === 'not-learning')) await save.firstMark();
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
      // The save was undone, or the PDF forgotten. The store has lost everything of this document.
      clearDocGoneTimer();
      docGone = false;
      mode = computeMode();
      dropForgottenRows();
      emit();
      return;
    }
    if (s.kind === 'saved') docGone = false;
    mode = computeMode();
    if (prevMode !== 'stored' && mode === 'stored') onBecameStored();
    if (prevMode !== mode) emit();
  }

  function onBecameStored(): void {
    compactQueue();
    // Drafts that could not be saved until now are given to the keeper again.
    for (const c of drafts.values()) if (c.body !== '') pushDraft(c);
    void pump();
    void refresh().then(adoptDraftsImpl);
  }

  /**
   * The store no longer has this document. Drop what it held: rows we know it had, and the mark that caused the save.
   * What was never written (changes still in the queue, notes still being typed) stays.
   */
  function dropForgottenRows(): void {
    const gone = new Set<string>([...persisted, ...savedTriggerKeys]);
    persisted.clear();
    savedTriggerKeys.clear();
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
    for (const b of [...queue]) {
      b.ops = b.ops.filter((op) => !gone.has(rowKey(op.table, op.row.id)));
      if (b.ops.length === 0) {
        queue.splice(queue.indexOf(b), 1);
        b.attempted();
      }
    }
    undo.prune((table, id) => gone.has(rowKey(table, id)));
    for (const [id, c] of comments) if (!threads.has(c.threadId)) comments.delete(id);
    if (active && !threads.has(active)) active = null;
    if (focusedMark && !marks.has(focusedMark)) focusedMark = null;
    marksVersion++;
  }

  /**
   * Before the first write of a PDF that was not saved when the notes were made: a row that was made and then removed
   * while nothing was stored never needs to exist in the store. Writing it would put text the owner deleted into the
   * database, the backup and sync, as a soft-deleted row. Undo history that points at such a row goes too.
   */
  function compactQueue(): void {
    const first = new Map<string, AnnotationOp['op']>();
    const last = new Map<string, AnnotationOp['op']>();
    for (const b of queue) {
      for (const op of b.ops) {
        const k = rowKey(op.table, op.row.id);
        if (!first.has(k)) first.set(k, op.op);
        last.set(k, op.op);
      }
    }
    const dead = new Set<string>();
    for (const [k, op] of first) if (op === 'upsert' && last.get(k) === 'soft-delete' && !persisted.has(k)) dead.add(k);
    if (dead.size === 0) return;
    for (const b of [...queue]) {
      b.ops = b.ops.filter((op) => !dead.has(rowKey(op.table, op.row.id)));
      if (b.ops.length === 0) {
        queue.splice(queue.indexOf(b), 1);
        b.attempted();
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
    for (const b of inflight ? [inflight, ...queue.filter((x) => x !== inflight)] : queue) {
      for (const op of b.ops) out.add(rowKey(op.table, op.row.id));
    }
    return out;
  }

  function enqueue(ops: AnnotationOp[]): Batch | null {
    if (ops.length === 0 || !d.store) return null; // with no store there is nothing to wait for, and nothing would ever drain
    const b = newBatch(ops);
    queue.push(b);
    void pump();
    return b;
  }

  function scheduleRetry(): void {
    if (retryTimer || disposed) return;
    const ms = WRITE_RETRY_MS[Math.min(failures, WRITE_RETRY_MS.length) - 1] ?? 8000;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void pump();
    }, ms);
  }

  /** Writes queued batches, oldest first, one at a time. Stops at the first failure and tries again later. */
  async function pump(): Promise<void> {
    if (pumping) return;
    syncSaveState();
    pumping = true;
    try {
      while (queue.length > 0 && canWrite()) {
        const b = queue[0]!;
        const id = currentDocId()!;
        const ops: AnnotationOp[] = b.ops.map((op) => ({ ...op, row: { ...op.row, documentId: id } }));
        inflight = b;
        writeEpoch++;
        let finish!: () => void;
        inflightDone = new Promise<void>((r) => (finish = r));
        try {
          await d.store!.writeAnnotations(ops, { tabId });
          // A batch can be emptied and removed while it was in flight (the document was forgotten); only pop our own.
          if (queue[0] === b) queue.shift();
          for (const op of ops) persisted.add(rowKey(op.table, op.row.id));
          failures = 0;
        } catch (e) {
          // The batch was emptied and dropped while it was in flight (the document was forgotten): nothing to retry.
          if (!queue.includes(b)) continue;
          failures++;
          report(e, 'writeAnnotations');
          scheduleRetry();
          return;
        } finally {
          inflight = null;
          inflightDone = null;
          finish();
          b.attempted();
        }
      }
    } finally {
      pumping = false;
    }
    if (queue.length === 0) patchDocIds();
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
      documentId: (currentDocId() ?? '') as DocumentId,
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
        const first = run[0]!;
        const last = run[run.length - 1]!;
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

  /** Gives the keeper the draft's latest text, with its thread if it opened one. */
  function pushDraft(c: CommentRow): void {
    const stash = rootDrafts.get(c.id);
    const thread = stash ? threads.get(c.threadId) : undefined;
    const meta = stash && thread ? ({ [STASH_KEY]: { thread, highlight: stash.highlight } } as unknown as CommentRow['meta']) : c.meta;
    // While the PDF is not saved, the text stays in this session only. It goes to the keeper the moment the PDF is saved.
    if (mode !== 'stored') return;
    keeperHas.add(c.id);
    try {
      d.drafts.change({ ...c, draftOfTab: tabId, meta }, thread);
    } catch (e) {
      report(e, 'drafts.change');
    }
  }

  function dropDraft(id: CommentId): void {
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
    emit();
  }

  function startThreadImpl(a: Anchor, o: { highlight: MarkColor | null }): { threadId: ThreadId; commentId: CommentId } {
    const threadId = newId<ThreadId>();
    const commentId = newId<CommentId>();
    if (disposed || mode === 'view-only') return { threadId, commentId };
    const t = d.now();
    const docId = (currentDocId() ?? '') as DocumentId;
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
    startSaveIfNeeded(triggers);
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
    for (const c of liveCommentsOf(thread.id)) b.rec('comments', c.id, c, null);
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
    return commit(b.build());
  }

  function editCommentImpl(id: CommentId, body: string): Committed | null {
    if (drafts.has(id)) {
      typeDraftImpl(id, body);
      return null;
    }
    const c = comments.get(id);
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
    // An untouched empty draft is not worth saving. Once text has been saved, an emptied draft is saved too.
    if (body !== '' || keeperHas.has(id)) pushDraft(next);
    emit();
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
    const started = startSaveIfNeeded(ops.filter((o) => o.op !== 'soft-delete').map((o) => rowKey(o.table, o.row.id)));
    emit();
    const batch = enqueue(ops);
    resolveLater(back);
    return { batch, started };
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
   * The document row is gone. Two causes look alike: our own Undo (the save controller says so a moment later, and
   * dropForgottenRows runs) or another tab forgetting it (the controller here still says "saved"). Wait a moment
   * and see which. In the second case nothing is dropped: we keep every note in memory and queue it to be written
   * again, because this tab did not ask to forget anything.
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
      if (disposed || drafts.has(r.id) || comments.has(r.id) || r.deletedAt !== null) continue;
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
      keeperHas.add(row.id);
      last = row.threadId;
    }
    if (last) {
      if (active === null) active = last;
      emit();
    }
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
        documentId: (currentDocId() ?? '') as DocumentId,
        author: 'me',
        body: '',
        draftOfTab: tabId,
        meta: {},
        createdAt: d.now(),
        editedAt: null,
      };
      drafts.set(commentId, row);
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

    editComment: (id, body) => mutate('editComment', () => (editable() ? editCommentImpl(id, body) : null)),
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

    undo: () => mutate('undo', () => undoRedo('undo')),
    redo: () => mutate('redo', () => undoRedo('redo')),
    adoptDrafts: () => adoptDraftsImpl(),

    dispose() {
      if (disposed) return;
      disposed = true;
      clearDocGoneTimer();
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
