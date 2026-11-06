// Tags, the auto categoriser's side of the store, and smart sorting (spec R92, schema v5).
//
// Wiring (Task 28's `createStoreApi`): `StoreApi extends TagsApi`, and the object it returns spreads `createTagsApi(db, deps)`.
// `protocol.ts` serves `TAGS_API_METHODS`, and `client.ts` proxies them.
//
// Two groups of methods:
// - The owner's: `listTags`, `tagsOf`, `tagsOfMany`, `addTag`, `removeTag`, `keepAutoTag`, `renameTag`, `mergeTags`, `deleteTag`, `readingsByTag`,
//   `related`, `groupBy`. The library pages and the viewer's menus will call these.
// - The categoriser's: `categoriseQueue`, `categoriseInput`, `putEmbedding`, `categoriseCorpus`, `categoriseTagged`,
//   `applyCourseTags`, `applySuggestions`, `applyTopics`. The categoriser worker (categorise/controller.ts) calls these; it never
//   touches the database any other way.
//
// Rules this file keeps:
// - Only readings the library holds are ever given a vector or a tag (every write checks `documents`, and the foreign keys back that up).
//   A reading in Trash gets none and is left out of topics, related readings and groups until it is restored.
// - A reading whose text the owner keeps out of the library (`index_text` 0: a private PDF saved by choice, R91) is never read, understood
//   or tagged by the categoriser at all: not its text, not its title, not its link. The owner's own tags still work on it. R102: it is
//   never in related readings, in either direction, never in the topics' corpus and never one of the owner's tag examples, even with
//   a vector left from before.
// - The owner always wins. An auto tag never replaces or changes an owner tag. A tag taken off a reading (`auto_tag_removed`) never
//   comes back on it, whatever the categoriser finds later. Re-adding it by hand clears that.
// - A tag the owner deletes keeps a row with `deleted_at` set, and the readings that had it are remembered as removals, so a deleted
//   course or topic tag is not made again, even when the topic's members have moved on.
// - The owner's rename sticks: a renamed tag is never renamed by the categoriser. A live tag's name is unique, ignoring case.
// - At most MAX_TOPICS_PER_DOC auto topic tags on one reading.
// - Vectors are local: `embeddings` has no outbox triggers and is not a backup table. Nothing here sends anything anywhere.
// - Every write is one transaction, stamps `hlc`, leaves `rev` to sync, and publishes its change event only after it commits.
// - Errors are rejections whose message starts with a code (`bad-input: …`), so the code survives a message port.
import { type DocumentId, EMBEDDING_MODEL, MAX_TOPICS_PER_DOC, TAG_MIN_DOCS, type HlcStamp, related as relatedIds, type TagKind, type TagSource } from '@sop/core';
import { CATEGORISER_TAB, type StoreChange } from './change-bus';
import { isReadOnly, type SqlDb, type SqlValue } from './schema-v2';

// ---- shapes ------------------------------------------------------------------------------------------------------------------------

export interface TagSummary {
  id: string;
  name: string;
  kind: TagKind;
  /** Readings (not in Trash) that carry it. */
  count: number;
  /** How many of those carry it as an auto tag. */
  autoCount: number;
}

export interface ReadingTag {
  tagId: string;
  name: string;
  kind: TagKind;
  source: TagSource;
}

export type GroupBy = 'topic' | 'course' | 'tag' | 'kind';

export interface TagGroup {
  /** The tag id, the reading kind (paper, book, slides, other), or "none". */
  key: string;
  label: string;
  /** The group's tag, or null for a reading kind and for the readings that fit nowhere. */
  tagId: string | null;
  /** Readings in the group, the most recently opened first. A reading with several tags is in several groups. */
  documentIds: DocumentId[];
}

/** What the categoriser reads of one reading. */
export interface CategoriseInput {
  id: DocumentId;
  title: string | null;
  authors: string[];
  kind: 'paper' | 'book' | 'slides' | 'other';
  hasText: boolean;
  pageCount: number;
  /** Always true: a reading whose text the owner keeps out of the library is never offered (`categoriseInput` answers null). */
  indexText: boolean;
  /** Web links it was opened from, newest first, and the links of the pages that led to it. */
  urls: string[];
  /** File paths it was opened from, newest first. */
  paths: string[];
  /** The text of its first OPENING_PAGES pages (empty strings for a page with no text yet). */
  pageTexts: string[];
  /** How many of those pages are stored (a page stored with no text counts). Give it back as `pagesUsed`. */
  pagesPresent: number;
  /** The title of the page it was opened from (R92c), or null. Used for course codes only; never leaves this computer. */
  pageTitle: string | null;
  /** The vector stored for it, as the categoriser last made it. */
  embedding: { model: string; textHash: string; pagesUsed: number } | null;
}

export interface EmbeddingInput {
  model: string;
  vector: Float32Array;
  /** A hash of the text the vector was made from, so the same text is not embedded twice. */
  textHash: string;
  /** The abstract or opening text it was made from (the words topic names are picked from). */
  abstract: string;
  /** How many of the first pages had text when it was made. */
  pagesUsed: number;
}

export interface CorpusDoc {
  id: DocumentId;
  title: string;
  /** The authors' names, so the categoriser can keep them out of topic names. */
  authors: string[];
  abstract: string;
  vector: Float32Array;
  /** Tags taken off this reading. */
  removed: string[];
}

/** An owner tag with the readings that carry it as the owner's own, and their vectors (same order). */
export interface TaggedVectors {
  tagId: string;
  name: string;
  documentIds: DocumentId[];
  vectors: Float32Array[];
}

export interface TopicPlan {
  key: string;
  docIds: string[];
  name: string;
}

export interface TagsApi {
  /** Every live tag with its count. A course or topic tag nobody carries is left out; the owner's own tags are always listed. */
  listTags(): Promise<TagSummary[]>;
  /** A reading's tags: the owner's first, then auto ones; course, tag, topic; then by name. */
  tagsOf(documentId: DocumentId): Promise<ReadingTag[]>;
  /** `tagsOf` for many readings in one call (the library's rows and cards). A reading with no tags is left out. At most 500 ids. */
  tagsOfMany(documentIds: DocumentId[]): Promise<Record<string, ReadingTag[]>>;
  /** Gives the reading a tag by name, making the tag when it is new. A tag the reading has as auto becomes the owner's (kept). */
  addTag(documentId: DocumentId, name: string): Promise<ReadingTag>;
  /** Takes a tag off a reading. The categoriser never puts it back there. */
  removeTag(documentId: DocumentId, tagId: string): Promise<void>;
  /** One click on an auto chip: it becomes the owner's own tag. */
  keepAutoTag(documentId: DocumentId, tagId: string): Promise<void>;
  /** The new name sticks: the categoriser never renames it. A name another tag has is refused (`tag-exists`). */
  renameTag(tagId: string, name: string): Promise<void>;
  /** Moves every reading of `fromId` to `intoId` and retires `fromId`. */
  mergeTags(fromId: string, intoId: string): Promise<void>;
  /** The tag leaves every reading. A deleted course or topic tag is not made again. */
  deleteTag(tagId: string): Promise<void>;
  /** Readings (not in Trash) with the tag, the most recently opened first. */
  readingsByTag(tagId: string): Promise<DocumentId[]>;
  /** The `n` (default 5) readings closest in meaning, closest first. Empty until the reading has been understood. */
  related(documentId: DocumentId, n?: number): Promise<DocumentId[]>;
  /** The library's readings in groups, readings inside a group most recently opened first; readings that fit nowhere come last. */
  groupBy(by: GroupBy): Promise<TagGroup[]>;

  /** Readings (not in Trash, text not kept out of the library) that have no current vector, newest first. */
  categoriseQueue(limit: number): Promise<DocumentId[]>;
  /** What the categoriser needs to read one reading, or null when it is not in the library, is in Trash, or its text is kept out of the library. */
  categoriseInput(documentId: DocumentId): Promise<CategoriseInput | null>;
  /** Stores a vector. False (nothing stored) when the reading is gone, in Trash, or its text is kept out of the library. */
  putEmbedding(documentId: DocumentId, e: EmbeddingInput): Promise<boolean>;
  /** Every reading (not in Trash) with a vector, the newest `limit` of them. */
  categoriseCorpus(limit: number): Promise<CorpusDoc[]>;
  /** The owner's own tags that have at least TAG_MIN_DOCS readings with a vector. */
  categoriseTagged(): Promise<TaggedVectors[]>;
  /** Sets the reading's auto course tags to these codes (at most 2). Never touches an owner tag or one taken off. */
  applyCourseTags(documentId: DocumentId, codes: string[]): Promise<void>;
  /** Sets the readings' auto tags of the owner's own kind to these tag ids. Never touches an owner tag or one taken off. */
  applySuggestions(items: { documentId: DocumentId; tagIds: string[] }[]): Promise<void>;
  /** Makes the auto topic tags match these topics. Never touches an owner tag, a renamed name, or a deleted topic. */
  applyTopics(topics: TopicPlan[]): Promise<{ added: number; removed: number }>;
}

export const TAGS_API_METHODS = [
  'listTags',
  'tagsOf',
  'tagsOfMany',
  'addTag',
  'removeTag',
  'keepAutoTag',
  'renameTag',
  'mergeTags',
  'deleteTag',
  'readingsByTag',
  'related',
  'groupBy',
  'categoriseQueue',
  'categoriseInput',
  'putEmbedding',
  'categoriseCorpus',
  'categoriseTagged',
  'applyCourseTags',
  'applySuggestions',
  'applyTopics',
] as const satisfies readonly (keyof TagsApi)[];

/** The methods that only read: their answers are not kept for replays. */
export const TAGS_READ_METHODS = [
  'listTags',
  'tagsOf',
  'tagsOfMany',
  'readingsByTag',
  'related',
  'groupBy',
  'categoriseQueue',
  'categoriseInput',
  'categoriseCorpus',
  'categoriseTagged',
] as const satisfies readonly (keyof TagsApi)[];

/** The most readings one `tagsOfMany` call answers for. */
const MAX_TAGS_OF_MANY = 500;
/** The longest a tag's name is. */
export const MAX_TAG_CHARS = 60;
/** The name prefix of a course tag. */
export const COURSE_PREFIX = 'Course: ';
/** Pages of text given to the categoriser. */
const INPUT_PAGES = 3;
/** The version of the course rules (R92c). A reading tagged by older rules is looked at again, so a wrong tag the old rules made goes. */
export const COURSE_RULES = 2;
/** The most auto course tags on one reading. */
const MAX_COURSE_TAGS = 2;
const MAX_PAGE_CHARS = 6000;
const MAX_EVENT_IDS = 500;

export interface TagsDeps {
  now(): number;
  hlc: { tick(): HlcStamp };
  publish(c: StoreChange): void;
}

export type TagsErrorCode = 'bad-input' | 'read-only' | 'document-missing' | 'tag-missing' | 'tag-exists';

export class TagsError extends Error {
  readonly code: TagsErrorCode;
  constructor(code: TagsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'StoreError';
    this.code = code;
  }
}

function fail(code: TagsErrorCode, message: string): never {
  throw new TagsError(code, message);
}

function attempt<T>(f: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      resolve(f());
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

type Row = Record<string, SqlValue>;

const HEX64 = /^[0-9a-f]{64}$/;
const str = (r: Row, col: string): string => {
  const v = r[col];
  if (typeof v !== 'string') throw new Error(`column ${col} is not text`);
  return v;
};
const num = (r: Row, col: string): number => {
  const v = r[col];
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  throw new Error(`column ${col} is not a number`);
};
const maybeStr = (r: Row, col: string): string | null => (r[col] == null ? null : str(r, col));
const readingTagId = (documentId: string, tagId: string): string => `${documentId}:${tagId}`;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** A tag name as it is stored: no control characters, one space between words, no leading "#". Throws `bad-input` for an empty or long one. */
export function cleanTagName(raw: unknown): string {
  if (typeof raw !== 'string') fail('bad-input', 'A tag needs a name.');
  const name = raw.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
  if (name === '') fail('bad-input', 'A tag needs a name.');
  if ([...name].length > MAX_TAG_CHARS) fail('bad-input', `A tag name can be at most ${MAX_TAG_CHARS} letters long.`);
  return name;
}

/**
 * A tag name from outside (a backup being restored, R101): cleaned as the owner's own names are, and cut to MAX_TAG_CHARS letters
 * rather than refused. Null when nothing is left of it.
 */
export function tidyTagName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = [...raw.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '')].slice(0, MAX_TAG_CHARS).join('').trim();
  return name === '' ? null : name;
}

/** A vector as the BLOB stored for it. */
function blobOf(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

/** A stored BLOB as a vector (a copy, so it is aligned), or null when it cannot be one. */
function vectorOf(cell: SqlValue | undefined, dim: number): Float32Array | null {
  let bytes: Uint8Array;
  if (cell instanceof Uint8Array) bytes = cell;
  else if (cell instanceof ArrayBuffer) bytes = new Uint8Array(cell);
  else if (cell instanceof Int8Array) bytes = new Uint8Array(cell.buffer, cell.byteOffset, cell.byteLength);
  else return null;
  if (bytes.byteLength !== dim * 4) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// ---- what forgetting removes ------------------------------------------------------------------------------------------------------

/** The ids of the tag rows that hang off these readings (`<document>:<tag>`), so their outbox entries can be cleared with the reading's. */
export function tagRowIds(db: SqlDb, documentIds: readonly string[]): string[] {
  const list = JSON.stringify(documentIds);
  const ids: string[] = [];
  for (const sql of ['SELECT id FROM reading_tags WHERE document_id IN (SELECT value FROM json_each(?))', 'SELECT id FROM auto_tag_removed WHERE document_id IN (SELECT value FROM json_each(?))']) {
    for (const r of db.selectObjects(sql, [list])) ids.push(str(r, 'id'));
  }
  return ids;
}

/**
 * Clears the outbox of every entry for a tag row of these readings, including the ones for rows that are already gone (a tag taken off, a tag
 * merged away), whose ids `tagRowIds` cannot list: a tag row's id begins with its reading's id. Call it with the other outbox clean-up.
 */
export function clearTagOutbox(tx: SqlDb, documentIds: readonly string[]): void {
  tx.exec({
    sql: `DELETE FROM outbox WHERE table_name IN ('reading_tags','auto_tag_removed') AND substr(row_id, 1, 64) IN (SELECT value FROM json_each(?))`,
    bind: [JSON.stringify(documentIds)],
  });
}

/**
 * Deletes the course and topic tags that nothing refers to any more (no reading carries them and none is remembered as taken off), unless
 * the owner renamed them. Call it in the transaction that forgets readings, so a topic named from a forgotten PDF's words does not outlive
 * it. Returns the ids deleted.
 */
export function dropOrphanAutoTags(tx: SqlDb): string[] {
  const rows = tx.selectObjects(
    `SELECT id FROM tags WHERE kind IN ('topic','course') AND renamed = 0
       AND NOT EXISTS (SELECT 1 FROM reading_tags rt WHERE rt.tag_id = tags.id)
       AND NOT EXISTS (SELECT 1 FROM auto_tag_removed r WHERE r.tag_id = tags.id)`,
  );
  const ids = rows.map((r) => str(r, 'id'));
  if (ids.length > 0) tx.exec({ sql: 'DELETE FROM tags WHERE id IN (SELECT value FROM json_each(?))', bind: [JSON.stringify(ids)] });
  return ids;
}

// ---- the API ------------------------------------------------------------------------------------------------------------------------

export function createTagsApi(db: SqlDb, deps: TagsDeps): TagsApi {
  const binding = (bind: readonly SqlValue[]): SqlValue[] | undefined => (bind.length > 0 ? [...bind] : undefined);
  const select = (sql: string, bind: readonly SqlValue[] = []): Row[] => db.selectObjects(sql, binding(bind));
  const one = (sql: string, bind: readonly SqlValue[] = []): Row | undefined => select(sql, bind)[0];
  const run = (sql: string, bind: readonly SqlValue[] = []): void => {
    db.exec({ sql, bind: binding(bind) });
  };
  const assertWritable = (): void => {
    if (isReadOnly(db)) fail('read-only', 'Update sickofpdfs. This library was saved by a newer version, so it cannot be changed.');
  };
  function checkDocId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !HEX64.test(id)) fail('bad-input', 'the reading id is not a SHA-256 (64 lower-case hex characters)');
  }
  function checkTagId(id: unknown): asserts id is string {
    if (typeof id !== 'string' || id === '' || id.length > 128) fail('bad-input', 'that is not a tag id');
  }
  const documentExists = (id: string): boolean => one('SELECT 1 AS x FROM documents WHERE id = ?', [id]) !== undefined;
  /** In the library, not in Trash, and its text not kept out of it: the only readings the categoriser may tag. */
  const readableDocumentExists = (id: string): boolean => one('SELECT 1 AS x FROM documents WHERE id = ? AND deleted_at IS NULL AND index_text = 1', [id]) !== undefined;
  const liveTag = (id: string): Row | undefined => one('SELECT * FROM tags WHERE id = ? AND deleted_at IS NULL', [id]);
  const liveTagByName = (name: string): Row | undefined => one('SELECT * FROM tags WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL', [name]);

  /** A change on the channel, split so no event carries a huge list of ids. */
  const emit = (table: 'tags' | 'reading_tags' | 'auto_tag_removed', op: 'upsert' | 'delete', ids: readonly string[], documentId?: string, byCategoriser = false): StoreChange[] => {
    const out: StoreChange[] = [];
    for (let i = 0; i < ids.length; i += MAX_EVENT_IDS) {
      out.push({
        table,
        ids: ids.slice(i, i + MAX_EVENT_IDS),
        op,
        ...(documentId === undefined ? {} : { documentId: documentId as DocumentId }),
        ...(byCategoriser ? { origin: 'tab' as const, tabId: CATEGORISER_TAB } : {}),
      });
    }
    return out;
  };
  const publish = (changes: StoreChange[]): void => {
    for (const c of changes) {
      try {
        deps.publish(c);
      } catch {
        // The write is committed. Other tabs catch up on their next read.
      }
    }
  };

  /** What a write did, to publish after it commits. */
  interface Touched {
    tagsUp: Set<string>;
    tagsDel: Set<string>;
    rtUp: Set<string>;
    rtDel: Set<string>;
    remUp: Set<string>;
    remDel: Set<string>;
  }
  const touched = (): Touched => ({ tagsUp: new Set(), tagsDel: new Set(), rtUp: new Set(), rtDel: new Set(), remUp: new Set(), remDel: new Set() });
  /** `byCategoriser` marks the events as the categoriser's own (its `tabId`), so it does not react to its own writes. */
  const eventsOf = (t: Touched, documentId?: string, byCategoriser = false): StoreChange[] => [
    ...emit('tags', 'upsert', [...t.tagsUp], undefined, byCategoriser),
    ...emit('tags', 'delete', [...t.tagsDel], undefined, byCategoriser),
    ...emit('reading_tags', 'upsert', [...t.rtUp], documentId, byCategoriser),
    ...emit('reading_tags', 'delete', [...t.rtDel], documentId, byCategoriser),
    ...emit('auto_tag_removed', 'upsert', [...t.remUp], documentId, byCategoriser),
    ...emit('auto_tag_removed', 'delete', [...t.remDel], documentId, byCategoriser),
  ];

  // ---- row writers (call inside a transaction) ----

  function insertTag(t: Touched, name: string, kind: TagKind, topicKey: string | null): string {
    const id = crypto.randomUUID();
    const now = deps.now();
    run(
      `INSERT INTO tags (id, name, kind, topic_key, renamed, created_at, updated_at, rev, hlc) VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?)`,
      [id, name, kind, topicKey, now, now, deps.hlc.tick()],
    );
    t.tagsUp.add(id);
    return id;
  }

  /** `base`, or `base (2)`, `base (3)` … when another live tag has the name. */
  function freeName(base: string, exceptId: string | null): string {
    let name = base;
    for (let i = 2; ; i++) {
      const other = liveTagByName(name);
      if (other === undefined || str(other, 'id') === exceptId) return name;
      name = `${base.slice(0, MAX_TAG_CHARS - String(i).length - 3)} (${i})`;
    }
  }

  /** Puts a tag on a reading. An existing row keeps its place; `owner` upgrades an auto row, `auto` never downgrades an owner row. Returns the source now stored. */
  function putReadingTag(t: Touched, documentId: string, tagId: string, source: TagSource): TagSource {
    const id = readingTagId(documentId, tagId);
    const cur = one('SELECT source FROM reading_tags WHERE id = ?', [id]);
    if (cur === undefined) {
      run(`INSERT INTO reading_tags (id, document_id, tag_id, source, created_at, rev, hlc) VALUES (?, ?, ?, ?, ?, 0, ?)`, [id, documentId, tagId, source, deps.now(), deps.hlc.tick()]);
      t.rtUp.add(id);
      return source;
    }
    if (source === 'owner' && str(cur, 'source') === 'auto') {
      run('UPDATE reading_tags SET source = ?, hlc = ? WHERE id = ?', ['owner', deps.hlc.tick(), id]);
      t.rtUp.add(id);
      return 'owner';
    }
    return str(cur, 'source') as TagSource;
  }

  function dropReadingTag(t: Touched, documentId: string, tagId: string): boolean {
    const id = readingTagId(documentId, tagId);
    if (one('SELECT 1 AS x FROM reading_tags WHERE id = ?', [id]) === undefined) return false;
    run('DELETE FROM reading_tags WHERE id = ?', [id]);
    t.rtDel.add(id);
    return true;
  }

  function putRemoval(t: Touched, documentId: string, tagId: string): void {
    const id = readingTagId(documentId, tagId);
    const had = one('SELECT 1 AS x FROM auto_tag_removed WHERE id = ?', [id]) !== undefined;
    run(
      `INSERT INTO auto_tag_removed (id, document_id, tag_id, removed_at, rev, hlc) VALUES (?, ?, ?, ?, 0, ?)
       ON CONFLICT (id) DO UPDATE SET removed_at = excluded.removed_at, hlc = excluded.hlc`,
      [id, documentId, tagId, deps.now(), deps.hlc.tick()],
    );
    if (!had) t.remUp.add(id);
  }

  function clearRemoval(t: Touched, documentId: string, tagId: string): void {
    const id = readingTagId(documentId, tagId);
    if (one('SELECT 1 AS x FROM auto_tag_removed WHERE id = ?', [id]) === undefined) return;
    run('DELETE FROM auto_tag_removed WHERE id = ?', [id]);
    t.remDel.add(id);
  }

  const wasRemoved = (documentId: string, tagId: string): boolean => one('SELECT 1 AS x FROM auto_tag_removed WHERE id = ?', [readingTagId(documentId, tagId)]) !== undefined;

  /** The owner is done with a tag (deleted or merged away): its rows go, its readings are remembered as removals, and it is kept as a tombstone. */
  function retireTag(t: Touched, tagId: string, moveTo: string | null): void {
    const kind = str(one('SELECT kind FROM tags WHERE id = ?', [tagId]) as Row, 'kind');
    const members = select('SELECT document_id, source FROM reading_tags WHERE tag_id = ?', [tagId]);
    for (const m of members) {
      const doc = str(m, 'document_id');
      if (moveTo !== null) {
        if (!wasRemoved(doc, moveTo)) putReadingTag(t, doc, moveTo, str(m, 'source') as TagSource);
      }
      dropReadingTag(t, doc, tagId);
      // A retired course or topic tag stays remembered by the readings it had, so the categoriser does not make it again.
      if (kind !== 'tag') putRemoval(t, doc, tagId);
    }
    for (const r of select('SELECT document_id FROM auto_tag_removed WHERE tag_id = ?', [tagId])) {
      const doc = str(r, 'document_id');
      if (moveTo !== null && kind === 'tag') {
        // keep "taken off" on the tag that remains
        putRemoval(t, doc, moveTo);
        clearRemoval(t, doc, tagId);
      } else if (kind === 'tag') {
        clearRemoval(t, doc, tagId);
      }
    }
    run('UPDATE tags SET deleted_at = ?, updated_at = ?, hlc = ? WHERE id = ?', [deps.now(), deps.now(), deps.hlc.tick(), tagId]);
    t.tagsUp.add(tagId);
  }

  const tagFromRow = (r: Row): ReadingTag => ({ tagId: str(r, 'tag_id'), name: str(r, 'name'), kind: str(r, 'kind') as TagKind, source: str(r, 'source') as TagSource });

  const KIND_ORDER: Record<TagKind, number> = { course: 0, tag: 1, topic: 2 };
  const byReadingTag = (a: ReadingTag, b: ReadingTag): number =>
    Number(b.source === 'owner') - Number(a.source === 'owner') || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.tagId < b.tagId ? -1 : 1);

  /** Readings in Trash are not "in the library" for lists, groups and related readings. */
  const LIVE = 'd.deleted_at IS NULL';
  const OPENED = 'coalesce(h.last_opened, d.created_at)';

  return {
    listTags: () =>
      attempt(() => {
        const rows = select(
          `SELECT t.id AS id, t.name AS name, t.kind AS kind,
             (SELECT count(*) FROM reading_tags rt JOIN documents d ON d.id = rt.document_id WHERE rt.tag_id = t.id AND ${LIVE}) AS n,
             (SELECT count(*) FROM reading_tags rt JOIN documents d ON d.id = rt.document_id WHERE rt.tag_id = t.id AND rt.source = 'auto' AND ${LIVE}) AS auto_n
           FROM tags t WHERE t.deleted_at IS NULL`,
        );
        return rows
          .map((r): TagSummary => ({ id: str(r, 'id'), name: str(r, 'name'), kind: str(r, 'kind') as TagKind, count: num(r, 'n'), autoCount: num(r, 'auto_n') }))
          .filter((t) => t.kind === 'tag' || t.count > 0)
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
      }),

    tagsOf: (documentId) =>
      attempt(() => {
        checkDocId(documentId);
        return select(
          `SELECT rt.tag_id AS tag_id, t.name AS name, t.kind AS kind, rt.source AS source
           FROM reading_tags rt JOIN tags t ON t.id = rt.tag_id WHERE rt.document_id = ? AND t.deleted_at IS NULL`,
          [documentId],
        )
          .map(tagFromRow)
          .sort(byReadingTag);
      }),

    tagsOfMany: (documentIds) =>
      attempt(() => {
        if (!Array.isArray(documentIds) || documentIds.length > MAX_TAGS_OF_MANY) fail('bad-input', `ask for at most ${MAX_TAGS_OF_MANY} readings`);
        for (const id of documentIds) checkDocId(id);
        const out: Record<string, ReadingTag[]> = {};
        if (documentIds.length === 0) return out;
        const rows = select(
          `SELECT rt.document_id AS document_id, rt.tag_id AS tag_id, t.name AS name, t.kind AS kind, rt.source AS source
           FROM reading_tags rt JOIN tags t ON t.id = rt.tag_id
           WHERE rt.document_id IN (SELECT value FROM json_each(?)) AND t.deleted_at IS NULL`,
          [JSON.stringify(documentIds)],
        );
        for (const r of rows) (out[str(r, 'document_id')] ??= []).push(tagFromRow(r));
        for (const list of Object.values(out)) list.sort(byReadingTag);
        return out;
      }),

    addTag: (documentId, name) =>
      attempt(() => {
        assertWritable();
        checkDocId(documentId);
        const clean = cleanTagName(name);
        const t = touched();
        let result: ReadingTag | undefined;
        db.savepoint(() => {
          if (!documentExists(documentId)) fail('document-missing', 'tags are only given to readings in the library');
          let tag = liveTagByName(clean);
          const tagId = tag === undefined ? insertTag(t, clean, 'tag', null) : str(tag, 'id');
          tag ??= liveTag(tagId);
          clearRemoval(t, documentId, tagId);
          putReadingTag(t, documentId, tagId, 'owner');
          result = { tagId, name: str(tag as Row, 'name'), kind: str(tag as Row, 'kind') as TagKind, source: 'owner' };
        });
        publish(eventsOf(t, documentId));
        return result as ReadingTag;
      }),

    removeTag: (documentId, tagId) =>
      attempt(() => {
        assertWritable();
        checkDocId(documentId);
        checkTagId(tagId);
        const t = touched();
        db.savepoint(() => {
          if (!dropReadingTag(t, documentId, tagId)) return; // the reading does not have it: nothing to take off
          putRemoval(t, documentId, tagId);
        });
        publish(eventsOf(t, documentId));
      }),

    keepAutoTag: (documentId, tagId) =>
      attempt(() => {
        assertWritable();
        checkDocId(documentId);
        checkTagId(tagId);
        const t = touched();
        db.savepoint(() => {
          if (one('SELECT 1 AS x FROM reading_tags WHERE id = ?', [readingTagId(documentId, tagId)]) === undefined) fail('tag-missing', 'this reading does not have that tag');
          putReadingTag(t, documentId, tagId, 'owner');
        });
        publish(eventsOf(t, documentId));
      }),

    renameTag: (tagId, name) =>
      attempt(() => {
        assertWritable();
        checkTagId(tagId);
        const clean = cleanTagName(name);
        const t = touched();
        db.savepoint(() => {
          const cur = liveTag(tagId);
          if (cur === undefined) fail('tag-missing', 'that tag is not there any more');
          const other = liveTagByName(clean);
          if (other !== undefined && str(other, 'id') !== tagId) fail('tag-exists', 'A tag with that name already exists. Merge them instead.');
          if (str(cur, 'name') === clean && num(cur, 'renamed') === 1) return;
          run('UPDATE tags SET name = ?, renamed = 1, updated_at = ?, hlc = ? WHERE id = ?', [clean, deps.now(), deps.hlc.tick(), tagId]);
          t.tagsUp.add(tagId);
        });
        publish(eventsOf(t));
      }),

    mergeTags: (fromId, intoId) =>
      attempt(() => {
        assertWritable();
        checkTagId(fromId);
        checkTagId(intoId);
        if (fromId === intoId) fail('bad-input', 'Pick two different tags to merge.');
        const t = touched();
        db.savepoint(() => {
          if (liveTag(fromId) === undefined || liveTag(intoId) === undefined) fail('tag-missing', 'that tag is not there any more');
          retireTag(t, fromId, intoId);
        });
        publish(eventsOf(t));
      }),

    deleteTag: (tagId) =>
      attempt(() => {
        assertWritable();
        checkTagId(tagId);
        const t = touched();
        db.savepoint(() => {
          if (liveTag(tagId) === undefined) return; // already gone
          retireTag(t, tagId, null);
        });
        publish(eventsOf(t));
      }),

    readingsByTag: (tagId) =>
      attempt(() => {
        checkTagId(tagId);
        return select(
          `SELECT d.id AS id FROM reading_tags rt JOIN documents d ON d.id = rt.document_id LEFT JOIN history h ON h.document_id = d.id
           WHERE rt.tag_id = ? AND ${LIVE} ORDER BY ${OPENED} DESC, d.id`,
          [tagId],
        ).map((r) => str(r, 'id') as DocumentId);
      }),

    related: (documentId, n) =>
      attempt(() => {
        checkDocId(documentId);
        const count = n === undefined ? 5 : n;
        if (!Number.isInteger(count) || count < 1 || count > 50) fail('bad-input', 'ask for between 1 and 50 related readings');
        // R102: a reading saved without searchable text (D9, index_text 0) is never related, in either direction: it is not a
        // candidate, and asking for its own related readings gives none. It should have no vector; one left from before (a
        // restore can bring the row with index_text 0) is ignored here too.
        const all = select(`SELECT e.document_id AS id, e.vector AS vector, e.dim AS dim FROM embeddings e JOIN documents d ON d.id = e.document_id WHERE ${LIVE} AND d.index_text = 1`);
        const docs = all.flatMap((r) => {
          const vector = vectorOf(r.vector, num(r, 'dim'));
          return vector === null ? [] : [{ id: str(r, 'id'), vector, text: { title: '', abstract: '' } }];
        });
        const me = docs.find((d) => d.id === documentId);
        return me === undefined ? [] : (relatedIds(me, docs, count) as DocumentId[]);
      }),

    groupBy: (by) =>
      attempt(() => {
        if (by !== 'topic' && by !== 'course' && by !== 'tag' && by !== 'kind') fail('bad-input', 'group by topic, course, tag or kind');
        const groups = new Map<string, TagGroup>();
        const seen = new Set<string>();
        const add = (key: string, label: string, tagId: string | null, id: DocumentId): void => {
          const g = groups.get(key) ?? { key, label, tagId, documentIds: [] };
          g.documentIds.push(id);
          groups.set(key, g);
        };
        if (by === 'kind') {
          const labels: Record<string, string> = { paper: 'Papers', book: 'Books', slides: 'Slides', other: 'Other' };
          for (const r of select(`SELECT d.id AS id, d.kind AS kind FROM documents d LEFT JOIN history h ON h.document_id = d.id WHERE ${LIVE} ORDER BY ${OPENED} DESC, d.id`)) {
            add(str(r, 'kind'), labels[str(r, 'kind')] ?? 'Other', null, str(r, 'id') as DocumentId);
          }
        } else {
          const rows = select(
            `SELECT t.id AS tag_id, t.name AS name, d.id AS id FROM reading_tags rt
               JOIN tags t ON t.id = rt.tag_id AND t.deleted_at IS NULL AND t.kind = ?
               JOIN documents d ON d.id = rt.document_id LEFT JOIN history h ON h.document_id = d.id
             WHERE ${LIVE} ORDER BY ${OPENED} DESC, d.id`,
            [by],
          );
          for (const r of rows) {
            add(str(r, 'tag_id'), str(r, 'name'), str(r, 'tag_id'), str(r, 'id') as DocumentId);
            seen.add(str(r, 'id'));
          }
          const none = select(`SELECT d.id AS id FROM documents d LEFT JOIN history h ON h.document_id = d.id WHERE ${LIVE} ORDER BY ${OPENED} DESC, d.id`).filter((r) => !seen.has(str(r, 'id')));
          const noneLabel = { topic: 'No topic', course: 'No course', tag: 'No tags' }[by];
          for (const r of none) add('none', noneLabel, null, str(r, 'id') as DocumentId);
        }
        const list = [...groups.values()];
        return list.sort(
          (a, b) =>
            Number(a.key === 'none') - Number(b.key === 'none') || b.documentIds.length - a.documentIds.length || a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) || (a.key < b.key ? -1 : 1),
        );
      }),

    // ---- the categoriser's ----

    categoriseQueue: (limit) =>
      attempt(() => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail('bad-input', 'ask for between 1 and 500 readings');
        return select(
          `SELECT d.id AS id FROM documents d LEFT JOIN embeddings e ON e.document_id = d.id
           WHERE ${LIVE} AND d.index_text = 1 AND (e.document_id IS NULL
             OR e.model <> ? OR e.rules < ${COURSE_RULES} OR e.pages_used <> (SELECT count(*) FROM page_text p WHERE p.document_id = d.id AND p.page_index < ${INPUT_PAGES}))
           ORDER BY d.created_at DESC, d.id LIMIT ?`,
          [EMBEDDING_MODEL, limit],
        ).map((r) => str(r, 'id') as DocumentId);
      }),

    categoriseInput: (documentId) =>
      attempt((): CategoriseInput | null => {
        checkDocId(documentId);
        const d = one('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL AND index_text = 1', [documentId]);
        if (d === undefined) return null;
        const indexText = true;
        const urls: string[] = [];
        const paths: string[] = [];
        for (const l of select('SELECT kind, raw, via_page FROM locations WHERE document_id = ? ORDER BY last_seen DESC, id', [documentId])) {
          if (str(l, 'kind') === 'url') urls.push(str(l, 'raw'));
          else {
            const raw = str(l, 'raw');
            let path = raw.replace(/^file:\/\//i, '');
            try {
              path = decodeURIComponent(path);
            } catch {
              // keep it as it is
            }
            paths.push(path);
          }
          const via = maybeStr(l, 'via_page');
          if (via !== null) urls.push(via);
        }
        const pageTexts = new Array<string>(INPUT_PAGES).fill('');
        let pagesUsed = 0;
        if (indexText) {
          for (const p of select('SELECT page_index, text FROM page_text WHERE document_id = ? AND page_index < ? ORDER BY page_index', [documentId, INPUT_PAGES])) {
            pageTexts[num(p, 'page_index')] = str(p, 'text').slice(0, MAX_PAGE_CHARS);
            pagesUsed += 1;
          }
        }
        let authors: string[] = [];
        try {
          const parsed: unknown = JSON.parse(str(d, 'authors'));
          if (Array.isArray(parsed)) authors = parsed.filter((a): a is string => typeof a === 'string');
        } catch {
          // no authors
        }
        const e = one('SELECT model, text_hash, pages_used FROM embeddings WHERE document_id = ?', [documentId]);
        const page = one('SELECT title FROM source_pages WHERE document_id = ?', [documentId]);
        return {
          id: documentId,
          title: maybeStr(d, 'title'),
          authors,
          kind: str(d, 'kind') as CategoriseInput['kind'],
          hasText: num(d, 'has_text') === 1,
          pageCount: num(d, 'page_count'),
          indexText,
          pageTitle: page === undefined ? null : str(page, 'title'),
          urls,
          paths,
          pageTexts,
          pagesPresent: pagesUsed,
          embedding: e === undefined ? null : { model: str(e, 'model'), textHash: str(e, 'text_hash'), pagesUsed: num(e, 'pages_used') },
        };
      }),

    putEmbedding: (documentId, e) =>
      attempt(() => {
        assertWritable();
        checkDocId(documentId);
        if (typeof e !== 'object' || e === null || typeof e.model !== 'string' || e.model === '' || !(e.vector instanceof Float32Array) || e.vector.length === 0) fail('bad-input', 'an embedding needs a model and a vector');
        if (e.vector.some((x) => !Number.isFinite(x))) fail('bad-input', 'the vector has a number that is not finite');
        if (typeof e.textHash !== 'string' || e.textHash === '' || typeof e.abstract !== 'string' || !Number.isInteger(e.pagesUsed) || e.pagesUsed < 0) fail('bad-input', 'an embedding needs the hash of its text');
        let stored = false;
        db.savepoint(() => {
          // Forgotten, trashed or made private while the vector was being made: nothing is kept.
          if (one('SELECT 1 AS x FROM documents WHERE id = ? AND deleted_at IS NULL AND index_text = 1', [documentId]) === undefined) return;
          run(
            `INSERT INTO embeddings (document_id, model, dim, vector, text_hash, abstract, pages_used, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (document_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vector = excluded.vector, text_hash = excluded.text_hash,
               abstract = excluded.abstract, pages_used = excluded.pages_used, created_at = excluded.created_at`,
            [documentId, e.model, e.vector.length, blobOf(e.vector), e.textHash, e.abstract.slice(0, 4000), e.pagesUsed, deps.now()],
          );
          stored = true;
        });
        return stored;
      }),

    categoriseCorpus: (limit) =>
      attempt(() => {
        if (!Number.isInteger(limit) || limit < 1 || limit > 5000) fail('bad-input', 'ask for between 1 and 5000 readings');
        const removed = new Map<string, string[]>();
        for (const r of select('SELECT document_id, tag_id FROM auto_tag_removed')) {
          const list = removed.get(str(r, 'document_id')) ?? [];
          list.push(str(r, 'tag_id'));
          removed.set(str(r, 'document_id'), list);
        }
        return select(
          `SELECT d.id AS id, d.title AS title, d.authors AS authors, e.abstract AS abstract, e.vector AS vector, e.dim AS dim
           FROM embeddings e JOIN documents d ON d.id = e.document_id WHERE ${LIVE} AND d.index_text = 1 ORDER BY d.created_at DESC, d.id LIMIT ?`,
          [limit],
        ).flatMap((r): CorpusDoc[] => {
          const vector = vectorOf(r.vector, num(r, 'dim'));
          if (vector === null) return [];
          const id = str(r, 'id') as DocumentId;
          let authors: string[] = [];
          try {
            const parsed: unknown = JSON.parse(str(r, 'authors'));
            if (Array.isArray(parsed)) authors = parsed.filter((a): a is string => typeof a === 'string');
          } catch {
            // no authors
          }
          return [{ id, title: maybeStr(r, 'title') ?? '', authors, abstract: str(r, 'abstract'), vector, removed: removed.get(id) ?? [] }];
        });
      }),

    categoriseTagged: () =>
      attempt(() => {
        const byTag = new Map<string, TaggedVectors>();
        for (const r of select(
          `SELECT t.id AS tag_id, t.name AS name, d.id AS id, e.vector AS vector, e.dim AS dim
           FROM tags t JOIN reading_tags rt ON rt.tag_id = t.id AND rt.source = 'owner'
             JOIN documents d ON d.id = rt.document_id AND ${LIVE} AND d.index_text = 1 JOIN embeddings e ON e.document_id = d.id
           WHERE t.deleted_at IS NULL AND t.kind = 'tag' ORDER BY t.id, d.id`,
        )) {
          const vector = vectorOf(r.vector, num(r, 'dim'));
          if (vector === null) continue;
          const g = byTag.get(str(r, 'tag_id')) ?? { tagId: str(r, 'tag_id'), name: str(r, 'name'), documentIds: [], vectors: [] };
          g.documentIds.push(str(r, 'id') as DocumentId);
          g.vectors.push(vector);
          byTag.set(g.tagId, g);
        }
        return [...byTag.values()].filter((g) => g.vectors.length >= TAG_MIN_DOCS);
      }),

    applyCourseTags: (documentId, codes) =>
      attempt(() => {
        assertWritable();
        checkDocId(documentId);
        if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) fail('bad-input', 'course codes come as a list of text');
        const t = touched();
        db.savepoint(() => {
          if (!readableDocumentExists(documentId)) return;
          const wanted: string[] = [];
          for (const code of [...new Set(codes.map((c) => c.trim()).filter((c) => c !== ''))].slice(0, MAX_COURSE_TAGS)) {
            const name = `${COURSE_PREFIX}${code.slice(0, MAX_TAG_CHARS - COURSE_PREFIX.length)}`;
            const live = liveTagByName(name);
            if (live !== undefined) {
              wanted.push(str(live, 'id'));
              continue;
            }
            // A course tag the owner deleted is not made again.
            if (one(`SELECT 1 AS x FROM tags WHERE name = ? COLLATE NOCASE AND kind = 'course' AND deleted_at IS NOT NULL`, [name]) !== undefined) continue;
            wanted.push(insertTag(t, name, 'course', null));
          }
          const current = select(
            `SELECT rt.tag_id AS tag_id FROM reading_tags rt JOIN tags x ON x.id = rt.tag_id WHERE rt.document_id = ? AND rt.source = 'auto' AND x.kind = 'course'`,
            [documentId],
          );
          for (const c of current) if (!wanted.includes(str(c, 'tag_id'))) dropReadingTag(t, documentId, str(c, 'tag_id'));
          for (const tagId of wanted) if (!wasRemoved(documentId, tagId)) putReadingTag(t, documentId, tagId, 'auto');
          run('UPDATE embeddings SET rules = ? WHERE document_id = ?', [COURSE_RULES, documentId]);
        });
        publish(eventsOf(t, documentId, true));
      }),

    applySuggestions: (items) =>
      attempt(() => {
        assertWritable();
        if (!Array.isArray(items) || items.length > 200) fail('bad-input', 'suggestions come as a list of at most 200 readings');
        const t = touched();
        db.savepoint(() => {
          for (const item of items) {
            checkDocId(item.documentId);
            if (!Array.isArray(item.tagIds) || item.tagIds.some((x) => typeof x !== 'string')) fail('bad-input', 'tag ids come as a list of text');
            if (!readableDocumentExists(item.documentId)) continue;
            const wanted = item.tagIds.filter((id) => one(`SELECT 1 AS x FROM tags WHERE id = ? AND kind = 'tag' AND deleted_at IS NULL`, [id]) !== undefined && !wasRemoved(item.documentId, id));
            const current = select(
              `SELECT rt.tag_id AS tag_id FROM reading_tags rt JOIN tags x ON x.id = rt.tag_id WHERE rt.document_id = ? AND rt.source = 'auto' AND x.kind = 'tag'`,
              [item.documentId],
            );
            for (const c of current) if (!wanted.includes(str(c, 'tag_id'))) dropReadingTag(t, item.documentId, str(c, 'tag_id'));
            for (const id of wanted) putReadingTag(t, item.documentId, id, 'auto');
          }
        });
        publish(eventsOf(t, undefined, true));
      }),

    applyTopics: (topics) =>
      attempt(() => {
        assertWritable();
        if (!Array.isArray(topics) || topics.length > 5000) fail('bad-input', 'topics come as a list');
        for (const topic of topics) {
          if (typeof topic?.key !== 'string' || topic.key === '' || typeof topic.name !== 'string' || !Array.isArray(topic.docIds) || topic.docIds.some((d) => typeof d !== 'string')) fail('bad-input', 'a topic needs a key, a name and its readings');
        }
        const t = touched();
        let added = 0;
        let removed = 0;
        db.savepoint(() => {
          const live = new Set(select(`SELECT d.id AS id FROM documents d WHERE ${LIVE} AND d.index_text = 1`).map((r) => str(r, 'id')));
          // The topic tags there are (deleted ones too) and the readings each is known by: carried, or taken off.
          const known = new Map<string, { row: Row; docs: Set<string> }>();
          for (const r of select(`SELECT * FROM tags WHERE kind = 'topic'`)) known.set(str(r, 'id'), { row: r, docs: new Set() });
          for (const r of select(`SELECT rt.tag_id AS tag_id, rt.document_id AS doc FROM reading_tags rt JOIN tags x ON x.id = rt.tag_id WHERE x.kind = 'topic'`)) known.get(str(r, 'tag_id'))?.docs.add(str(r, 'doc'));
          for (const r of select(`SELECT a.tag_id AS tag_id, a.document_id AS doc FROM auto_tag_removed a JOIN tags x ON x.id = a.tag_id WHERE x.kind = 'topic'`)) known.get(str(r, 'tag_id'))?.docs.add(str(r, 'doc'));

          // Which tag each topic is: the one with its key; else the one with the most readings in common (at least half the union).
          const claimed = new Set<string>();
          const tagOf = new Array<string | null>(topics.length).fill(null);
          const fixedKey = (key: string): boolean => key.startsWith('subject:') || key.startsWith('field:'); // R92c, R92d: named by a subject or a field
          const subjectKeyed = (k: Row): boolean => fixedKey(maybeStr(k, 'topic_key') ?? '');
          topics.forEach((topic, i) => {
            for (const [id, k] of known) {
              if (!claimed.has(id) && maybeStr(k.row, 'topic_key') === topic.key) {
                tagOf[i] = id;
                claimed.add(id);
                break;
              }
            }
          });
          topics.forEach((topic, i) => {
            if (tagOf[i] !== null) return;
            // A topic made from a subject (R92c) is its subject's tag for good, whoever is in it: another tag takes it over only by its key.
            if (fixedKey(topic.key)) {
              for (const [id, k] of known) {
                if (!claimed.has(id) && !subjectKeyed(k.row) && k.row.deleted_at == null && str(k.row, 'name').toLowerCase() === topic.name.toLowerCase()) {
                  tagOf[i] = id;
                  claimed.add(id);
                  return;
                }
              }
            }
            const mine = new Set(topic.docIds);
            let best: string | null = null;
            let bestScore = 0.5 - 1e-9;
            for (const [id, k] of [...known].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
              if (claimed.has(id) || k.docs.size === 0 || subjectKeyed(k.row)) continue;
              let shared = 0;
              for (const d of k.docs) if (mine.has(d)) shared += 1;
              const score = shared / (mine.size + k.docs.size - shared);
              if (score > bestScore) {
                best = id;
                bestScore = score;
              }
            }
            if (best !== null) {
              tagOf[i] = best;
              claimed.add(best);
            }
          });

          // The topics a reading is in, biggest topic first, at most MAX_TOPICS_PER_DOC.
          const perDoc = new Map<string, number>();
          const wantedBy = topics.map((topic) => {
            const out: string[] = [];
            for (const d of [...topic.docIds].sort()) {
              if (!live.has(d)) continue;
              const n = perDoc.get(d) ?? 0;
              if (n >= MAX_TOPICS_PER_DOC) continue;
              perDoc.set(d, n + 1);
              out.push(d);
            }
            return out;
          });

          topics.forEach((topic, i) => {
            let tagId = tagOf[i] ?? null;
            const row = tagId === null ? undefined : known.get(tagId)?.row;
            if (tagId === null) {
              tagId = insertTag(t, freeName(cleanTagName(topic.name), null), 'topic', topic.key);
              claimed.add(tagId);
            } else if (row !== undefined) {
              const retired = row.deleted_at != null;
              const sets: string[] = [];
              const binds: SqlValue[] = [];
              if (maybeStr(row, 'topic_key') !== topic.key) {
                sets.push('topic_key = ?');
                binds.push(topic.key);
              }
              // A name follows its subject; a name made from words stays as it was first seen, so it does not drift as the library grows.
              const subjectName = fixedKey(topic.key) || subjectKeyed(row);
              if (!retired && num(row, 'renamed') === 0 && str(row, 'name') !== topic.name && subjectName) {
                sets.push('name = ?');
                binds.push(freeName(cleanTagName(topic.name), tagId));
              }
              if (sets.length > 0) {
                run(`UPDATE tags SET ${sets.join(', ')}, updated_at = ?, hlc = ? WHERE id = ?`, [...binds, deps.now(), deps.hlc.tick(), tagId]);
                t.tagsUp.add(tagId);
              }
              if (retired) return; // the owner deleted this topic: it is not put on anything again
            }
            const want = new Set(wantedBy[i]);
            const have = select('SELECT document_id, source FROM reading_tags WHERE tag_id = ?', [tagId]);
            const haveDocs = new Set<string>();
            for (const h of have) {
              const doc = str(h, 'document_id');
              haveDocs.add(doc);
              if (str(h, 'source') === 'auto' && !want.has(doc)) {
                dropReadingTag(t, doc, tagId);
                removed += 1;
              }
            }
            for (const doc of want) {
              if (haveDocs.has(doc) || wasRemoved(doc, tagId)) continue;
              putReadingTag(t, doc, tagId, 'auto');
              added += 1;
            }
          });

          // Topic tags no topic is now: their auto rows go, and an empty one that the owner did not rename goes too.
          for (const [id, k] of known) {
            if (claimed.has(id) || k.row.deleted_at != null) continue;
            for (const h of select(`SELECT document_id FROM reading_tags WHERE tag_id = ? AND source = 'auto'`, [id])) {
              dropReadingTag(t, str(h, 'document_id'), id);
              removed += 1;
            }
            const left = one('SELECT 1 AS x FROM reading_tags WHERE tag_id = ?', [id]);
            const remembered = one('SELECT 1 AS x FROM auto_tag_removed WHERE tag_id = ?', [id]);
            if (left === undefined && remembered === undefined && num(k.row, 'renamed') === 0) {
              run('DELETE FROM tags WHERE id = ?', [id]);
              t.tagsDel.add(id);
              t.tagsUp.delete(id);
            }
          }
        });
        publish(eventsOf(t, undefined, true));
        return { added, removed };
      }),
  };
}
