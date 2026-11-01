// Two documents that are really one paper. This happens when two offline computers each save a different stamped download
// of the same paper before they have met (spec: "notes are split, never lost"), and an alias row later says so. The smaller
// document id wins. `planReparent` lists what moves so that nothing the loser held is dropped; the caller writes the moves
// through the normal store path, so they queue and sync like any other edit.
//
// Pure and idempotent: planning again after the moves are applied gives an empty plan, and two computers that plan from
// the same rows write the same values (the server then sees equal content and treats the second as a retry).

import type { DocumentId } from '../ids';
import type { WireRow } from './columns';
import { mergeHistoryRows } from './merge';

/** The smaller document id wins. Ids are lower-case hex, so plain string order is numeric order. */
export function pickWinner(a: DocumentId, b: DocumentId): { winner: DocumentId; loser: DocumentId } {
  return a <= b ? { winner: a, loser: b } : { winner: b, loser: a };
}

interface Owned {
  id: string;
  documentId: string;
  /** A draft is owned by one open tab and never syncs. It stays where it is until it is sent. */
  draftOfTab?: string | null;
}

export interface ReparentRows {
  /** The loser's rows. Rows that belong to another document are ignored. */
  marks?: readonly Owned[];
  threads?: readonly Owned[];
  comments?: readonly (Owned & { threadId: string })[];
  locations?: readonly Owned[];
  /** Aliases that point at the loser. */
  aliases?: readonly { sha256: string; documentId: string }[];
  /** The reading history of each document, wire form, if it has one. */
  history?: { loser: WireRow | null; winner: WireRow | null };
}

export type ReparentTable = 'marks' | 'threads' | 'comments' | 'locations';

export interface ReparentPlan {
  winner: DocumentId;
  loser: DocumentId;
  /** Rows to point at the winner: set `documentId` to `winner`, keep the id. Ordered by table, then id. */
  moves: { table: ReparentTable; id: string }[];
  /** Aliases (by `sha256`) that pointed at the loser and now point at the winner. */
  repointAliases: string[];
  /** The loser's own fingerprint becomes an alias of the winner, if no alias row says so yet. */
  addAlias: { sha256: DocumentId; documentId: DocumentId } | null;
  /** The two reading histories merged into one for the winner (per-field rules), or null when the loser had none. */
  history: WireRow | null;
  /** Drafts left on the loser because a tab still owns them. Plan again once they are sent. */
  leftInPlace: { table: 'threads' | 'comments'; id: string }[];
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * What to change so that everything the loser holds belongs to the winner. A thread and its comments move together: a
 * comment whose thread moves moves too, even if its own `documentId` was already the winner's.
 */
export function planReparent(loser: DocumentId, winner: DocumentId, rows: ReparentRows): ReparentPlan {
  const empty: ReparentPlan = { winner, loser, moves: [], repointAliases: [], addAlias: null, history: null, leftInPlace: [] };
  if (loser === winner) return empty;

  const moves: ReparentPlan['moves'] = [];
  const leftInPlace: ReparentPlan['leftInPlace'] = [];
  const isDraft = (r: Owned) => r.draftOfTab !== undefined && r.draftOfTab !== null;

  for (const m of [...(rows.marks ?? [])].sort(byId)) if (m.documentId === loser) moves.push({ table: 'marks', id: m.id });

  const movedThreads = new Set<string>();
  for (const t of [...(rows.threads ?? [])].sort(byId)) {
    if (t.documentId !== loser) continue;
    if (isDraft(t)) leftInPlace.push({ table: 'threads', id: t.id });
    else {
      moves.push({ table: 'threads', id: t.id });
      movedThreads.add(t.id);
    }
  }
  for (const c of [...(rows.comments ?? [])].sort(byId)) {
    if (c.documentId !== loser && !movedThreads.has(c.threadId)) continue;
    if (c.documentId === winner && !movedThreads.has(c.threadId)) continue;
    if (isDraft(c)) leftInPlace.push({ table: 'comments', id: c.id });
    else moves.push({ table: 'comments', id: c.id });
  }
  for (const l of [...(rows.locations ?? [])].sort(byId)) if (l.documentId === loser) moves.push({ table: 'locations', id: l.id });

  const repointAliases = (rows.aliases ?? [])
    .filter((a) => a.documentId === loser && a.sha256 !== winner)
    .map((a) => a.sha256)
    .sort();
  const history = rows.history?.loser ? (rows.history.winner ? mergeHistoryRows(rows.history.winner, rows.history.loser) : { ...rows.history.loser, documentId: winner }) : null;

  return { winner, loser, moves, repointAliases, addAlias: { sha256: loser, documentId: winner }, history, leftInPlace };
}
