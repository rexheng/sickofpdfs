// How a restore merges a backup into the library that is already here (contracts §5). It is a plan: pure, no database, no clock.
// `applyRestorePlan` (S13) writes it; nothing is written here.
//
// The rules are the sync merge's (Phase 5, `sync/merge.ts`), so restoring a backup and pulling the same rows from the cloud
// end in the same library:
//   - Rows are matched by fingerprint and id. A row only the backup has is added. A row only this library has stays.
//     Nothing that is here is ever deleted by a restore (a soft-deleted row is a row: the newer one wins like any other).
//   - Where both sides have a row, the NEWER `hlc` wins the whole row. Equal stamps are broken by the rows' content, so the
//     result never depends on which side was which. `compareHlc` is passed in (the real one is `hlc.ts`).
//   - No lost notes (CLAUDE.md, the first non-negotiable). A restore cannot see which version a computer had seen, as sync
//     does with `baseRev`, so it reads that from the stamp's device: a computer's later stamp follows its own earlier one (its
//     clock only goes up), and two versions written on different computers are rivals. R101: a backup row stamped by THIS computer
//     (`options.device`) that is newer than the row here is a rival too, since a backup made here can never be newer than the library
//     here (a crafted or damaged one could be). For rivals the sync rules apply:
//       - an edit beats a delete, whatever the stamps say (spec sync rules; R58: the deleting side's last words go with it);
//       - two live comments with different, non-empty bodies keep both: the loser's body becomes a new comment in the same
//         thread, made exactly as sync makes it (`makeConflictCopy`: same id, `ConflictCopyMeta`, "edited on another device").
//         It is written only if no comment has its id yet, so a restore run again, or a copy the owner deleted, adds nothing.
//   - Reading history merges field by field (earliest first opened, latest last opened, the larger counters, the union of
//     pages visited; the last position comes from the newer stamp). Locations keep the earliest `firstSeen` and the latest
//     `lastSeen` whichever row wins. Two aliases for one fingerprint that name different documents keep the smaller
//     document id; aliases from either side are all kept.
//   - Identity (spec "Identity rules" 2 and 5; the store refuses both with `alias-conflict`): a fingerprint is a document or
//     an alias, never both. A backup alias whose fingerprint is a document here is not written (the two copies keep their own
//     notes: split, never lost). A backup document that this library knows as an alias of one of its documents is not
//     written as a document: its notes, marks, locations, history and aliases are written onto that document instead.
//   - Tags (local schema v5, R92): a tag is a row like a note (the newer stamp wins; an edit beats a delete). Two tags with the same name
//     are one tag: a backup tag whose name a live tag here already has is folded into that one, and the rows that name it follow. A
//     tag on a reading, and a "taken off this reading" row, are rows keyed `<documentId>:<tagId>`; they are written only when their
//     reading and tag are known, and a tag the owner took off a reading here is not put back by a backup (an auto tag whose removal
//     is recorded on either side is left out).
//   - Drafts never come back. A row whose document (or, for a comment, whose thread) is not known is left out. A setting
//     that looks like a secret is left out. `author` never changes: a backup row that disagrees about it is ignored.
//   - It is idempotent: apply the plan, plan again, and the second plan is empty.
//
// `rev` is the store's own counter and is never compared; `applyRestorePlan` gives written rows their own. A restored
// document is marked `blobStored: false` until its PDF is copied in (the local value is kept for a document that is here).
//
import type { HlcStamp } from '../hlc';
import type { DocumentId } from '../ids';
import { clampHlc, parseHlc } from '../sync/clamp';
import { isSyncableSetting } from '../sync/columns';
import { makeConflictCopy, mergeHistoryRows, needsCopy } from '../sync/merge';
import { MAX_HLC_SKEW_MS } from '../sync/protocol';
import { DUMP_TABLES, isDraftRow, type DumpTable, type LibraryDump, type LibraryTables } from './format';

export type CompareHlc = (a: HlcStamp, b: HlcStamp) => number;

export interface RestoreOptions {
  /**
   * Unix ms. A backup stamp more than 5 minutes ahead of it is pulled back to it before the comparison, as the sync server
   * does, so a damaged or hostile backup cannot win every conflict for ever. A stamp that cannot be read is left as it is
   * (it sorts below every stamp that can be).
   */
  now?: number;
  /**
   * This computer's device id, as its own stamps carry it (R101). A backup written here can never hold a newer version of a row than
   * the library itself, so a backup row stamped by this computer that is newer than the row here is treated as a rival, as one from
   * another computer is: for a note, the words here are kept as an "edited on another device" copy, and a delete never beats an edit.
   * Without it, two rows stamped by one computer follow each other, as always.
   */
  device?: string;
}

export type TableCounts = Record<DumpTable, number>;

export interface RestoreSummary {
  /** Rows the backup has that this library does not. */
  added: TableCounts;
  /** Rows both have, where the result differs from what is here. */
  updated: TableCounts;
}

export interface RestorePlan {
  /** The rows to write, each table sorted by its key and parents first (`DUMP_TABLES`). Only rows that are new or change. */
  tables: LibraryTables;
  /** Documents in the backup whose PDF this library does not hold yet (restore copies them from `pdf/`, if the backup has them). */
  needsPdf: DocumentId[];
  summary: RestoreSummary;
}

type Row = Record<string, unknown>;

const KEY: Readonly<Record<DumpTable, string>> = {
  documents: 'id',
  aliases: 'sha256',
  locations: 'id',
  marks: 'id',
  threads: 'id',
  comments: 'id',
  history: 'documentId',
  settings: 'key',
  tags: 'id',
  reading_tags: 'id',
  auto_tag_removed: 'id',
};

const zeros = (): TableCounts => ({
  documents: 0,
  aliases: 0,
  locations: 0,
  marks: 0,
  threads: 0,
  comments: 0,
  history: 0,
  settings: 0,
  tags: 0,
  reading_tags: 0,
  auto_tag_removed: 0,
});
const hlcOf = (r: Row): string => (typeof r.hlc === 'string' ? r.hlc : '');
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const cmpText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** JSON with the keys in order, so equal rows give equal text whatever order their keys were written in. */
function canonical(v: unknown, omit: readonly string[] = []): string {
  const walk = (x: unknown, top: boolean): unknown => {
    if (Array.isArray(x)) return x.map((e) => walk(e, false));
    if (typeof x === 'object' && x !== null) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) {
        if (top && omit.includes(k)) continue;
        o[k] = walk((x as Row)[k], false);
      }
      return o;
    }
    return x;
  };
  return JSON.stringify(walk(v, true)) ?? 'null';
}

const REV = ['rev'] as const;

/** Rows by key. Rows without a usable key are ignored. */
function indexBy(rows: readonly unknown[] | undefined, key: string): Map<string, Row> {
  const m = new Map<string, Row>();
  for (const r of rows ?? []) {
    if (typeof r !== 'object' || r === null) continue;
    const k = (r as Row)[key];
    if (typeof k === 'string' && k !== '') m.set(k, r as Row);
  }
  return m;
}

const byKey = (key: string) => (a: Row, b: Row): number => cmpText(str(a[key]), str(b[key]));

/** A setting that may come back: the sync rule, so a key that says secret (`claude.apiKey`, `cloud_token`) never does. */
const restorableSetting = (key: string): boolean => isSyncableSetting(key);

function clampStamp(stamp: string, now: number | undefined): string {
  if (now === undefined) return stamp;
  const p = parseHlc(stamp);
  return p !== null && p.ms > now + MAX_HLC_SKEW_MS ? clampHlc(stamp, now) : stamp;
}

/** The tables of a dump, as rows with no drafts (and no comments of a draft thread), and the backup's stamps pulled back. */
function rowsOf(dump: LibraryDump | undefined, now: number | undefined, clamp: boolean): Record<DumpTable, Row[]> {
  const out = {} as Record<DumpTable, Row[]>;
  const tables = (dump?.tables ?? {}) as unknown as Partial<Record<DumpTable, unknown>>;
  for (const t of DUMP_TABLES) {
    const raw = tables[t];
    out[t] = (Array.isArray(raw) ? raw : [])
      .filter((r): r is Row => typeof r === 'object' && r !== null && !isDraftRow(r as { draftOfTab?: unknown }))
      .map((r) => (clamp && typeof r.hlc === 'string' ? { ...r, hlc: clampStamp(r.hlc, now) } : r));
  }
  const rawThreads = tables.threads;
  const draftThreads = new Set<string>();
  if (Array.isArray(rawThreads)) for (const t of rawThreads as unknown[]) if (typeof t === 'object' && t !== null && isDraftRow(t)) draftThreads.add(str((t as Row).id));
  if (draftThreads.size > 0) out.comments = out.comments.filter((c) => !draftThreads.has(str(c.threadId)));
  return out;
}

const isDeleted = (r: Row): boolean => r.deletedAt !== null && r.deletedAt !== undefined;
const deviceOf = (r: Row): string | null => parseHlc(hlcOf(r))?.device ?? null;

/** Two versions from different computers (or with a stamp that cannot be read): neither is known to follow the other. */
function rivals(a: Row, b: Row): boolean {
  const da = deviceOf(a);
  const db = deviceOf(b);
  return da === null || db === null || da !== db;
}

interface Hooks {
  /** A backup row that must not be restored at all. */
  skip?(b: Row): boolean;
  /** A backup row that loses to the one here whatever the stamps say. */
  keepLocal?(l: Row, b: Row): boolean;
  /** How a backup row is written when the library has no row for it. */
  fresh?(b: Row): Row;
  /** How a backup row that wins is written over a local one (fields only this library knows are kept). */
  adopt?(b: Row, l: Row): Row;
  /** The row to write once the winner is known (locations widen their dates). `winner` is `l` or `b`. */
  combine?(winner: Row, l: Row, b: Row): Row;
  /** The table soft-deletes (`deletedAt`): between rivals, a live row beats a tombstone. */
  softDelete?: boolean;
  /** Comments: between rivals, the losing body is kept. Called with the winner and the loser. */
  keepLoser?(winner: Row, loser: Row): void;
}

/** Whole-row last writer wins, for one table. Returns the rows to write and how many are new. `here`: this computer's device id. */
function mergeLww(table: DumpTable, lRows: readonly Row[], bRows: readonly Row[], cmp: CompareHlc, hooks: Hooks = {}, here?: string): { rows: Row[]; added: number; updated: number } {
  const key = KEY[table];
  const lm = indexBy(lRows, key);
  const rows: Row[] = [];
  let added = 0;
  let updated = 0;
  for (const b of [...bRows].sort(byKey(key))) {
    if (hooks.skip?.(b)) continue;
    const l = lm.get(str(b[key]));
    if (!l) {
      rows.push(hooks.fresh ? hooks.fresh(b) : b);
      added += 1;
      continue;
    }
    if (hooks.keepLocal?.(l, b)) continue;
    const c = cmp(hlcOf(b), hlcOf(l));
    // R101: this computer's own backup cannot be newer than this computer's library; such a row is treated as another computer's.
    const rival = rivals(l, b) || (here !== undefined && c > 0 && deviceOf(b) === here);
    const bWins =
      hooks.softDelete === true && rival && isDeleted(l) !== isDeleted(b)
        ? !isDeleted(b) // an edit beats a delete
        : c > 0 || (c === 0 && canonical(b, REV) > canonical(l, REV));
    if (rival && hooks.keepLoser) hooks.keepLoser(bWins ? b : l, bWins ? l : b);
    let merged: Row = bWins ? (hooks.adopt ? hooks.adopt(b, l) : b) : l;
    if (hooks.combine) merged = hooks.combine(merged, l, b);
    if (canonical(merged, REV) !== canonical(l, REV)) {
      rows.push(merged);
      updated += 1;
    }
  }
  return { rows, added, updated };
}

const CHILD_TABLES = ['aliases', 'locations', 'marks', 'threads', 'comments', 'history'] as const;

/**
 * A backup document whose fingerprint this library holds as an alias of one of its documents (a stamped re-download seen
 * first here as a copy, and first there as the document) is the same paper. It is taken out of the backup's documents and
 * everything that belonged to it is moved onto the document here, so its notes come back where the paper opens. Two reading
 * histories that land on one document are merged as sync merges them. Edits `B` in place.
 */
function foldAliasedDocuments(L: Record<DumpTable, Row[]>, B: Record<DumpTable, Row[]>, cmp: CompareHlc): void {
  const localDocs = new Set(L.documents.map((d) => str(d.id)));
  const aliasOf = new Map(L.aliases.map((a) => [str(a.sha256), str(a.documentId)]));
  const fold = new Map<string, string>();
  for (const d of B.documents) {
    const id = str(d.id);
    const to = aliasOf.get(id);
    if (id !== '' && !localDocs.has(id) && to !== undefined && localDocs.has(to)) fold.set(id, to);
  }
  if (fold.size === 0) return;
  B.documents = B.documents.filter((d) => !fold.has(str(d.id)));
  for (const t of CHILD_TABLES) {
    B[t] = B[t].map((r) => {
      const to = fold.get(str(r.documentId));
      return to === undefined ? r : { ...r, documentId: to };
    });
  }
  // A tag row's id carries its reading's id, so the id follows; two rows that now share an id keep the newer.
  for (const t of ['reading_tags', 'auto_tag_removed'] as const) {
    const byId = new Map<string, Row>();
    for (const r of B[t]) {
      const to = fold.get(str(r.documentId));
      const row: Row = to === undefined ? r : { ...r, documentId: to, id: `${to}:${str(r.tagId)}` };
      const other = byId.get(str(row.id));
      if (!other || cmp(hlcOf(row), hlcOf(other)) > 0) byId.set(str(row.id), row);
    }
    B[t] = [...byId.values()];
  }
  const history = new Map<string, Row>();
  for (const h of B.history) {
    const id = str(h.documentId);
    const other = history.get(id);
    if (!other) {
      history.set(id, h);
      continue;
    }
    const newer = cmp(hlcOf(h), hlcOf(other)) > 0 ? h : other;
    history.set(id, { ...newer, ...mergeHistoryRows(other, h), lastPosition: newer.lastPosition ?? null, hlc: hlcOf(newer) });
  }
  B.history = [...history.values()];
}

const lower = (v: unknown): string => str(v).trim().toLowerCase();

/**
 * Two tags with the same name are one tag. A live backup tag whose name a live tag here already has (under another id) is taken out
 * of the backup, and the reading tags and removals that name it are moved onto the tag here. Within the backup the first tag (by id)
 * of a name wins. Edits `B` in place.
 */
function foldSameNameTags(L: Record<DumpTable, Row[]>, B: Record<DumpTable, Row[]>, cmp: CompareHlc): void {
  const holder = new Map<string, string>(); // lower-case name -> id of the live tag that has it
  for (const t of L.tags) if (!isDeleted(t)) holder.set(lower(t.name), str(t.id));
  const remap = new Map<string, string>();
  for (const t of [...B.tags].sort(byKey('id'))) {
    if (isDeleted(t)) continue;
    const name = lower(t.name);
    const has = holder.get(name);
    if (has === undefined) holder.set(name, str(t.id));
    else if (has !== str(t.id)) remap.set(str(t.id), has);
  }
  if (remap.size === 0) return;
  B.tags = B.tags.filter((t) => !remap.has(str(t.id)));
  for (const table of ['reading_tags', 'auto_tag_removed'] as const) {
    const byId = new Map<string, Row>();
    for (const r of B[table]) {
      const to = remap.get(str(r.tagId));
      const row: Row = to === undefined ? r : { ...r, tagId: to, id: `${str(r.documentId)}:${to}` };
      const other = byId.get(str(row.id));
      if (!other || cmp(hlcOf(row), hlcOf(other)) > 0) byId.set(str(row.id), row);
    }
    B[table] = [...byId.values()];
  }
}

/**
 * What to write so that the library here holds everything in `backup`. See the file's header for the rules.
 * `local` is the library as it is now (`exportLibrary()`); `compareHlc` orders two stamps (negative, zero, positive).
 */
export function planRestore(local: LibraryDump, backup: LibraryDump, compareHlc: CompareHlc, options: RestoreOptions = {}): RestorePlan {
  const cmp: CompareHlc = (a, b) => compareHlc(a, b);
  const here = options.device;
  const L = rowsOf(local, undefined, false);
  const B = rowsOf(backup, options.now, true);
  foldAliasedDocuments(L, B, cmp);
  foldSameNameTags(L, B, cmp);
  const rows = {} as Record<DumpTable, Row[]>;
  const added = zeros();
  const updated = zeros();
  const done = (t: DumpTable, r: { rows: Row[]; added: number; updated: number }): void => {
    rows[t] = r.rows;
    added[t] = r.added;
    updated[t] = r.updated;
  };

  // documents: a row that is here keeps its own `blobStored`; a new one has no PDF yet
  const lDocs = indexBy(L.documents, 'id');
  const docIds = new Set<string>([...lDocs.keys(), ...B.documents.map((d) => str(d.id)).filter((id) => id !== '')]);
  done(
    'documents',
    mergeLww('documents', L.documents, B.documents, cmp, {
      softDelete: true,
      fresh: (b) => ({ ...b, blobStored: false }),
      adopt: (b, l) => {
        const merged: Row = { ...b };
        delete merged.blobStored;
        if (l.blobStored !== undefined) merged.blobStored = l.blobStored;
        return merged;
      },
    }, here),
  );

  // aliases: every alias is kept; for one fingerprint naming two documents, the smaller document id wins
  {
    const lm = indexBy(L.aliases, 'sha256');
    const out: Row[] = [];
    let a = 0;
    let u = 0;
    for (const b of [...B.aliases].sort(byKey('sha256'))) {
      // an alias names a document, and is never one itself
      if (!docIds.has(str(b.documentId)) || docIds.has(str(b.sha256))) continue;
      const l = lm.get(str(b.sha256));
      if (!l) {
        out.push(b);
        a += 1;
        continue;
      }
      if (str(l.documentId) === str(b.documentId)) {
        const newer = cmp(hlcOf(b), hlcOf(l)) > 0 ? hlcOf(b) : hlcOf(l);
        const merged: Row = { ...l, createdAt: Math.min(num(l.createdAt), num(b.createdAt)), similarity: Math.max(num(l.similarity), num(b.similarity)), hlc: newer };
        if (canonical(merged, REV) !== canonical(l, REV)) {
          out.push(merged);
          u += 1;
        }
      } else if (str(b.documentId) < str(l.documentId)) {
        out.push(b);
        u += 1;
      }
    }
    done('aliases', { rows: out, added: a, updated: u });
  }

  const known = (b: Row): boolean => docIds.has(str(b.documentId));

  // locations: the winner's row, with the earliest first sighting and the latest last sighting
  done(
    'locations',
    mergeLww('locations', L.locations, B.locations, cmp, {
      skip: (b) => !known(b),
      combine: (winner, l, b) => ({ ...winner, firstSeen: Math.min(num(l.firstSeen), num(b.firstSeen)), lastSeen: Math.max(num(l.lastSeen), num(b.lastSeen)) }),
    }),
  );

  // notes
  const authorChanged = (l: Row, b: Row): boolean => l.author !== b.author;
  done('marks', mergeLww('marks', L.marks, B.marks, cmp, { skip: (b) => !known(b), keepLocal: authorChanged, softDelete: true }, here));
  const threadsResult = mergeLww('threads', L.threads, B.threads, cmp, { skip: (b) => !known(b), softDelete: true }, here);
  done('threads', threadsResult);
  const threadIds = new Set<string>([...L.threads.map((t) => str(t.id)), ...B.threads.filter(known).map((t) => str(t.id))]);
  // the losing words of two rival comments, as new comments (only where no comment has that id yet)
  const commentIds = new Set<string>([...L.comments, ...B.comments].map((c) => str(c.id)));
  const copies = new Map<string, Row>();
  const keepLoser = (winner: Row, loser: Row): void => {
    if (!needsCopy(winner, loser)) return;
    const copy = makeConflictCopy(winner, loser, deviceOf(loser) ?? 'unknown', hlcOf(winner));
    const id = str(copy.row.id);
    if (!commentIds.has(id)) copies.set(id, { ...copy.row, rev: 0, hlc: copy.hlc });
  };
  const commentsResult = mergeLww('comments', L.comments, B.comments, cmp, {
    skip: (b) => !known(b) || !threadIds.has(str(b.threadId)),
    keepLocal: authorChanged,
    softDelete: true,
    keepLoser,
  }, here);
  done('comments', { ...commentsResult, rows: [...commentsResult.rows, ...copies.values()], added: commentsResult.added + copies.size });

  // reading history: field by field
  {
    const lm = indexBy(L.history, 'documentId');
    const out: Row[] = [];
    let a = 0;
    let u = 0;
    for (const b of [...B.history].sort(byKey('documentId'))) {
      if (!known(b)) continue;
      const l = lm.get(str(b.documentId));
      if (!l) {
        out.push(b);
        a += 1;
        continue;
      }
      const bNewer = cmp(hlcOf(b), hlcOf(l)) > 0;
      const fields = mergeHistoryRows(l, b);
      const merged: Row = { ...l, ...fields, lastPosition: (bNewer ? b : l).lastPosition ?? null, hlc: bNewer ? hlcOf(b) : hlcOf(l) };
      if (canonical(merged, REV) !== canonical(l, REV)) {
        out.push(merged);
        u += 1;
      }
    }
    done('history', { rows: out, added: a, updated: u });
  }

  // settings: newest wins; a key that looks like a secret never comes back
  done('settings', mergeLww('settings', L.settings, B.settings, cmp, { skip: (b) => !restorableSetting(str(b.key)) }));

  // tags (R92): rows like notes, soft-deleted; a reading's tags and removals follow once their reading and tag are known
  done('tags', mergeLww('tags', L.tags, B.tags, cmp, { softDelete: true }, here));
  const tagIds = new Set<string>([...L.tags.map((t) => str(t.id)), ...B.tags.map((t) => str(t.id))]);
  const knownTag = (b: Row): boolean => known(b) && tagIds.has(str(b.tagId));
  const removedKeys = new Set<string>([...L.auto_tag_removed, ...B.auto_tag_removed].map((r) => `${str(r.documentId)}:${str(r.tagId)}`));
  done('reading_tags', mergeLww('reading_tags', L.reading_tags, B.reading_tags, cmp, { skip: (b) => !knownTag(b) || (b.source === 'auto' && removedKeys.has(`${str(b.documentId)}:${str(b.tagId)}`)) }));
  done('auto_tag_removed', mergeLww('auto_tag_removed', L.auto_tag_removed, B.auto_tag_removed, cmp, { skip: (b) => !knownTag(b) }));

  // documents of the backup whose PDF is not held here
  const finalDocs = new Map(lDocs);
  for (const r of rows.documents) finalDocs.set(str(r.id), r);
  const needsPdf = B.documents
    .map((d) => str(d.id))
    .filter((id) => id !== '' && finalDocs.get(id)?.blobStored !== true)
    .sort() as DocumentId[];

  const tables = {} as Record<DumpTable, Row[]>;
  for (const t of DUMP_TABLES) tables[t] = [...rows[t]].sort(byKey(KEY[t]));
  return { tables: tables as unknown as LibraryTables, needsPdf, summary: { added, updated } };
}

/** True when a plan changes nothing: every table empty. */
export function isEmptyPlan(plan: Pick<RestorePlan, 'tables'>): boolean {
  return DUMP_TABLES.every((t) => plan.tables[t].length === 0);
}

/** The number of rows a plan writes in all. */
export function planSize(plan: Pick<RestorePlan, 'tables'>): number {
  return DUMP_TABLES.reduce((n, t) => n + plan.tables[t].length, 0);
}
