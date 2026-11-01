/**
 * Undo and redo for the annotation session.
 *
 * One user action is one `Change`: the rows it touched, each with how it looked before and after. Undo and redo
 * apply the inverse (or the same) batch of store operations.
 *
 * Why this is careful: another tab can change a row after we did. Replaying our old snapshot over its newer edit
 * would throw its work away. So before an entry runs, every row it touches is compared with the row as it stands
 * now. If someone else got there first, the whole entry is dropped and nothing is overwritten. Creating a row is
 * undone by a soft delete, which never loses content (the row can be restored), so that one only needs the row to
 * still be there.
 */

import type { Anchor, AnnotationOp, AnnotationTable, CommentRow, MarkRow, ThreadRow } from './boundary';

export type Table = AnnotationTable;
export type AnyRow = MarkRow | ThreadRow | CommentRow;

/** How one row looked before and after a user action. `null` means the row was not live. */
export interface RowChange {
  table: Table;
  id: string;
  before: AnyRow | null;
  after: AnyRow | null;
}

/** One user action. */
export interface Change {
  rows: RowChange[];
}

/** Reads a row as it stands now. `null` when it is not live. */
export type RowReader = (table: Table, id: string) => AnyRow | null;

/** Parents before children: a comment's thread row must be written before the comment (foreign key). */
const TABLE_ORDER: Record<Table, number> = { marks: 0, threads: 1, comments: 2 };

export function rowKey(table: Table, id: string): string {
  return `${table}:${id}`;
}

export function compareTables(a: Table, b: Table): number {
  return TABLE_ORDER[a] - TABLE_ORDER[b];
}

/** A stable text for an anchor's identity: where it is, not how it was measured. */
export function anchorKey(a: Anchor): string {
  switch (a.kind) {
    case 'text':
      return `t|${a.start.page}:${a.start.index}|${a.end.page}:${a.end.index}|${a.quote.quote}`;
    case 'area':
      return `a|${a.page}|${a.rect.join(',')}`;
    case 'figure':
      return `f|${a.page}|${a.rect.join(',')}|${JSON.stringify(a.sub ?? null)}`;
    case 'point':
      return `p|${a.page}|${a.point.join(',')}`;
    case 'page':
      return `g|${a.page}`;
    case 'document':
      return 'd';
  }
}

/**
 * What a person would call "the same row". The store re-stamps rev and hlc and the writer sets updatedAt, so those
 * are left out; everything the owner can change is in.
 */
export function semanticKey(table: Table, row: AnyRow): string {
  switch (table) {
    case 'marks': {
      const m = row as MarkRow;
      return `${m.style}|${m.color ?? '-'}|${anchorKey(m.anchor)}`;
    }
    case 'threads': {
      const t = row as ThreadRow;
      return `${anchorKey(t.anchor)}|${t.placement}`;
    }
    case 'comments': {
      const c = row as CommentRow;
      return `${c.author}|${c.body}`;
    }
  }
}

function sameRow(table: Table, a: AnyRow, b: AnyRow): boolean {
  return semanticKey(table, a) === semanticKey(table, b);
}

type Direction = 'undo' | 'redo';

/** True when running `c` in this direction would not overwrite anything a different tab did since. */
export function canRun(c: Change, dir: Direction, read: RowReader): boolean {
  for (const rc of c.rows) {
    const now = read(rc.table, rc.id);
    const start = dir === 'undo' ? rc.after : rc.before; // how the row should look right now
    const end = dir === 'undo' ? rc.before : rc.after; // how it will look afterwards
    if (start === null && end === null) continue;
    if (start === null) {
      // The row is about to appear again. It must still be gone.
      if (now !== null) return false;
    } else if (end === null) {
      // The row is about to be removed. Removing is safe whatever it now says; it only has to still be there.
      if (now === null) return false;
    } else if (now === null || !sameRow(rc.table, now, start)) {
      // The row is about to change back. It must still look as we left it.
      return false;
    }
  }
  return true;
}

/** The store operations for a change, parents first. `replay` is true when the change ran before (redo). */
export function opsFor(c: Change, dir: Direction | 'first', now: number, read: RowReader): AnnotationOp[] {
  const ops: AnnotationOp[] = [];
  for (const rc of c.rows) {
    const from = dir === 'undo' ? rc.after : rc.before;
    const to = dir === 'undo' ? rc.before : rc.after;
    if (from === null && to === null) continue;
    if (to === null) {
      // Removing. Pass the row as it stands now, so the soft-deleted copy keeps the latest content.
      const current = read(rc.table, rc.id) ?? from;
      if (current === null) continue;
      ops.push({ table: rc.table, op: 'soft-delete', row: { ...current, deletedAt: now } });
    } else if (from === null) {
      // Appearing. The first time a row is made it is an upsert. Every later time it exists, soft-deleted, so restore.
      ops.push({ table: rc.table, op: dir === 'first' ? 'upsert' : 'restore', row: { ...to, deletedAt: null } });
    } else {
      ops.push({ table: rc.table, op: 'upsert', row: { ...to, deletedAt: null } });
    }
  }
  return ops.sort((a, b) => compareTables(a.table, b.table));
}

export interface UndoStack {
  /** A new action. Clears redo. */
  record(c: Change): void;
  /** Pops entries until one can run without overwriting another tab's work. Moves it to redo. */
  takeUndo(read: RowReader): Change | null;
  takeRedo(read: RowReader): Change | null;
  /** Forgets every entry that touches a row for which `gone` is true. */
  prune(gone: (table: Table, id: string) => boolean): void;
  depth(): { undo: number; redo: number };
  clear(): void;
}

export function createUndoStack(limit = 200): UndoStack {
  let undoList: Change[] = [];
  let redoList: Change[] = [];

  function take(from: Change[], dir: Direction, read: RowReader): { change: Change | null; rest: Change[] } {
    const rest = [...from];
    while (rest.length > 0) {
      const top = rest.pop()!;
      if (canRun(top, dir, read)) return { change: top, rest };
      // Skipped for good: running it now would overwrite a newer edit.
    }
    return { change: null, rest };
  }

  return {
    record(c) {
      if (c.rows.length === 0) return;
      undoList.push(c);
      if (undoList.length > limit) undoList = undoList.slice(undoList.length - limit);
      redoList = [];
    },
    takeUndo(read) {
      const r = take(undoList, 'undo', read);
      undoList = r.rest;
      if (r.change) redoList.push(r.change);
      return r.change;
    },
    takeRedo(read) {
      const r = take(redoList, 'redo', read);
      redoList = r.rest;
      if (r.change) undoList.push(r.change);
      return r.change;
    },
    prune(gone) {
      const keep = (c: Change) => !c.rows.some((rc) => gone(rc.table, rc.id));
      undoList = undoList.filter(keep);
      redoList = redoList.filter(keep);
    },
    depth: () => ({ undo: undoList.length, redo: redoList.length }),
    clear() {
      undoList = [];
      redoList = [];
    },
  };
}
