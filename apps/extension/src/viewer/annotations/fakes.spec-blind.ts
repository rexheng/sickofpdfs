// Test support only (spec-blind tests for drafts, tab presence and the annotation session; slices S8 and S9).
// No import of the code under test except types: the browser tests load this file too.
//
// These are the mocks at the boundary the plan allows: S9 is "against mocks" for the store client, SaveController,
// DraftKeeper and TabPresence. Every fake here follows the CONTRACT text (contracts sections 3 and 4, plan section 7), not
// any implementation:
//   FakeStore    - listAnnotations returns live non-draft rows; writeAnnotations is one atomic batch (upsert, soft-delete,
//                  restore) that stamps rev/hlc, and publishes StoreChange { table, ids, op, documentId, origin, tabId };
//                  saveDraft/sendDraft/listDrafts/claimDrafts as in section 3; draft writes publish nothing.
//   FakeSave     - the SaveController of Task 23 with the transitions of Task 30's table (unsure + first mark -> saved with
//                  an Undo; not-learning + first mark -> asking; answerAsk; memory-only; undo -> forget).
//   FakeKeeper   - a DraftKeeper without timers: change() remembers, flush() writes through saveDraft, drop() discards.
//                  changeEdit()/dropEdit()/editDrafts() do the same for the unsent edit of a sent note (R54).
//   PresenceHub  - TabPresence objects that answer a roll call at once; crash(tab) makes a tab stop answering.
/* eslint-disable @typescript-eslint/require-await -- the fakes keep the async signatures of the interfaces they stand in for */
import { vi } from 'vitest';
import type { Anchor, CommentRow, DocumentId, MarkRow, ThreadRow } from '../../../../../packages/core/src/index';
import type { CommentId, TabId, ThreadId } from '../../../../../packages/core/src/ids';
import type { StoreChange } from './boundary';
import { DOC, DOC2, T_A, T_B, T_C } from '../../store/rows.spec-blind';
import type { EditDraft } from '../../store/annotations';
import type { DraftKeeper } from './drafts';
import type { TabPresence } from './tab-presence';

export { DOC, DOC2, T_A, T_B, T_C };
export type CharRange = { pageIndex: number; start: number; end: number };
export type TextAnchor = Extract<Anchor, { kind: 'text' }>;
export type SaveStateLike =
  | { kind: 'checking' } | { kind: 'saved'; documentId: DocumentId; undoable: boolean }
  | { kind: 'unsure'; reasons: string[] } | { kind: 'not-learning'; reasons: string[] }
  | { kind: 'asking' } | { kind: 'memory-only' } | { kind: 'incognito' };

/** Three short pages. Offsets in the tests point into these strings. */
export const PAGES = [
  'The difference-in-differences estimator compares treated and control groups. Parallel trends is the key assumption.',
  'Placebo tests check the pre-period fit. Event studies plot leads and lags around the policy change.',
  'Standard errors are clustered by state. See Table 2 for robustness checks and Figure 3 for the event study.',
];
export const range = (pageIndex: number, start: number, end: number): CharRange => ({ pageIndex, start, end });
export const textOf = (r: CharRange) => PAGES[r.pageIndex].slice(r.start, r.end);

/** What the viewer's anchor builder gives the session: quote, positions and rects for these ranges (one anchor for the whole selection). */
export async function makeTextAnchor(ranges: CharRange[]): Promise<TextAnchor> {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  return {
    kind: 'text',
    quote: {
      quote: ranges.map(textOf).join('\n'),
      prefix: PAGES[first.pageIndex].slice(Math.max(0, first.start - 32), first.start),
      suffix: PAGES[last.pageIndex].slice(last.end, last.end + 32),
    },
    start: { page: first.pageIndex, index: first.start },
    end: { page: last.pageIndex, index: last.end },
    rects: ranges.map((r) => ({ page: r.pageIndex, rects: [[0.1, 0.1 + r.start / 1000, 0.9, 0.12 + r.start / 1000] as [number, number, number, number]] })),
  };
}

/**
 * Like makeTextAnchor, but longer selections take longer (the real one waits for the page text and the line rects), so two
 * quick actions can finish out of order unless the session keeps them in order. Needs real timers.
 */
export async function slowTextAnchor(ranges: CharRange[]): Promise<TextAnchor> {
  const chars = ranges.reduce((n, r) => n + (r.end - r.start), 0);
  await new Promise<void>((r) => setTimeout(r, Math.ceil(chars / 4)));
  return makeTextAnchor(ranges);
}

/** An AnchorContext over the strings above. Rects and figures are not what these tests are about. */
export function anchorContext(pages: string[] = PAGES) {
  const text = {
    source: () => 'pdfium',
    text: async (i: number) => pages[i] ?? '',
    glyphs: async () => {
      throw new Error('not used');
    },
    rects: async (_i: number, start: number, count: number) => [{ x: start, y: 0, width: count, height: 10 }],
    search: async () => [],
  };
  return { pageCount: pages.length, text, figures: async () => [], dHash: async () => '0000000000000000' } as never;
}

type Op = { table: 'marks' | 'threads' | 'comments'; op: 'upsert' | 'soft-delete' | 'restore'; row: MarkRow | ThreadRow | CommentRow };

export class FakeStore {
  marks = new Map<string, MarkRow>();
  threads = new Map<string, ThreadRow>();
  comments = new Map<string, CommentRow>();
  calls: { method: string; args: unknown[] }[] = [];
  /** Writes that reached the store, in order: 'table:op:id'. */
  log: string[] = [];
  private listeners = new Set<(c: StoreChange) => void>();
  private stamp = 0;
  private clock = 5_000_000;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;
  failWrites = 0;
  /** Documents that were forgotten: the real store would refuse any write for them (foreign key). */
  private forgotten = new Set<string>();

  /** Holds every write until `unhold()`: the pending write is "in flight" and the session must not wait for it to draw. */
  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }
  unhold(): void {
    this.open?.();
    this.gate = null;
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  writeCalls(): string[] {
    return this.calls.filter((c) => ['writeAnnotations', 'saveDraft', 'sendDraft', 'discardDraft'].includes(c.method)).map((c) => c.method);
  }
  private h = () => `${String(1_700_000_000_000 + ++this.stamp).padStart(13, '0')}-0000-fake`;
  private emit(c: StoreChange): void {
    void Promise.resolve().then(() => this.listeners.forEach((cb) => cb(c)));
  }
  /** Lets a test play another tab or device. */
  announce(c: StoreChange): void {
    this.emit(c);
  }
  onChange(cb: (c: StoreChange) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  close(): void {}

  async listAnnotations(documentId: DocumentId) {
    this.calls.push({ method: 'listAnnotations', args: [documentId] });
    const live = <T extends { documentId: DocumentId; deletedAt: number | null; draftOfTab?: TabId | null }>(m: Map<string, T>) =>
      [...m.values()].filter((r) => r.documentId === documentId && r.deletedAt === null && !r.draftOfTab).map((r) => structuredClone(r));
    return {
      marks: live(this.marks).sort((a, b) => a.pageIndex - b.pageIndex || a.sortKey - b.sortKey),
      threads: live(this.threads).sort((a, b) => a.createdAt - b.createdAt),
      comments: live(this.comments).sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  async writeAnnotations(ops: Op[], o?: { tabId?: TabId }): Promise<void> {
    this.calls.push({ method: 'writeAnnotations', args: [ops, o] });
    if (this.gate) await this.gate;
    if (this.failWrites > 0) {
      this.failWrites--;
      throw new Error('disk full');
    }
    const tables = { marks: new Map(this.marks), threads: new Map(this.threads), comments: new Map(this.comments) } as Record<Op['table'], Map<string, never>>;
    const changed = new Map<string, Set<string>>();
    const docOf = new Map<string, DocumentId>();
    for (const { table, op, row } of ops) {
      const map = tables[table];
      const old = map.get(row.id) as { rev?: number; deletedAt?: number | null } | undefined;
      if (this.forgotten.has(row.documentId)) throw new Error('FOREIGN KEY constraint failed');
      if (table === 'comments' && !tables.threads.has((row as CommentRow).threadId)) throw new Error('FOREIGN KEY constraint failed');
      const next = { ...structuredClone(row), rev: old?.rev ?? 0, hlc: this.h() } as Record<string, unknown>;
      if (op === 'soft-delete') next.deletedAt = this.clock++;
      if (op === 'restore') next.deletedAt = null;
      map.set(row.id, next as never);
      if (!changed.has(table)) changed.set(table, new Set());
      changed.get(table)!.add(row.id);
      docOf.set(table, row.documentId);
      this.log.push(`${table}:${op}:${row.id}`);
    }
    this.marks = tables.marks;
    this.threads = tables.threads;
    this.comments = tables.comments;
    for (const [table, ids] of changed) this.emit({ table, ids: [...ids], op: 'upsert', documentId: docOf.get(table), origin: 'tab', ...(o?.tabId ? { tabId: o.tabId } : {}) } as StoreChange);
  }

  async saveDraft(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): Promise<void> {
    this.calls.push({ method: 'saveDraft', args: [row, thread] });
    if (this.gate) await this.gate;
    if (this.forgotten.has(row.documentId)) throw new Error('FOREIGN KEY constraint failed');
    const had = this.comments.get(row.id);
    if (had && !had.draftOfTab) return; // a late write for a note that was already sent
    if (thread && !(this.threads.get(thread.id) && !this.threads.get(thread.id)!.draftOfTab)) this.threads.set(thread.id, structuredClone(thread));
    this.comments.set(row.id, { ...structuredClone(row), hlc: this.h() });
  }
  async sendDraft(commentId: CommentId): Promise<void> {
    this.calls.push({ method: 'sendDraft', args: [commentId] });
    if (this.gate) await this.gate;
    const c = this.comments.get(commentId);
    if (!c || !c.draftOfTab) throw new Error('no such draft');
    const t = this.threads.get(c.threadId);
    this.comments.set(commentId, { ...c, draftOfTab: null, hlc: this.h() });
    this.log.push(`comments:send:${commentId}`);
    this.emit({ table: 'comments', ids: [commentId], op: 'upsert', documentId: c.documentId });
    if (t?.draftOfTab) {
      this.threads.set(t.id, { ...t, draftOfTab: null, hlc: this.h() });
      this.log.push(`threads:send:${t.id}`);
      this.emit({ table: 'threads', ids: [t.id], op: 'upsert', documentId: t.documentId });
    }
  }
  async listDrafts(documentId: DocumentId, tabId: TabId): Promise<CommentRow[]> {
    this.calls.push({ method: 'listDrafts', args: [documentId, tabId] });
    return [...this.comments.values()].filter((c) => c.documentId === documentId && c.draftOfTab === tabId && c.deletedAt === null).map((c) => structuredClone(c));
  }
  async claimDrafts(documentId: DocumentId, tabId: TabId, liveTabs: TabId[]): Promise<CommentRow[]> {
    this.calls.push({ method: 'claimDrafts', args: [documentId, tabId, liveTabs] });
    const claimed: CommentRow[] = [];
    for (const c of this.comments.values()) {
      if (c.documentId !== documentId || !c.draftOfTab || c.draftOfTab === tabId || liveTabs.includes(c.draftOfTab)) continue;
      const t = this.threads.get(c.threadId);
      if (t?.draftOfTab === c.draftOfTab) this.threads.set(t.id, { ...t, draftOfTab: tabId });
      const mine = { ...c, draftOfTab: tabId };
      this.comments.set(c.id, mine);
      claimed.push(structuredClone(mine));
    }
    return claimed;
  }
  /** Contract addition (triage ruling): the new threads of a tab's drafts, so a restored draft knows where it sits. */
  async listDraftThreads(documentId: DocumentId, tabId: TabId): Promise<ThreadRow[]> {
    this.calls.push({ method: 'listDraftThreads', args: [documentId, tabId] });
    return [...this.threads.values()].filter((t) => t.documentId === documentId && t.draftOfTab === tabId && t.deletedAt === null).map((t) => structuredClone(t));
  }
  /** Contract addition (triage ruling): deletes an unsent draft and its empty new thread. Never touches a comment that was sent. */
  async discardDraft(commentId: CommentId): Promise<void> {
    this.calls.push({ method: 'discardDraft', args: [commentId] });
    if (this.gate) await this.gate;
    const c = this.comments.get(commentId);
    if (!c?.draftOfTab) return;
    this.comments.delete(commentId);
    const t = this.threads.get(c.threadId);
    if (t?.draftOfTab && ![...this.comments.values()].some((x) => x.threadId === t.id)) this.threads.delete(t.id);
  }
  /** R54: unsent edits of sent notes, one per comment, with the rules the contract records. A closed one only refuses a late save. */
  edits = new Map<string, { documentId: DocumentId; threadId: ThreadId; editId: string; tab: TabId | null; body: string; state: 'open' | 'closed'; updatedAt: number }>();
  async saveEditDraft(e: { commentId: CommentId; editId: string; draftOfTab: TabId; body: string }): Promise<void> {
    this.calls.push({ method: 'saveEditDraft', args: [e] });
    if (this.gate) await this.gate;
    const c = this.comments.get(e.commentId);
    if (!c || c.deletedAt !== null) throw new Error('not-found: there is no such comment to edit');
    if (c.draftOfTab) throw new Error('use-save-draft: this comment is an unsent draft');
    const cur = this.edits.get(e.commentId);
    if (cur?.editId === e.editId) {
      if (cur.state === 'closed') throw new Error('edit-closed: this edit was already sent or cancelled');
      if (cur.tab !== e.draftOfTab) throw new Error('draft-owned-elsewhere: another tab owns this edit');
    } else if (cur?.state === 'open') {
      if (cur.tab !== e.draftOfTab) throw new Error('edit-in-progress: another tab has an unsent edit of this comment');
      if (e.editId < cur.editId) throw new Error('edit-closed: a newer edit of this comment has begun');
    }
    this.edits.set(e.commentId, { documentId: c.documentId, threadId: c.threadId, editId: e.editId, tab: e.draftOfTab, body: e.body, state: 'open', updatedAt: this.clock++ });
  }
  private editDraft(commentId: string, x: NonNullable<ReturnType<FakeStore['edits']['get']>>): EditDraft {
    return { commentId: commentId as CommentId, threadId: x.threadId, documentId: x.documentId, editId: x.editId, draftOfTab: x.tab!, body: x.body, updatedAt: x.updatedAt };
  }
  async listEditDrafts(documentId: DocumentId, tabId: TabId): Promise<EditDraft[]> {
    this.calls.push({ method: 'listEditDrafts', args: [documentId, tabId] });
    return [...this.edits].filter(([id, x]) => x.documentId === documentId && x.tab === tabId && x.state === 'open' && this.comments.get(id)?.deletedAt === null).map(([id, x]) => this.editDraft(id, x));
  }
  async claimEditDrafts(documentId: DocumentId, tabId: TabId, liveTabs: TabId[]): Promise<EditDraft[]> {
    this.calls.push({ method: 'claimEditDrafts', args: [documentId, tabId, liveTabs] });
    const claimed: EditDraft[] = [];
    for (const [id, x] of this.edits) {
      if (x.documentId !== documentId || x.state !== 'open' || x.tab === tabId || (x.tab && liveTabs.includes(x.tab))) continue;
      x.tab = tabId;
      claimed.push(this.editDraft(id, x));
    }
    return claimed;
  }
  async discardEditDraft(commentId: CommentId, editId: string): Promise<void> {
    this.calls.push({ method: 'discardEditDraft', args: [commentId, editId] });
    if (this.gate) await this.gate;
    const c = this.comments.get(commentId);
    if (!c) return;
    const cur = this.edits.get(commentId);
    if (!cur) this.edits.set(commentId, { documentId: c.documentId, threadId: c.threadId, editId, tab: null, body: '', state: 'closed', updatedAt: this.clock++ });
    else if (cur.editId === editId) this.edits.set(commentId, { ...cur, tab: null, body: '', state: 'closed' });
  }
  /** A draft thread row, as saveDraft(row, thread) stored it. A test can read it; the contract gives callers no method for it. */
  draftThread(id: ThreadId): ThreadRow | undefined {
    return this.threads.get(id);
  }
  /** The state after "Forget": nothing of the document is left. */
  forgetAll(): void {
    this.forgotten.add(DOC);
    this.marks.clear();
    this.threads.clear();
    this.comments.clear();
  }
}

export class FakeSave {
  state: SaveStateLike;
  calls: string[] = [];
  onForget: (() => void) | null = null;
  private listeners = new Set<(s: SaveStateLike) => void>();
  constructor(initial: SaveStateLike, private id: DocumentId = DOC) {
    this.state = initial;
  }
  private set(s: SaveStateLike): void {
    this.state = s;
    this.listeners.forEach((cb) => cb(s));
  }
  subscribe(cb: (s: SaveStateLike) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  async start(): Promise<void> {}
  async requestSave(): Promise<void> {
    this.calls.push('requestSave');
    if (this.state.kind !== 'saved') this.set({ kind: 'saved', documentId: this.id, undoable: false });
  }
  /** Task 30's table: unsure + first mark saves with an Undo; not-learning + first mark asks; the rest do nothing. It returns when the question is asked, not answered. */
  async firstMark(): Promise<void> {
    this.calls.push('firstMark');
    if (this.state.kind === 'unsure') {
      await Promise.resolve();
      this.set({ kind: 'saved', documentId: this.id, undoable: true });
    } else if (this.state.kind === 'not-learning') this.set({ kind: 'asking' });
  }
  async answerAsk(save: boolean): Promise<void> {
    this.calls.push(`answerAsk:${save}`);
    if (this.state.kind !== 'asking') return;
    if (save) this.set({ kind: 'saved', documentId: this.id, undoable: false });
    else this.set({ kind: 'memory-only' });
  }
  async undo(): Promise<void> {
    this.calls.push('undo');
    if (this.state.kind === 'saved' && this.state.undoable) {
      this.onForget?.();
      this.set({ kind: 'unsure', reasons: ['No filter yet: your first mark saves it'] });
    }
  }
  documentId(): DocumentId | null {
    return this.state.kind === 'saved' ? this.state.documentId : null;
  }
}

export class PresenceHub {
  private live = new Set<TabId>();
  join(tabId: TabId): TabPresence {
    this.live.add(tabId);
    return {
      tabId,
      liveTabs: async () => [...this.live],
      close: () => void this.live.delete(tabId),
    };
  }
  /** The tab dies without saying goodbye. */
  crash(tabId: TabId): void {
    this.live.delete(tabId);
  }
}

export class FakeKeeper implements DraftKeeper {
  pending = new Map<string, { row: CommentRow & { draftOfTab: TabId }; thread?: ThreadRow }>();
  calls: { method: string; args: unknown[] }[] = [];
  memoryOnly = false;
  private threads = new Map<string, ThreadRow>();
  constructor(private store: FakeStore | null, private presence: TabPresence) {}
  change(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): void {
    this.calls.push({ method: 'change', args: [structuredClone(row), thread && structuredClone(thread)] });
    this.pending.set(row.id, { row: structuredClone(row), thread: thread ? structuredClone(thread) : this.pending.get(row.id)?.thread });
  }
  async flush(): Promise<void> {
    this.calls.push({ method: 'flush', args: [] });
    for (const [id, { row, thread }] of [...this.pending]) {
      this.pending.delete(id);
      if (this.store && !this.memoryOnly) await this.store.saveDraft(row, thread);
    }
    for (const x of this.edits.values()) {
      if (!x.dirty || !this.store || this.memoryOnly) continue;
      x.dirty = false;
      await this.store.saveEditDraft({ commentId: x.comment.id, editId: x.editId, draftOfTab: this.presence.tabId, body: x.body });
    }
  }
  /** Like the real keeper: forget the draft and ask the store to discard it. A comment that was sent is never touched (the store's rule). */
  drop(id: CommentId): void {
    this.calls.push({ method: 'drop', args: [id] });
    this.pending.delete(id);
    if (this.store && !this.memoryOnly) void this.store.discardDraft(id);
  }
  async restore(documentId: DocumentId): Promise<CommentRow[]> {
    this.calls.push({ method: 'restore', args: [documentId] });
    if (!this.store) return [...this.pending.values()].map((p) => p.row);
    const live = await this.presence.liveTabs();
    await this.store.claimDrafts(documentId, this.presence.tabId, live);
    for (const t of await this.store.listDraftThreads(documentId, this.presence.tabId)) this.threads.set(t.id, t);
    await this.store.claimEditDrafts(documentId, this.presence.tabId, live);
    for (const e of await this.store.listEditDrafts(documentId, this.presence.tabId)) {
      const comment = (await this.store.listAnnotations(documentId)).comments.find((c) => c.id === e.commentId);
      if (comment && !this.edits.has(e.commentId)) this.edits.set(e.commentId, { comment, editId: e.editId, body: e.body, dirty: false });
    }
    return this.store.listDrafts(documentId, this.presence.tabId);
  }
  draftThread(threadId: ThreadId): ThreadRow | undefined {
    return [...this.pending.values()].find((p) => p.thread?.id === threadId)?.thread ?? this.threads.get(threadId);
  }
  /** R54: unsent edits of sent notes, held until flush() writes them through the store. */
  private edits = new Map<string, { comment: CommentRow; editId: string; body: string; dirty: boolean }>();
  changeEdit(comment: CommentRow, body: string): void {
    this.calls.push({ method: 'changeEdit', args: [structuredClone(comment), body] });
    const had = this.edits.get(comment.id);
    this.edits.set(comment.id, { comment: structuredClone(comment), editId: had?.editId ?? `${Date.now().toString(36).padStart(10, '0')}-${this.edits.size}`, body, dirty: true });
  }
  dropEdit(commentId: CommentId): void {
    this.calls.push({ method: 'dropEdit', args: [commentId] });
    const x = this.edits.get(commentId);
    this.edits.delete(commentId);
    if (x && this.store && !this.memoryOnly) void this.store.discardEditDraft(commentId, x.editId);
  }
  editDrafts(documentId: DocumentId): EditDraft[] {
    return [...this.edits.values()]
      .filter((x) => x.comment.documentId === documentId)
      .map((x) => ({ commentId: x.comment.id, threadId: x.comment.threadId, documentId, editId: x.editId, draftOfTab: this.presence.tabId, body: x.body, updatedAt: 0 }));
  }
  dispose(): void {
    this.calls.push({ method: 'dispose', args: [] });
  }
  called(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

/** Lets pending promises and queued change events run. Real timers only. */
export const settle = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
export const until = (fn: () => boolean, message = 'the condition never became true'): Promise<void> => vi.waitFor(() => { if (!fn()) throw new Error(message); }, { timeout: 2000, interval: 5 });

/** The marks of a session as plain tuples, for comparing with the store and with an expectation. */
export const marksOf = (s: { marks: MarkRow[] }) =>
  s.marks
    .map((m) => ({ style: m.style, color: m.color, from: m.anchor.kind === 'text' ? [m.anchor.start.page, m.anchor.start.index] : null, to: m.anchor.kind === 'text' ? [m.anchor.end.page, m.anchor.end.index] : null }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export const storeMarks = async (store: FakeStore) => marksOf({ marks: (await store.listAnnotations(DOC)).marks });
