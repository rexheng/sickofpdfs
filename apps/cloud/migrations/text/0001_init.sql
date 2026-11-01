-- sop_text_n: page text with full-text search. Every shard has the same tables. A document lives in exactly one shard, recorded
-- in sop_meta.doc_text; a new document goes to the emptiest shard, and adding a shard never moves a document.
--
-- `page_index` is 0-based (research 05 had 1-based `n`). `page.id` is docnum * 100000 + page_index, so the pages of a document
-- are one id range and need no extra index (every extra index is another row written for every page).

CREATE TABLE shard_doc (
  docnum INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL UNIQUE CHECK (length(document_id) = 64),
  pages INTEGER NOT NULL DEFAULT 0,
  extractor TEXT);

CREATE TABLE page (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  page_index INTEGER NOT NULL CHECK (page_index >= 0 AND page_index < 100000),
  text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'pdfium');

CREATE VIRTUAL TABLE page_fts USING fts5(text, content='page', content_rowid='id', tokenize="unicode61 remove_diacritics 2");
CREATE TRIGGER page_ai AFTER INSERT ON page BEGIN
  INSERT INTO page_fts (rowid, text) VALUES (NEW.id, NEW.text);
END;
CREATE TRIGGER page_ad AFTER DELETE ON page BEGIN
  INSERT INTO page_fts (page_fts, rowid, text) VALUES ('delete', OLD.id, OLD.text);
END;
CREATE TRIGGER page_au AFTER UPDATE ON page BEGIN
  INSERT INTO page_fts (page_fts, rowid, text) VALUES ('delete', OLD.id, OLD.text);
  INSERT INTO page_fts (rowid, text) VALUES (NEW.id, NEW.text);
END;
