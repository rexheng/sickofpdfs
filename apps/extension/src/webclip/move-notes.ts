// "Save this page to library" (spec R103): when a saved page changed and is saved again as a newer version, the owner's marks
// and notes move to it, re-anchored on their quotes with the viewer's own re-anchoring (core's `resolveAnchor`, the same that
// places notes when a PDF opens).
//
// - A note whose words are found in the new version moves to where they are now.
// - A note whose words are not found moves too, with its old anchor and quote, marked "unplaced": the new version lists it under
//   "Couldn't place" with its words. A note is never deleted.
// - A mark (a highlight, an underline) whose words are not found stays on the earlier version, where it is still drawn: a mark
//   has no words of its own to show, so moving it would hide it.
// - A note still being typed in a tab stays on the earlier version (the store keeps it there).
// The store does the move in one transaction (`moveNotes`): everything moves, or nothing does.
import { type AnchorContext, type DocumentId, resolveAnchor, type Resolution } from '@sop/core';
import type { MoveNotesInput, MoveNotesResult } from '../store/store-api';
import type { StoreClient } from '../store/client';
import { placeOf } from '../viewer/annotations/place-of';

export interface MovedNotes extends MoveNotesResult {
  /** Notes that moved but could not be placed in the new text ("Couldn't place"). */
  unplaced: number;
  /** Marks whose words are not in the new version: they stay on the earlier version. */
  marksStayed: number;
}

type MoveStore = Pick<StoreClient, 'listAnnotations' | 'moveNotes'>;

async function place(anchor: Parameters<typeof resolveAnchor>[0], ctx: AnchorContext): Promise<Resolution | null> {
  try {
    return await resolveAnchor(anchor, ctx);
  } catch {
    return null; // counts as not found: the note keeps its words
  }
}

/** Moves the owner's marks and notes from `from` (the earlier version) to `to`. Null when there was nothing to move. */
export async function moveNotesToNewerVersion(store: MoveStore, from: DocumentId, to: DocumentId, ctx: AnchorContext): Promise<MovedNotes | null> {
  const a = await store.listAnnotations(from);
  const liveMarks = a.marks.filter((m) => m.deletedAt === null);
  const liveThreads = a.threads.filter((t) => t.deletedAt === null && t.draftOfTab === null);
  if (liveMarks.length === 0 && liveThreads.length === 0) return null;
  const input: MoveNotesInput = { from, to, marks: [], threads: [] };
  let marksStayed = 0;
  let unplaced = 0;
  for (const m of liveMarks) {
    const r = await place(m.anchor, ctx);
    if (r === null || !r.placed) {
      marksStayed += 1;
      continue;
    }
    const where = placeOf(r.anchor);
    input.marks.push({ id: m.id, anchor: r.anchor, pageIndex: where.pageIndex ?? m.pageIndex, sortKey: where.sortKey ?? m.sortKey });
  }
  for (const t of liveThreads) {
    const r = await place(t.anchor, ctx);
    if (r === null || !r.placed) {
      unplaced += 1;
      input.threads.push({ id: t.id, anchor: t.anchor, pageIndex: t.pageIndex, sortKey: t.sortKey, placement: 'unplaced' });
      continue;
    }
    const where = placeOf(r.anchor);
    input.threads.push({ id: t.id, anchor: r.anchor, pageIndex: where.pageIndex, sortKey: where.sortKey, placement: 'placed' });
  }
  const moved = await store.moveNotes(input);
  return { ...moved, unplaced: Math.min(unplaced, moved.threads), marksStayed };
}

/** What the saving tab says about the move, in plain words; empty when there is nothing worth stopping for. */
export function movedNotesWords(m: MovedNotes | null, failed: boolean): string[] {
  if (failed) return ['Your notes couldn’t be moved to this version, so they stay on the earlier version. Nothing was lost.'];
  if (m === null) return [];
  const out: string[] = [];
  const n = (k: number, one: string, many: string) => (k === 1 ? `1 ${one}` : `${k} ${many}`);
  if (m.unplaced > 0) {
    out.push(`${n(m.unplaced, 'note', 'notes')} couldn’t be placed in the new text. You’ll find ${m.unplaced === 1 ? 'it' : 'them'} in Notes, under “Couldn’t place”, with ${m.unplaced === 1 ? 'its' : 'their'} words.`);
  }
  if (m.marksStayed > 0) out.push(`${n(m.marksStayed, 'mark is', 'marks are')} on words that are no longer on the page. ${m.marksStayed === 1 ? 'It stays' : 'They stay'} on the earlier version.`);
  if (m.kept > 0) out.push(`${n(m.kept, 'note was', 'notes were')} still being written, so ${m.kept === 1 ? 'it stays' : 'they stay'} on the earlier version.`);
  if (out.length > 0) out.unshift('Your notes moved to this version.');
  return out;
}
