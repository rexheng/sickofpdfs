/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any -- this kit calls functions that did not exist when it was written, and reads whatever shape they return */
// Test support only (spec-blind tests for T3, the backup core). Written from the spec ("Storage, sync and backup": "Every night ...
// a backup goes to a folder you pick ... 'Restore from backup' in Settings rebuilds the library on a fresh install, merging by
// fingerprint and id"), contracts section 5 ("Backup format v1": manifest.json, library.json, `snapshots/library-<YYYY-MM-DD>.json`
// "the last 7 nightly copies of library.json" (decision D6), "Versions": "Restore reads any `version` up to the one it knows. It
// refuses a higher one with 'Update sickofpdfs first'"; "Restore merges by fingerprint and id. The newer `hlc` wins, and nothing
// local is deleted"), contracts section 4 (the version ladder, the alias rule) and the Phase 3 plan's "Test packs" and "Contract
// additions" (`exportLibrary(): LibraryDump`, `applyRestorePlan(plan)`, "camelCase rows, drafts excluded"). It never saw the code.
//
// The contracts name the module (`packages/core/src/backup/format.ts`) and what it must do, but not one function name, argument
// order or return shape. So this kit is the ONE place that guesses them. It does two things:
//   1. It finds each function by trying the likely names across every file in `packages/core/src/backup/`, and says which names
//      it tried and what the folder exports when none fits. It tries the likely ways to call it, and keeps the one that passes a
//      probe that has nothing to do with correctness (restore a document into an empty library; drop the oldest of eight
//      copies). A function that is simply wrong therefore fails the test about the wrong thing, not every test.
//   2. It reads the result by what it MEANS: after a restore, which rows would the library hold; after a rotation, which files
//      would the folder hold; after a version check, was the backup accepted and what was said.
// A different name or shape is a one-line fix here.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compareHlc } from '../../src/hlc';
import type { CommentRow, DocumentRow, MarkRow, ThreadRow } from '../../src/model/rows';
import { deepFreeze, documentRow, hex64, type AliasRowLike, type HistoryRowLike, type LocationRowLike, type SettingRowLike } from './p3-rows';

// The modules are read from the folder when the tests run, not when Vite transforms this file. (A build-time glob is cached
// with the transformed file, so a kit first run before the backup code exists would keep seeing an empty folder afterwards.)
const BACKUP_DIR = join(import.meta.dirname, '..', '..', 'src', 'backup');

let loaded: Promise<Record<string, Record<string, unknown>>> | null = null;
function modules(): Promise<Record<string, Record<string, unknown>>> {
  loaded ??= (async () => {
    const files = existsSync(BACKUP_DIR) ? readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.spec-blind.ts') && !f.endsWith('.d.ts')) : [];
    const out: Record<string, Record<string, unknown>> = {};
    for (const f of files.sort()) out[f] = (await import(/* @vite-ignore */ join(BACKUP_DIR, f))) as Record<string, unknown>;
    return out;
  })();
  return loaded;
}

async function exportsOf(): Promise<string> {
  const found = Object.entries(await modules()).map(([file, m]) => `${file}: ${Object.keys(m).join(', ') || '(nothing)'}`);
  return found.length > 0 ? found.join(' | ') : 'there are no files in packages/core/src/backup/ yet';
}

async function find<T extends (...a: any[]) => unknown>(names: readonly string[], what: string): Promise<{ fn: T; name: string }> {
  const mods = await modules();
  for (const name of names) {
    for (const m of Object.values(mods)) {
      if (typeof m[name] === 'function') return { fn: m[name] as T, name };
    }
  }
  throw new Error(`packages/core/src/backup/ exports none of [${names.join(', ')}] (${what}). It exports: ${await exportsOf()}`);
}

async function findValue(names: readonly string[]): Promise<unknown> {
  const mods = await modules();
  for (const name of names) for (const m of Object.values(mods)) if (name in m && typeof m[name] !== 'function') return m[name];
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The library as a backup holds it (contracts section 5: `library.json` is `{ tables: { documents, aliases, locations, marks,
// threads, comments, history, settings } }`, camelCase rows)

export const TABLE_NAMES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings'] as const;
export type TableName = (typeof TABLE_NAMES)[number];

export interface Tables {
  documents: DocumentRow[];
  aliases: AliasRowLike[];
  locations: LocationRowLike[];
  marks: MarkRow[];
  threads: ThreadRow[];
  comments: CommentRow[];
  history: HistoryRowLike[];
  settings: SettingRowLike[];
}

export const emptyTables = (): Tables => ({ documents: [], aliases: [], locations: [], marks: [], threads: [], comments: [], history: [], settings: [] });

/** The row's identity inside its table: what "merges by fingerprint and id" means. */
export const keyOf = (table: TableName, row: any): string => {
  switch (table) {
    case 'aliases':
      return String(row.sha256);
    case 'history':
      return String(row.documentId);
    case 'settings':
      return String(row.key);
    default:
      return String(row.id);
  }
};

export function tables(part: Partial<Tables>): Tables {
  return { ...emptyTables(), ...structuredClone(part) };
}

/** The same library under both names a function might read it by: `{ tables }` (the file) and the tables themselves. */
export function dumpOf(t: Tables): Record<string, unknown> {
  return { ...t, tables: t };
}

/**
 * triage (spec gap 4): `blobStored` is this computer's own state (are the bytes in its file storage). A restore writes a new
 * document with `false` until restore copies its PDF in, and keeps the local value otherwise, so libraries compare without it.
 */
function comparable(table: TableName, r: any): any {
  if (table !== 'documents' || r === null || typeof r !== 'object') return r;
  const rest = { ...r };
  delete rest.blobStored;
  return rest;
}

export function byKey(t: Tables, table: TableName): Map<string, any> {
  return new Map((t[table] as any[]).map((r) => [keyOf(table, r), comparable(table, r)]));
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a restore: "which rows would the library hold afterwards"

/** Which table a row is from, by the columns only that table has. Rows are told apart by their shape, not by where they sit. */
export function tableOf(o: any): TableName | null {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  if ('sha256' in o && 'documentId' in o) return 'aliases';
  if ('canonical' in o && 'documentId' in o) return 'locations';
  if ('threadId' in o && 'body' in o) return 'comments';
  if ('style' in o && 'anchor' in o) return 'marks';
  if ('placement' in o && 'anchor' in o) return 'threads';
  if ('firstOpened' in o && 'documentId' in o) return 'history';
  if ('pageCount' in o && 'byteSize' in o) return 'documents';
  if ('key' in o && 'value' in o && 'hlc' in o) return 'settings';
  return null;
}

export interface FoundRow {
  table: TableName;
  row: any;
}

const DELETE_WORD = /^(delete|deletes|deleted|remove|removes|removed|purge|purges|drop|drops)$/i;

/** Every library row anywhere in `x` (a plan can be shaped any way), and every sign of a hard delete. */
export function harvest(x: unknown, out: { rows: FoundRow[]; deletes: unknown[] } = { rows: [], deletes: [] }, seen = new Set<object>()): { rows: FoundRow[]; deletes: unknown[] } {
  if (x === null || typeof x !== 'object' || seen.has(x)) return out;
  seen.add(x);
  const table = tableOf(x);
  if (table) {
    out.rows.push({ table, row: x });
    return out;
  }
  if (!Array.isArray(x)) {
    const o = x as Record<string, unknown>;
    for (const k of ['op', 'action', 'type', 'kind']) if (typeof o[k] === 'string' && DELETE_WORD.test(o[k])) out.deletes.push(x);
    for (const [k, v] of Object.entries(o)) {
      if (DELETE_WORD.test(k) && ((Array.isArray(v) && v.length > 0) || (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0))) out.deletes.push({ [k]: v });
    }
  }
  for (const v of Array.isArray(x) ? x : Object.values(x)) harvest(v, out, seen);
  return out;
}

/** `local` with every row the restore produced written over the row with the same key (added when there is none). */
export function applyRows(local: Tables, rows: readonly FoundRow[]): Tables {
  const after = structuredClone(local);
  for (const { table, row } of rows) {
    const list = after[table] as any[];
    const k = keyOf(table, row);
    const i = list.findIndex((r) => keyOf(table, r) === k);
    if (i >= 0) list[i] = structuredClone(row);
    else list.push(structuredClone(row));
  }
  return after;
}

export interface RestoreOutcome {
  /** The library after the restore is applied to `local`. */
  after: Tables;
  /** Every row the function handed back (what it would write). */
  rows: FoundRow[];
  /** Every sign of a hard delete in what it handed back; there should be none. */
  deletes: unknown[];
  raw: unknown;
}

type RestoreFn = (...a: any[]) => unknown;
type RestoreStyle = { name: string; call: (f: RestoreFn, local: Tables, backup: Tables) => unknown };

const RESTORE_NAMES = ['planRestore', 'restorePlan', 'planRestoreMerge', 'planMerge', 'mergeRestore', 'restoreMerge', 'mergeLibraries', 'mergeLibrary', 'mergeBackup', 'mergeDumps', 'restoreLibrary', 'restoreFromBackup', 'restore'];
const RESTORE_STYLES: RestoreStyle[] = [
  // triage: the plan's signature is planRestore(local, backup, compareHlc); the real comparer is passed
  { name: '(local, backup, compareHlc)', call: (f, l, b) => f(dumpOf(l), dumpOf(b), compareHlc) },
  { name: '(backup, local)', call: (f, l, b) => f(dumpOf(b), dumpOf(l)) },
  { name: '({ local, backup })', call: (f, l, b) => f({ local: dumpOf(l), backup: dumpOf(b) }) },
  { name: '(local tables, backup tables)', call: (f, l, b) => f(l, b) },
  { name: '(backup tables, local tables)', call: (f, l, b) => f(b, l) },
];

let restoreChoice: { fn: RestoreFn; style: RestoreStyle } | null = null;

async function chooseRestore(): Promise<{ fn: RestoreFn; style: RestoreStyle }> {
  if (restoreChoice) return restoreChoice;
  const { fn, name } = await find<RestoreFn>(RESTORE_NAMES, 'the restore merge');
  // The probe asks nothing about correctness: restoring one document into an empty library must hand that document back.
  const probeDoc: DocumentRow = documentRow(hex64('f0'), { title: 'PROBE', hlc: '0000000000001-0000-probe' });
  const seen: string[] = [];
  for (const style of RESTORE_STYLES) {
    try {
      const raw = await Promise.resolve(style.call(fn, emptyTables(), tables({ documents: [probeDoc] })));
      const found = harvest(raw).rows;
      if (found.some((r) => r.table === 'documents' && r.row.id === probeDoc.id)) {
        restoreChoice = { fn, style };
        return restoreChoice;
      }
      seen.push(`${style.name} -> ${found.length} rows`);
    } catch (e) {
      seen.push(`${style.name} -> threw ${(e as Error).message}`);
    }
  }
  throw new Error(`${name}() never handed back a document when restoring one into an empty library, however it was called: ${seen.join('; ')}`);
}

/** Restores `backup` into `local`, with both frozen: a function that edits its input throws. */
export async function restore(local: Tables, backup: Tables): Promise<RestoreOutcome> {
  const { fn, style } = await chooseRestore();
  const l = deepFreeze(structuredClone(local));
  const b = deepFreeze(structuredClone(backup));
  const raw = await Promise.resolve(style.call(fn, l, b));
  const { rows, deletes } = harvest(raw);
  return { after: applyRows(local, rows), rows, deletes, raw };
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing libraries

export function sorted<T>(table: TableName, rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (keyOf(table, a) < keyOf(table, b) ? -1 : keyOf(table, a) > keyOf(table, b) ? 1 : 0));
}

/** A library in a form `toEqual` can compare: every table sorted by key. */
export function canonical(t: Tables): Record<TableName, unknown[]> {
  return Object.fromEntries(TABLE_NAMES.map((n) => [n, sorted(n, t[n] as unknown[]).map((r) => comparable(n, r))])) as Record<TableName, unknown[]>;
}

/** The newer of two rows by stamp, as the contract orders them. */
export const newerOf = (a: { hlc: string }, b: { hlc: string }): number => compareHlc(a.hlc, b.hlc);

/** Problems with how the rows of a library refer to each other: a child with no document, an alias that goes nowhere. */
export function integrityProblems(t: Tables): string[] {
  const docs = new Set(t.documents.map((d) => d.id));
  const out: string[] = [];
  for (const table of ['aliases', 'locations', 'marks', 'threads', 'comments', 'history'] as const) {
    for (const r of t[table] as any[]) if (!docs.has(r.documentId)) out.push(`${table} ${keyOf(table, r)} belongs to a document that is not in the library`);
  }
  const threads = new Set(t.threads.map((x) => x.id));
  for (const c of t.comments) if (!threads.has(c.threadId)) out.push(`comment ${c.id} is in a thread that is not in the library`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Rotation of the nightly copies: "the last 7 nightly copies of library.json" in `snapshots/library-<YYYY-MM-DD>.json`

export const KEEP = 7;
const SNAP = /library-(\d{4}-\d{2}-\d{2})\.json$/;

/** The file name of the copy made on `date` ('YYYY-MM-DD'). */
export const snapName = (date: string): string => `library-${date}.json`;

/** `n` consecutive days starting at `from` ('YYYY-MM-DD'), as dates. */
export function days(from: string, n: number): string[] {
  const t0 = Date.parse(`${from}T12:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(t0 + i * 86_400_000).toISOString().slice(0, 10));
}

type RotateFn = (...a: any[]) => unknown;
interface RotateVariant {
  name: string;
  /** What to call it with: the listing (file names) and today's date. */
  args: (names: string[], today: string, listing: 'bare' | 'folder') => unknown[];
  /** Whether `names` handed over already include today's copy. */
  includesToday: boolean;
}

const noon = (d: string): number => Date.parse(`${d}T12:00:00Z`);
const ROTATE_NAMES = ['planSnapshots', 'rotateSnapshots', 'planSnapshotRotation', 'snapshotPlan', 'pruneSnapshots', 'snapshotsToPrune', 'snapshotsToDelete', 'snapshotsToRemove', 'staleSnapshots', 'expiredSnapshots', 'planRotation', 'rotation'];
const ROTATE_VARIANTS: RotateVariant[] = [
  { name: '(names, ms)', args: (n, t) => [n, noon(t)], includesToday: false },
  { name: '(names, "YYYY-MM-DD")', args: (n, t) => [n, t], includesToday: false },
  { name: '(names, Date)', args: (n, t) => [n, new Date(noon(t))], includesToday: false },
  { name: '(names with today in it)', args: (n) => [n], includesToday: true },
];

const withFolder = (name: string, listing: 'bare' | 'folder'): string => (listing === 'folder' ? `snapshots/${name}` : name);
const bare = (s: string): string => s.replace(/^.*\//, '');
const stringsIn = (x: unknown): string[] => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(stringsIn) : x && typeof x === 'object' ? Object.values(x).flatMap(stringsIn) : []);

type Reading = 'removals' | 'kept';

/** The names left in the folder, read from what the function returned, in the given reading. */
function folderAfter(result: unknown, readingOf: Reading, given: string[], today: string, includesToday: boolean): Set<string> | null {
  const base = new Set(given.map(bare));
  if (!includesToday) base.add(snapName(today));
  if (result === undefined || result === null) return null;
  const match = (s: string): string[] => {
    const b = bare(s);
    if (base.has(b)) return [b];
    const d = SNAP.exec(s)?.[1];
    return d ? [...base].filter((n) => n.includes(d)) : [];
  };
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const o = result as Record<string, unknown>;
    // triage: what is removed is read first. A `keep` list names only the nightly copies kept, not the other files in the folder.
    const keep = Object.keys(o).find((k) => /keep|retain|remain/i.test(k));
    const drop = Object.keys(o).filter((k) => /remove|delete|prune|drop|stale|expire|old/i.test(k));
    if (keep && drop.length === 0) return new Set([...stringsIn(o[keep]).flatMap(match), ...Object.keys(o).filter((k) => /write|create|add|new|today/i.test(k)).flatMap((k) => stringsIn(o[k]).flatMap(match))]);
    if (drop.length > 0) {
      const gone = new Set(drop.flatMap((k) => stringsIn(o[k]).flatMap(match)));
      // a file the function says it will write under a name that is not tonight's is a file in the folder too
      const written = Object.keys(o).filter((k) => /write|create|add|new|today/i.test(k)).flatMap((k) => stringsIn(o[k]).map(bare));
      return new Set([...[...base].filter((n) => !gone.has(n)), ...written]);
    }
    return null;
  }
  const names = stringsIn(result).flatMap(match);
  if (readingOf === 'kept') return new Set(names);
  const gone = new Set(names);
  return new Set([...base].filter((n) => !gone.has(n)));
}

let rotateChoice: { fn: RotateFn; variant: RotateVariant; listing: 'bare' | 'folder'; reading: Reading } | null = null;

async function chooseRotate() {
  if (rotateChoice) return rotateChoice;
  const { fn, name } = await find<RotateFn>(ROTATE_NAMES, 'the snapshot rotation');
  // The probe: seven copies in the folder and a new night makes eight; the oldest must go and the other seven stay.
  const existing = days('2026-10-01', 7);
  const today = '2026-10-08';
  const expected = days('2026-10-02', 7).map(snapName).sort().join(',');
  const seen: string[] = [];
  for (const variant of ROTATE_VARIANTS) {
    for (const listing of ['bare', 'folder'] as const) {
      for (const reading of ['removals', 'kept'] as const) {
        try {
          const given = (variant.includesToday ? [...existing, today] : existing).map((d) => withFolder(snapName(d), listing));
          const result = await Promise.resolve(fn(...variant.args(given, today, listing)));
          const left = folderAfter(result, reading, given, today, variant.includesToday);
          if (left && [...left].sort().join(',') === expected) {
            rotateChoice = { fn, variant, listing, reading };
            return rotateChoice;
          }
          seen.push(`${variant.name}/${listing}/${reading} -> ${JSON.stringify(result)?.slice(0, 80)}`);
        } catch (e) {
          seen.push(`${variant.name}/${listing}/${reading} -> threw ${(e as Error).message}`);
        }
      }
    }
  }
  throw new Error(`${name}() does not drop the oldest of eight nightly copies and keep the other seven, however it was called and read. Tried: ${seen.slice(0, 6).join(' ; ')} ...`);
}

/**
 * The nightly copies that are in the folder once night `today` has been backed up and old copies pruned.
 * `existing` are the file names found in `snapshots/` before tonight's copy is written (today's may already be there).
 */
export async function foldersAfterRotation(existing: readonly string[], today: string): Promise<string[]> {
  const { fn, variant, listing, reading } = await chooseRotate();
  const given = (variant.includesToday && !existing.map(bare).includes(snapName(today)) ? [...existing, snapName(today)] : [...existing]).map((n) => withFolder(n, listing));
  const result = await Promise.resolve(fn(...variant.args(Object.freeze(given) as string[], today, listing)));
  const left = folderAfter(result, reading, given, today, variant.includesToday);
  if (!left) throw new Error(`the rotation returned something this kit cannot read: ${JSON.stringify(result)}`);
  return [...left].sort();
}

// ---------------------------------------------------------------------------------------------------------------
// The version check: "Restore reads any `version` up to the one it knows. It refuses a higher one with 'Update sickofpdfs first'"

export interface Verdict {
  accepted: boolean;
  /** What the owner would be told when it is refused. */
  message: string;
}

const VERSION_NAMES = ['checkBackupVersion', 'assertBackupVersion', 'checkManifest', 'assertManifest', 'validateManifest', 'verifyManifest', 'readManifest', 'parseManifest', 'assertRestorable', 'checkRestorable', 'canRestore', 'checkVersion', 'assertVersion', 'manifestVerdict'];

/** The format version the code knows, when it is exported as a constant; 1 otherwise (contracts section 5: `version: 1`). */
export async function knownVersion(): Promise<number> {
  const v = await findValue(['BACKUP_VERSION', 'BACKUP_FORMAT_VERSION', 'FORMAT_VERSION', 'CURRENT_VERSION', 'BACKUP_FORMAT']);
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
}

const reasonOf = (x: any): string => {
  if (typeof x === 'string') return x;
  for (const k of ['message', 'error', 'reason', 'text', 'why', 'refusal']) if (typeof x?.[k] === 'string') return x[k];
  if (typeof x?.error?.message === 'string') return x.error.message;
  return x === undefined ? '' : JSON.stringify(x);
};

function readVerdict(result: any): Verdict {
  if (typeof result === 'boolean') return { accepted: result, message: '' };
  if (result === undefined) return { accepted: true, message: '' };
  if (result === null) return { accepted: true, message: '' };
  if (typeof result === 'string') return result.trim() === '' ? { accepted: true, message: '' } : { accepted: false, message: result };
  if (typeof result === 'object') {
    const refused = result.ok === false || result.accepted === false || result.restorable === false || result.valid === false || result.refused === true || result.status === 'refused' || result.kind === 'refused' || (result.error !== undefined && result.error !== null && result.error !== false);
    return refused ? { accepted: false, message: reasonOf(result) } : { accepted: true, message: '' };
  }
  return { accepted: true, message: '' };
}

/** Asks the code about a manifest. A thrown error is a refusal, and its message is what the owner is told. */
export async function versionVerdict(manifest: unknown): Promise<Verdict> {
  const { fn } = await find<(m: unknown) => unknown>(VERSION_NAMES, 'the version check');
  const ask = async (m: unknown): Promise<Verdict> => {
    try {
      return readVerdict(await Promise.resolve(fn(m)));
    } catch (e) {
      return { accepted: false, message: e instanceof Error ? e.message : String(e) };
    }
  };
  const first = await ask(manifest);
  // a function that takes the file's text, not the parsed object
  if (!first.accepted && /JSON|Unexpected token|not valid/i.test(first.message) && manifest !== null && typeof manifest === 'object') return ask(JSON.stringify(manifest));
  return first;
}

export function manifest(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'sop-backup',
    version: 1,
    createdAt: Date.UTC(2026, 10, 2, 9, 0, 0),
    schemaVersion: 3,
    appVersion: '0.1.0',
    counts: { documents: 1, marks: 2, threads: 1, comments: 1 },
    pdfs: { ['d0'.repeat(32)]: 482113 },
    ...o,
  };
}
