// What a synced row looks like on the wire and in a database. One table of facts, shared by the extension's collect and apply
// code and by the Worker, so the two sides can never disagree about a column.
//
//  - The wire row is camelCase with parsed JSON and real booleans (`rows.ts` shapes), and has no `rev` and no `hlc`: those
//    travel beside it (`ChangeEntry.baseRev`, `ChangeEntry.hlc`).
//  - A database row is snake_case with INTEGER booleans, JSON as TEXT and a bitset as a BLOB.
//  - The cloud mirrors the local columns exactly (local schema v1 to v3) and adds server columns on top (`seq`, `device`,
//    `comments.mcp_request_id`). Server columns never appear in a wire row.
//
// Nothing here throws on bad input: `normalizeWireRow` answers with a reason, so the server can refuse one entry and go on.

import type { SyncedTable } from './protocol';

export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'bitset';

export interface ColumnSpec {
  /** The camelCase wire name. */
  field: string;
  /** The snake_case column in both databases. */
  column: string;
  type: ColumnType;
  nullable: boolean;
  /** `text`: the exact length (ids are 64 hex characters). */
  length?: number;
  /** `text` with `length`: lower-case hex only. */
  hex?: boolean;
  /** `text`: the allowed values (a CHECK ... IN (...)). */
  oneOf?: readonly string[];
  /** `text`: a size cap that protects the database, never a product limit. */
  maxLength?: number;
  /** `integer` and `real`: inclusive range. */
  min?: number;
  max?: number;
  /** `json`: what the parsed value must be. */
  json?: 'array' | 'object';
  /**
   * Not part of the wire row at all. It is the client's own state, or the server's, and each side keeps its own:
   * `documents.blobStored` is "the PDF is in this copy's file storage" locally and "the PDF is in R2" in the cloud, and only
   * the server sets the cloud's. A pulled value never overwrites a local one and a pushed value is never trusted.
   */
  localOnly?: boolean;
  /** Must be null or absent on the wire; a row that has it set is refused. `draftOfTab`: drafts never sync. */
  neverSync?: boolean;
  /** Added by a later local schema step with `ALTER TABLE ... ADD COLUMN`, so in a database it sits after `rev` and `hlc`. */
  since?: 2;
}

export interface TableSpec {
  table: SyncedTable;
  /** The wire field that is the row's id (`ChangeEntry.id`). */
  idField: string;
  /** Rows of this table can be soft-deleted (they have `deletedAt`). */
  softDelete: boolean;
  /** The field that names the row's document; null for `documents` itself and `settings`. */
  documentField: string | null;
  columns: readonly ColumnSpec[];
  /** Columns that exist only in the cloud copy of the table. */
  serverColumns: readonly string[];
}

const MAX_TEXT = 1_000_000; // 1 MB: D1 rows are limited to 2 MB

const id64: Partial<ColumnSpec> = { type: 'text', length: 64, hex: true, nullable: false };

function text(field: string, o: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, column: snakeCase(field), type: 'text', nullable: false, maxLength: 8192, ...o };
}
function int(field: string, o: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, column: snakeCase(field), type: 'integer', nullable: false, min: 0, ...o };
}
function bool(field: string, o: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, column: snakeCase(field), type: 'boolean', nullable: false, ...o };
}
function json(field: string, kind: 'array' | 'object', o: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, column: snakeCase(field), type: 'json', nullable: false, json: kind, maxLength: 262_144, ...o };
}
function real(field: string, o: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, column: snakeCase(field), type: 'real', nullable: false, ...o };
}
function hex64(field: string, o: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, column: snakeCase(field), ...id64, ...o } as ColumnSpec;
}

const AUTHORS = ['me', 'claude'] as const;
const NOTE_ID = { maxLength: 128 };

/** The tables, as local schema v1 to v3 define them. Order is the wire order; `dbColumns` gives the database order. */
export const TABLE_SPECS: Readonly<Record<SyncedTable, TableSpec>> = {
  documents: {
    table: 'documents',
    idField: 'id',
    softDelete: true,
    documentField: null,
    serverColumns: ['seq', 'device'],
    columns: [
      hex64('id'),
      int('pageCount'),
      int('byteSize'),
      text('title', { nullable: true, maxLength: 4096 }),
      json('authors', 'array'),
      int('year', { nullable: true, min: -10_000, max: 10_000 }),
      text('doi', { nullable: true, maxLength: 512 }),
      text('arxivId', { nullable: true, maxLength: 128 }),
      text('pdfId', { nullable: true, maxLength: 256 }),
      text('kind', { oneOf: ['paper', 'book', 'slides', 'other'] }),
      bool('hasText'),
      bool('encrypted'),
      bool('indexText'),
      bool('blobStored', { localOnly: true }),
      bool('starred'),
      json('saveReasons', 'array'),
      int('createdAt'),
      int('updatedAt'),
      int('deletedAt', { nullable: true }),
    ],
  },
  aliases: {
    table: 'aliases',
    idField: 'sha256',
    softDelete: false,
    documentField: 'documentId',
    serverColumns: ['seq', 'device'],
    columns: [
      hex64('sha256'),
      hex64('documentId'),
      real('similarity', { min: 0.995, max: 1 }),
      int('createdAt'),
    ],
  },
  locations: {
    table: 'locations',
    idField: 'id',
    softDelete: false,
    documentField: 'documentId',
    serverColumns: ['seq', 'device'],
    columns: [
      hex64('id'),
      hex64('documentId'),
      text('kind', { oneOf: ['url', 'file'] }),
      text('canonical', { maxLength: 8192 }),
      text('raw', { maxLength: 8192 }),
      text('viaPage', { nullable: true, maxLength: 8192 }),
      int('firstSeen'),
      int('lastSeen'),
    ],
  },
  marks: {
    table: 'marks',
    idField: 'id',
    softDelete: true,
    documentField: 'documentId',
    serverColumns: ['seq', 'device'],
    columns: [
      text('id', NOTE_ID),
      hex64('documentId'),
      text('style', { oneOf: ['highlight', 'underline', 'bold', 'strike', 'area'] }),
      int('color', { nullable: true, min: 1, max: 5 }),
      json('anchor', 'object'),
      int('pageIndex'),
      real('sortKey'),
      int('createdAt'),
      int('updatedAt'),
      int('deletedAt', { nullable: true }),
      text('author', { oneOf: AUTHORS, since: 2 }),
    ],
  },
  threads: {
    table: 'threads',
    idField: 'id',
    softDelete: true,
    documentField: 'documentId',
    serverColumns: ['seq', 'device'],
    columns: [
      text('id', NOTE_ID),
      hex64('documentId'),
      json('anchor', 'object'),
      int('pageIndex', { nullable: true }),
      real('sortKey', { nullable: true }),
      text('placement', { oneOf: ['placed', 'unplaced'] }),
      int('createdAt'),
      int('updatedAt'),
      int('deletedAt', { nullable: true }),
      text('draftOfTab', { nullable: true, neverSync: true, maxLength: 128, since: 2 }),
    ],
  },
  comments: {
    table: 'comments',
    idField: 'id',
    softDelete: true,
    documentField: 'documentId',
    serverColumns: ['seq', 'device', 'mcp_request_id'],
    columns: [
      text('id', NOTE_ID),
      text('threadId', NOTE_ID),
      hex64('documentId'),
      text('author', { oneOf: AUTHORS }),
      text('body', { maxLength: MAX_TEXT }),
      text('draftOfTab', { nullable: true, neverSync: true, maxLength: 128 }),
      json('meta', 'object'),
      int('createdAt'),
      int('editedAt', { nullable: true }),
      int('deletedAt', { nullable: true }),
    ],
  },
  history: {
    table: 'history',
    idField: 'documentId',
    softDelete: false,
    documentField: 'documentId',
    serverColumns: ['seq', 'device'],
    columns: [
      hex64('documentId'),
      int('firstOpened'),
      int('lastOpened'),
      int('openCount'),
      int('readingMs'),
      json('lastPosition', 'object', { nullable: true }),
      { field: 'pagesVisited', column: 'pages_visited', type: 'bitset', nullable: false, maxLength: 65_536 },
    ],
  },
  settings: {
    table: 'settings',
    idField: 'key',
    softDelete: false,
    documentField: null,
    serverColumns: ['seq', 'device'],
    columns: [text('key', { maxLength: 256 }), text('value', { maxLength: 262_144 })],
  },
};

/** The two columns every synced row has beside its data: the base revision and the hybrid-clock stamp. */
export const META_COLUMNS = ['rev', 'hlc'] as const;

export function snakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function camelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function tableSpec(table: SyncedTable): TableSpec {
  return TABLE_SPECS[table];
}

/** Columns that cross the wire, in database order: everything except the local-only ones. */
export function wireColumns(table: SyncedTable): readonly ColumnSpec[] {
  return TABLE_SPECS[table].columns.filter((c) => c.localOnly !== true);
}

/**
 * Every column of a database row for this table, in order: data, then `rev` and `hlc`, then (cloud only) server columns.
 * Both sides have `blob_stored` and `draft_of_tab`; in the cloud copy `draft_of_tab` is always NULL (a CHECK).
 */
export function dbColumns(table: SyncedTable, side: 'local' | 'cloud'): string[] {
  const spec = TABLE_SPECS[table];
  const v1 = spec.columns.filter((c) => c.since === undefined).map((c) => c.column);
  const later = spec.columns.filter((c) => c.since !== undefined).map((c) => c.column);
  return [...v1, ...META_COLUMNS, ...later, ...(side === 'cloud' ? spec.serverColumns : [])];
}

/** The id a `ChangeEntry` carries for this wire row, or null when the row has none. */
export function wireIdOf(table: SyncedTable, row: Record<string, unknown>): string | null {
  const v = row[TABLE_SPECS[table].idField];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ─── Settings ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Settings that must never sync, whatever their key: a name that says secret. Secrets live in `sop-local`, outside backup,
 * export and sync; this is a second lock on the door, not the first.
 */
const SECRET_KEY = /(^|[._:-])(api[_-]?key|apikey|token|secret|password|passphrase|salt|credential)s?($|[._:-])/i;

export function isSyncableSetting(key: string): boolean {
  // "filterSalt" reads as "filter.salt"
  return key.length > 0 && key.length <= 256 && !SECRET_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1.$2'));
}

const FILTER_LISTS = new Set(['filter.allow', 'filter.deny']);

/**
 * A folder on this computer: a Windows path, a network path, a rooted path or a `file:` link. These reveal the user name and
 * folder layout, so a filter list leaves the computer with web entries only (hosts, hosts with a folder, web addresses).
 */
export function isLocalFolderEntry(entry: string): boolean {
  const e = entry.trim().toLowerCase();
  return /^[a-z]:[\\/]/.test(e) || e.startsWith('\\\\') || e.startsWith('/') || e.startsWith('file:') || e.includes('\\');
}

/**
 * `filter.allow` / `filter.deny` hold a JSON array of strings. Returns the array without its local-folder entries, as JSON,
 * and whether anything was removed; or null when the value is not an array of strings.
 */
export function sanitizeFilterList(value: string): { value: string; changed: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) return null;
  const kept = parsed.filter((e: string) => !isLocalFolderEntry(e));
  return { value: JSON.stringify(kept), changed: kept.length !== parsed.length };
}

// ─── File locations leave as file names ────────────────────────────────────────────────────────────────────────────────

/** `C:\Users\me\x.pdf`, `file:///C:/Users/me/x.pdf` and `/home/me/x.pdf` all become `x.pdf`; a bare name stays as it is. */
export function fileNameOnly(value: string): string {
  const noQuery = value.replace(/[?#].*$/, '');
  const parts = noQuery.split(/[\\/]/);
  const last = parts[parts.length - 1] ?? '';
  return last.length > 0 ? last : value.replace(/^file:/i, '').replace(/[\\/]+/g, ' ').trim();
}

function looksLikeLocalPath(v: string): boolean {
  return /^file:/i.test(v) || /^[a-zA-Z]:[\\/]/.test(v) || v.startsWith('\\\\') || v.startsWith('/') || v.includes('\\');
}

// ─── Bitsets (history.pagesVisited) ────────────────────────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) return null;
  try {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** A bitset with its trailing zero bytes removed: the canonical form, so equal sets compare equal. */
export function trimBitset(bytes: Uint8Array): Uint8Array {
  let n = bytes.length;
  while (n > 0 && bytes[n - 1] === 0) n--;
  return bytes.subarray(0, n);
}

/** The union of two page bitsets (bit i = page i). */
export function unionBitsets(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) | (b[i] ?? 0);
  return trimBitset(out);
}

// ─── Wire rows ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WireRow = Record<string, unknown>;

export type NormalizeResult =
  | { ok: true; row: WireRow; /** The server changed a value to keep it out of the cloud (a path, a filter entry). */ adjusted: boolean }
  | { ok: false; code: 'bad_row' | 'draft' | 'too_large'; message: string };

function bad(message: string, code: 'bad_row' | 'draft' | 'too_large' = 'bad_row'): NormalizeResult {
  return { ok: false, code, message };
}

function checkColumn(c: ColumnSpec, v: unknown): { ok: true; value: unknown } | { ok: false; message: string; code?: 'too_large' } {
  if (v === undefined || v === null) {
    if (c.nullable) return { ok: true, value: null };
    return { ok: false, message: `${c.field} is required` };
  }
  switch (c.type) {
    case 'text': {
      if (typeof v !== 'string') return { ok: false, message: `${c.field} must be text` };
      if (c.length !== undefined && v.length !== c.length) return { ok: false, message: `${c.field} must be ${c.length} characters` };
      if (c.hex === true && !/^[0-9a-f]+$/.test(v)) return { ok: false, message: `${c.field} must be lower-case hex` };
      if (c.oneOf && !c.oneOf.includes(v)) return { ok: false, message: `${c.field} must be one of ${c.oneOf.join(', ')}` };
      if (c.maxLength !== undefined && v.length > c.maxLength) return { ok: false, message: `${c.field} is too long`, code: 'too_large' };
      if ((c.field === 'id' || c.field === 'key') && v.length === 0) return { ok: false, message: `${c.field} is empty` };
      return { ok: true, value: v };
    }
    case 'integer': {
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, message: `${c.field} must be an integer` };
      if (c.min !== undefined && v < c.min) return { ok: false, message: `${c.field} is below ${c.min}` };
      if (c.max !== undefined && v > c.max) return { ok: false, message: `${c.field} is above ${c.max}` };
      return { ok: true, value: v };
    }
    case 'real': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, message: `${c.field} must be a number` };
      if (c.min !== undefined && v < c.min) return { ok: false, message: `${c.field} is below ${c.min}` };
      if (c.max !== undefined && v > c.max) return { ok: false, message: `${c.field} is above ${c.max}` };
      return { ok: true, value: v };
    }
    case 'boolean':
      if (typeof v !== 'boolean') return { ok: false, message: `${c.field} must be true or false` };
      return { ok: true, value: v };
    case 'json': {
      const isArr = Array.isArray(v);
      const isObj = typeof v === 'object' && !isArr;
      if ((c.json === 'array' && !isArr) || (c.json === 'object' && !isObj)) return { ok: false, message: `${c.field} must be an ${c.json}` };
      let size: number;
      try {
        size = JSON.stringify(v).length;
      } catch {
        return { ok: false, message: `${c.field} is not JSON` };
      }
      if (c.maxLength !== undefined && size > c.maxLength) return { ok: false, message: `${c.field} is too large`, code: 'too_large' };
      return { ok: true, value: v };
    }
    case 'bitset': {
      if (typeof v !== 'string') return { ok: false, message: `${c.field} must be base64 text` };
      const bytes = base64ToBytes(v);
      if (!bytes) return { ok: false, message: `${c.field} is not base64` };
      if (c.maxLength !== undefined && bytes.length > c.maxLength) return { ok: false, message: `${c.field} is too large`, code: 'too_large' };
      return { ok: true, value: bytesToBase64(trimBitset(bytes)) };
    }
  }
}

/**
 * Checks one wire row against the table's columns (types, enums, ranges, the CHECKs the local schema has) and returns the
 * normalised row: every wire column present (nulls explicit), nothing else. `rev`, `hlc`, `seq`, `device`, local-only columns
 * and unknown fields are dropped (a newer extension may know columns this build does not; they stay on that device).
 * Also the one place where private data is kept out of the cloud:
 *  - a `file` location keeps only the file name;
 *  - `filter.allow` and `filter.deny` keep web entries only, never a folder path.
 * Normalising an already-normalised row returns it unchanged.
 */
export function normalizeWireRow(table: SyncedTable, raw: unknown): NormalizeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('row must be an object');
  const src = raw as Record<string, unknown>;
  const out: WireRow = {};
  let adjusted = false;
  for (const c of TABLE_SPECS[table].columns) {
    if (c.localOnly === true) continue;
    if (c.neverSync === true) {
      if (src[c.field] !== undefined && src[c.field] !== null) return bad(`${c.field} is set: drafts never sync`, 'draft');
      out[c.field] = null;
      continue;
    }
    const r = checkColumn(c, src[c.field]);
    if (!r.ok) return bad(r.message, r.code ?? 'bad_row');
    out[c.field] = r.value;
  }

  if (table === 'locations' && out.kind === 'file') {
    for (const f of ['canonical', 'raw'] as const) {
      const v = out[f] as string;
      if (looksLikeLocalPath(v)) {
        out[f] = fileNameOnly(v);
        adjusted = true;
      }
    }
    const via = out.viaPage;
    if (typeof via === 'string' && looksLikeLocalPath(via)) {
      out.viaPage = null;
      adjusted = true;
    }
  }
  if (table === 'settings') {
    const key = out.key as string;
    if (FILTER_LISTS.has(key)) {
      const s = sanitizeFilterList(out.value as string);
      if (!s) return bad(`${key} must be a list of strings`);
      out.value = s.value;
      if (s.changed) adjusted = true;
    }
  }
  return { ok: true, row: out, adjusted };
}

/** The same JSON for two equal values whatever their key order. Used to compare rows. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

// ─── Database rows <-> wire rows ────────────────────────────────────────────────────────────────────────────────────────

/** What a SQL layer hands back or accepts. `number[]` is how D1 returns a BLOB. */
export type DbValue = string | number | null | bigint | Uint8Array | ArrayBuffer | number[];
export type DbRow = Record<string, DbValue | undefined>;

function toBytes(v: DbValue | undefined): Uint8Array {
  if (v === null || v === undefined) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v);
  return new Uint8Array(0);
}

/**
 * A database row (snake_case) as a wire row plus its `rev` and `hlc`. Local-only and server columns are left out. Text
 * columns that hold JSON are parsed; a value that does not parse is left out of the row so `normalizeWireRow` reports it.
 */
export function dbToWire(table: SyncedTable, db: DbRow): { row: WireRow; rev: number; hlc: string } {
  const row: WireRow = {};
  for (const c of TABLE_SPECS[table].columns) {
    if (c.localOnly === true) continue;
    const v = db[c.column];
    if (c.neverSync === true) {
      row[c.field] = v === undefined ? null : v;
      continue;
    }
    if (v === null || v === undefined) {
      row[c.field] = null;
      continue;
    }
    switch (c.type) {
      case 'boolean':
        row[c.field] = v === 1 || v === 1n;
        break;
      case 'json':
        try {
          row[c.field] = JSON.parse(typeof v === 'string' ? v : '');
        } catch {
          /* left out */
        }
        break;
      case 'bitset':
        row[c.field] = bytesToBase64(trimBitset(toBytes(v)));
        break;
      default:
        row[c.field] = typeof v === 'bigint' ? Number(v) : v;
    }
  }
  return { row, rev: Number(db.rev ?? 0), hlc: typeof db.hlc === 'string' ? db.hlc : '' };
}

/**
 * A wire row as database columns (snake_case, INTEGER booleans, JSON text, a BLOB bitset), with `rev` and `hlc`. Local-only
 * columns are not written; the caller keeps its own. Expects a row that `normalizeWireRow` accepted.
 */
export function wireToDb(table: SyncedTable, row: WireRow, meta: { rev: number; hlc: string }): Record<string, string | number | null | Uint8Array> {
  const out: Record<string, string | number | null | Uint8Array> = {};
  for (const c of TABLE_SPECS[table].columns) {
    if (c.localOnly === true) continue;
    const v = row[c.field];
    if (v === null || v === undefined) {
      out[c.column] = c.type === 'bitset' ? new Uint8Array(0) : null;
      continue;
    }
    switch (c.type) {
      case 'boolean':
        out[c.column] = v === true ? 1 : 0;
        break;
      case 'json':
        out[c.column] = JSON.stringify(v);
        break;
      case 'bitset':
        out[c.column] = base64ToBytes(typeof v === 'string' ? v : '') ?? new Uint8Array(0);
        break;
      default:
        out[c.column] = v as string | number;
    }
  }
  out.rev = meta.rev;
  out.hlc = meta.hlc;
  return out;
}
