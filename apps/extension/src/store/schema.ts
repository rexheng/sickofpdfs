// The local library's schema, version 1 (normative; Phase 1 plan, Task 28). Later versions only add (contracts §4):
// schema-v2.ts holds Phase 2's step, and migrate.ts runs the steps in order.
//
// The outbox and full-text triggers are generated, so every synced table queues its changes the same way. Their names
// follow one pattern, `<table>_outbox_ai|au|ad` and `<table>_fts_ai|au|ad`, the same names schema-v2.ts re-creates.

/** The normative v1 script. Times are Unix ms. Synced rows carry rev (base revision) and hlc. */
export const SCHEMA_V1 = `
-- sickofpdfs schema v1. Times are Unix ms. Synced rows carry rev (base revision) and hlc. Drafts, FTS and caches never sync.
CREATE TABLE documents (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),            -- SHA-256 hex of the first copy's bytes
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  byte_size INTEGER NOT NULL,
  title TEXT, authors TEXT NOT NULL DEFAULT '[]', year INTEGER, doi TEXT, arxiv_id TEXT,
  pdf_id TEXT,                                              -- trailer /ID[0] hex
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('paper','book','slides','other')),
  has_text INTEGER NOT NULL CHECK (has_text IN (0,1)),
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
  index_text INTEGER NOT NULL DEFAULT 1 CHECK (index_text IN (0,1)),
  blob_stored INTEGER NOT NULL DEFAULT 0 CHECK (blob_stored IN (0,1)),   -- OPFS pdf/<id[0..2]>/<id>.pdf exists
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  save_reasons TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE TABLE aliases (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  similarity REAL NOT NULL CHECK (similarity >= 0.995 AND similarity <= 1),
  created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX aliases_document ON aliases(document_id);
CREATE TABLE locations (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),              -- sha256(kind || ':' || canonical)
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url','file')),
  canonical TEXT NOT NULL, raw TEXT NOT NULL,               -- raw = cleanLink(url) or the file URL
  via_page TEXT,                                            -- canonical link of the page that led here (Referer or embedding page)
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX locations_document ON locations(document_id);
CREATE TABLE page_text (
  rowid INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'pdfium',                    -- 'pdfium' | 'ocr:<engine>@<version>' (Release 3)
  UNIQUE (document_id, page_index));
CREATE VIRTUAL TABLE page_text_fts USING fts5(text, content='page_text', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2");
CREATE TABLE marks (
  id TEXT PRIMARY KEY,                                      -- UUIDv4, assigned once
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  style TEXT NOT NULL CHECK (style IN ('highlight','underline','bold','strike','area')),
  color INTEGER CHECK (color BETWEEN 1 AND 5),              -- highlight/underline/strike only
  anchor TEXT NOT NULL,                                     -- JSON Anchor: 'text' | 'area' | 'figure'
  page_index INTEGER NOT NULL, sort_key REAL NOT NULL,      -- first page; top of the first rect (0–1)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX marks_order ON marks(document_id, page_index, sort_key);
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor TEXT NOT NULL,                                     -- JSON Anchor, its own copy (any kind)
  page_index INTEGER, sort_key REAL,                        -- NULL for document threads
  placement TEXT NOT NULL DEFAULT 'placed' CHECK (placement IN ('placed','unplaced')),  -- 'unplaced' = "Couldn't place"
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX threads_order ON threads(document_id, page_index, sort_key);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('me','claude')),
  body TEXT NOT NULL,                                       -- Markdown
  draft_of_tab TEXT,                                        -- non-NULL = unsent draft owned by that tab; never synced
  meta TEXT NOT NULL DEFAULT '{}',                          -- Claude: model, citations, web sources (Phase 4)
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE INDEX comments_thread ON comments(thread_id, created_at);
CREATE TABLE history (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  first_opened INTEGER NOT NULL, last_opened INTEGER NOT NULL, open_count INTEGER NOT NULL DEFAULT 1,
  reading_ms INTEGER NOT NULL DEFAULT 0,
  last_position TEXT,                                       -- JSON { page, offset (0–1), zoom }
  pages_visited BLOB NOT NULL DEFAULT x'',                  -- bitset, bit i = page i
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL);
CREATE TABLE page_figures (                                 -- derived cache (Phase 2 detector); never synced or backed up
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL, detector_version TEXT NOT NULL, figures TEXT NOT NULL,
  PRIMARY KEY (document_id, page_index));
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  base_rev INTEGER NOT NULL, hlc TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE documents_fts USING fts5(document_id UNINDEXED, title, authors, tokenize="unicode61 remove_diacritics 2");
CREATE VIRTUAL TABLE comments_fts USING fts5(comment_id UNINDEXED, document_id UNINDEXED, body, tokenize="unicode61 remove_diacritics 2");
`;

/** The tables whose rows sync (Phase 5), with their primary key. Every change to them is queued in `outbox`. */
export const SYNCED_TABLES = ['documents', 'aliases', 'locations', 'marks', 'threads', 'comments', 'history', 'settings'] as const;
export type SyncedTable = (typeof SYNCED_TABLES)[number];

const PRIMARY_KEY: Record<SyncedTable, string> = {
  documents: 'id',
  aliases: 'sha256',
  locations: 'id',
  marks: 'id',
  threads: 'id',
  comments: 'id',
  history: 'document_id',
  settings: 'key',
};

const NOW_MS = `CAST(unixepoch('subsec') * 1000 AS INTEGER)`;

/**
 * The AFTER INSERT, UPDATE and DELETE triggers that queue a table's changes for sync. An insert queues an upsert at
 * base_rev 0, an update an upsert at OLD.rev, a delete a delete at OLD.rev. Unsent comment drafts never queue (they never
 * sync), so `comments` guards each trigger on `draft_of_tab`.
 */
export function outboxTriggers(table: string, pk: string = PRIMARY_KEY[table as SyncedTable]): string[] {
  const queue = (op: 'upsert' | 'delete', row: 'NEW' | 'OLD', rev: string, hlc: string) =>
    `INSERT INTO outbox (table_name, row_id, op, base_rev, hlc, created_at) VALUES ('${table}', ${row}.${pk}, '${op}', ${rev}, ${hlc}, ${NOW_MS});`;
  const draftGuard = (row: 'NEW' | 'OLD') => (table === 'comments' ? ` WHEN ${row}.draft_of_tab IS NULL` : '');
  return [
    `CREATE TRIGGER ${table}_outbox_ai AFTER INSERT ON ${table}${draftGuard('NEW')} BEGIN ${queue('upsert', 'NEW', '0', 'NEW.hlc')} END`,
    `CREATE TRIGGER ${table}_outbox_au AFTER UPDATE ON ${table}${draftGuard('NEW')} BEGIN ${queue('upsert', 'NEW', 'OLD.rev', 'NEW.hlc')} END`,
    `CREATE TRIGGER ${table}_outbox_ad AFTER DELETE ON ${table}${draftGuard('OLD')} BEGIN ${queue('delete', 'OLD', 'OLD.rev', 'OLD.hlc')} END`,
  ];
}

/** An author list as words for the index: the JSON array's strings joined by spaces. */
const AUTHOR_WORDS = (row: 'NEW' | 'OLD') => `(SELECT coalesce(group_concat(value, ' '), '') FROM json_each(CASE WHEN json_valid(${row}.authors) THEN ${row}.authors ELSE '[]' END))`;

/** The full-text index triggers: page text (an external-content index), document titles and authors, sent comments. */
export const FTS_TRIGGERS_V1: string[] = [
  // page_text -> page_text_fts: the external-content trio. A delete is told the old text, so the index can drop its words.
  `CREATE TRIGGER page_text_fts_ai AFTER INSERT ON page_text BEGIN
     INSERT INTO page_text_fts (rowid, text) VALUES (NEW.rowid, NEW.text); END`,
  `CREATE TRIGGER page_text_fts_ad AFTER DELETE ON page_text BEGIN
     INSERT INTO page_text_fts (page_text_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text); END`,
  `CREATE TRIGGER page_text_fts_au AFTER UPDATE OF text ON page_text BEGIN
     INSERT INTO page_text_fts (page_text_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text);
     INSERT INTO page_text_fts (rowid, text) VALUES (NEW.rowid, NEW.text); END`,
  // documents -> documents_fts
  `CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN
     INSERT INTO documents_fts (document_id, title, authors) VALUES (NEW.id, coalesce(NEW.title, ''), ${AUTHOR_WORDS('NEW')}); END`,
  `CREATE TRIGGER documents_fts_au AFTER UPDATE OF title, authors ON documents BEGIN
     DELETE FROM documents_fts WHERE document_id = OLD.id;
     INSERT INTO documents_fts (document_id, title, authors) VALUES (NEW.id, coalesce(NEW.title, ''), ${AUTHOR_WORDS('NEW')}); END`,
  `CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
     DELETE FROM documents_fts WHERE document_id = OLD.id; END`,
  // comments -> comments_fts: sent comments only (schema v2 narrows this to sent and live ones).
  `CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments WHEN NEW.draft_of_tab IS NULL BEGIN
     INSERT INTO comments_fts (comment_id, document_id, body) VALUES (NEW.id, NEW.document_id, NEW.body); END`,
  `CREATE TRIGGER comments_fts_au AFTER UPDATE ON comments BEGIN
     DELETE FROM comments_fts WHERE comment_id = OLD.id;
     INSERT INTO comments_fts (comment_id, document_id, body) SELECT NEW.id, NEW.document_id, NEW.body WHERE NEW.draft_of_tab IS NULL; END`,
  `CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
     DELETE FROM comments_fts WHERE comment_id = OLD.id; END`,
];

/** Every v1 trigger, in the order migrate creates them. */
export function triggersV1(): string[] {
  return [...SYNCED_TABLES.flatMap((t) => outboxTriggers(t)), ...FTS_TRIGGERS_V1];
}

/** The full-text tables. `forgetDocument` runs FTS5 'optimize' on each, so no deleted words stay in the index (R13). */
export const FTS_TABLES = ['page_text_fts', 'documents_fts', 'comments_fts'] as const;
