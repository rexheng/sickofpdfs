-- sop_meta: the cloud copy of the extension's synced tables, plus the server's own tables.
--
-- The eight synced tables use the same names, columns, defaults and CHECKs as the extension's local schema v1 to v3
-- (apps/extension/src/store). Columns are listed in the local order: the v1 columns, then the ones v2 added at the end.
-- The cloud adds only server columns after them: `seq` (the global change number, the pull cursor) and `device` (who wrote
-- the version), and on comments `mcp_request_id` (idempotency for Claude's writes).
--
-- Differences from local, all on purpose:
--   - `draft_of_tab` exists but is always NULL (CHECK): a draft never syncs.
--   - `documents.blob_stored` means "the PDF is in R2" here, and only the server sets it. Locally it means "the file is in
--     this computer's storage".
--   - `rev` starts at 0 in the default like local, but the server always writes a real revision (1 or more).
--   - `comments.thread_id` has no foreign key: a device may push a comment before its thread arrives in the same batch.
--   - No outbox, no `page_text` (page text lives in the sop_text_n shards) and no `page_figures`.
--
-- Times are Unix ms. Tombstones are rows with `deleted_at` set and are never purged by sync.

-- ─── Synced tables ─────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE documents (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  page_count INTEGER NOT NULL CHECK (page_count >= 0),
  byte_size INTEGER NOT NULL,
  title TEXT, authors TEXT NOT NULL DEFAULT '[]', year INTEGER, doi TEXT, arxiv_id TEXT,
  pdf_id TEXT,
  kind TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('paper','book','slides','other')),
  has_text INTEGER NOT NULL CHECK (has_text IN (0,1)),
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
  index_text INTEGER NOT NULL DEFAULT 1 CHECK (index_text IN (0,1)),
  blob_stored INTEGER NOT NULL DEFAULT 0 CHECK (blob_stored IN (0,1)),
  starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  save_reasons TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX documents_seq ON documents(seq);

CREATE TABLE aliases (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  similarity REAL NOT NULL CHECK (similarity >= 0.995 AND similarity <= 1),
  created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX aliases_document ON aliases(document_id);
CREATE INDEX aliases_seq ON aliases(seq);

CREATE TABLE locations (
  id TEXT PRIMARY KEY CHECK (length(id) = 64),
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('url','file')),
  canonical TEXT NOT NULL, raw TEXT NOT NULL,
  via_page TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX locations_document ON locations(document_id);
CREATE INDEX locations_seq ON locations(seq);

CREATE TABLE marks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  style TEXT NOT NULL CHECK (style IN ('highlight','underline','bold','strike','area')),
  color INTEGER CHECK (color BETWEEN 1 AND 5),
  anchor TEXT NOT NULL,
  page_index INTEGER NOT NULL, sort_key REAL NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT 'me' CHECK (author IN ('me','claude')),
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX marks_order ON marks(document_id, page_index, sort_key);
CREATE INDEX marks_seq ON marks(seq);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  anchor TEXT NOT NULL,
  page_index INTEGER, sort_key REAL,
  placement TEXT NOT NULL DEFAULT 'placed' CHECK (placement IN ('placed','unplaced')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  draft_of_tab TEXT CHECK (draft_of_tab IS NULL),
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX threads_order ON threads(document_id, page_index, sort_key);
CREATE INDEX threads_seq ON threads(seq);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author TEXT NOT NULL CHECK (author IN ('me','claude')),
  body TEXT NOT NULL,
  draft_of_tab TEXT CHECK (draft_of_tab IS NULL),
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '',
  mcp_request_id TEXT UNIQUE);
CREATE INDEX comments_thread ON comments(thread_id, created_at);
CREATE INDEX comments_seq ON comments(seq);

CREATE TABLE history (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  first_opened INTEGER NOT NULL, last_opened INTEGER NOT NULL, open_count INTEGER NOT NULL DEFAULT 1,
  reading_ms INTEGER NOT NULL DEFAULT 0,
  last_position TEXT,
  pages_visited BLOB NOT NULL DEFAULT x'',
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX history_last_opened ON history(last_opened);
CREATE INDEX history_seq ON history(seq);

CREATE TABLE settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX settings_seq ON settings(seq);

-- ─── Search over titles and notes (derived; the nightly backup skips these) ───────────────────────────────────────────────

-- As local v3: documents in Trash are not searchable.
CREATE VIRTUAL TABLE documents_fts USING fts5(document_id UNINDEXED, title, authors, tokenize="unicode61 remove_diacritics 2");
CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents WHEN NEW.deleted_at IS NULL BEGIN
  INSERT INTO documents_fts (document_id, title, authors) VALUES (NEW.id, NEW.title, NEW.authors);
END;
CREATE TRIGGER documents_fts_au AFTER UPDATE ON documents BEGIN
  DELETE FROM documents_fts WHERE document_id = OLD.id;
  INSERT INTO documents_fts (document_id, title, authors) SELECT NEW.id, NEW.title, NEW.authors WHERE NEW.deleted_at IS NULL;
END;
CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
  DELETE FROM documents_fts WHERE document_id = OLD.id;
END;

-- As local v2: only sent, live comments are searchable.
CREATE VIRTUAL TABLE comments_fts USING fts5(comment_id UNINDEXED, document_id UNINDEXED, body, tokenize="unicode61 remove_diacritics 2");
CREATE TRIGGER comments_fts_ai AFTER INSERT ON comments WHEN NEW.draft_of_tab IS NULL AND NEW.deleted_at IS NULL BEGIN
  INSERT INTO comments_fts (comment_id, document_id, body) VALUES (NEW.id, NEW.document_id, NEW.body);
END;
CREATE TRIGGER comments_fts_au AFTER UPDATE ON comments BEGIN
  DELETE FROM comments_fts WHERE comment_id = OLD.id;
  INSERT INTO comments_fts (comment_id, document_id, body) SELECT NEW.id, NEW.document_id, NEW.body
    WHERE NEW.draft_of_tab IS NULL AND NEW.deleted_at IS NULL;
END;
CREATE TRIGGER comments_fts_ad AFTER DELETE ON comments BEGIN
  DELETE FROM comments_fts WHERE comment_id = OLD.id;
END;

-- ─── Server-only tables (never synced, never in a pull) ───────────────────────────────────────────────────────────────────

-- The global change counter. The push handler reads it, assigns seq = counter + i to the i-th applied row, and adds N.
CREATE TABLE sync_counter (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
INSERT INTO sync_counter (id, seq) VALUES (1, 0);

-- Devices that sync. 'claude' is the connector: it writes only rows with author 'claude' and edits nobody's.
CREATE TABLE device (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('extension','web','claude')),
  created_at INTEGER NOT NULL, last_seen_at INTEGER, last_pull_seq INTEGER);
INSERT INTO device (id, name, kind, created_at) VALUES ('claude', 'Claude (connector)', 'claude', CAST(strftime('%s','now') AS INTEGER) * 1000);

-- The newest stamp of an entry from each device for each row that the server has processed. mergeEntry reads it
-- (MergeContext.processedUpTo) so that a retry or a replayed log does nothing: no second conflict copy, no note brought
-- back after a delete. The daily job prunes rows older than 30 days. One small row per device and row.
CREATE TABLE applied_entry (
  device TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL, hlc TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (device, table_name, row_id)) WITHOUT ROWID;
CREATE INDEX applied_entry_at ON applied_entry(at);

-- Multipart PDF uploads in flight (R2 aborts an unfinished one after 7 days).
CREATE TABLE blob_upload (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64), upload_id TEXT NOT NULL, part_size INTEGER NOT NULL,
  byte_size INTEGER NOT NULL, parts TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL);

-- Every write the connector makes, and every grant change. No bodies, no text, no tokens.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, client_id TEXT,
  action TEXT NOT NULL, target TEXT, batch TEXT);
CREATE INDEX audit_at ON audit(at);

-- Rows written per UTC day, for the write meter. Text stops at WRITE_BUDGET; notes go on to WRITE_BUDGET + NOTES_RESERVE.
CREATE TABLE usage_day (day TEXT PRIMARY KEY, text_rows INTEGER NOT NULL DEFAULT 0, note_rows INTEGER NOT NULL DEFAULT 0);

-- Switches the owner controls: mcp_enabled (the kill switch: off makes /mcp answer 503), claude_can_comment.
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO setting (key, value) VALUES ('mcp_enabled', 'true'), ('claude_can_comment', 'true');

-- Where each document's page text lives. A different `extractor` replaces that document's pages (OCR finishing, an engine
-- upgrade).
CREATE TABLE doc_text (
  document_id TEXT PRIMARY KEY CHECK (length(document_id) = 64),
  shard INTEGER NOT NULL CHECK (shard >= 0),
  extractor TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0 CHECK (pages >= 0),
  state TEXT NOT NULL CHECK (state IN ('partial','complete','no_text')));

-- A forgotten document: its blob, text and notes are gone and nothing about it is accepted again. Served to other devices as
-- { id, deletedAt, forgotten: true }.
CREATE TABLE forgotten (document_id TEXT PRIMARY KEY CHECK (length(document_id) = 64), at INTEGER NOT NULL);
