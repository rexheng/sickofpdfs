-- sop_meta step 3 (CL11). Deletes that sync, for the five synced tables without soft deletes: a reading's tags, the auto tags
-- taken off a reading, settings, locations and aliases. Without it, a tag taken off a reading on one computer stayed on the others.
--
-- `removed_row` is one small marker per deleted row: which row, its revision and stamp after the delete, and the device. It holds
-- no content. A pull hands it out like any change (`removed: true`), so every computer deletes the row too. When the row is
-- added again later, its marker goes. Forget removes the markers of the forgotten document with the rest of it.
CREATE TABLE removed_row (
  table_name TEXT NOT NULL CHECK (table_name IN ('aliases','locations','settings','reading_tags','auto_tag_removed')),
  row_id TEXT NOT NULL,
  document_id TEXT,
  rev INTEGER NOT NULL, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL, device TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL,
  PRIMARY KEY (table_name, row_id));
CREATE INDEX removed_row_seq ON removed_row(seq);
CREATE INDEX removed_row_document ON removed_row(document_id);
