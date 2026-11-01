# Phases 5–6 plan · Release 2: cloud sync, the web library and the claude.ai connector

Nov 1, 2026. Read first: `CLAUDE.md`; the spec ("Storage, sync and backup", "Hosting", "Claude integration" part 2, "Build phases"); contracts §1, §4, §7, §8, §10; research 05 (its §9 schema is replaced by the contracts); the Phase 2 and 3 plans (comment UI, library pages, Settings, backup badge).

## Goal and done when

**Goal.** Your saved readings and notes are copied to your own Cloudflare account and open from any computer. claude.ai can search them and add comments that show up in the viewer.

**Phase 5 is done when** (gate g5):
- After a full reinstall, signing in once brings back everything marked as synced: notes, page text and PDFs.
- The library says how many items are not yet synced. The icon shows a badge if sync has stopped.
- Two computers that edit the same note lose nothing. A receipt, a draft or an unsaved PDF never leaves your computer.
- Staging and production are separate Workers. Production changes only from a tagged release, after a restore point.

**Phase 6 is done when** (gate g6):
- The web library works from any computer and on a phone: browse, search, open a PDF, read and write notes.
- claude.ai can search the library, read pages and add a comment, and the comment appears in the viewer after sync.
- Claude can never change or delete your notes, or download your PDFs.

**Hard rule.** Nothing is created on your Cloudflare account until you say OK. Rounds 1–5 use `wrangler dev` / Miniflare and local tests only. Deployment is Round 6, with two separate OK points.

## Frontier check (4 searches, 1 Nov; nothing changes the stack)

- **MCP spec.** `2026-07-28` is final and nothing newer exists. New facts for us: `server/discover` is mandatory, every result carries `resultType`, list results carry `ttlMs`/`cacheScope`, and DCR is deprecated but still works. Anthropic reportedly rolls `2026-07-28` out across Claude, so CL6 tests both lanes on the wire.
- **`agents` / McpAgent.** No change: `agents` 0.32.0 with `@modelcontextprotocol/server` 2.4.0 is still current. `McpAgent` is feature-frozen and `createMcpHandler(server)` is deprecated, so use the factory form only.
- **claude.ai sign-in.** Unchanged. "Use Claude's published identity" is CIMD, with client ids `https://claude.ai/oauth/mcp-oauth-client-metadata` (web, desktop, phone) and `…/claude-code-client-metadata` (Claude Code, loopback). New detail: allow the `claude.com` twin of the callback in the DCR fallback.
- **Testing.** `@cloudflare/vitest-pool-workers` is now `@cloudflare/vitest-plugin` 1.4.11, whose peer range includes our Vitest 5.0.5. Worker tests run on real workerd under Miniflare, as a `cloud` test project. Pins today: wrangler 4.156.0, workers-oauth-provider 1.2.4, hono 4.13.16, zod 4.6.7.

## Slices

Tags **[P5]**, **[P6]**. Implementers commit no tests. "High" means a spec-blind test author plus a short security read of the diff. Each slice writes its own results file.

### Worker (`apps/cloud`): CL1–CL8 start NOW, local tests only

**CL1 · Scaffold, schema and local harness** [P5] · low · sonnet · S
Goal: an empty Worker that runs under `wrangler dev` and in tests, with a database shaped exactly like the extension's.
- **Owns:** `apps/cloud/{package.json,tsconfig.json,wrangler.jsonc,vitest.config.ts}`, `src/{index,env,routes}.ts`, a stub `app.ts` in each of `src/{auth,sync,query,mcp,export,web}/`, stub `src/pages/*` (the slice that owns the folder replaces them), `migrations/{meta,text}/0001_init.sql`, `test/{harness,fake-github}.ts`. One-line edits: root `package.json` (`test` adds `--project cloud`), root `vitest.config.ts` (adds the `cloud` project; `unit` skips it), `packages/core/package.json` (subpaths `@sop/core/sync` and `@sop/core/connector`, with stub index files).
- **Makes:** CA1 and CA2. `wrangler.jsonc` has the top level as `local`, plus `staging` and `production`, with placeholder ids only.
- **Local run:** `pnpm -C apps/cloud dev:test` starts the Worker and a fake GitHub that signs in as the owner or as a stranger, on temporary storage. The harness has `asOwner(scopes)`, a fake CIMD host, and a D1 wrapper that fails past 100 bound parameters or 50 queries per request (real D1 limits that Miniflare may not enforce).
- **Depends on:** nothing.

**CL2 · Sync protocol and merge, pure** [P5] · high · sonnet (test author: opus) · M
Goal: the rules that decide what wins when two computers change the same thing. No note is ever dropped.
- **Owns:** `packages/core/src/sync/{index,protocol,columns,merge,clamp,reparent}.ts`.
- **Makes:** the wire types of contracts §7, unchanged; `mergeEntry(serverRow | null, entry, ctx) → apply | noop | reject (+ conflict copy)`; `clampHlc`; `planReparent(loser, winner, rows)`.
- **`columns.ts`:** per table, the wire id (`aliases` → `sha256`, `history` → `documentId`, `settings` → `key`, the rest `id`), camelCase to snake_case, JSON columns, the local-only column `blobStored`. The settings keys `filter.allow` and `filter.deny` leave with host entries only, never folder paths.
- **Rules (contracts §7, plus):**
  - A retry of an applied push is a no-op, not a conflict.
  - An edit beats a delete. Otherwise the newer `hlc` wins the row.
  - Two different non-empty comment bodies: the loser becomes a new comment in the thread, with `ConflictCopyMeta`.
  - `history` merges per field: `firstOpened` min, `lastOpened` max, counters max, visited pages union, `lastPosition` from the newer stamp.
  - Locations: `firstSeen` min, `lastSeen` max. Two aliases for one fingerprint: the smaller document id wins.
  - `author` never changes. The `claude` device writes only `claude` rows and edits nobody's.
- **Depends on:** Task 28's `hlc.ts` (cherry-pick it first if not merged).

**CL3 · Sign-in and OAuth server** [P5] · high · sonnet · M
Goal: only you get in. GitHub sign-in, locked to your numeric id, serves claude.ai, Claude Code, the extension and the web.
- **Owns:** `apps/cloud/src/auth/**`.
- **Makes:** `OAuthAuthorizationServer` plus two resource servers, `/mcp` and `/api`. Produces `authenticate(req, env): AuthContext | Response`.
- **Clients and tokens:** CIMD on. A restricted DCR fallback (claude.ai and claude.com callbacks, loopback, the extension's `chromiumapp.org` address). The extension is a client registered once, by `registerExtensionClient()` (bootstrap and the harness call it). `iss` on responses (RFC 9207). Scopes `library:read library:comment sync offline_access`. A token for `/api` fails on `/mcp` and back.
- **Owner only:** the id is checked at the callback and on every request. The web uses a `__Host-sess` cookie with CSRF and `Origin` checks. Also rate limits, `GET /api/grants` and `DELETE /api/grants/:id`, and the kill switch `setting.mcp_enabled` (503). GitHub base URLs are settings, overridable only in `local`.
- **Depends on:** CL1.

**CL4 · Sync API** [P5] · high · sonnet · L
Goal: computers send and receive changes and upload PDFs and page text. The server refuses anything that is not a saved learning PDF, and any draft.
- **Owns:** `apps/cloud/src/sync/**`. Implements `SyncService`; routes in CA3.
- **Push:** runs CL2's `mergeEntry` in one D1 `batch()` and assigns `seq`. `needBlobs` and `needText` tell the device what to upload.
- **Refusals:** a document needs `label: 'learning'`; a child row needs a known document; `draftOfTab` must be null (also a database CHECK). Only the server sets `blob_stored`.
- **Blobs and text:** a single PUT up to 32 MiB is hash-checked by R2; multipart uses 32 MiB parts and survives a restart. Text goes to the emptiest shard, recorded in `doc_text`; a different `extractor` replaces that document's pages (OCR finishing, engine upgrade).
- **Write meter:** text stops at `WRITE_BUDGET` (production 75,000, staging 10,000). Notes go on to `WRITE_BUDGET + NOTES_RESERVE` (staging: reserve 0). A refusal is 429 with `Retry-After`.
- **Forget:** a forgotten document is served as `{ id, deletedAt, forgotten: true }`.
- **Depends on:** CL1; CL2 by signature (merged first).

**CL5 · Library queries** [P6] · high · sonnet · M
Goal: one set of read queries shared by the connector and the web library, so they never disagree.
- **Owns:** `apps/cloud/src/query/**`. Implements `QueryApi` (CA1): `search`, `listDocuments`, `getDocument`, `readPages`, `getAnnotations`, `recentActivity`, `listNotes`, with the meaning of Phase 3's local queries (contracts §5).
- **Search:** pages across every text shard merged by bm25, plus notes and titles. FTS input is split into quoted terms, never raw `MATCH`.
- **Reads:** only live, non-draft, non-forgotten rows.
- **Depends on:** CL1 (tests seed the tables by SQL).

**CL6 · The MCP connector** [P6] · high · sonnet · M
Goal: claude.ai and Claude Code search your library, read pages and add comments that Claude owns.
- **Owns:** `packages/core/src/connector/{index,tools}.ts` (tool and result types), `apps/cloud/src/mcp/**`.
- **Tools:** the eight of contracts §8, via `createMcpHandler` (factory form) and `@modelcontextprotocol/server`. Both lanes: `2026-07-28` (no handshake, `Mcp-Method`/`Mcp-Name`, `server/discover`, `resultType`, `ttlMs`/`cacheScope`) and the legacy stateless lane. No token gets 401 with resource metadata.
- **Reads and writes:** reads use `QueryApi`. Writes use `SyncService.push` as device `claude`, so they pass the same rules as every other write. Write tools exist only with `library:comment` and `setting.claude_can_comment`.
- **Safety:** each write is logged in `audit` (no bodies). Output is capped at 40,000 characters with cursors. The `read_pages` description says page text is untrusted data.
- **`add_comment`:** a quote that is missing, or appears twice on the page, is a retryable error (`quote_not_found`, `quote_ambiguous`). Matching ignores whitespace and line-break differences and maps back to raw char offsets. `sortKey` is start ÷ page length. No highlight is added (D4). `update_comment` gains `delete` (D3).
- **Depends on:** CL1; CL4 and CL5 by interface, wired at merge.

**CL7 · Export, backup and daily jobs** [P5] · high · sonnet · S
Goal: a nightly copy of everything that matters, kept 30 days, plus housekeeping.
- **Owns:** `apps/cloud/src/export/**`: `GET /api/export/:table?after&limit`, `PUT /api/backup/:date/:part`, `scheduled()`.
- **Export:** the eight synced tables and the server-only tables, never the search tables. Auth is the `SOP_EXPORT_TOKEN` Worker secret (constant-time compare).
- **Daily job:** prunes backups over 30 days, stale uploads and audit rows over 180 days. It hard-purges documents in Trash 30 days (D8) with `SyncService.purgeDocument`, so Trash purge needs no call from the extension.
- **Depends on:** CL1; CL4 by interface.

**CL8 · Deploy kit** [P5] · high · sonnet · M (files only; nothing runs until Round 6)
Goal: everything needed to put staging, then production, on your account, written and checked without touching it.
- **Owns:** `.github/workflows/cloud-{ci,bootstrap,deploy-staging,deploy-production,backup}.yml`, `apps/cloud/scripts/{bootstrap,restore-point,smoke}.mjs`, `docs/setup/cloud.md` (the spec's Release 2 list, every secret named; the controller links it from `SETUP.md`).
- **`ci`:** typecheck, lint and tests, no secrets. **`bootstrap`:** creates databases, bucket, KV and Workers per environment, registers the extension client, sets Worker secrets, commits the ids.
- **`deploy-production`:** runs only on a `v*` tag, after a D1 Time Travel restore point per database. **`backup`:** nightly, production only.
- **`smoke`:** a stranger is refused, `/mcp` answers 401 with metadata, one sync round trip works.
- **Rules:** every workflow starts as `workflow_dispatch` only, and Actions are pinned by full SHA.
- **Depends on:** CL1 (shape).

### Extension (`apps/extension`)

**CL9 · Local store: the sync side** [P5] · high · sonnet · M
Goal: the local database can queue, send, receive and apply changes without echoing, dropping or overwriting a note.
- **Owns:** `apps/extension/src/store/{schema-v4,sync-store}.ts`; one-line mix-ins in `store-api.ts`, `protocol.ts`, `migrate.ts`. Makes schema v4 (CA4) and `SyncStoreApi` (CA5).
- **Sending:** one entry per queued row, with the oldest queued `baseRev`. A row created and deleted before any push is dropped. File locations leave as file names. Drafts, unsaved PDFs, `owner-override` documents (CD1) and "never sync" ones never leave.
- **Receiving:** a pulled row skips any row with a queued edit (the server decides at the next push). Pulled rows never enter the outbox. The remote `blobStored` is ignored, and a pulled file location never overwrites a local path.
- **Duplicates:** a pulled alias that names a local document as a duplicate re-parents its notes into the smaller id (`planReparent`).
- **Depends on:** Task 28; the v2 and v3 schema steps; CL2.

**CL10 · Cloud sign-in and the token broker** [P5] · high · sonnet · M
Goal: you sign in once from Settings and every sync call has a fresh token, while the refresh token is readable by one small module only.
- **Owns:** `apps/extension/src/local-only/{db,cloud-auth,cloud-forget}.ts`, `src/background/cloud-broker.ts`, `src/shared/cloud-messages.ts`; the amended import-boundary test and ESLint rule (CA7); a mechanical move of the IndexedDB open code out of `secrets-store.ts` into `db.ts`.
- **Sign-in:** `chrome.identity.launchWebAuthFlow` with PKCE, resource `…/api`, scope `sync offline_access`. Refresh is single-flight.
- **Messages:** `cloud:signin|signout|token|status|forget`. The offscreen engine gets tokens by message and never imports `sop-local`. The Worker address is an optional host permission asked for at Connect, and the network gate allows it only after Connect.
- **Forget (D2):** the queue sits beside the token and an alarm retries it. `requestCloudForget(sha)` is for viewer and library code.
- **Tests:** test builds replace the browser leg with a headless follower of the redirects, because Playwright cannot click the sign-in window.
- **Depends on:** Tasks 12 and 29; CL3 for the end-to-end check.

**CL11 · Sync engine and restore** [P5] · high · sonnet · L
Goal: notes, text and PDFs flow both ways in the background, resume after any interruption, and a fresh install restores the whole library.
- **Owns:** `apps/extension/src/sync/{engine,scheduler,client,blobs,text,restore,status}.ts`; one line in `entrypoints/offscreen/main.ts`.
- **When it runs:** push then pull, cursor in `sync_state`. After a change (debounced), on start and focus, on a 5-minute alarm, and a `head` check every 30 s while a viewer is visible.
- **Uploads:** `HEAD` first; one PUT up to 32 MiB; resumable 32 MiB multipart above that. PDFs go only when the global switch is on and the document is not "keep local". A 429 is honoured with its `Retry-After`.
- **Text:** chunks of at most 256 KB, recent documents first. None for password-protected PDFs (CD2) or `indexText = 0`. It remembers the source last sent (`textSent:<id>`) and sends again when `page_text.source` changes, as OCR finishes (Phase 7).
- **Restore:** downloads PDFs two at a time, re-hashes each, and shows progress.
- **Reports:** `SyncStatus`; `StoreChange` with `origin: 'sync' | 'restore'`; a `sync` source in Phase 3's `backup/badge.ts` (backup-waiting outranks it).
- **Depends on:** CL4, CL9, CL10.

**CL12 · Cloud screens in the extension** [P5] · visual · opus · S
Goal: you see and control sync: connect, status, "N not yet synced", PDF upload switch, "Keep this PDF local", "Remove from cloud".
- **Owns:** `apps/extension/src/sync/ui/{CloudSettings,SyncChip,KeepLocalMenuItem}.tsx`, plus one-line registrations in Phase 3's `SETTINGS_SECTIONS`, the library shell and the viewer's File menu.
- **Makes:** `useSyncStatus()` from CL11, with `packages/ui` components only. Plain words for every state: connected, syncing, restoring "N of M", offline, stopped, signed out, daily limit reached.
- **Depends on:** CL11; Phase 3's Settings and shell.

### Web (`apps/cloud/web`)

**CL13 · Web library: pages, sign-in, Settings** [P6] · visual · opus · L
Goal: the library opens in any browser, looks like Drive, and works on a phone.
- **Owns:** `apps/cloud/web/**` (Vite SPA, `_headers` with the CSP, built into `apps/cloud/public/`) and `apps/cloud/src/pages/**` (sign-in, "not your account", consent: server-rendered HTML plus one CSS file built from the tokens).
- **`RemoteStore`:** implements Phase 3's `LibraryData` over `/api`, plus the annotation methods Phase 2's session needs (CA6). It writes as device `web-<id>`. Drafts stay in the browser's own storage and are sent only on send.
- **Pages:** Phase 3's Home, My library, Recent, Starred, Notes and Trash, through a Vite alias (CA6). A web Settings page: connections (revoke), Claude on/off, "Claude can comment", usage meters, devices.
- **Also:** a "Saving…" / "Offline, not saved" indicator; deep links `/d/<sha>?page=N#c=<id>`; layouts checked at 360, 768 and 1280 px.
- **Depends on:** CL1; CL3, CL4, CL5 for data; Phase 3's pages.

**CL14 · Web viewer** [P6] · visual · opus · L
Goal: open a saved PDF on the web with its notes, and add and edit notes.
- **Owns:** `apps/cloud/web/src/viewer/**`.
- **Reuses:** `packages/viewer`'s page list and text layer; Phase 2's marks layer, comment cards and annotation session over `RemoteStore`, with `save: null` (CA6).
- **PDF:** streams from `/api/blobs/:sha` with a progress bar and Range, and is re-hashed. "Download" is the fallback for huge files and phones. PDFium wasm comes from the Worker's own assets (each file at most 25 MiB).
- **Ask Claude:** shows one plain line, "Ask Claude from the extension or from claude.ai."
- **Depends on:** CL13; Phase 2's marks and cards.

**CL15 · Web upload** [P6] · high · sonnet · M
Goal: drag a PDF into the web library. The same filter and text extraction run in your browser first.
- **Owns:** `apps/cloud/web/src/upload/**`.
- **Flow:** hash, then Phase 3's `buildFilterInput` and `classify`, text through `PdfBackend`, then PUT blob and text and push a `documents` row with `label: 'learning'`. Progress and resume as in CL11.
- **Decisions:** "Not sure" asks you (no MiniLM on the web). Not-learning is refused with the reason, and nothing is sent.
- **Depends on:** CL14; Phase 3's filter; CL4.

## Rounds

Merge once per round with `merge-wave`, then the three gates. **8 of 15 slices can start NOW:** CL1 and CL2 at once, CL3–CL8 right after Round 1 merges.

| Round | Slices | Starts |
| --- | --- | --- |
| 1 | CL1, CL2 | **NOW** (only the tiny `hlc.ts` from Task 28) |
| 2 | CL3, CL4, CL5, CL6, CL7, CL8 | **NOW**, after Round 1 (all local) |
| 3 | CL9, CL10 | after Tasks 12, 28, 29 and the v2/v3 schema steps |
| 4 | CL11, CL13 | after Round 3; CL13 also needs Phase 3's pages |
| 5 | CL12, CL14, CL15 | after Round 4; CL14 needs Phase 2's marks and cards. Gates g5 and g6 run on local `dev:test` |
| 6 | Cutover (the controller; not a build round) | only with your OK |

**Round 6, in order:**
1. *Pre-flight, no OK needed.* Confirm which Cloudflare account the tools are signed in to (research 05 §6.5 saw an email that is not your claude.ai one).
2. *OK #1: staging.* Bootstrap staging (two small databases, a bucket, a KV namespace, a Worker, its own GitHub OAuth app). Run the cloud walkthroughs against it. Hand checks: the claude.ai connector screens (Free allows one custom connector and its sign-in settings cannot be edited, so you remove and re-add it for production), Workers Logs CPU against the 10 ms limit, and the D1 rows written by a 50-page text upload.
3. *OK #2: production.* Bootstrap production, tag `v*`, restore point recorded. You run the reinstall test on your own computer.

## Gate 1: walkthrough tests to add

A spec-blind author writes them from the spec and contracts. They run on `dev:test` from Round 2 (7 and 8 first) and again on staging in Round 6, with screenshots.

1. **Restore after a reinstall.** Read two learning PDFs, mark and comment, let sync finish. Open a fresh profile with the same extension and sign in. Library, notes, page text and PDFs match, the unsynced count is 0, and search finds the notes.
2. **Two computers, one note.** Both go offline and edit the same comment: the later text wins and the other text is a reply "edited on another device". Computer A deletes a note while B edits it: the note comes back with B's edit. Nothing is lost.
3. **A receipt never leaves.** Open a receipt and a learning PDF, and save the receipt by hand against the filter (CD1). The cloud holds only the learning PDF. A draft note is not there. The network log shows no upload for the receipt.
4. **Forget.** Forget a PDF with sync on, and again offline. The cloud's blob, text and notes go, and a second signed-in computer drops it too.
5. **Offline and back.** Mark and comment offline: the count shows N, then 0 after reconnecting. Sign out: the icon shows a badge and no note is lost. At a small test write budget, notes still sync, text waits, and the message is plain.
6. **A big PDF.** Upload 70 MB, cut the network halfway, reconnect. It resumes, and a second computer opens it with identical bytes.
7. **The web library.** A stranger is refused. As the owner: browse, search, open a PDF with a progress bar, see notes, add a comment ("Saving…", then saved); it appears in the extension within 35 s. A dropped receipt is refused and nothing is sent. A dropped paper is saved and searchable.
8. **claude.ai (walkthrough 8).** A test client plays claude.ai: CIMD sign-in, search "parallel trends" and find your note, read pages 3–4, add a comment on a quote. It shows in the open viewer within 35 s as a Claude comment with a dotted underline. A missing quote gives a retryable error. Without `library:comment` the write tools are absent. Claude cannot edit or delete your note. With the kill switch on, `/mcp` answers 503.

**Unit tests (spec-blind, table-driven; only these):** the CL2 merge, with a random-order convergence check (no distinct non-empty note body ever disappears); CL9's collect and apply rules; CL6's quote anchoring; CL5's hostile search queries; and a check that the cloud migration matches the local schema (written with CL9).

**Hand checks:** the claude.ai connector screens; the web library on a real phone; the full reinstall on your computer.

## Gate 2

None. The engine and text layer are reused unchanged. If CL14 or CL15 touch engine or text-layer code, Gate 2 runs as usual.

## Gate 3: screens to add

Each next to its Drive reference, at 360 px and on desktop.
- **Web:** sign-in, "not your account", consent, Home, My library as list and grid with thumbnails, Notes, Trash, empty library, Settings, upload with progress, the viewer with comment cards, "Saving…", "Offline, not saved".
- **Extension:** Settings → Cloud in each state, the "N not yet synced" chip, "Keep this PDF local" in the File menu.

## Contract additions

- **CA1 · Seams (CL1 declares them, types only).**
  - `AuthContext { kind: 'bearer' | 'cookie'; uid; clientId: string | null; scopes: string[]; device: string | null }`.
  - `SyncService { head(); pull(since, limit); push(device, entries); purgeDocument(sha) }`.
  - `QueryApi` has the shapes of contracts §5 and §8. `Author` stays `'me' | 'claude'` inside, and `'user'` appears only at the MCP edge.
- **CA2 · Cloud schema.**
  - `sop_meta` has the eight synced tables with the local names, columns and CHECKs (local v1 to v3), plus `seq` and `device`. `comments.mcp_request_id` is UNIQUE. The `draft_of_tab` columns are `CHECK (… IS NULL)`.
  - Server-only tables: `sync_counter`, `device`, `blob_upload`, `audit`, `usage_day`, `setting`, `doc_text(document_id, shard, extractor, pages, state)`, `forgotten(document_id, at)`.
  - Shards `sop_text_n` hold `shard_doc`, `page(id, document_id, page_index, text, source)` and `page_fts`. `page_index` is 0-based (research 05 had 1-based `n`).
  - The cloud `documents.blob_stored` means "the PDF is in R2", and only the server sets it. Staging has one meta and one text database. Production starts with two text shards, and a new shard needs your OK.
- **CA3 · Routes.**
  - Bearer `sync`: `POST /api/devices`, `GET /api/sync/{head,pull}`, `POST /api/sync/push`, `PUT|GET /api/text/:sha`, `HEAD|PUT|GET /api/blobs/:sha`, `/api/blobs/:sha/multipart…`, `PUT|GET /api/thumbs/:sha` (R2 `thumb/<sha>.webp`), `DELETE /api/documents/:sha` (Forget).
  - Library reads, bearer or cookie: `GET /api/{search,documents,notes,activity,me}`. Cookie only: `/login`, `/logout`, `/api/grants`. `/api/export` and `/api/backup` take the export token.
- **CA4 · Local schema v4.** `sync_state(key, value)` with keys `cursor`, `deviceRegistered`, `uploadPdfs`, `keepLocal:<id>`, `neverSync:<id>`, `textSent:<id>`. The eight outbox triggers are re-created with `WHEN NOT sop_sync_applying()`, and the store worker registers that function.
- **CA5 · `SyncStoreApi`.** `collectPush(limit)`, `ackPush(result)`, `applyPulled(entries)`, `getSyncState/setSyncState`, `unsyncedCount()`, `pendingBlobs()`, `pendingText()`, `forgetLocally(id)` (for a pulled `forgotten: true` row). `unsynced` counts queued rows plus PDFs and text still waiting.
- **CA6 · What the web reuses (Phases 2 and 3 must agree).**
  - From Phase 3: `LibraryData`, the pages, `buildFilterInput`, `classify`.
  - From Phase 2: the comment components in `packages/ui`, `packages/viewer/{marks,react,text}`, and `createAnnotationSession`, `CardColumn`, `comment-flow` and the notes panel from `apps/extension/src/viewer`.
  - Conditions: none imports `chrome.*` outside entrypoints, and each takes its store as a narrowed `Pick` of `StoreClient`, so `RemoteStore` can fit. The web reaches them through a Vite alias. If one fails, the controller has its owner fix it (a mechanical change) before Round 4.
- **CA7 · Import boundary.** Task 29's test allows exactly one new edge from the service worker into `local-only/`: `db.ts`, `cloud-auth.ts`, `cloud-forget.ts`. They touch only `cloud_token` and the Forget queue, and never import `secrets-store.ts`. The broker opens `sop-local` through `db.ts`, so it can never create a half-built database.
- **CA8 · Asks of other phases.**
  - Phase 3's S11 writes the reason `owner-override` into `saveReasons` when you save a PDF the filter judged not learning, and calls `requestCloudForget(sha)` after a local Forget.
  - Phase 2 draws a thread with empty `rects` by computing them on open, and shows a "Claude" badge for `meta.via = 'connector'`.
  - Phase 7 needs nothing more: OCR setting `has_text` queues a documents push, and CL11 then sends the text.
- **CA9 · Connector additions.** Error codes `quote_not_found`, `quote_ambiguous`, `thread_not_found`, `document_not_synced`, `comment_not_yours`. `update_comment` takes `delete?: boolean` (D3).
- **Defaults I used (you can overrule).** **CD1:** a PDF you saved against the filter stays on this computer unless you choose otherwise. **CD2:** a password-protected PDF uploads its encrypted file, but its text stays local.

## Risks

- **Lost notes by sync** is the worst case. CL2 and CL9 get spec-blind tests and a security read. The backup folder (Phase 3) and D1 Time Travel (7 days) are the backstops. Sync never purges a tombstone.
- **Two offline computers can still make two documents for one stamped paper.** Only alias rows reconcile them. Notes are split, never lost. Accepted ("fix it or drop it").
- **Miniflare is not real Cloudflare.** It may not enforce D1's query and parameter limits (CL1's wrapper does), the 10 ms CPU limit, or how FTS writes are counted. Round 6 measures those on staging. Fallback: Workers Paid, $5 a month, only with your OK.
- **The Worker address is final.** The extension and the claude.ai connector are tied to it. Pick the workers.dev name once.
- **No test-only token mint exists.** Test sign-in follows the real redirects through the fake GitHub.
- **Prompt injection in PDF text.** Claude has no tool that deletes or edits your notes or reads PDF bytes. Its comments are labelled and logged, and the kill switch stops them. In claude.ai you can set the two write tools to "ask first".
- **Two badge writers** (backup and sync): CL11 adds a source to Phase 3's `badge.ts`, and whichever merges second adds the one line.
- **CL13 and CL14 depend on CA6.** If Phase 2 or 3 built that UI against the extension, they slip until it is isolated.
- **Not in this plan:** "Answer with my Claude plan" (spec, Claude part 1, marked Release 2). It is a small follow-up on the connector; the controller assigns it.

## Carried requirements (controller, 1 Nov 2026, from CL1+CL2)

- **CL4:** after every `apply` or `noop` result, record `entry.hlc` in `applied_entry(device, table_name, row_id, hlc, at)` in the same D1 batch, and pass `processedUpTo` to `mergeEntry`. Without this replay memory, a replayed log can add a spurious conflict copy or bring back a deleted note.
- **CL7:** the daily job prunes `applied_entry` rows older than 30 days.
- **CL9:** drop a non-retryable entry from the outbox when `PushResponse.rejected` lists it (CA10, ratified). Decide whether the emptied duplicate after `planReparent` is hidden or trashed.
- **Ruling R57 (Claude rows):** the owner may soft-delete or restore a Claude comment or mark, but never rewrite it. The owner's delete beats a concurrent Claude edit, and Claude's newer text is kept in the tombstone, so a restore brings it back.
- **Task 28:** `compareHlc` must agree with CL2's `compareStamps` on well-formed stamps (time, then hex counter, then device).
