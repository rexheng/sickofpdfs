# 05 — Hosted backend on the user's own free Cloudflare account

Research date: 2026-10-31. Builds on `03-platform-claude.md`, which covers the local side: SQLite-wasm + FTS5 on OPFS in the offscreen document, and PDF copies in OPFS. That file is not repeated here.

The backend gives the user three things:
1. **Backup.** Nothing is lost if Chrome resets or the extension is uninstalled.
2. **The library at a web address**, reachable from any computer.
3. **A remote MCP server** added to claude.ai as a custom connector. Claude can search the readings and notes, and can add comments that show up in the viewer's comment threads.

How to read the tags:
- **[V: source]** means verified this session against a primary source: a docs page (with its "last updated" date), an npm package's contents or metadata, or a measurement I ran.
- **[U]** means unverified: an inference or estimate, or something to test on the real account.

Nothing was deployed or created. The only Cloudflare tool I called was `whoami` (see §6.5).

---

## 0. Recommendations at a glance

| Area | Recommendation |
|---|---|
| Topology | **One Worker** (`sickofpdfs`) on `https://sickofpdfs.<subdomain>.workers.dev`. It serves the SPA as static assets, plus `/mcp`, `/api/*`, and the OAuth endpoints. Storage: D1 `sop_meta` (metadata, notes, sync), D1 `sop_text_0..n` (page text + FTS5, sharded to stay under the 500 MB free cap), R2 `sop-blobs` (PDFs), and KV `OAUTH_KV` (OAuth grants). |
| MCP stack | `agents` **0.32.0** `createMcpHandler` (stateless Streamable HTTP; `McpAgent` is deprecated) + `@modelcontextprotocol/server` **2.4.0** (the exact peer of agents 0.32.0) + `zod` **4.6.7** + `@cloudflare/workers-oauth-provider` **1.2.4**. Use `OAuthAuthorizationServer` and two `OAuthResourceServer`s (`/mcp`, `/api`) in the same Worker with a local validator. |
| claude.ai auth | OAuth with **CIMD enabled** ("Use Claude's published identity", the recommended option), plus a **restricted DCR** fallback. Callback `https://claude.ai/api/mcp/auth_callback`. Claude Code uses a loopback redirect on any port, which the library already accepts. |
| Login (single user) | **GitHub OAuth App, allowlisted to one numeric GitHub user ID.** It uses the library's documented `beginUpstream`/`finishUpstream` flow, and the user needs GitHub for the repo and CI anyway. Passkey is second choice; Cloudflare Access is third. |
| Data | Content-addressed: `doc.sha256` is the key everywhere, and R2 keys are `pdf/ab/<sha>.pdf`. Text extraction, thumbnails and classification are **client-side only**. The Worker never parses a PDF. |
| Sync | **Per-record revisions + last-write-wins (HLC) + tombstones + a global `seq` cursor.** No CRDT. Concurrent edits to a note body produce a *conflict-copy reply*, so nothing is silently lost. Claude's MCP writes are just another device (`device='claude'`). |
| Blob upload | Stream through the Worker: a single PUT with an R2 `sha256` integrity check for files ≤ 32 MiB, and **R2 multipart through the Worker** (32 MiB parts) for larger ones. This avoids presigned URLs, S3 keys and bucket CORS. |
| Extension auth | `chrome.identity.launchWebAuthFlow` against the same authorization server (PKCE public client, redirect `https://<ext-id>.chromiumapp.org/oauth`, resource `…/api`). Keep the refresh token in extension-origin IndexedDB. Fallback: device pairing from the web settings page. |
| Web library | The same React library UI and viewer, built as an SPA and served by Workers Static Assets with `run_worker_first` for the server routes. It is an online client: it reads and writes through `/api`. |
| Deploy | First deploy from the user's PC with `wrangler login`. After that, **GitHub Actions** runs `npx wrangler d1 migrations apply … --remote` and then `npx wrangler deploy`, with an account-owned token: **Workers Editor on this one Worker + D1 Edit** (+ Zone Workers Routes Write only for a custom domain). |
| Cost | Fits the free tiers, with three pinch points: **R2 10 GB-month** (the library is about 10 GB), **D1 500 MB per database** (so shard the text), and **D1 100k rows written/day** (so throttle the first full-text backfill over about 5–8 days). Workers Paid at **$5/month** removes all three. R2 above 10 GB costs **$0.015/GB-month**. |
| Privacy | Only `learning` documents ever enter the sync queue, and the server enforces this too. Text and notes sync whenever sync is on. **PDF upload is ON by default** (backup is goal #1), with a global and per-document "keep local" toggle. URLs are sanitized, and local paths are reduced to file names. No end-to-end encryption, because it would make server search and MCP impossible. |

---

## 1. Remote MCP on Cloudflare Workers

### 1.1 Current stack (versions as of 2026-10-31)

| Piece | Version / fact | Status |
|---|---|---|
| `agents` (Cloudflare Agents SDK) | **0.32.0** (published 2026-10-29). `createMcpHandler` is exported from `agents/mcp/server` | [V: npm registry; CF "MCP Server" handler-api doc, updated 2026-10-27] |
| `@modelcontextprotocol/server` (MCP TS SDK v2) | **2.4.0** (2026-10-23). It is an *optional peer* of `agents`, pinned **exactly**: agents 0.32.0 declares `"@modelcontextprotocol/server": "2.4.0"`. The CF doc's install line still says `@2.3.1`, and the doc itself says "Use the exact version required by your installed Agents release." | [V: npm peerDependencies; CF doc] |
| `@modelcontextprotocol/sdk` (SDK v1) | 1.32.2. Use it only for a temporary legacy lane, which we don't need | [V: npm] |
| `McpAgent` | **Deprecated** for new servers. Use `createMcpHandler` | [V: CF handler-api doc; agents-sdk skill] |
| Transport | **Streamable HTTP only.** "SSE … has been deprecated", and `createMcpHandler` serves Streamable HTTP only | [V: CF "Transport" doc, 2026-10-27] |
| Handler model | **Stateless**: a fresh `McpServer` per request, with no Durable Object, session or WebSocket. Pass the *factory*, not a server instance. `legacy: "stateless"` (the default) accepts older-protocol clients. In that lane GET/DELETE return 405 and there is no session id | [V: CF handler-api doc] |
| Origin checks | The wrapper rejects malformed, opaque and **non-HTTP Origins (403)**, so a `chrome-extension://` Origin would be rejected on `/mcp`. Defaults allow localhost and the endpoint's `workers.dev` host. A custom domain needs `allowedHostnames` / `allowedOriginHostnames` | [V: CF handler-api doc] |
| `@cloudflare/workers-oauth-provider` | **1.2.4** (2026-10-22). Split roles: `OAuthAuthorizationServer` + `OAuthResourceServer`. The combined `OAuthProvider` is "fully supported" for one Worker that is its *only* resource. Implements MCP authorization 2026-07-28, OAuth 2.1, RFC 7591/7636/8414/8707/9207/9728, and CIMD draft-00 | [V: package README + docs + d.ts] |
| Other | `hono` 4.13.14, `wrangler` 4.156.0, `zod` 4.6.7 (CF recommends zod ≥ 4.5.0 for memory) | [V: npm; CF Workers limits doc] |

**Why two resource servers in one Worker.**
- Claude requires the protected-resource `resource` to equal the MCP URL exactly, path included: `https://…/mcp` [V: claude.com connector auth doc].
- The library's path matching is path-boundary prefix matching, so a `…/mcp` audience does not cover `/api` [V: authorization-server.md].
- So the authorization server declares `resources: [".../mcp", ".../api"]`, and each route gets its own `OAuthResourceServer` with a **local** validator. That is the documented "Same Worker" pattern, and it needs no Service Binding [V: resource-servers.md].

**CPU check (Workers Free = 10 ms CPU per request).** I benchmarked locally on Node 22.22.0 with `agents` 0.32.0, `@modelcontextprotocol/server` 2.4.0 and zod 4.6.7, using the 8 tools of §11:
- Building the server costs **0.9 ms**.
- A stateless `tools/list` costs **~3 ms CPU**, and a `tools/call` **~2 ms CPU**.
- The legacy lane answered a `2025-11-25` `initialize` with 200.

This was measured in Node, not workerd, and excludes token validation and the D1 JSON work [V: measurement / U: workerd]. It fits under 10 ms with headroom, but not a lot.

### 1.2 What claude.ai custom connectors require today

Sources: claude.com/docs/connectors/building/authentication.md, …/building/index.md, …/custom/add-unlisted.md, and support article 11175166 (updated 2026-10-31). All rows **[V]** unless marked.

| Question | Answer |
|---|---|
| Auth types | `oauth_dcr` and `oauth_cimd` are supported by default; `none` (authless) is supported. `static_headers` is a limited beta, and `oauth_anthropic_creds` is for directory listings. |
| OAuth 2.1 + DCR mandatory? | **No.** Either DCR **or** CIMD works. The add dialog offers "Use Claude's published identity (**Recommended**)" (CIMD), "Register automatically" (DCR), or "Use your own OAuth client". Claude picks CIMD only if the authorization server metadata has `client_id_metadata_document_supported: true` **and** `"none"` in `token_endpoint_auth_methods_supported`. Our library advertises both when CIMD is enabled and the `global_fetch_strictly_public` flag is set ("none" is in its default list) [V: d.ts/js]. PKCE S256 is required on every request. |
| Spec versions | Claude follows the 2025-03-26, 2025-06-18 and 2025-11-25 authorization specs. |
| Discovery | Must answer **401** with `WWW-Authenticate: Bearer resource_metadata="…"`; Claude ignores it on a 200. Claude uses only the **first** `authorization_servers` entry. Endpoints have a 10 s limit (30 s for refresh). `/token` must accept `application/x-www-form-urlencoded`. `OAuthResourceServer` produces exactly this 401 [V: resource-servers.md]. |
| Callback URL | **`https://claude.ai/api/mcp/auth_callback`** for web, Desktop, mobile and Cowork. **Claude Code** uses a loopback redirect `http://localhost:<port>/callback` / `http://127.0.0.1:<port>/callback` from its own CIMD (`https://claude.ai/oauth/claude-code-client-metadata`), so the port must be ignored. The library allows any port for `localhost`, `127.0.0.0/8` and `::1` [V: oauth-provider.js "RFC 8252 loopback support … any port"]. |
| Refresh | Claude refreshes proactively (up to 5 min before expiry) and on 401. Refresh tokens must rotate for public clients, which the library does [V: authorization-server.md]. Claude appends `offline_access` if the authorization server lists it, so **list `offline_access`**. |
| Network | Calls come from Anthropic's cloud (`160.79.104.0/21`), on **every** surface including mobile. localhost is unreachable. |
| Plans | **Free, Pro, Max, Ultra, Team, Enterprise.** **Free = one custom connector.** On Team/Enterprise only Owners add them. |
| Surfaces | claude.ai web, Desktop, mobile, Cowork and Claude Code share the same connector infrastructure. You add the connector in **Customize → Connectors** (web/Desktop) and enable it per chat via **+ → Connectors**. Whether it can be *added* from the mobile app is [U]; *using* it on mobile is [V]. |
| Limits | claude.ai/Desktop: tool result **~150,000 characters**, **240 s** per tool call. Claude Code: **25,000 tokens** (set by `MAX_MCP_OUTPUT_TOKENS`). Unsupported in Claude: resource subscriptions and sampling. |
| Editing | Auth settings can't be edited later; you remove and re-add the connector. |

**Claude Code** can use the same server, in two ways [V: code.claude.com/docs/en/mcp.md]:
- **Automatically**: claude.ai connectors appear in `/mcp` when Claude Code is logged in with a claude.ai subscription. They do not appear when `ANTHROPIC_API_KEY` or similar is set.
- **Explicitly**: `claude mcp add --transport http sickofpdfs https://sickofpdfs.<sub>.workers.dev/mcp`, then `/mcp` or `claude mcp login sickofpdfs`.

A locally added server takes precedence over a claude.ai connector with the same URL. Keep tool outputs paginated so they stay under 25k tokens.

### 1.3 Single-user login: options and recommendation

The authorization server must sign the user in *before* `completeAuthorization()`. The library is "not an identity provider" [V].

| Option | How | Pros | Cons |
|---|---|---|---|
| **GitHub OAuth App, allowlisted by numeric user ID (recommended)** | The `/authorize` consent page → `beginUpstream()` → GitHub → `/oauth/github/callback` → `finishUpstream()`. Reject unless `user.id === ALLOWED_GITHUB_ID`. Request **no** GitHub scopes (only `GET /user` is needed) and don't store the GitHub token in `props`. | The documented flow, with an example in CF's "Securing MCP" doc. It handles confused-deputy, unforgeable consent and browser-bound `state` [V]. No passwords are stored, and GitHub has 2FA and passkeys. The user needs GitHub for CI anyway. Works on any computer. | One more dashboard (GitHub → Developer settings → OAuth Apps). If the GitHub account is lost, recovery is to change the secret. Use the numeric **id**, not the login, because logins can be renamed and re-registered [U: standard advice]. Whether a GitHub token with no scopes can call `/user` is [U]. |
| Passkey (WebAuthn in the Worker) | Register one passkey through a one-time setup code (a Worker secret), then verify assertions on `/login`. | No third party. Passkeys sync through Google Password Manager on Chrome. | You own security-critical WebAuthn code (registration, counters, recovery). On a new computer without the synced passkey you need a phone QR flow. More code than GitHub. |
| Cloudflare Access | Access for SaaS (OIDC) as the upstream identity provider for our authorization server (CF demo `remote-mcp-cf-access`), with a one-time PIN or Google login and a policy of "email = me". | Zero login code, and one-time-PIN email login. | Requires creating a Zero Trust org plus dashboard configuration. Whether that needs a payment method is [U]. **Don't** put a plain Access app in front of `/mcp` or `/api`: Claude's servers can't complete an Access login. Access "Managed OAuth" for MCP exists, but its fit with claude.ai CIMD/DCR is [U]. |

**Recommendation:** use GitHub. Add a defense-in-depth check that `ctx.props.uid === env.ALLOWED_GITHUB_ID` in every `/mcp` and `/api` handler, so a misconfiguration can't open the data to a second account.

---

## 2. Data model on Cloudflare

### 2.1 D1: metadata, annotations and page text

| Fact | Value | Status |
|---|---|---|
| FTS5 | **Supported**, including `fts5vocab`, plus JSON1 and math functions | [V: D1 "SQL statements" doc] |
| Virtual tables and export | `wrangler d1 export` **does not support DBs that contain virtual tables**. Workaround: drop them, export, recreate | [V: D1 import/export doc] |
| Max DB size | **500 MB (Free)** / 10 GB (Paid). The 10 GB cap can't be raised | [V: D1 limits, 2026-10-30] |
| Account storage | **5 GB (Free)**, **10 DBs (Free)** | [V] |
| Queries per Worker invocation | **50 (Free)** / 1,000. A `batch()` counts as **one** | [V] |
| Row / statement / params | 2 MB row; 100 KB SQL statement; **100 bound params per query**; 50 MB result (from 2026-11-04) | [V] |
| Batch semantics | `batch()` is **one SQL transaction**; a failure rolls back the whole sequence | [V: D1 Worker API doc] |
| Free quotas | **5M rows read/day**, **100k rows written/day**, 5 GB storage. Since **2026-09-01**, queries **fail** after the daily limit until 00:00 UTC (email alert). Data is unaffected | [V: D1 pricing 2026-10-30; changelog 2026-09-01] |
| Time Travel | **7 days (Free)** / 30 days (Paid) point-in-time restore | [V] |
| Concurrency | Single-threaded per DB (backed by one Durable Object). Use `batch()` to cut round trips | [V] |
| Encryption | AES-256-GCM at rest, TLS in transit | [V: D1 data-security doc] |

**Sizing for about 2,000 PDFs (10 GB) [U: estimate].**
- Estimated raw page text is about **300–500 MB**: roughly 1,200 papers × 70 KB, 600 slide decks × 25 KB, 200 textbooks × 1.5 MB.
- An FTS5 index with positions adds very roughly 30–50%, so the total is about **0.45–0.75 GB**.
- That **does not fit one free 500 MB DB.**
- **Measure instead of guessing.** The extension already builds the same FTS5 schema locally (03 §4). `PRAGMA page_count * page_size` on the local DB predicts D1 size closely.

**Design: shard the text, keep metadata in one DB.**
- `sop_meta` (binding `META`) holds docs, sources, folders, annotations, notes FTS, sync and auth tables. It is small, tens of MB.
- `sop_text_0`, `sop_text_1` (bindings `TEXT_0`, `TEXT_1`, more later; Free allows up to 9 shards plus meta, and 5 GB total) hold `page` + `page_fts`.
- A doc's shard is **recorded in `doc.text_shard`** when its text is first uploaded. New docs go to the emptiest shard (D1 results report `meta.size_after` [V: D1 pricing doc example]).
- Adding a shard never rehashes, and a doc never moves.
- Search fans out to all shards in parallel (at most 6 simultaneous connections, well under 50 queries) and merges by `bm25`. BM25 is shard-local, so merged scores are approximate; with hash-like placement that is fine [U].

**Rows-written budget.**
- 2,000 PDFs at about 75 pages each is about **150k page rows**.
- FTS5 writes shadow-table rows (`_docsize`, `_data`/`_idx` segments, and merges). How D1 counts those toward `rows_written` is **[U]**.
- Estimate about 3–5 written rows per page, so **0.5–0.75M rows** for the first backfill. At 100k/day that is **5–8 days**.
- Mitigations:
  - Page rowid = `docnum*100000 + n`, with no extra UNIQUE index (saves 1 row per page).
  - The server meters `meta.rows_written` for text uploads and returns **429 + Retry-After until 00:00 UTC** at about 85k/day, so metadata and notes keep working.
  - The client queues text by priority: recently opened docs first.
  - Optional: one month of Workers Paid ($5) finishes the backfill in hours.
- Measure on the first 50-page upload and adapt.

### 2.2 R2: PDF blobs

| Fact | Value | Status |
|---|---|---|
| Free tier (Standard class only) | **10 GB-month storage, 1M Class A, 10M Class B per month**, egress free. Usage rounds up to the next unit | [V: R2 pricing, 2026-10-30] |
| Paid rates | $0.015/GB-month; Class A $4.50/M; Class B $0.36/M. DeleteObject is free | [V] |
| Enabling R2 | "You need a Cloudflare account with an R2 subscription … Complete the checkout flow" | [V: R2 get-started]. Whether a payment method is required is [U, commonly yes] |
| Upload limits | 5 GiB single PUT; multipart parts must be uniform (≥ 5 MiB except the last), max 10,000 parts. **A Worker's inbound body is capped by the zone plan: 100 MB on Free** (413 above). Each multipart *part* through a Worker is subject to that cap | [V: R2 limits; Workers limits; R2 multipart doc] |
| Integrity | `put(key, body, { sha256 })` makes R2 verify the hash and reject a mismatch. `R2MultipartOptions` has **no** per-part checksum in the Workers API | [V: R2 Workers API reference] |
| Ranged reads | `get(key, { range })` / Range headers | [V] |
| Presigned URLs | Need an **R2 API token** (S3 access key and secret) as Worker secrets, signed with `aws4fetch`. They only work on `<account>.r2.cloudflarestorage.com` and need **bucket CORS** for browser use. POST form uploads are unsupported | [V: R2 presigned-URLs doc, 2026-10-26] |
| Encryption | AES-256-GCM at rest. Optional SSE-C (`ssecKey`) | [V: R2 data-security doc; API reference] |

**Recommendation: stream through the Worker, without presigned URLs.**
- **≤ 32 MiB:** `PUT /api/blobs/:sha` → `env.BLOBS.put("pdf/ab/<sha>.pdf", request.body, { sha256: sha, httpMetadata: { contentType: "application/pdf" } })`. R2 enforces the hash, so a corrupt upload can't occupy a content-addressed key. Whether a `request.body` stream needs a Content-Length is [U]; the extension sends one.
- **> 32 MiB (e.g. 50–300 MB):** `POST …/multipart` → `createMultipartUpload`. Then `PUT …/multipart/:id/:n` with 32 MiB parts → `uploadPart(n, request.body)`. Then `POST …/complete`.
  - Integrity of the whole object isn't verified server-side, because hashing 300 MB on a 10 ms CPU budget is impossible.
  - Instead, check `object.size`, and re-hash on the client whenever the blob is downloaded. Comparing part ETags to MD5 is [U].
  - Uncompleted uploads auto-abort after 7 days [V].
- Why: no S3 credentials to bootstrap, no bucket CORS, one auth path, and the 100 MB cap never matters. Streaming bytes through the Worker is I/O, not JS CPU [U: likely; verify with Workers Logs CPU time].
- **Dedup is free:** `HEAD` first; if the key exists, the upload is skipped (content-addressed).
- Also store a first-page thumbnail at `thumb/<sha>.webp` (rendered client-side) for the web grid.

### 2.3 The Worker never parses PDFs

| Limit | Free | Paid | Status |
|---|---|---|---|
| CPU per HTTP request | **10 ms** | 30 s default, up to 5 min | [V: Workers limits, 2026-10-29] |
| Memory per isolate | **128 MB** (heap + wasm) | 128 MB | [V] |
| Requests | 100k/day | 10M/month included | [V] |
| Subrequests | 50 per request (1,000 to internal services) | 10,000 | [V] |

- PDFium-wasm on a 50–300 MB PDF needs hundreds of MB of wasm memory and seconds of CPU. That is impossible at 128 MB / 10 ms, and impossible at 128 MB even on Paid.
- So **all extraction happens client-side**: page text via EmbedPDF/PDFium (or pdf.js `getTextContent`), the classifier, thumbnails, and the quote → quads anchoring of Claude comments.
- The Worker only moves bytes and rows.
- JSON-parsing a 1.8 MB page-text payload costs about 1 ms [V: Node measurement], but chunk text uploads to about 256 KB (about 50 pages) anyway, to keep D1 batches and retries small.

---

## 3. Sync protocol (one user, a few devices, local-first)

### 3.1 Choice: per-record LWW + revisions + tombstones (no CRDT)

| | LWW records + HLC + tombstones | CRDT (Yjs / Automerge) |
|---|---|---|
| Data shape | Annotations are small discrete records. Docs and folders are metadata | Shines for long, concurrently edited text |
| Concurrency reality | One person. Same-note edits on two offline devices are rare | Overkill |
| Server search / MCP | Plain columns, so FTS5 and SQL work directly, and Claude writes are an INSERT | The server must decode CRDT state to search it or to apply Claude's writes |
| Storage | One row per record | Binary update logs per note in D1, plus compaction |
| Correctness risk | Low if every write carries `base_rev`, and losers are kept as conflict copies | Library and encoding complexity across extension, web and Worker |

**Verdict:** use LWW with optimistic concurrency, and keep losers as conflict copies. It is the simplest *correct* option, because no edit is silently discarded.

### 3.2 Mechanics

- **Every synced row has** `rev` (server revision), `hlc` (hybrid logical clock string), `seq` (a global change number, assigned by the server), `device`, and `deleted` (tombstone).
- **IDs:**
  - Docs: `sha256`.
  - Sources: `sha256(sha|kind|value)`, so every device computes the same id.
  - Annotations and folders: UUIDv7/ULID created by the writer. MCP writes get theirs from the Worker.
- **Push** (`POST /api/sync/push`). Each record carries `base_rev`: the `rev` the device last saw, or 0 if new. Server steps:
  1. **One D1 `batch()` (one transaction).** For each record: `INSERT … ON CONFLICT(id) DO UPDATE SET … , rev = rev + 1, seq = <counter>+i WHERE annotation.rev = ?base_rev`. Then one `UPDATE sync_counter SET seq = seq + N`, then one `SELECT id, rev, seq … WHERE id IN (SELECT value FROM json_each(?))`. The json_each form avoids the 100-parameter limit.
     - Because the batch is atomic and D1 is single-threaded per DB, readers never see a `seq` committed out of order. Gaps from skipped updates are harmless.
  2. Rows whose `rev` didn't advance are **conflicts** (rare). The Worker loads the server row and compares HLCs:
     - The newer HLC wins the record.
     - If `body` differs and both versions are non-empty, the *loser's* body is inserted as a **conflict-copy reply** in the same thread (`kind='reply'`, `conflict_of=<id>`, rendered as "Edited on two devices — other version").
     - A delete that wins over an edit makes no copy. The tombstone keeps the last body, so "Recently deleted" can restore it.
  3. The response is `{applied:[{id,rev,seq}], rebased:[<full server rows>], need_blobs:[sha…], need_text:[sha…]}`. The client overwrites its local copies with the `rebased` rows.
- **Field rules on the server.**
  - `author` is immutable.
  - User devices may delete or resolve Claude-authored annotations, but not rewrite them. Claude may edit only `author='claude'` rows.
  - `doc_source.last_seen` merges as `max()`.
  - Docs must have `classified_as='learning'`, or the push is rejected.
- **Pull** (`GET /api/sync/pull?since=<seq>&limit=500`).
  - For each table: `WHERE seq > ?since ORDER BY seq LIMIT ?limit`, on indexed `seq`, so rows read equals rows returned.
  - `cursor` = the smallest last-seq among tables that hit the limit, otherwise `head`. Rows above the cursor are dropped and come next page.
  - A new device starts at `since=0`. About 2,000 docs plus about 20k annotations is about 50 pages.
- **Tombstones are kept indefinitely.** They are tiny, so there is no "cursor too old" path. The only hard deletes are:
  - the **trash purge** (30 days after `trashed_at`), and
  - an explicit **"Remove from cloud"** action. This deletes the R2 blob, the text-shard rows, the annotations and the sources, and blanks the doc row to a sha-only tombstone, so other devices learn it is gone.
- **When devices sync:**
  - The extension pulls on startup, on window focus, when a viewer opens a doc, and on a `chrome.alarms` tick every 5 min. The alarms minimum period is 30 s [U].
  - While a viewer tab is visible, it polls `GET /api/sync/head` (1 row read) every 30 s and pulls when `head` moved.
  - That is at most about 3k requests/day per device, against 100k/day.
- **Blobs and page text are not in the change feed.** They are immutable and content-addressed. The doc row's `blob_state` / `text_state` changes carry the signal, and devices fetch blobs on demand ("Open" or "Make available offline").
- **Where the engine runs:** in the extension's offscreen document. It already owns SQLite (03 §4), and the offscreen document avoids the service worker's 30 s fetch limit for big uploads.

### 3.3 How Claude's comments reach the viewer

1. Claude calls `add_comment({doc, page, quote, body, request_id})` over `/mcp`.
2. The Worker checks the scope `library:comment`. It is idempotent on `request_id` (a UNIQUE `mcp_request_id`). It INSERTs an `annotation` (`author='claude'`, `device='claude'`, anchor `{quote:{exact,prefix,suffix}}`, no quads) with a new `seq`, and writes an `audit` row.
3. The extension's next pull (within about 30 s if the doc is open, otherwise at focus or alarm) brings it into local SQLite.
4. The viewer resolves `quote` to quads with PDFium text search on that page and **caches the quads locally only**.
   - They are never pushed back, so Claude's later edits can't conflict with geometry.
   - If the quote isn't found, the comment shows as a page-level note.
5. The thread UI shows a "Claude" badge plus an "Undo Claude's comments from this session" bulk action (tombstones by `audit` batch).
6. The hosted web viewer gets the same rows through `/api` and resolves the anchor the same way.

### 3.4 Conflict cases

| Case | Result |
|---|---|
| Same note body edited offline on laptop A and desktop B | The first push applies (rev 5→6). The second push has `base_rev=5` → conflict. The newer HLC wins, and the other body becomes a conflict-copy reply. Both devices converge after their next pull. |
| A changes color, B edits body | Record-level LWW: the newer write wins *all* fields, and the body difference creates a copy. Color loss is acceptable. Per-field LWW is possible later. |
| A deletes, B edits (offline) | Newer HLC wins. If the delete wins, the tombstone keeps B's last body for restore. If the edit wins, the note is resurrected. |
| Claude replies to a thread the user deleted offline | The reply is attached to a tombstoned root. The client shows it as a standalone page note. MCP `add_comment` returns an error if the root is already deleted on the server. |
| Device clock skew | HLC = max(local wall clock, last seen HLC)+1. The server clamps HLCs more than 5 min in the future to server time [U: policy]. |
| Two devices upload the same PDF | Same sha256 → same key. The second sees `HEAD 200` and skips. |
| Doc re-extracted with a newer extractor | `PUT /api/text/:sha?extractor=…` deletes the doc's page rowid range in its shard and reinserts. Search may be briefly partial. |

### 3.5 Endpoints

Auth for each:
- **MCP** = an OAuth bearer for resource `…/mcp`.
- **API-B** = an OAuth bearer for resource `…/api`, scope `sync` (the extension).
- **API-C** = the `__Host-sess` cookie plus a CSRF check: `Sec-Fetch-Site: same-origin` and an `X-SOP: 1` header (the web SPA).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /.well-known/oauth-authorization-server` | none | Authorization server metadata (library) |
| `GET /.well-known/oauth-protected-resource/mcp` · `…/api` | none | RFC 9728 resource metadata (library) |
| `GET,POST /authorize` | GitHub sign-in | Consent page → GitHub (`beginConsent` / `approveConsent` / `beginUpstream`) |
| `GET /oauth/github/callback` | state cookie | `finishUpstream`, ID allowlist, `completeAuthorization`; also completes web login |
| `POST /oauth/token`, `POST /oauth/register` | client | Token and refresh (library). DCR is restricted by `clientRegistrationCallback` (§4) |
| `GET /login`, `POST /logout` | — | Web session (own PKCE + state cookie → GitHub) |
| `POST /mcp` | MCP | Streamable HTTP, stateless. GET returns 405 |
| `GET /api/me` | API-B/C | User, devices, quota usage (R2 GB, D1 MB per shard, rows written today) |
| `POST /api/devices` | API-B/C | Register a device `{name, kind}` → `device_id` |
| `GET /api/sync/head` | API-B/C | `{seq}` |
| `GET /api/sync/pull?since&limit` | API-B/C | Change feed (docs, sources, folders, annotations) |
| `POST /api/sync/push` | API-B/C | Batch of ≤ 200 records `{table,id,base_rev,hlc,fields}` |
| `PUT /api/text/:sha?from&to&extractor` | API-B/C | ≤ 256 KB of `{pages:[{n,text}]}`. Idempotent. 429 + Retry-After when the daily write budget is hit |
| `GET /api/text/:sha?pages=a-b` | API-B/C | Page text for the web viewer's search highlights |
| `HEAD /api/blobs/:sha` | API-B/C | Exists? |
| `PUT /api/blobs/:sha` | API-B/C | ≤ 32 MiB upload, R2 `sha256`-verified |
| `POST /api/blobs/:sha/multipart` → `PUT …/:uploadId/:part` → `POST …/:uploadId/complete` / `DELETE …/:uploadId` | API-B/C | Large uploads in 32 MiB parts |
| `GET /api/blobs/:sha` | API-B/C | Stream with Range support (206). `Cache-Control: private, max-age=31536000, immutable`; `ETag: "<sha>"` |
| `GET,PUT /api/thumbs/:sha` | API-B/C | Grid thumbnails |
| `GET /api/search?q&scope&doc&limit` | API-B/C | Same engine as MCP `search_library` |
| `GET /api/activity?days` | API-B/C | Recent opens, adds, notes, Claude comments |
| `GET /api/grants` · `DELETE /api/grants/:id` | API-C | List and revoke Claude and extension connections (`listUserGrants`, `revokeGrant` [V: d.ts]) |
| `POST /api/admin/purge/:sha` | API-C | "Remove from cloud" (hard delete) |
| cron `17 3 * * *` | — | Purge trash older than 30 days, abort stale multipart uploads, prune `audit` older than 180 days |

---

## 4. Auth between the extension and the Worker

| | `launchWebAuthFlow` + the same authorization server (**recommended**) | Device token from the web settings page (fallback) |
|---|---|---|
| Flow | 1. Options page: the user enters the server URL. 2. Fetch `/.well-known/oauth-authorization-server`. 3. Register once through DCR with `redirect_uris:[chrome.identity.getRedirectURL("oauth")]` (`https://<ext-id>.chromiumapp.org/oauth` [V: Chrome identity API, 2026-10-29]), `token_endpoint_auth_method:"none"`. 4. `launchWebAuthFlow({url: /authorize?…&code_challenge=S256…&scope=sync offline_access&resource=…/api, interactive:true})` → GitHub sign-in and consent → code → `POST /oauth/token`. | The user signs in on the web, clicks "Pair this browser's extension", and the Worker mints a random 32-byte token (stored as a SHA-256 in D1). The page hands it to the extension with `chrome.runtime.sendMessage(EXT_ID, …)` (manifest `externally_connectable` on the Worker host). |
| Token life | Access token 1 h (library default [V: d.ts]). Rotating refresh token with `refreshTokenIdleTTL` set to 30 days (sliding) [V: option exists]. | Long-lived until revoked. |
| Pros | One auth system for Claude and the extension. Consent shows the `chromiumapp.org` host and extension ID. Revocation through grants. | Fewer moving parts. No DCR or refresh logic. |
| Cons | Needs a stable extension ID (manifest `"key"`, already required by 03 §6). Whether the auth window shares the profile's GitHub cookies is [U]. | A long-lived bearer, and a second token type for the server to validate. |

**Hardening DCR.** Use the documented `clientRegistrationCallback` [V: d.ts]. Allow a registration only if every `redirect_uri` is one of:
- `https://<EXTENSION_ID>.chromiumapp.org/oauth`
- `https://claude.ai/api/mcp/auth_callback`
- a loopback `http://localhost|127.0.0.1/…` (Claude Code fallback)

Return 403 otherwise. Claude normally uses CIMD and Claude Code always does, so DCR is only a fallback.

**CORS from `chrome-extension://`.**
- Extension pages and the service worker with host permissions are **not** subject to CORS. Content scripts always are [V: Chrome "Cross-origin network requests"].
- Our manifest already has `<all_urls>`; also list `https://sickofpdfs.<sub>.workers.dev/*` explicitly.
- `/api` should still validate `Origin`. Allow `chrome-extension://<EXTENSION_ID>` and the Worker's own origin. Reject other Origins on cookie-authenticated requests (CSRF). Bearer requests don't need CORS headers.
- **Never call `/mcp` from the extension**: `createMcpHandler` rejects non-HTTP Origins with 403 [V].
- All extension network calls happen in extension pages or the offscreen document, never in content scripts.

**Token storage.**
- The refresh token and DCR `client_id` go in **extension-origin IndexedDB**, which content scripts can't reach because they run in the page's origin [U: standard origin model, as 03 §5a]. Alternatively use `chrome.storage.local` after `setAccessLevel({accessLevel:"TRUSTED_CONTEXTS"})` (03 [V]).
- The access token lives in the offscreen document's memory, or in `chrome.storage.session` (not exposed to content scripts by default).
- **Refresh single-flight** in the offscreen document, so two contexts never race a rotating refresh token. The library also keeps the previous refresh token valid until its replacement is first used [V: authorization-server.md], which makes retries safe.
- Settings shows "Connected as @login · Disconnect", which revokes the grant.

---

## 5. The hosted web library (same Worker)

- **Static assets.** Set `assets.directory`, `not_found_handling: "single-page-application"` and `binding: "ASSETS"`.
  - Asset requests are **free and unlimited**, and storage is free [V: static-assets billing].
  - Limits: 25 MiB per file, 20,000 files per version on Free [V].
- **Gotcha: OAuth callbacks are navigations.** With SPA mode and a compatibility date of 2025-04-01 or later, navigation requests are served `index.html` **without running the Worker** [V: SPA routing doc, 2026-10-12]. So list every server route in `run_worker_first`: `/mcp`, `/api/*`, `/authorize`, `/oauth/*`, `/login`, `/logout`, `/.well-known/*`. This needs Wrangler ≥ 4.20 [V].
- **`_headers` applies to assets only**, not to Worker responses [V: static-assets headers doc]. Set CSP in `_headers` for the SPA: `script-src 'self' 'wasm-unsafe-eval'; frame-ancestors 'none'; object-src 'none'`. Set headers in code for Worker routes.
- **The SPA shell is public. That's fine.** It contains no data, and every data route is authenticated.

**Can the hosted page open saved PDFs from R2 in the same viewer component?** Yes. The viewer takes a `Blob`/URL source and a storage interface, so the same component runs in the extension and on the web. Gotchas:

1. **Abstract storage.** Use `LibraryRepo` with `LocalRepo` (extension: offscreen SQLite + OPFS + sync engine) and `RemoteRepo` (web: `fetch('/api/…')`, online-only). The viewer and library UI must never import `chrome.*`.
2. **Bundle the wasm with the SPA.** Serve PDFium wasm (EmbedPDF) and the pdf.js wasm and workers from static assets, and point `wasmUrl` at them; don't use a CDN. That mirrors the extension rule (03 §6 [V]). Each file must be ≤ 25 MiB.
3. **Fetch the PDF same-origin from `/api/blobs/:sha`.** The session cookie authenticates it, so tokens never go in URLs. Range support lets pdf.js stream. EmbedPDF's loader probably reads the whole file into wasm memory [U], so a **300 MB PDF on the web means a large download and wasm heap**. Show progress and offer "Download" as a fallback, especially on phones.
4. **Caching.** Blobs are immutable: use `Cache-Control: private, max-age=31536000, immutable`. Never use the shared CDN cache. Optionally keep opened PDFs in the browser's Cache Storage on that computer.
5. **Annotation writes on the web** go straight to `/api/sync/push` as device `web-<id>`. Show a "Saving… / Offline — not saved" state; the web is not local-first.
6. **Search on the web** uses server FTS (`/api/search`); the extension keeps local FTS.
7. **PDFs uploaded through the web** (drag-drop on a lab computer) run the same client pipeline in the page (hash → classify → extract text → thumbnail → upload). Only `learning` PDFs are accepted.
8. **Deep links:** `https://…/d/<sha>?page=12#a=<annotation-id>`. MCP results include them, so a click from claude.ai opens the hosted viewer at the right spot. The extension can optionally DNR-redirect these URLs to its local viewer [U].

---

## 6. Deployment for a non-expert user

### 6.1 `wrangler.jsonc` (server)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "sickofpdfs",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-31",
  "compatibility_flags": ["nodejs_compat", "global_fetch_strictly_public"], // CIMD needs the second flag [V]
  "workers_dev": true,
  "preview_urls": false,                       // [U] avoid extra public hostnames for this app
  "observability": { "enabled": true },
  "assets": {
    "directory": "./public",                   // built by apps/web
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/mcp", "/api/*", "/authorize", "/oauth/*", "/login", "/logout", "/.well-known/*"]
  },
  "vars": {
    "PUBLIC_URL": "https://sickofpdfs.<subdomain>.workers.dev",   // = OAuth issuer; no trailing slash
    "EXTENSION_ID": "<32-char id from manifest key>"
  },
  "d1_databases": [
    { "binding": "META",   "database_name": "sop_meta",   "database_id": "<id>", "migrations_dir": "migrations/meta" },
    { "binding": "TEXT_0", "database_name": "sop_text_0", "database_id": "<id>", "migrations_dir": "migrations/text" },
    { "binding": "TEXT_1", "database_name": "sop_text_1", "database_id": "<id>", "migrations_dir": "migrations/text" }
  ],
  "r2_buckets":    [{ "binding": "BLOBS", "bucket_name": "sop-blobs" }],
  "kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<id>" }],          // name required by the library [V]
  "ratelimits": [                                                      // period must be 10 or 60 [V]
    { "name": "RL_AUTH", "namespace_id": "1001", "simple": { "limit": 20,  "period": 60 } },
    { "name": "RL_MCP",  "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_API",  "namespace_id": "1003", "simple": { "limit": 600, "period": 60 } }
  ],
  "triggers": { "crons": ["17 3 * * *"] }
}
// Secrets (wrangler secret put): GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ALLOWED_GITHUB_ID, SESSION_SECRET
```

Wrangler ≥ 4.45 can **auto-provision** D1, KV and R2 for bindings that have no IDs, and writes the IDs back to the file [V: CF changelog 2025-10-24; Wrangler configuration doc]. That simplifies the first deploy.

### 6.2 Worker composition sketch (TypeScript, option names verified against 1.2.4 types)

```ts
// apps/server/src/index.ts
import { Hono } from "hono";
import { OAuthAuthorizationServer, OAuthResourceServer, insufficientScope } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { createLibraryServer } from "./mcp";          // factory: new McpServer(...) + registerTool(...) per §11
import { api } from "./api";                          // Hono sub-app for /api/*
import { authorize, githubCallback, webLogin, logout, sessionFrom } from "./auth";

const O = env.PUBLIC_URL;
export const as = new OAuthAuthorizationServer<Env>({
  issuer: O,
  resources: [`${O}/mcp`, `${O}/api`],
  scopesSupported: ["library:read", "library:comment", "sync", "offline_access"],
  clientIdMetadataDocumentEnabled: true,               // claude.ai "published identity" + Claude Code
  clientRegistrationEndpoint: "/oauth/register",       // DCR fallback, restricted:
  clientRegistrationCallback: ({ clientMetadata }) => allowedRedirects(clientMetadata) ? undefined
      : { code: "invalid_redirect_uri", description: "not allowed", status: 403 }, // [U] exact result field names
  refreshTokenIdleTTL: 60 * 60 * 24 * 30,
});
const local = (e: Env) => (resource: string, token: string) => as.validateToken(resource, token, e);
const mcpHandler = createMcpHandler(createLibraryServer, { route: "/mcp" });

const mcpRs = new OAuthResourceServer<Env, Props>({
  resourceMetadata: { resource: `${O}/mcp`, authorization_servers: [O] },
  requiredScopes: ["library:read", "library:comment"],  // advertised; enforced below [V: "advertised, not enforced"]
  validateToken: local,
  handler: { async fetch(req, e, ctx) {
    if (ctx.props.uid !== e.ALLOWED_GITHUB_ID) return new Response("forbidden", { status: 403 });
    if (!(await e.RL_MCP.limit({ key: ctx.auth.clientId ?? "mcp" })).success) return new Response("rate limited", { status: 429 });
    if (!ctx.auth.scope.includes("library:read")) return insufficientScope(ctx.auth, ["library:read"]);
    return mcpHandler(req, e, ctx);                    // tools read ctx.props/scopes via getMcpAuthContext()
  } },
});
const apiRs = new OAuthResourceServer<Env, Props>({
  resourceMetadata: { resource: `${O}/api`, authorization_servers: [O] },
  requiredScopes: ["sync"], validateToken: local,
  handler: { fetch: (req, e, ctx) => api.fetch(req, e, ctx) },
});

const app = new Hono<{ Bindings: Env }>();
app.all("/.well-known/oauth-protected-resource/mcp", c => mcpRs.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/.well-known/oauth-protected-resource/api", c => apiRs.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/mcp", c => mcpRs.fetch(c.req.raw, c.env, c.executionCtx));
app.all("/api/*", async c => (await sessionFrom(c)) ? api.fetch(c.req.raw, c.env, c.executionCtx)  // cookie (web)
                                                     : apiRs.fetch(c.req.raw, c.env, c.executionCtx)); // bearer (extension)
app.on(["GET", "POST"], "/authorize", authorize);        // describeConsent/beginConsent/approveConsent/beginUpstream
app.get("/oauth/github/callback", githubCallback);       // finishUpstream → id allowlist → completeAuthorization
app.get("/login", webLogin); app.post("/logout", logout);
app.all("*", c => as.fetch(c.req.raw, c.env, c.executionCtx)); // AS metadata, /oauth/token, /oauth/register
export default app;
```

### 6.3 GitHub Actions workflow skeleton

Latest tags are `actions/checkout` **v7.0.1**, `actions/setup-node` **v7.1.0** and `cloudflare/wrangler-action` **v4.1.3** [V: `git ls-remote --tags`]. The CF doc example still shows `checkout@v6` and `wrangler-action@v4` [V: CF GitHub Actions doc, 2026-10-18]. The workflow calls `npx wrangler` directly, with wrangler pinned in `package.json`. Wrangler reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` [V: same doc]. `wrangler-action@v4` works too.

```yaml
# .github/workflows/deploy-server.yml
name: Deploy server
on:
  push:
    branches: [main]
    paths: ["apps/server/**", "apps/web/**", "packages/**", "package-lock.json", ".github/workflows/deploy-server.yml"]
  workflow_dispatch: {}
permissions:
  contents: read
concurrency:
  group: deploy-server
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: production            # optional: add a required reviewer in repo settings
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with: { node-version: 24, cache: npm }
      - run: npm ci
      - run: npm run typecheck && npm test
      - run: npm run build -w apps/web              # emits SPA + viewer + wasm into apps/server/public
      - name: Apply D1 migrations (additive, backward-compatible only)
        working-directory: apps/server
        run: |
          npx wrangler d1 migrations apply sop_meta --remote
          for db in sop_text_0 sop_text_1; do npx wrangler d1 migrations apply "$db" --remote; done
      - name: Deploy Worker + static assets
        working-directory: apps/server
        run: npx wrangler deploy
```

- In CI, `migrations apply` skips the confirmation prompt, takes a backup, and rolls back a failing migration [V: wrangler d1 commands doc].
- Run migrations **before** deploy, and write them so the old code still works (add columns and tables; never rename or drop in the same release).

**Minimal API token (account-owned, Account API tokens → Create → Custom)** [V: CF "Workers roles and permissions", 2026-09-15]:

| Permission | Why | Notes |
|---|---|---|
| **Workers → Editor**, scoped to *Individual Worker* `sickofpdfs` | `wrangler deploy` of an existing Worker, versions, secrets | Creating a *new* Worker needs product-level **Admin**, so do the first deploy locally with `wrangler login`. Legacy equivalent: "Workers Scripts Edit". |
| **D1 → Edit** | `d1 migrations apply --remote` touches the DB directly | "Permissions on bound resources are only required if you need to access those resources directly." Whether D1 can be scoped per database is [U]. |
| *(only with a custom domain)* **Zone → Workers Routes → Write** on that zone | Changing routes or custom domains during deploy | Not needed once configured, if deploys don't change it [V]. |
| Not needed | R2, KV, Account Settings | Deploying with bindings needs only Editor on the Worker [V]. If wrangler errors on account lookup, add *Account Settings Read* [U]. |

Avoid the "Edit Cloudflare Workers" template for CI; it is broader. Save `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **repo secrets**.

**Simpler alternative: Workers Builds** (Cloudflare's own Git integration, which "Deploy to Cloudflare" buttons set up). It needs no API token or repo secrets, and the free plan includes 3,000 build minutes/month [V: Workers Builds limits, 2026-10-28]. Running D1 migrations as part of its deploy command is [U]. GitHub Actions is kept here because it was requested and is portable.

### 6.4 Custom domain vs `*.workers.dev`

- **`workers.dev`**: free, instant, and covered by `createMcpHandler`'s default Host/Origin allowlist [V]. The account subdomain is part of the URL.
- **Custom domain**: needs an **active Cloudflare zone** (a domain on Cloudflare; Registrar price about $10/yr [U]). Cloudflare creates DNS and certificates automatically [V: custom-domains doc]. It requires `allowedHostnames` in `createMcpHandler` [V] and the Workers Routes permission for deploys that change it.
- **The URL is identity.** The OAuth issuer, token audiences, the Claude connector URL and the extension's server URL are all bound to it. Changing it later means re-adding the claude.ai connector and reconnecting the extension. **Decide on day one.** Default: `workers.dev`.
- The request-body limit is the same either way on the Free zone plan (100 MB), which is irrelevant with 32 MiB parts.

### 6.5 Can the Cloudflare MCP tools in this session deploy for us?

I called only `whoami`, which is read-only.

- **It is authenticated.** It returned Cloudflare user `user:56f84a8431c8637e3bde56c5a824331d` with the email `ripost…@gmail.com`. **That is not the user's claude.ai email**, so confirm it is the right Cloudflare account before anyone creates anything there. No account ID or token scopes were returned, and I did not probe them.
- **Tools present:**
  - `mcp__cloudflare__docs` (docs search, used read-only for this research).
  - `mcp__cloudflare__search` (API spec search, read-only).
  - `mcp__cloudflare__execute` (runs arbitrary Cloudflare API calls, including creating D1/R2/KV, uploading Worker scripts, and setting secrets). **I did not call it.**
  - A **deprecated** "Cloudflare Developer Platform" server with D1/KV/R2 create and delete and Worker list/get, but no Worker upload. Not called.
  - Separately, the plugin server `plugin:cloudflare:cloudflare` reports that it needs authentication.
- **Could they deploy?** Technically yes, through `execute`. But static assets need Cloudflare's multi-step assets-upload API, and D1 migrations would become raw SQL calls, which is not reproducible.
- **Recommendation:**
  - Deploy with wrangler: the first time locally, then through CI.
  - Use the Cloudflare MCP for **read-only checks**: list resources, verify bindings, read D1 sizes and usage.
  - At most, use it for one-time resource creation after the user explicitly approves each call.
  - Never paste secrets such as the GitHub client secret through chat; use `wrangler secret put` or the dashboard.

### 6.6 Bootstrap checklist for the user (one time, about 45 min)

1. **Cloudflare account**: sign up (free), verify email, pick the **workers.dev subdomain** (Workers & Pages). Decide now between workers.dev and a custom domain (§6.4).
2. **Enable R2**: Dashboard → Storage & databases → R2 → complete the R2 checkout. Free-tier usage is $0; a payment method is likely required [U].
3. **GitHub**: create a **private** repo from the project template, which contains `apps/server`, `apps/web`, `apps/extension` and `packages/*`. Find your numeric GitHub id at `https://api.github.com/users/<login>` (`"id"`).
4. **GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New):
   - Homepage: `https://sickofpdfs.<sub>.workers.dev`
   - Callback: `https://sickofpdfs.<sub>.workers.dev/oauth/github/callback`
   - Generate a client secret.
5. **On the Windows PC**: install Node 24 LTS [U: e.g. `winget install OpenJS.NodeJS.LTS`], clone the repo, `npm ci`, then `cd apps/server && npx wrangler login` (browser OAuth).
6. **Create resources**, or let auto-provisioning do it on the first deploy (§6.1). Then put the IDs into `wrangler.jsonc` and commit.
   - `npx wrangler d1 create sop_meta`, `… sop_text_0`, `… sop_text_1` (add `--location weur` or `enam` near you [U: flag name per wrangler help])
   - `npx wrangler r2 bucket create sop-blobs`
   - `npx wrangler kv namespace create OAUTH_KV`
7. **Secrets:**
   - `npx wrangler secret put GITHUB_CLIENT_ID`
   - `… GITHUB_CLIENT_SECRET`
   - `… ALLOWED_GITHUB_ID`
   - `… SESSION_SECRET` (paste 32+ random bytes, e.g. from a password manager)
8. **First deploy** (creates the Worker, which needs Admin, provided by `wrangler login`):
   ```
   npm run build -w apps/web
   npx wrangler d1 migrations apply sop_meta --remote
   npx wrangler d1 migrations apply sop_text_0 --remote
   npx wrangler d1 migrations apply sop_text_1 --remote
   npx wrangler deploy
   ```
9. **CI token**: create the minimal token (§6.3). Add repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (Account ID is in the dashboard sidebar). Push a commit and check that the Action is green.
10. **Smoke test**: open `https://sickofpdfs.<sub>.workers.dev` → Sign in with GitHub → an empty library. Signing in with a second GitHub account should get **403**.
11. **Extension**: Settings → Cloud → enter the URL → Connect (GitHub sign-in in a popup, then Allow). Choose "Back up PDF files" (default on). Watch the quota meter: R2 GB, D1 MB per shard, "search indexing: day N of ~M".
12. **claude.ai**: Customize → Connectors → **Add custom connector**.
    - Name "My readings".
    - URL `https://sickofpdfs.<sub>.workers.dev/mcp` (exact, no trailing slash).
    - Authentication "Sign in now".
    - OAuth client "**Use Claude's published identity**".
    - Add → GitHub sign-in → consent: library:read ☑ and library:comment ☑ (untick for read-only).
    - In a chat: **+ → Connectors → on**. (Free plan: this is your one custom connector.)
13. **Claude Code (optional)**: nothing to do if logged in with your claude.ai subscription (`/mcp` lists it). Otherwise: `claude mcp add --transport http sickofpdfs https://…/mcp` → `/mcp` → sign in.
14. **Safety settings**: in claude.ai, set the write tools (`add_comment`, `update_comment`) to "ask" or "Blocked" if you prefer, and turn the connector off during Research runs (§8).

---

## 7. Cost for about 2,000 PDFs (about 10 GB)

| Resource | Expected usage | Free allowance | Verdict |
|---|---|---|---|
| R2 storage | ~10 GB PDFs + ~0.1 GB thumbnails | **10 GB-month** [V] | **At the edge.** Overage $0.015/GB-month: 15 GB ≈ $0.08/mo, 30 GB ≈ $0.30/mo [V rates] |
| R2 Class A (writes) | ~3–5k for the first upload (multipart = create + parts + complete), then <1k/mo | 1M/mo [V] | Fine |
| R2 Class B (reads) | Web opens and HEAD checks, a few k/mo | 10M/mo [V] | Fine |
| D1 storage | meta 20–50 MB; text + FTS ~0.45–0.75 GB [U] | 500 MB/DB, 5 GB total, 10 DBs [V] | Fine **with 2–3 text shards** |
| D1 rows written | Backfill ~0.5–0.75M [U]; then <5k/day | **100k/day** [V] | Backfill spread over **~5–8 days**, then fine |
| D1 rows read | Searches: hundreds to thousands of rows each; pulls ≈ rows returned | 5M/day [V] | Fine |
| Workers requests | ~2–6k/day (polling, MCP, sync) | 100k/day [V] | Fine. Static assets free [V] |
| Workers CPU | ~2–3 ms per MCP call (measured in Node); sync and uploads mostly I/O | 10 ms/request [V] | OK, but the tightest constraint |
| KV (OAuth) | <100 writes/day (consent, refresh) | 1k writes, 100k reads/day; 1 GB [V] | Fine |
| Workers Builds (if used) | Few minutes/deploy | 3,000 min/mo [V] | Fine |
| Custom domain | Optional | — | ~$10/yr [U] |

**Where it starts costing money:**
1. **R2 above 10 GB**: pennies per GB-month, but it requires the R2 subscription to be active.
2. **Workers Paid at $5/month** becomes worth it if any of these happen:
   - a text shard would exceed 500 MB and you'd rather not add shards (Paid: 10 GB per DB),
   - you want the backfill done in hours instead of about a week (Paid: 50M rows written/month included),
   - Workers Logs show CPU-limit errors (1102) on MCP or sync (Paid: 30 s default CPU).

   Paid includes 10M requests and 30M CPU-ms per month [V: Workers pricing, 2026-10-02].
3. **Nothing else** at this scale. Egress is free on R2 and D1 [V]. Rate-limiting binding pricing on the Free plan is [U]; it is documented without a plan restriction.

---

## 8. Privacy and security

### 8.1 What lands in the cloud

| Data | Default | Notes |
|---|---|---|
| Docs classified **non-learning** | **Never** | The client sync queue only selects `classified_as='learning' AND cloud_policy!='local_only'`. The **server rejects** any doc without `classified_as='learning'` (CHECK constraint). Low-confidence classifications wait in a "Confirm before backing up" tray. |
| Doc metadata (title, authors, page count, folder, tags, sha256) | Synced | Needed for the library everywhere. |
| Source URLs | Synced, **sanitized** | Strip fragments and token-like query params (`token`, `sig`, `X-Amz-*`, `session`, `key`, …). Option: origin + path only. |
| Local file paths | **File name only** | Full paths reveal the Windows user name and folder layout. Toggle "Sync full file paths" (off). Paths stay in local SQLite for relinking. |
| Page text | Synced when sync is on | Required for server search, MCP and web search. |
| Highlights, comments, threads | Synced | Core feature. |
| **PDF files** | **ON** (toggle: "Back up PDF files to my cloud") | Backup is goal #1. Per-doc "Keep this PDF local only". With it off you still get search, notes and Claude, but a Chrome reset loses local-only PDFs (URL PDFs can be re-fetched if the link still works). |
| Never | — | The Anthropic API key, OAuth tokens, browsing history, non-PDF content, settings with secrets. |

- **Encryption at rest:** R2 and D1 use AES-256-GCM [V]. The library stores OAuth tokens and codes as hashes, and `props` are encrypted with a key only the token holder can unwrap [V: README].
- **No end-to-end encryption**, because it would make server FTS and MCP impossible. R2 SSE-C (`ssecKey`, with the key as a Worker secret) only protects against leaked R2 S3 credentials, which we don't create. It is not worth the complexity in v1.
- **Claude conversations:** text excerpts and notes returned by tools enter claude.ai conversations and follow the user's Claude data settings.

### 8.2 Protecting the MCP server and API

- **Identity:** one allowlisted numeric GitHub id, checked at the callback **and** on every request (`ctx.props.uid`).
- **Consent:** the library's unforgeable, unframeable consent page with a single-use handle and `__Host-` cookie. It shows the client name, the redirect host and the scopes [V: securing doc]. Escape client strings (Hono `html` / JSX) [V].
- **Tokens:**
  - Bound to their resource: a `/api` token is rejected on `/mcp` and vice versa [V].
  - Access tokens last 1 h. Refresh tokens rotate, with 30-day sliding idle expiry.
  - The `/api/grants` page lists and revokes connections.
  - Kill switch: setting `mcp_enabled=false` in the `setting` table → `/mcp` returns 503.
- **Scopes:**
  - `library:read` (search and read).
  - `library:comment` (add and edit Claude's own comments). Comment tools are registered only if the token has this scope. `getMcpAuthContext()` works in the factory [V].
  - `sync` (extension).
- **Least-destructive tool design:**
  - No MCP tool can delete or edit **user** annotations, delete documents, or download PDF bytes.
  - So prompt injection hidden in a PDF's text can, at worst, make Claude add visible, attributed comments, which can be bulk-undone through the `audit` trail.
  - Write tools carry `readOnlyHint:false, destructiveHint:false/true, idempotentHint:true` annotations.
  - Advise disabling write tools for **Research** mode, which "can invoke tools … automatically without further approval" [V: support article].
- **Rate limiting** (Workers Rate Limiting binding; approximate, per location [V]):
  - `RL_AUTH` 20/min per IP on `/authorize`, `/oauth/*` and `/login`.
  - `RL_MCP` 120/min per client_id.
  - `RL_API` 600/min per device.
  - Plus input caps: query ≤ 300 chars, `read_pages` ≤ 120k chars, push ≤ 200 records, text chunk ≤ 256 KB.
- **FTS query safety:** never pass raw input to `MATCH`. Tokenize and quote each term (`"term"`), and allow only a small safe syntax subset (phrases, `-term`, `prefix*`).
- **Web app:**
  - `__Host-sess` cookie (HttpOnly, Secure, SameSite=Lax, 30 days, rotated).
  - CSRF: `Sec-Fetch-Site: same-origin` + `X-SOP` header on state-changing calls.
  - CSP as in §5; `frame-ancestors 'none'`.
- **Origin/Host:** keep `createMcpHandler`'s Origin validation on. Set `allowedHostnames` if you use a custom domain [V].
- **Logging:** never log note bodies, page text, tokens or `props`. The `audit` table keeps tool name, target id, client_id and time only.
- **Supply chain:** pin exact versions (`agents` 0.32.0 ↔ `@modelcontextprotocol/server` 2.4.0, exact pin [V]). Use Dependabot. Optionally pin Actions by commit SHA.

---

## 9. Schema (SQL)

### 9.1 `apps/server/migrations/meta/0001_init.sql` (database `sop_meta`, binding `META`)

```sql
-- Synced tables carry: rev (server revision), hlc (hybrid logical clock, lexicographically ordered
-- 'TTTTTTTTTTTTT-CCCC-<device>'), seq (global change number = pull cursor), device (last writer;
-- 'claude' for MCP), deleted (tombstone). No FOREIGN KEYs: offline devices push out of order.

CREATE TABLE sync_counter (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL);
INSERT INTO sync_counter (id, seq) VALUES (1, 0);

CREATE TABLE doc (
  sha256          TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  classified_as   TEXT NOT NULL CHECK (classified_as = 'learning'),      -- server-side guard
  title           TEXT NOT NULL DEFAULT '',
  authors         TEXT NOT NULL DEFAULT '[]',                            -- JSON array
  year            INTEGER,
  kind            TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('paper','textbook','slides','notes','other')),
  page_count      INTEGER,
  byte_size       INTEGER NOT NULL,
  pdf_fingerprint TEXT,                                                  -- secondary id (03 §2)
  folder_id       TEXT,
  tags            TEXT NOT NULL DEFAULT '[]',                            -- JSON array
  starred         INTEGER NOT NULL DEFAULT 0,
  added_at        INTEGER NOT NULL,                                      -- unix ms
  last_opened_at  INTEGER,
  trashed_at      INTEGER,                                               -- purge after 30 d
  blob_state      TEXT NOT NULL DEFAULT 'none' CHECK (blob_state IN ('none','stored','local_only')),
  text_state      TEXT NOT NULL DEFAULT 'none' CHECK (text_state IN ('none','partial','complete','no_text')),
  text_shard      INTEGER,                                               -- TEXT_n holding its pages
  extractor       TEXT,
  rev INTEGER NOT NULL DEFAULT 1, hlc TEXT NOT NULL, seq INTEGER NOT NULL,
  device TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX doc_seq    ON doc(seq);
CREATE INDEX doc_folder ON doc(folder_id) WHERE deleted = 0;
CREATE INDEX doc_recent ON doc(last_opened_at DESC) WHERE deleted = 0;

CREATE TABLE doc_source (
  id         TEXT PRIMARY KEY,                    -- hex sha256(sha256||'|'||kind||'|'||value)
  sha256     TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('url','file')),
  value      TEXT NOT NULL,                       -- sanitized URL, or file NAME unless full paths enabled
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,                    -- merged with max()
  rev INTEGER NOT NULL DEFAULT 1, hlc TEXT NOT NULL, seq INTEGER NOT NULL,
  device TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX doc_source_doc ON doc_source(sha256);
CREATE INDEX doc_source_seq ON doc_source(seq);

CREATE TABLE folder (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, color TEXT, sort_key TEXT,
  rev INTEGER NOT NULL DEFAULT 1, hlc TEXT NOT NULL, seq INTEGER NOT NULL,
  device TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX folder_seq ON folder(seq);

CREATE TABLE annotation (
  id             TEXT PRIMARY KEY,                -- UUIDv7/ULID from the creator
  sha256         TEXT NOT NULL,
  page           INTEGER,                         -- 1-based; NULL = document-level
  kind           TEXT NOT NULL CHECK (kind IN ('highlight','underline','strike','note','ink','comment','reply')),
  thread_id      TEXT,                            -- root annotation id (root: = id)
  parent_id      TEXT,
  anchor         TEXT,                            -- JSON {"quads":[[x1,y1,…]]} and/or {"quote":{"exact","prefix","suffix"}}
  color          TEXT,
  quote          TEXT,                            -- highlighted text (searchable)
  body           TEXT,                            -- comment markdown (searchable)
  author         TEXT NOT NULL CHECK (author IN ('user','claude')),   -- immutable
  resolved       INTEGER NOT NULL DEFAULT 0,
  conflict_of    TEXT,                            -- set on conflict-copy replies
  mcp_request_id TEXT UNIQUE,                     -- idempotency for Claude writes
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1, hlc TEXT NOT NULL, seq INTEGER NOT NULL,
  device TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ann_doc    ON annotation(sha256, page);
CREATE INDEX ann_thread ON annotation(thread_id);
CREATE INDEX ann_seq    ON annotation(seq);

-- Full-text over notes and titles (external content; tombstones excluded).
CREATE VIRTUAL TABLE annotation_fts USING fts5(quote, body, content='annotation', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2");
CREATE TRIGGER ann_ai AFTER INSERT ON annotation WHEN new.deleted = 0 BEGIN
  INSERT INTO annotation_fts(rowid, quote, body) VALUES (new.rowid, new.quote, new.body);
END;
CREATE TRIGGER ann_ad AFTER DELETE ON annotation WHEN old.deleted = 0 BEGIN
  INSERT INTO annotation_fts(annotation_fts, rowid, quote, body) VALUES ('delete', old.rowid, old.quote, old.body);
END;
CREATE TRIGGER ann_au AFTER UPDATE ON annotation BEGIN
  INSERT INTO annotation_fts(annotation_fts, rowid, quote, body)
    SELECT 'delete', old.rowid, old.quote, old.body WHERE old.deleted = 0;
  INSERT INTO annotation_fts(rowid, quote, body)
    SELECT new.rowid, new.quote, new.body WHERE new.deleted = 0;
END;

CREATE VIRTUAL TABLE doc_fts USING fts5(title, authors, content='doc', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2");
CREATE TRIGGER doc_ai AFTER INSERT ON doc WHEN new.deleted = 0 BEGIN
  INSERT INTO doc_fts(rowid, title, authors) VALUES (new.rowid, new.title, new.authors);
END;
CREATE TRIGGER doc_ad AFTER DELETE ON doc WHEN old.deleted = 0 BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, title, authors) VALUES ('delete', old.rowid, old.title, old.authors);
END;
CREATE TRIGGER doc_au AFTER UPDATE OF title, authors, deleted ON doc BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, title, authors)
    SELECT 'delete', old.rowid, old.title, old.authors WHERE old.deleted = 0;
  INSERT INTO doc_fts(rowid, title, authors)
    SELECT new.rowid, new.title, new.authors WHERE new.deleted = 0;
END;

-- Server-only tables (not synced)
CREATE TABLE device (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('extension','web','claude')),
  created_at INTEGER NOT NULL, last_seen_at INTEGER, last_pull_seq INTEGER
);
INSERT INTO device (id, name, kind, created_at) VALUES ('claude', 'Claude (MCP)', 'claude', CAST(strftime('%s','now') AS INTEGER) * 1000);

CREATE TABLE web_session (id_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  last_seen_at INTEGER, user_agent TEXT);
CREATE TABLE blob_upload (sha256 TEXT PRIMARY KEY, upload_id TEXT NOT NULL, part_size INTEGER NOT NULL,
  byte_size INTEGER NOT NULL, parts TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL);
CREATE TABLE audit (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL, client_id TEXT,
  action TEXT NOT NULL, target TEXT, batch TEXT);         -- no bodies/text/tokens
CREATE INDEX audit_at ON audit(at);
CREATE TABLE usage_day (day TEXT PRIMARY KEY, text_rows_written INTEGER NOT NULL DEFAULT 0);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- mcp_enabled, claude_can_comment, …
INSERT INTO setting VALUES ('mcp_enabled', 'true'), ('claude_can_comment', 'true');
```

### 9.2 `apps/server/migrations/text/0001_init.sql` (every `sop_text_n`)

```sql
CREATE TABLE shard_doc (
  docnum    INTEGER PRIMARY KEY,             -- per-shard integer id
  sha256    TEXT NOT NULL UNIQUE,
  pages     INTEGER NOT NULL DEFAULT 0,
  extractor TEXT
);
CREATE TABLE page (
  id     INTEGER PRIMARY KEY,                -- = docnum * 100000 + n  (no extra UNIQUE index → fewer rows written)
  sha256 TEXT NOT NULL,
  n      INTEGER NOT NULL,                   -- 1-based page number
  text   TEXT NOT NULL
);
CREATE VIRTUAL TABLE page_fts USING fts5(text, content='page', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2");
CREATE TRIGGER page_ai AFTER INSERT ON page BEGIN
  INSERT INTO page_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER page_ad AFTER DELETE ON page BEGIN
  INSERT INTO page_fts(page_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
-- Page text is immutable; re-extraction = DELETE FROM page WHERE id BETWEEN d*100000 AND d*100000+99999, then INSERT.
```

### 9.3 Key queries

```sql
-- search one shard (run on every shard in parallel; merge by score ascending)
SELECT p.sha256, p.n, snippet(page_fts, 0, '[[', ']]', '…', 20) AS snip, bm25(page_fts) AS score
FROM page_fts JOIN page p ON p.id = page_fts.rowid
WHERE page_fts MATCH ?1 ORDER BY score LIMIT ?2;

-- push: optimistic upsert (one statement per record inside one batch)
INSERT INTO annotation (id, sha256, page, kind, thread_id, parent_id, anchor, color, quote, body, author,
                        created_at, updated_at, deleted, rev, hlc, seq, device)
VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14, 1, ?15, (SELECT seq FROM sync_counter WHERE id=1) + ?16, ?17)
ON CONFLICT (id) DO UPDATE SET
  page=excluded.page, anchor=excluded.anchor, color=excluded.color, quote=excluded.quote, body=excluded.body,
  updated_at=excluded.updated_at, deleted=excluded.deleted,
  rev=annotation.rev + 1, hlc=excluded.hlc, seq=excluded.seq, device=excluded.device
WHERE annotation.rev = ?18 AND annotation.author = excluded.author;   -- ?18 = base_rev (0 for new)
-- …last statements of the batch:
UPDATE sync_counter SET seq = seq + ?1 WHERE id = 1;
SELECT id, rev, seq FROM annotation WHERE id IN (SELECT value FROM json_each(?1));

-- pull
SELECT * FROM annotation WHERE seq > ?1 ORDER BY seq LIMIT ?2;   -- same for doc, doc_source, folder
```

---

## 10. Endpoint list

See §3.5 (method, path, auth, purpose).

---

## 11. MCP tools (JSON Schemas)

- All tools return `structuredContent` plus a short text rendering.
- Every hit carries `url` = `https://…/d/<sha>?page=N#a=<id>`.
- Outputs are capped at about 40k chars by default, below the ~150k claude.ai limit and the 25k-token Claude Code default.
- Tools 1–6 need `library:read`. Tools 7–8 are registered only when the token has `library:comment` and `setting.claude_can_comment='true'`.

```json
[
  {
    "name": "search_library",
    "title": "Search my readings and notes",
    "description": "Full-text search over every saved PDF's page text, my highlights/comments, and titles. Returns ranked hits (document, page, snippet). Use read_pages for more context.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query":     { "type": "string", "minLength": 1, "maxLength": 300, "description": "Words or \"quoted phrase\"; words are ANDed; -word excludes; word* prefix." },
        "scope":     { "type": "string", "enum": ["all", "pages", "notes", "titles"], "default": "all" },
        "doc":       { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "Restrict to one document (sha256)." },
        "folder_id": { "type": "string" },
        "tag":       { "type": "string", "maxLength": 100 },
        "limit":     { "type": "integer", "minimum": 1, "maximum": 25, "default": 10 }
      },
      "required": ["query"], "additionalProperties": false
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "list_documents",
    "title": "List documents",
    "description": "Browse the library like Drive: filter by folder, tag, kind or title text; sort by recent/added/title.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "folder_id":      { "type": "string" },
        "tag":            { "type": "string", "maxLength": 100 },
        "kind":           { "type": "string", "enum": ["paper", "textbook", "slides", "notes", "other"] },
        "title_contains": { "type": "string", "maxLength": 200 },
        "sort":           { "type": "string", "enum": ["recent", "added", "title"], "default": "recent" },
        "include_trashed":{ "type": "boolean", "default": false },
        "limit":          { "type": "integer", "minimum": 1, "maximum": 100, "default": 25 },
        "cursor":         { "type": "string" }
      },
      "additionalProperties": false
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "get_document",
    "title": "Get document details",
    "description": "Metadata for one document: title, authors, kind, pages, folder, tags, source URLs, text availability, annotation counts per page.",
    "inputSchema": {
      "type": "object",
      "properties": { "doc": { "type": "string", "pattern": "^[0-9a-f]{64}$" } },
      "required": ["doc"], "additionalProperties": false
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "read_pages",
    "title": "Read pages",
    "description": "Extracted text of a page range, with [p.N] markers. Truncates at max_chars and returns next_from.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "doc":       { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "from":      { "type": "integer", "minimum": 1 },
        "to":        { "type": "integer", "minimum": 1, "description": "Inclusive; at most from+49." },
        "max_chars": { "type": "integer", "minimum": 1000, "maximum": 120000, "default": 40000 }
      },
      "required": ["doc", "from", "to"], "additionalProperties": false
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "get_annotations",
    "title": "Get highlights and comments",
    "description": "Highlights, comments and threads on a document, optionally limited to a page range or author.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "doc":             { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "page_from":       { "type": "integer", "minimum": 1 },
        "page_to":         { "type": "integer", "minimum": 1 },
        "author":          { "type": "string", "enum": ["any", "user", "claude"], "default": "any" },
        "include_replies": { "type": "boolean", "default": true },
        "limit":           { "type": "integer", "minimum": 1, "maximum": 200, "default": 100 },
        "cursor":          { "type": "string" }
      },
      "required": ["doc"], "additionalProperties": false
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "recent_activity",
    "title": "What I've been reading",
    "description": "Documents opened or added and notes written in the last N days.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "days":  { "type": "integer", "minimum": 1, "maximum": 90, "default": 7 },
        "limit": { "type": "integer", "minimum": 1, "maximum": 100, "default": 30 }
      },
      "additionalProperties": false
    },
    "annotations": { "readOnlyHint": true, "openWorldHint": false }
  },
  {
    "name": "add_comment",
    "title": "Add a comment to my PDF",
    "description": "Adds a comment authored by Claude, shown in the PDF viewer's comment threads with a Claude badge. Anchor it to an exact quote on a page, to a page, to the whole document, or reply to an existing thread.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "doc":        { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "page":       { "type": "integer", "minimum": 1, "description": "Omit for a document-level comment." },
        "quote":      { "type": "string", "minLength": 3, "maxLength": 500, "description": "Exact text on that page to highlight and anchor to." },
        "reply_to":   { "type": "string", "description": "Annotation id of a thread to reply in (page/quote ignored)." },
        "body":       { "type": "string", "minLength": 1, "maxLength": 4000, "description": "Markdown." },
        "request_id": { "type": "string", "format": "uuid", "description": "Idempotency key; reuse it when retrying." }
      },
      "required": ["doc", "body", "request_id"], "additionalProperties": false
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
  },
  {
    "name": "update_comment",
    "title": "Edit or delete a Claude comment",
    "description": "Edits or deletes a comment that Claude wrote earlier. Cannot touch the user's own annotations.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id":     { "type": "string" },
        "body":   { "type": "string", "minLength": 1, "maxLength": 4000 },
        "delete": { "type": "boolean", "default": false }
      },
      "required": ["id"], "additionalProperties": false
    },
    "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true, "openWorldHint": false }
  }
]
```

In code these become `server.registerTool(name, { title, description, inputSchema: z.object({...}), annotations }, handler)` with zod 4 [V: CF handler-api examples; the benchmark in §1.1 used these exact 8 tools].

Possible later additions:
- `get_page_image`: return a client-uploaded page render as MCP image content. Claude supports image tool results [V].
- An MCP App UI.

---

## 12. Risks

1. **D1 free cap of 500 MB per DB.** The text + FTS size is an estimate [U]. *Mitigation:* shards from day one, a measured projection from the local SQLite DB, and a quota meter. Paid $5/mo gives 10 GB per DB.
2. **FTS5 write amplification vs 100k rows/day.** How D1 counts shadow-table writes is [U]. The backfill may take a week. *Mitigation:* server-side metering → 429 until 00:00 UTC; notes and metadata are prioritized; measure on the first upload.
3. **The 10 ms CPU limit.** MCP measured about 2–3 ms in Node [V], but not in workerd or with token validation [U]. Occasional overruns are tolerated per isolate, while consistent ones fail with 1102 [V]. *Mitigation:* watch Workers Logs CPU; the escape hatch is Paid.
4. **R2 sits at the 10 GB free edge** and needs an R2 checkout (payment method likely [U]). *Mitigation:* the "Back up PDF files" toggle, per-doc local-only, and a storage meter with a 9 GB warning.
5. **URL lock-in.** Changing the workers.dev subdomain or moving to a custom domain breaks token audiences, the claude.ai connector and the extension config. *Mitigation:* decide on day one, and document "re-add connector" steps.
6. **Prompt injection through PDF text** (papers can hide instructions). *Mitigation:* no destructive tools on user data, attributed Claude comments, bulk undo by audit batch, the `claude_can_comment` switch, and advising write tools "ask"/off in Research mode.
7. **Sync bugs could lose notes.** *Mitigation:* tombstones (never hard-delete through sync), conflict copies, D1 Time Travel (7 days on Free [V]), the extension's full local replica, and the 03 FSA backup folder kept as a second copy. Property-test the merge logic. Note that `wrangler d1 export` fails on DBs with FTS virtual tables [V], so `sop_meta` relies on Time Travel and the client copy, not export.
8. **Lockout.** If the GitHub account is lost, the user can't sign in. *Recovery:* `wrangler secret put ALLOWED_GITHUB_ID` with the new id (needs Cloudflare access); the data is untouched.
9. **Token theft from the extension profile.** A rotating refresh token sits in extension IndexedDB; local malware could read it. *Mitigation:* revoke on `/api/grants`; 30-day idle expiry; no PDF-byte tool in MCP.
10. **Classifier false positives** upload a non-learning PDF. *Mitigation:* a confirm tray for low-confidence results, the server CHECK, and "Remove from cloud" hard-purges the blob, text, notes and metadata.
11. **Large PDFs in the web viewer** (300 MB) may exhaust browser or wasm memory, especially on phones [U]. *Mitigation:* progress, a download fallback, and pdf.js range loading where possible.
12. **Stateless MCP lane:** GET/DELETE return 405 and there are no server-push notifications [V]. That is fine for claude.ai (no subscriptions or sampling support [V]); test once end-to-end.
13. **CIMD dependency:** it needs `global_fetch_strictly_public` and `none` auth advertised [V]. If Claude falls back to DCR, the restricted `clientRegistrationCallback` must allow `https://claude.ai/api/mcp/auth_callback`.
14. **Account mismatch:** this session's Cloudflare connector is signed in with an email that is not the user's claude.ai email (§6.5). Confirm the account before creating anything.
15. **Version drift:** `agents` pins `@modelcontextprotocol/server` exactly [V]. Upgrade the two together, and don't trust doc install lines (the CF doc still shows 2.3.1).

---

## 13. Sources

- **Cloudflare Agents / MCP** (developers.cloudflare.com, `index.md` variants):
  - `/agents/model-context-protocol/apis/handler-api/` (2026-10-27)
  - `/agents/model-context-protocol/protocol/authorization/` (2026-10-27)
  - `/agents/model-context-protocol/guides/securing-mcp-server/` (2026-10-27)
  - `/agents/model-context-protocol/protocol/transport/` (2026-10-27)
  - `/agents/model-context-protocol/guides/migrate-to-mcp-sdk-v2/`
  - Cloudflare agents-sdk skill reference `mcp.md`
- **Workers OAuth Provider 1.2.4** npm package: `README.md`, `docs/{authorization-server,resource-servers,consent-page,upstream-sign-in,mcp-discovery,migration-1.x}.md`, `dist/oauth-provider.{d.ts,js}`.
- **npm registry metadata (2026-10-31):** agents 0.32.0 (peerDependencies), @modelcontextprotocol/server 2.4.0, @modelcontextprotocol/sdk 1.32.2, wrangler 4.156.0, hono 4.13.14, zod 4.6.7, @cloudflare/workers-oauth-provider 1.2.4, @cloudflare/vite-plugin 1.66.0, @embedpdf/engines 2.15.1.
- **Claude connectors:**
  - claude.com/docs/connectors/building/authentication.md
  - claude.com/docs/connectors/building/index.md
  - claude.com/docs/connectors/custom/add-unlisted.md
  - support.claude.com/en/articles/11175166 (updated 2026-10-31)
  - code.claude.com/docs/en/mcp.md
- **D1:**
  - `/d1/platform/limits/` (2026-10-30), `/d1/platform/pricing/` (2026-10-30)
  - `/d1/sql-api/sql-statements/`, `/d1/best-practices/import-export-data/`, `/d1/reference/migrations/`
  - `/workers/wrangler/commands/d1/`, `/d1/worker-api/d1-database/`, `/d1/reference/data-security/`
  - changelog 2026-09-01 (free-tier enforcement)
- **R2:**
  - `/r2/pricing/` (2026-10-30), `/r2/platform/limits/` (2026-10-30), `/r2/api/s3/presigned-urls/` (2026-10-26)
  - `/r2/api/workers/workers-api-reference/`, `/r2/api/workers/workers-multipart-usage/`
  - `/r2/reference/data-security/`, `/r2/get-started/`
- **Workers:**
  - `/workers/platform/limits/` (2026-10-29), `/workers/platform/pricing/` (2026-10-02)
  - `/workers/static-assets/billing-and-limitations/`, `/workers/static-assets/routing/single-page-application/` (2026-10-12), `/workers/static-assets/headers/`
  - `/workers/configuration/routing/custom-domains/`, `/workers/ci-cd/external-cicd/github-actions/` (2026-10-18)
  - `/workers/authorization/workers/` (2026-09-15), `/fundamentals/api/reference/permissions/`
  - `/workers/runtime-apis/bindings/rate-limit/` (2026-10-21), `/workers/ci-cd/builds/limits-and-pricing/` (2026-10-28)
  - changelog 2025-10-24 (auto-provisioning)
  - `/kv/platform/{pricing,limits}/`
- **Access:** `/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/` (2026-10-22), `/workers/configuration/cloudflare-access/`.
- **Chrome:** developer.chrome.com/docs/extensions/reference/api/identity (2026-10-29); …/develop/concepts/network-requests.
- **GitHub Actions tags** via `git ls-remote --tags`: cloudflare/wrangler-action v4.1.3, actions/checkout v7.0.1, actions/setup-node v7.1.0.
- **Local benchmark:** Node 22.22.0. Building the server with 8 tools took 0.89 ms. A stateless `tools/list` took 3.15 ms CPU and a `tools/call` 2.18 ms CPU per request. JSON.parse of 1.8 MB took 1.03 ms. Scripts are in `scratchpad/research/hosted/bench-scripts/`.
- **Cloudflare connector in this session:** `mcp__cloudflare__whoami` (the only call made).
