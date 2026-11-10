-- sop_meta step 2 (CL3, CL4, CL7). Additive for the synced tables; two small server-only tables change shape.
--
-- 1. The three tag tables of local schema v5 (R92), mirrored like the other synced tables: the local names, columns and CHECKs,
--    plus `seq` and `device`. Two differences from local, on purpose:
--      - no unique index on a live tag's name: two computers can each make a tag with the same name before they meet, and the
--        second push must not fail. Each computer folds a pulled tag into its own live tag of that name (as a restore does).
--      - `tag_id` has no foreign key (like `comments.thread_id`): a computer may push a reading's tag before the tag itself.
--    The server checks the remaining CHECKs before it writes (sync/rows.ts), so one bad row is refused alone and never stops a push.
-- 2. `device` gains the phone kinds and the sign-in it belongs to (`grant_id`), so a push names its device from the token, never
--    from the request body. Rebuilt, because a CHECK cannot change in place. Nothing references this table.
-- 3. `forgotten` gains `seq`, so other devices pull a Forget like any other change.
-- 4. `sync_counter` gains `lock`, and `sync_guard` is new: together they make a push all-or-nothing against a push that ran in
--    between (sync/service.ts). `sync_guard` is always empty between pushes.

CREATE TABLE tags (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK (kind IN ('topic','course','tag')),
  topic_key TEXT,
  renamed INTEGER NOT NULL DEFAULT 0 CHECK (renamed IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '');
CREATE INDEX tags_seq ON tags(seq);

CREATE TABLE reading_tags (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner','auto')),
  created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '',
  UNIQUE (document_id, tag_id),
  CHECK (id = document_id || ':' || tag_id));
CREATE INDEX reading_tags_tag ON reading_tags(tag_id);
CREATE INDEX reading_tags_seq ON reading_tags(seq);

CREATE TABLE auto_tag_removed (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL,
  removed_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0, hlc TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, device TEXT NOT NULL DEFAULT '',
  UNIQUE (document_id, tag_id),
  CHECK (id = document_id || ':' || tag_id));
CREATE INDEX auto_tag_removed_tag ON auto_tag_removed(tag_id);
CREATE INDEX auto_tag_removed_seq ON auto_tag_removed(seq);

-- `grant_id` is the sign-in (OAuth grant) this device syncs with; a web device belongs to a browser session instead (NULL here).
CREATE TABLE device_v2 (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('extension','android','ios','web','claude')),
  created_at INTEGER NOT NULL, last_seen_at INTEGER, last_pull_seq INTEGER,
  grant_id TEXT, client_id TEXT);
INSERT INTO device_v2 (id, name, kind, created_at, last_seen_at, last_pull_seq)
  SELECT id, name, kind, created_at, last_seen_at, last_pull_seq FROM device;
DROP TABLE device;
ALTER TABLE device_v2 RENAME TO device;
CREATE UNIQUE INDEX device_grant ON device(grant_id) WHERE grant_id IS NOT NULL;

ALTER TABLE forgotten ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX forgotten_seq ON forgotten(seq);

ALTER TABLE sync_counter ADD COLUMN lock TEXT NOT NULL DEFAULT '';
CREATE TABLE sync_guard (ok INTEGER NOT NULL);
