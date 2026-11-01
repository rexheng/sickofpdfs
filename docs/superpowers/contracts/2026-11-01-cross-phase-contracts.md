# sickofpdfs · Cross-phase contracts (Phases 2–8)

Nov 1, 2026. Binding for every plan from Phase 2 to Phase 8. The spec wins over this file, and this file wins over a phase plan. A name marked **exists** comes from the Phase 1 plan: keep it exactly. A plan that needs a change here asks the controller first, and the change is made here, not in the plan.

**Shared rules for every shape below**

- `pageIndex` is 0-based everywhere inside the product. `page` is 1-based, and only appears where a person or Claude reads it (MCP tools, Markdown, PDF export).
- Times are Unix milliseconds. Ids for notes are UUIDv4 from `crypto.randomUUID()`, made once by the writer (v1 rule).
- A char offset is a PDFium char index on one page, and `end` is exclusive (as in Task 22's `CharRange`). `page_text.text` is exactly `getPageText()` output, so string offsets into it are the same char indices. A unit test pins this on the fixtures.
- Engine geometry is `PdfRect` in points (unrotated page space, origin top-left, Task 15). Stored geometry is `NormRect`, 0–1 of the crop box (Task 28).
- PDF text, quotes and titles are untrusted. The UI never renders them as HTML, and snippet markers are split, never put into `innerHTML`.
- Model names: code and stored data use the roles `default` and `think-harder`. No model id is ever written in code, comments or docs (see open decision D1).

## 1. Ownership map

| Shape | Owner | Code lives in | Consumers | Phase 1 status |
| --- | --- | --- | --- | --- |
| Ids | P2 adds brands | `packages/core/src/ids.ts` | all | **exists** (Task 18): `Sha256`, `DocumentId`, `LocationId`, `LocationKind`. New: `MarkId`, `ThreadId`, `CommentId`, `TabId`, `Author` |
| Anchor JSON | P2 | `packages/core/src/model/anchor.ts` | P2, P4, P6, P7, P8 | **exists** (Task 28): `Anchor`, `NormRect`, `CharPos`, `TextQuote`, `FigureFingerprint`. New: two optional fields |
| Annotation rows | P2 | `packages/core/src/model/rows.ts` | P2–P8 | the tables **exist** (Task 28, schema v1). New: `MarkRow`, `ThreadRow`, `CommentRow` |
| Style planning | P2 | `packages/core/src/annotations/marks.ts` | P2, P8 | new: `planStyle` |
| Re-anchoring | P2 | `packages/core/src/anchoring/` (vendored Hypothesis match-quote and approx-string-match) | P2, P5, P7, P8 | new: `resolveAnchor` |
| Page text access | P2 | `packages/viewer/src/text/page-text.ts` | P2, P4, P7 | new: `PageTextProvider` over Task 15's `getPageText`, `getPageGlyphs`, `searchPage` |
| Engine additions | P2, P8 | `packages/viewer/src/backend/types.ts` | viewer | **exists** (Task 15): `PdfBackend`. New: `getTextRects` (Task 22, R44), `getGlyphOutlines` (P2), `readAnnotations`, `writeAnnotations` (P8) |
| Figures | P2 | `packages/core/src/model/figures.ts`; detector in `packages/viewer/src/figures/find-figures.ts` | P2, P4, P8 | `DetectedFigure` (Task 5 spike) and the `page_figures` table **exist** |
| Schema steps | one step per phase | `apps/extension/src/store/{schema,migrate}.ts` | the store | **exists**: `SCHEMA_V1`, `migrate` (Task 28) |
| Store API | each phase adds methods | `apps/extension/src/store/store-api.ts` | all | **exists**: `StoreApi`, `StoreClient`, `connectStore` (Task 28) |
| Change events | P2 extends | `apps/extension/src/store/change-bus.ts` | viewer, library, sync | **exists**: `StoreChange`, `CHANGES_CHANNEL` (Task 28) |
| Save decision | exists | `packages/core/src/save/types.ts`, `packages/viewer/src/contracts.ts` | P2 calls `firstMark()` | **exists**: `SaveState`, `SaveController` (Tasks 23, 30) |
| Filter | P3 | `packages/core/src/filter/{types,classify,hard-blocks}.ts` | save controller, P3 | **exists** (Task 30): `FilterInput`, `FilterDecision`, `FilterVerdict`, `standInFilter`. There is no `SaveDecision` type; `FilterDecision` is the name |
| Library queries | P3 | `store-api.ts` | library pages, Ctrl+K, P4, P6 | **exists**: `searchPages`, `recordOpen`, `getDocument` (Task 28) |
| Backup format | P3 | `packages/core/src/backup/format.ts`; writer in `apps/extension/src/backup/` | restore, P5 cloud backup | new |
| Markdown export | P3 | `packages/core/src/export/markdown.ts` | Ctrl+Shift+E, backup | new |
| Viewer links | P3 | `apps/extension/src/shared/viewer-url.ts` | library, export links | **exists** (Task 12): `ViewerParams` `source`, `back`, `page`. New: `doc`, `note` |
| Claude reply meta | P4 | `packages/core/src/claude/types.ts` | P2 keeps it intact, P3 search, P6, P8 | the `comments.meta` column **exists** |
| Claude turn and passages | P4 | `packages/core/src/claude/`; `apps/extension/src/viewer/claude/`; `packages/viewer/src/figures/render-region.ts` | P4, P6 | new |
| Secrets and local-only data | exists | `apps/extension/src/local-only/secrets-store.ts` | P3 Settings, P4 key, P5 token | **exists** (Task 29): `LocalOnlyStore`, `SecretName` (`anthropic_api_key`, `cloud_token`), `MetaKey` |
| Sync protocol | P5 | `packages/core/src/sync/{protocol,merge}.ts`; engine `apps/extension/src/sync/`; server `apps/cloud/src/sync/` | P5, P6 | the `outbox`, `rev`, `hlc` and `Hlc` **exist** (Task 28) |
| Cloud schema | P5 | `apps/cloud/migrations/{meta,text}/` | P5, P6 | new. Research 05 §9 is a draft and this file supersedes it |
| MCP tools | P6 | types in `packages/core/src/connector/tools.ts`; server in `apps/cloud/src/mcp/` | claude.ai, Claude Code | new |
| OCR results | P7 | `packages/core/src/ocr/types.ts`; engine in `apps/extension/src/ocr/` | `PageTextProvider`, search, P4 | `page_text.source` **exists** |
| PDF export mapping | P8 | `packages/core/src/export/pdf-mapping.ts` | P8 | new |

## 2. Annotation model (Phase 2)

```ts
// packages/core/src/ids.ts (Phase 2 adds)
export type MarkId = string & { readonly __mark: unique symbol };
export type ThreadId = string & { readonly __thread: unique symbol };
export type CommentId = string & { readonly __comment: unique symbol };
export type TabId = string & { readonly __tab: unique symbol };   // random per viewer page load; owns drafts
export type Author = 'me' | 'claude';                             // the v1 CHECK values. MCP shows 'me' as 'user'
// packages/core/src/model/anchor.ts: Task 28's union, with two optional v2 fields (absent = the v1 meaning)
export type Anchor =
  | { kind: 'text'; quote: TextQuote; start: CharPos; end: CharPos /* exclusive */; rects: { page: number; rects: NormRect[] }[];
      textSource?: string /* v2: 'pdfium' (default) | 'ocr:<engine>@<version>' */ }
  | { kind: 'area'; page: number; rect: NormRect; dHash: string }
  | { kind: 'figure'; page: number; rect: NormRect; figure: FigureFingerprint; sub?: { rect?: NormRect; point?: [number, number] } }
  | { kind: 'point'; page: number; point: [number, number] }
  | { kind: 'page'; page: number }
  | { kind: 'document' };
export interface FigureFingerprint { label: string | null; captionQuote: (TextQuote & { position: CharPos }) | null; imageSha256: string | null; dHash: string;
  detector: 'tagged' | 'objects' | 'caption' | 'manual' | 'layout-model'; detectorVersion: string;
  objectIndices?: number[] /* v2: indices into listPageObjects(page, { recurseForms: true }); a hint only, never proof */ }
// packages/core/src/model/rows.ts (Phase 2 adds; camelCase mirrors of the columns)
export type MarkStyle = 'highlight' | 'underline' | 'bold' | 'strike' | 'area';
export type MarkColor = 1 | 2 | 3 | 4 | 5;   // a slot: tokens --sop-mark-1 … --sop-mark-5 in packages/ui. Hex values live only in the token file
interface Synced { rev: number; hlc: HlcStamp; deletedAt: number | null }
export interface MarkRow extends Synced { id: MarkId; documentId: DocumentId; style: MarkStyle; color: MarkColor | null /* null for bold and area */;
  anchor: Anchor /* 'text' | 'area' | 'figure' */; pageIndex: number; sortKey: number; author: Author /* v2 */; createdAt: number; updatedAt: number }
export interface ThreadRow extends Synced { id: ThreadId; documentId: DocumentId; anchor: Anchor /* any kind */; pageIndex: number | null; sortKey: number | null;
  placement: 'placed' | 'unplaced'; draftOfTab: TabId | null /* v2 */; createdAt: number; updatedAt: number }
export interface CommentRow extends Synced { id: CommentId; threadId: ThreadId; documentId: DocumentId; author: Author; body: string /* Markdown */;
  draftOfTab: TabId | null; meta: CommentMeta; createdAt: number; editedAt: number | null }
export type CommentMeta = Record<string, never> | ClaudeReplyMeta | ConflictCopyMeta;   // '{}' for an owner comment
// packages/core/src/annotations/marks.ts: pure; the caller turns ranges into anchors (quote plus rects)
export interface StylePlan { create: { style: MarkStyle; color: MarkColor | null; start: CharPos; end: CharPos }[];
  shrink: { id: MarkId; start: CharPos; end: CharPos }[]; remove: MarkId[] }
export function planStyle(existing: readonly MarkRow[], target: { start: CharPos; end: CharPos }, style: Exclude<MarkStyle, 'area'>, color: MarkColor | null): StylePlan;
// packages/core/src/anchoring/reanchor.ts
export const FUZZY_MIN_SCORE = 0.8, FUZZY_MIN_QUOTE = 12;
export type PlacedBy = 'stored' | 'same-page' | 'fuzzy' | 'figure-match' | 'caption' | 'image';
export type Resolution = { placed: true; by: PlacedBy; score: number; anchor: Anchor /* positions and rects for these bytes */ }
  | { placed: false; reason: 'quote-not-found' | 'below-threshold' | 'figure-not-found' | 'no-text' };
export interface AnchorContext { pageCount: number; text: PageTextProvider; figures(pageIndex: number): Promise<PageFigure[]>; dHash(pageIndex: number, rect: NormRect): Promise<string> }
export function resolveAnchor(a: Anchor, ctx: AnchorContext): Promise<Resolution>;
// packages/viewer/src/text/page-text.ts: the one way marks, find and Claude read text. Phase 7 adds an OCR source
export interface PageTextProvider {
  source(pageIndex: number): string;                                            // 'pdfium' | 'ocr:<engine>@<version>'
  text(pageIndex: number): Promise<string>; glyphs(pageIndex: number): Promise<PageGlyphs>;
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;   // merged line rects (FPDFText_CountRects/GetRect, R44)
  search(pageIndex: number, query: string, o: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
}
// PdfBackend additions: getTextRects(doc, pageIndex, start, count): Promise<PdfRect[]> (Task 22 adds it for R44; if Task 22 shipped
// another name, that name stands and this line follows); getGlyphOutlines(doc, pageIndex, charStart, charCount): Promise<{ charIndex: number; d: string }[]> (Task 4 shape)
// packages/core/src/model/figures.ts: the JSON in page_figures.figures (a derived cache, never synced or backed up)
export interface PageFigure extends DetectedFigure /* Task 5: kind, rect (PdfRect, pt), label, captionRect, confidence */ {
  index: number; objectIndices: number[]; caption: { start: number; end: number; text: string } | null; imageSha256: string | null }
```

**What the model means**

- **Kinds of note.** Marks are highlight, underline, bold, strikethrough and area. A comment thread sits on a text passage (`text`), a rectangle (`area`), a figure (`figure`; a pin is `sub.point`, a sub-area is `sub.rect`), a point, a page or the whole document.
- **Marks and threads are independent rows.** Ctrl+Alt+M writes a thread, its first comment and a highlight `MarkRow` in one transaction. Removing or splitting a style never touches a thread. A thread whose passage has no style left draws a dotted underline (spec).
- **Several styles can overlap.** There is one `MarkRow` per style and continuous range, and a range may cross pages. `planStyle` toggles a style off when it already covers the whole target, and splits a mark as `shrink` plus `create` (new id). Applying a style puts it on the whole target and joins it with every same-colour mark the target overlaps or touches into one row: the leftmost keeps its id, the others are in `remove`. `shrink` names the range a mark has afterwards, so it also stretches a mark.
- **Anchors keep both W3C selectors.** `quote` with `prefix`/`suffix` is the W3C TextQuoteSelector (`quote` = `exact`). `start`/`end` is a TextPositionSelector scoped to one page, and `page + 1` is the RFC 8118 `#page=N` fragment. Each one is the fallback for the other. Rects are computed at creation from `PageTextProvider.rects`, so a mark draws without waiting for text. An empty `rects` array means "compute on open" (comments made in claude.ai).
- **Re-anchoring order (spec):** the stored position, if the quote still matches there; then the quote on the same page; then a fuzzy match across the document, at score ≥ 0.8 on a quote of ≥ 12 chars. Pages are searched nearest-first from the stored page (Hypothesis #3705): of several places that agree about equally well, the one on the nearest page wins, and two at the same distance are not placed. **Line breaks are not content (ruling R52):** matching treats a line break and a run of spaces as one space, so the same words with new line breaks are found by the first two steps, quietly, with no "Moved" label. Figures: the stored rect while the fingerprint matches, then the caption, then the image hash. Anything else is "Couldn't place".
- **Resolution is a view, not data.** It depends on which bytes are open (a stamped alias shifts char indices). It is computed on open and kept in memory, and it never writes the stored anchor. `threads.placement` stays `'placed'`; the UI reads the in-memory `Resolution`. A fuzzy placement is never silent: the card shows a quiet "Moved" label. Hypothesis's open issue #7571 (July 2026) shows how a silent fuzzy jump to look-alike text goes wrong.
- **Lifecycle.** `deletedAt` is a soft delete, and Trash restores it for 30 days. After 30 days the body is blanked and the row stays as a tombstone, because sync needs it. Only `forgetDocument` hard-deletes (Task 28, R13). `author` never changes. The owner may delete a Claude row but not rewrite it.

## 3. Threads and replies (Phase 2 stores them; Phase 4 writes Claude's)

```ts
// packages/core/src/claude/types.ts (Phase 4 owns; Phase 2 stores the JSON as-is and preserves unknown fields)
export type ModelRole = 'default' | 'think-harder';
export interface PageCitation { n: number; pageIndex: number; start: number; end: number; textSource: string; quote: string }
export interface WebSource { n: number; url: string; title: string; citedText: string | null }
export interface ReplyError { code: 'interrupted' | 'network' | 'no-key' | 'bad-key' | 'refused' | 'over-cap' | 'rate-limited' | 'server' | 'cancelled'; message: string /* plain words */ }
export interface ClaudeReplyMeta {
  kind: 'claude-reply'; v: 1;
  role: ModelRole | null;            // null when Claude wrote it through the connector
  status: 'pending' | 'streaming' | 'done' | 'error'; error: ReplyError | null;
  questionId: CommentId | null;      // the owner comment that asked
  citations: PageCitation[]; webSources: WebSource[];
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; webSearches: number; usd: number } | null;
  scope: 'passages' | 'whole-document'; figureLabels: string[]; via: 'viewer' | 'connector';
}
export interface ConflictCopyMeta { kind: 'conflict-copy'; v: 1; of: CommentId; device: string }   // shown as "Edited on another device" (Phase 5)
```

- A thread is an ordered list of `CommentRow`s (by `createdAt`). The first is the root, and the rest are replies from the owner or from Claude. There are no nested replies.
- A reply body cites inline with Markdown links: `[p. 4](cite:1)` points at `citations[n = 1]`, and `[source](web:2)` points at `webSources[n = 2]`. The viewer turns them into chips that jump to the passage. Export rewrites them (§9).
- **A Claude reply's row lifecycle.** `draftOfTab` means "not final yet, owned by this tab". It covers a note being typed and a Claude reply being written.
  1. The tab creates the reply row first: `author 'claude'`, empty body, `draftOfTab = this tab`, status `pending`.
  2. Streamed text is written to the row at most every 500 ms, with status `streaming`.
  3. On `done`, the row gets its final body, citations, sources and usage, and `draftOfTab = NULL` in one write. It now syncs and is searchable.
  4. On an error, the partial text stays, with status `error`. It stays local until "Try again", which reuses the same id, or until the owner dismisses it.
  5. On open, a `pending` or `streaming` row whose tab is gone becomes `error: interrupted`.
- **The "no lost text" gate.** Phase 2 must pass it before the marks UI ships, and Phase 4 again for replies.
  - A draft is saved within 300 ms of the last keystroke, and at once on blur, Esc, `visibilitychange` (hidden) and `pagehide`.
  - Kill the renderer 100 ms after typing stops, then reopen: the draft is back in its card with the caret at the end.
  - A draft disappears only when it is sent, when an empty new note is cancelled, or when the owner discards it.
  - A tab adopts drafts whose owner tab is gone. Live tabs answer a roll call on BroadcastChannel `sop-tabs` within 200 ms.
  - On a memory-only PDF (Task 30 `memory-only`), drafts stay in memory and nothing is written.
- **Phase 2 `StoreApi` additions:**
  - `listAnnotations(documentId): Promise<{ marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[] }>`. It returns live, non-draft rows.
  - `writeAnnotations(ops: { table: 'marks' | 'threads' | 'comments'; op: 'upsert' | 'soft-delete' | 'restore'; row: MarkRow | ThreadRow | CommentRow }[]): Promise<void>`. One transaction. Undo and redo are inverse batches.
  - `saveDraft(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): Promise<void>`. It publishes no change event and queues nothing for sync.
  - `sendDraft(commentId): Promise<void>`. It clears `draftOfTab` on the comment and its new thread in one transaction.
  - `listDrafts(documentId, tabId)`, and `claimDrafts(documentId, tabId, liveTabs: TabId[]): Promise<CommentRow[]>`.

## 4. Store schema v2 and later steps

```sql
-- SCHEMA_V2 (Phase 2). Additive only, one transaction, then user_version = 2.
ALTER TABLE marks ADD COLUMN author TEXT NOT NULL DEFAULT 'me' CHECK (author IN ('me','claude'));
ALTER TABLE threads ADD COLUMN draft_of_tab TEXT;     -- non-NULL = a new thread whose first comment is unsent; never synced
CREATE INDEX comments_drafts ON comments(draft_of_tab) WHERE draft_of_tab IS NOT NULL;
-- Triggers re-created by v2 (DROP TRIGGER, then CREATE):
--   threads outbox triggers: WHEN NEW.draft_of_tab IS NULL (DELETE: OLD.draft_of_tab IS NULL), as v1 already does for comments.
--   comments -> comments_fts: index only rows with draft_of_tab IS NULL AND deleted_at IS NULL. The UPDATE trigger handles
--   draft->sent, soft delete and restore. Then rebuild comments_fts once from comments.
```

- **Comment text in search.** v1's `comments_fts` (`comment_id`, `document_id`, `body`) already covers owner notes and Claude replies, including figure explanations. v2 only fixes which rows are indexed. Figure captions are page text, so `page_text_fts` covers them.
- **The version ladder.** It is reserved now, so parallel plans never collide. Phases 4 and 6 change no local schema.

| `user_version` | Owner | Adds |
| --- | --- | --- |
| 1 | Task 28 | the normative v1 |
| 2 | Phase 2 | the deltas above |
| 3 | Phase 3 | `documents_fts` skips trashed documents (trigger rewrite and rebuild); index `history(last_opened)` |
| 4 | Phase 5 | `sync_state(key TEXT PRIMARY KEY, value TEXT)`: cursor, device registration. Local only |
| 5 | Phase 7 | `page_ocr` (§9) |
| 6 | Phase 8 | `pdf_import_refs(document_id, pdf_ref, row_table, row_id, PRIMARY KEY (document_id, pdf_ref))` |

- **Migration rules:**
  - Only add: columns with defaults, tables, indexes, re-created triggers, and dropped and rebuilt derived data (FTS, `page_figures`). Never drop, rename or change the meaning of a column or value in a synced table. Never change a CHECK, because that needs a table rebuild.
  - v1 data stays readable: anchors without the new fields mean what they meant in v1.
  - JSON columns (`anchor`, `meta`, `figures`) keep unknown fields on rewrite, so readers spread rather than rebuild.
  - Each step is idempotent and tested from a filled v1 database.
  - Code that finds `user_version` higher than it knows opens read-only and shows "Update sickofpdfs". It never writes.
- **Change events** extend Task 28's `StoreChange` without breaking it:

```ts
export type StoreTable = 'documents' | 'aliases' | 'locations' | 'page_text' | 'history' | 'marks' | 'threads' | 'comments' | 'settings' | 'page_figures' | 'page_ocr';
export interface StoreChange { table: StoreTable; ids: string[]; op: 'upsert' | 'delete'; documentId?: DocumentId; origin?: 'tab' | 'sync' | 'restore'; tabId?: TabId }
```

- A viewer listens for changes to its own `documentId`, and ignores an event with its own `tabId` (its own echo). Draft writes publish nothing. Applied sync and restore rows publish with `origin` set, so open tabs redraw. Sync never listens to events: it reads the outbox.

## 5. Library and filter (Phase 3)

```ts
// packages/core/src/filter/types.ts: Task 30's names kept; Phase 3 adds optional fields only
export interface FilterInput { url: string | null; fileName: string; pageCount: number; pageSizes: PageSize[]; metadata: PdfMetadata;
  sampleText: string[] /* first and last 5 pages */; viaPage?: string | null /* course or referring page */ }
export type FilterRule = 'file-choice' | 'hard-block' | 'deny-list' | 'allow-list' | 'force-save' | 'score' | 'model' | 'no-text';
export type HardBlock = 'card' | 'iban' | 'sort-code-account' | 'ni-number' | 'ssn' | 'utr' | 'passport-line' | 'boarding-pass';
export interface FilterSignal { id: string; weight: number; label: string /* chip wording, e.g. "References section" */ }
export interface FilterDecision { verdict: FilterVerdict; reasons: string[]; score?: number /* starts at −1 */; rule?: FilterRule;
  signals?: FilterSignal[]; hardBlocks?: HardBlock[]; forceSave?: 'arxiv+references' | 'doi+abstract+references' | null; needsModel?: boolean }
export interface FilterRules { fileChoice: 'save' | 'never' | null; deny: string[]; allow: string[] /* hosts and folder prefixes */ }
export function classify(input: FilterInput, rules: FilterRules): FilterDecision;   // steps 1–2 of the spec, synchronous, < 150 ms
export function nudge(d: FilterDecision, sim: { learning: number; notLearning: number }): FilterDecision;   // step 3: MiniLM, verdicts only for 'unsure'
```

- **The order of rules (spec):** your choice for this file, then hard block, then deny and allow lists, then force save, then the score. With text, ≥ 3 saves, ≤ 0 does not, and anything between is `unsure`, which goes to MiniLM and then to the chip.
  - A card number blocks on its own. Any two of the other hard blocks block, unless positive evidence is ≥ 8.
  - A scan with no text is never saved automatically. It is `unsure` from scholarly sites or course pages, and `not-learning` otherwise (`rule 'no-text'`).
- **Privacy.** A `FilterDecision` never holds PDF text, numbers or matched strings. Reasons are fixed labels.
- **The save controller's filter.** Task 30's `filter` dependency widens to `(i: FilterInput) => FilterDecision | Promise<FilterDecision>`, so the stand-in still fits. The async filter is `classify`, then the MiniLM worker when `needsModel`.
- **Local-only additions** (`LocalOnlyStore`, viewer and Settings only):
  - `isNeverSave(sha)` and `addNeverSave(sha)`, stored as salted hashes using `filterSalt`;
  - `addFilterReport(sha, label)`;
  - `MetaKey` gains `'claudeSpendMonth'`, and the store gains `setMeta(k, v)`.
- **The backup folder handle.** It moves out of `sop-local` into its own IndexedDB `sop-handles` (store side, like `sop-device`), because the backup code may not import `sop-local` (R14). Permission is re-granted by a click from the badge.

```ts
// apps/extension/src/store/store-api.ts (Phase 3 adds)
export interface LibraryQuery { view: 'all' | 'recent' | 'starred' | 'trash'; sort: { by: 'title' | 'lastOpened' | 'added' | 'pages'; dir: 'asc' | 'desc' };
  filter?: { starred?: boolean; hasNotes?: boolean; readFrom?: number; readTo?: number; kind?: DocumentRow['kind'][] }; limit: number; cursor?: string }
export interface LibraryItem { doc: DocumentRow; firstOpened: number; lastOpened: number; readingMs: number; noteCount: number; location: LocationRow | null }
export type SearchHit =
  | { kind: 'reading'; documentId: DocumentId; title: string; snippet: string; rank: number }
  | ({ kind: 'page' } & PageHit)                                   // Task 28's PageHit: documentId, pageIndex, snippet, rank
  | { kind: 'note'; documentId: DocumentId; threadId: ThreadId; commentId: CommentId; author: Author; pageIndex: number | null; snippet: string; rank: number };
// listDocuments(q: LibraryQuery): Promise<{ items: LibraryItem[]; nextCursor: string | null; total: number }>
// search(q: { text: string; documentId?: DocumentId; kinds?: SearchHit['kind'][]; limit: number }): Promise<SearchHit[]>   // FTS terms quoted, never raw MATCH
// listNotes(o: { author?: Author; limit: number; cursor?: string }): Promise<{ items: { thread: ThreadRow; comments: CommentRow[]; title: string }[]; nextCursor: string | null }>
// recordReading(documentId, o: { at: number; msDelta: number; position: { page: number; offset: number; zoom: number }; pagesVisited: number[] }): Promise<void>
// setStarred(documentId, on), trashDocument(documentId), restoreDocument(documentId), purgeTrash(olderThan: number)
```

- **Search.** Snippets keep v1's `<b>…</b>` markers (Task 28 test). "Enter jumps to the passage" finds the first term on that page with `PageTextProvider.search`.
- **Viewer links.** `ViewerParams` gains `doc: DocumentId | null` (open the saved copy) and `note: ThreadId | null` (jump target).
- **Backup format v1.** It is written by the offscreen document into the chosen folder. Every file is written through `createWritable()`, so a half-written file never replaces a good one.

```text
sickofpdfs-backup/
  manifest.json            { format: 'sop-backup', version: 1, createdAt, schemaVersion, appVersion, counts, pdfs: { <sha>: size } }
  library.json             { tables: { documents, aliases, locations, marks, threads, comments, history, settings } }   camelCase row types, drafts excluded
  snapshots/library-<YYYY-MM-DD>.json   the last 7 nightly copies of library.json (open decision D6)
  pdf/<sha[0..2]>/<sha>.pdf             saved copies, written once per fingerprint
  notes/<title-slug>-<sha[0..8]>.md     the Markdown export of each document with notes
```

- **What a backup never holds:** `sop-local` (key, tokens, never-save list, reports), `sop-device`, drafts, FTS tables, `page_text`, `page_figures`, `outbox`, and anything from an unsaved PDF. A test scans every backup for the key.
- **Versions.** Restore reads any `version` up to the one it knows. It refuses a higher one with "Update sickofpdfs first".
- **Restore** merges by fingerprint and id. The newer `hlc` wins, and nothing local is deleted. Then text is re-extracted in the background. A forgotten document is removed from the backup at the next run. "Export library" zips the same layout.
- **Markdown export** (`exportMarkdown(doc, marks, threads, comments): string`):
  - Front matter: title, authors, DOI or arXiv id, source link, and `sickofpdfs: { documentId, format: 1 }`.
  - Then one `## Page N` section per page. Each item has the quote as a blockquote, a style label, the comment and its replies.
  - Bold quotes render as `**…**` and strikethrough as `~~…~~`. Highlight and underline get a label.
  - `cite:n` becomes "p. N" with a link back, and `web:n` becomes the source's URL. The link back is the canonical web link plus `#page=N`; for a file-only document it is the viewer link with `doc` and `page`.

## 6. Claude (Phase 4)

```ts
// packages/core/src/claude/passages.ts
export interface Passage { documentId: DocumentId; pageIndex: number; start: number; end: number; textSource: string; text: string; rank: number; tokens: number /* ceil(chars / 4) */ }
export interface PassageRetriever { getPassages(docId: DocumentId, query: string, tokenBudget: number): Promise<Passage[]> }
export function createPassageRetriever(src: { pageCount: number; text(pageIndex: number): Promise<string>; textSource(pageIndex: number): string;
  rankPages(query: string, limit: number): Promise<{ pageIndex: number; rank: number }[]> /* store FTS when saved; in memory when not */ }): PassageRetriever;
export interface DocumentMap { title: string | null; abstract: Passage | null; headings: { text: string; pageIndex: number }[]; figures: { label: string; pageIndex: number; caption: string }[] }
// packages/viewer/src/figures/render-region.ts: local rendering through PdfBackend.renderTile({ pageIndex, scale, rect, viewRotation: 0, withAnnotations: true })
export interface RegionImage { blob: Blob; mediaType: 'image/png' | 'image/jpeg'; width: number; height: number; scale: number /* px per pt = dpi / 72 */; visualTokens: number }
export function renderRegion(be: PdfBackend, doc: DocHandle, pageIndex: number, rect: PdfRect,
  o: { maxTokens: number /* 1,600; 3,200 think harder; 4,784 scans */; mark?: { rect?: PdfRect; point?: [number, number] }; format?: 'auto' | 'png' | 'jpeg' }): Promise<RegionImage>;
export interface FigurePack { label: string | null; pageIndex: number; image: RegionImage; caption: Passage | null; insideText: string; mentions: Passage[] /* ≤ 3 */ }
// packages/core/src/claude/types.ts
export interface ClaudeTurnRequest { documentId: DocumentId; threadId: ThreadId; questionId: CommentId; replyId: CommentId; role: ModelRole;
  scope: 'passages' | 'whole-document'; webSearch: boolean; focus: Anchor | null /* the thread's anchor */ }
export interface CitableBlock { title: string; pageIndex: number; start: number; end: number; textSource: string }   // blocks[i] = the i-th citable text block sent
export interface ContextPack { map: DocumentMap; focus: Passage | null; passages: Passage[]; figures: FigurePack[]; blocks: CitableBlock[]; estimate: { inputTokens: number; usd: number } }
export type ClientTool = 'search_document' | 'get_pages' | 'get_figure';   // run in the viewer; every result counts against the turn's budget
export type ClaudeStreamEvent =
  | { type: 'status'; status: 'pending' | 'streaming' } | { type: 'text'; delta: string }
  | { type: 'citation'; citation: PageCitation } | { type: 'web-source'; source: WebSource }
  | { type: 'tool'; tool: ClientTool | 'web_search'; state: 'running' | 'done'; label: string /* "Searching the web for …" */ }
  | { type: 'done'; meta: ClaudeReplyMeta } | { type: 'error'; error: ReplyError };
// apps/extension/src/viewer/claude/turn.ts (viewer tab only)
export interface ClaudeTurnRunner { run(req: ClaudeTurnRequest, onEvent: (e: ClaudeStreamEvent) => void, signal: AbortSignal): Promise<ClaudeReplyMeta> }
```

- **Passages.**
  - A passage is a paragraph, cut at sentence ends to ≤ 300 tokens. A default question sends the anchor's paragraph, the document map and the top 5 passages, within 3,500 tokens (the spec says 2,000 to 5,000).
  - `getPassages` never returns the whole document. "Ask about the whole document" is a separate path with a cost estimate first.
  - The output is deterministic for the same inputs, so the prompt cache holds.
  - It needs Phase 3's `search` with `documentId` for saved documents.
- **Citations.** Each passage and figure text is its own citable text block. `content_block_location` maps back through `blocks[i]` to a page and char range. Claude cannot cite an image, so a figure answer always carries a "Fig. N · p. M" chip.
- **The request.**
  - The order is: a frozen system prompt; the document map with `cache_control`; the images before their text packs; the passages; the question.
  - Web search is Anthropic's server tool, at most 3 uses per question, and only when `claude.webSearch` is on.
  - Follow-ups append to the exact blocks held in the tab's memory. After a reload, the thread is rebuilt from stored comments as plain text turns, and a cache miss is accepted. Nothing large is stored in `meta`.
- **Settings keys** (synced settings rows):
  - `claude.model.default` and `claude.model.thinkHarder`: the owner's choices, stored as data (D1);
  - `claude.webSearch` (default `true`);
  - `claude.monthlyCapUsd` (default `null`);
  - `claude.confirmOverUsd` (`0.25`).

  The month's spend is kept in `sop-local` as `claudeSpendMonth`.
- **Before sending:**
  - On a PDF that is not in the library, nothing is sent until the owner confirms.
  - An estimate over $0.25 asks first.
  - Over the monthly cap, the reply fails with `over-cap`.
- **The API key.**
  - Only viewer and Settings code read it, with `getSecret('anthropic_api_key')` (Task 29).
  - The Anthropic client is created in the viewer tab, which also makes the calls, because the service worker would cut long streams.
  - The key never enters the store worker, the offscreen document, a message to the service worker, backups, logs, error text or test hooks.
  - The network gate allows `api.anthropic.com` only during a request.

## 7. Sync (Phase 5)

```ts
// packages/core/src/sync/protocol.ts. The local outbox (Task 28) is the queue; a ChangeEntry is the wire form of one queued row.
export type SyncedTable = 'documents' | 'aliases' | 'locations' | 'marks' | 'threads' | 'comments' | 'history' | 'settings';   // = v1 SYNCED_TABLES
export interface ChangeEntry { table: SyncedTable; id: string; baseRev: number; hlc: HlcStamp; row: Record<string, unknown> /* camelCase row without rev */; label?: 'learning' /* documents only */ }
export interface PushRequest { device: string; entries: ChangeEntry[] /* ≤ 200 */ }
export interface PushResponse { applied: { table: SyncedTable; id: string; rev: number; seq: number }[]; rebased: (ChangeEntry & { rev: number; seq: number })[]; needBlobs: Sha256[]; needText: DocumentId[] }
export interface PullResponse { entries: (ChangeEntry & { rev: number; seq: number; device: string })[]; cursor: number; head: number; more: boolean }
export interface SyncStatus { state: 'off' | 'ok' | 'syncing' | 'offline' | 'stopped' | 'signed-out' | 'quota'; unsynced: number; lastSyncAt: number | null; message: string | null }
```

- **Records.** Every record is last-writer-wins by `hlc`, with server revisions and tombstones. There is no CRDT (research 05 §3).
  - The server bumps `rev` and assigns a global `seq`, the pull cursor.
  - A push applies only where `baseRev` equals the server's `rev`. Otherwise it is a conflict:
    - An edit concurrent with a delete wins, and the note comes back (spec).
    - Otherwise the newer `hlc` wins the whole row.
    - For comments, if both bodies are non-empty and differ, the loser's body becomes a new comment in the same thread with `ConflictCopyMeta`.
- **The local side.**
  - Each push sends the current row for each queued `(table, id)`, with the `baseRev` of the oldest queued entry.
  - A row created and deleted before it was ever pushed is dropped from the queue.
  - Pulled rows and acks are written with a connection flag that the outbox triggers check (`WHEN NOT sop_sync_applying()`), so they never queue a push.
  - `Hlc.receive` runs on every pulled stamp. The server clamps stamps more than 5 minutes ahead.
- **What never syncs:**
  - drafts, `page_figures`, FTS and caches;
  - page text, which goes through `PUT /api/text/:sha` with `extractor` = `page_text.source`.
  - File locations sync with the file name only. A pulled file location never overwrites a local full path. `firstSeen` merges by min and `lastSeen` by max.
- **Server rules.**
  - A document is accepted only with `label: 'learning'`. A child row is accepted only when its document is known.
  - `author` never changes. The `claude` device writes only `author = 'claude'` rows. Devices may soft-delete Claude rows but not edit them.
- **The cloud schema mirrors the local one.** The same table names, column names and values (`author` `'me'|'claude'`, `kind` `'paper'|'book'|'slides'|'other'`) go in `sop_meta`, plus server columns `seq`, `device` and `mcp_request_id`. Page text goes in `sop_text_n` shards, as in research 05 §9.2.
- **Blobs.**
  - The blob store holds only the first copy's bytes (`documents.id`), once per fingerprint, at R2 `pdf/<sha[0..2]>/<sha>.pdf` (the local `blobPath`). Aliases upload nothing.
  - `HEAD` comes first, and an existing key is skipped.
  - Up to 32 MiB, a single `PUT`, which R2 checks against `sha256`. Above that, multipart through the Worker in 32 MiB parts. The client re-hashes on every download.
  - Only saved documents upload, and only when the global switch is on and the document is not "keep local". Uploads run in the offscreen document.
- **Auth.**
  - GitHub OAuth, locked to the owner's numeric GitHub id. It is checked at the callback and again on every `/api` and `/mcp` request.
  - The extension signs in with `chrome.identity.launchWebAuthFlow`, PKCE, resource `…/api`, and scope `sync offline_access`. It is a client registered once at bootstrap, not DCR.
  - The refresh token is the `cloud_token` secret. Only a small token broker, `apps/extension/src/local-only/cloud-auth.ts`, reads it. The broker runs in the service worker, refreshes single-flight, and hands 1-hour access tokens to the offscreen sync engine, which never imports `sop-local`.
  - The web library uses a `__Host-` session cookie with CSRF checks.

## 8. Connector (Phase 6)

- **The protocol.** The Worker serves MCP at `/mcp` over Streamable HTTP, with no session. That fits the 2026-07-28 spec, which removed `initialize` and `Mcp-Session-Id`, and requires `Mcp-Method`/`Mcp-Name` headers. The handler keeps the legacy stateless lane for clients still on 2025-11-25.
  - Any state between calls is an explicit `cursor` the tool returns.
  - OAuth: CIMD first ("Use Claude's published identity"), because the new spec deprecates DCR. Restricted DCR remains a fallback.
  - The authorization server returns `iss` (RFC 9207).
  - Tokens are bound to `/mcp` or `/api`. Scopes are `library:read` and `library:comment`.
- **Output rules.**
  - Pages are 1-based, and `author` reads `'user' | 'claude'`.
  - Every result carries `url` = `https://<worker>/d/<sha>?page=N#c=<id>`. Output is capped at about 40,000 characters, and longer results paginate.
  - Write tools exist only with `library:comment`. Claude can never delete or change the owner's notes or download PDFs.

```ts
// packages/core/src/connector/tools.ts (input → output)
search_library({ query /* ≤ 300 */; scope?: 'all' | 'pages' | 'notes' | 'titles'; doc?: Sha256; limit?: number /* ≤ 25 */ })
  → { hits: { kind: 'reading' | 'page' | 'note'; doc: Sha256; title: string; page?: number; snippet: string; author?: 'user' | 'claude'; thread_id?: string; url: string }[] }
list_documents({ kind?: 'paper' | 'book' | 'slides' | 'other'; starred?: boolean; has_notes?: boolean; title_contains?: string; sort?: 'recent' | 'added' | 'title'; limit?: number; cursor?: string })
  → { documents: { doc: Sha256; title: string; authors: string[]; year: number | null; kind: string; pages: number; last_opened: string | null; note_count: number; url: string }[]; next_cursor: string | null }
get_document({ doc }) → { doc; title; authors; year; doi; arxiv_id; kind; pages; starred; locations: { kind: 'url' | 'file'; value: string }[]; text_available: boolean; notes_by_page: Record<number, number>; url }
read_pages({ doc; from; to /* ≤ from + 49 */; max_chars?: number /* ≤ 120,000 */ }) → { pages: { page: number; text: string }[]; next_from: number | null }
get_annotations({ doc; page_from?; page_to?; author?: 'any' | 'user' | 'claude'; limit?; cursor? })
  → { marks: { id; style; color; page; quote }[]; threads: { id; page: number | null; anchor: 'text' | 'area' | 'figure' | 'point' | 'page' | 'document'; quote: string | null;
      comments: { id; author; body; created_at; edited_at }[] }[]; next_cursor: string | null }
recent_activity({ days?: number /* ≤ 90 */; limit? }) → { items: { at: string; kind: 'opened' | 'added' | 'note' | 'claude-note'; doc; title; page?: number; snippet?: string }[] }
add_comment({ doc; page?; quote? /* exact text on that page, 3–500 chars */; reply_to?: string /* thread id */; body /* Markdown, ≤ 4,000 */; request_id: string /* uuid */ })
  → { thread_id; comment_id; anchored: 'quote' | 'page' | 'document' | 'reply'; url }
update_comment({ id; body }) → { comment_id; edited_at }   // Claude's own comments only (D3)
```

- **`add_comment`.**
  - It is idempotent on `request_id`.
  - The server checks the quote against that page's text in the shard. A missing quote is an error Claude can retry, so it is never stored as a guess.
  - It builds a `text` anchor with `start`/`end` found by position in the page text, a 32-char `prefix`/`suffix`, and `rects: []`. The viewer computes rects on open and keeps them in memory only.
  - The new comment has `author 'claude'` and `meta.via = 'connector'`, and every write is logged in the `audit` table.

## 9. OCR and export (Phases 7–8)

```ts
// packages/core/src/ocr/types.ts (Phase 7)
export interface OcrWord { text: string; box: PdfRect /* pt, unrotated page space */; confidence: number /* 0–1 */; line: number; block: number }
export interface OcrPageResult { documentId: DocumentId; pageIndex: number; engine: string; engineVersion: string; langs: string[];
  words: OcrWord[]; text: string /* words in reading order; offsets into it are this page's char indices */; createdAt: number }
export function ocrToPageGlyphs(r: OcrPageResult): PageGlyphs;   // one Glyph per char, boxes split across each word, so the text layer needs no change
// v5 table: page_ocr(document_id, page_index, engine, engine_version, words TEXT /* JSON OcrWord[] */, created_at, PRIMARY KEY (document_id, page_index))
```

- **OCR results merge at `PageTextProvider`.**
  - For an OCR page, `source()` is `ocr:<engine>@<version>`. `text()` is `r.text`, `glyphs()` is `ocrToPageGlyphs(r)`, and `rects` and `search` run on the word boxes.
  - So selection, marks, find, search and Claude treat a scan like text. The same text goes into `page_text` with that `source`.
  - Anchors on OCR text record `textSource`. An engine upgrade re-runs recognition and re-anchors by quote.
  - OCR runs only for saved PDFs. `page_ocr` is backed up, because it is costly to redo, but never synced; the cloud gets the text through `PUT /api/text`.
- **The PDF export mapping (Phase 8).** It uses PDFium incremental save through `PdfBackend.writeAnnotations`; the original file is never modified.
  - Every annotation gets `/NM` = `sop:<row id>` and `/T` = the owner's name or "Claude".
  - `/M` and `/CreationDate` come from the row. `/C` is the token colour's RGB, read from the same token file.
  - We write our own `/AP` appearance for every annotation.

| Our note | PDF annotation |
| --- | --- |
| Highlight / underline / strikethrough | `/Highlight` / `/Underline` / `/StrikeOut`, `/QuadPoints` from the anchor rects |
| Bold | `/Square` with no border and an `/AP` of the bolded glyph outlines, `/Subj (Bold)`. One per page the mark spans. A plain viewer shows bold text; the comment list shows "Bold" |
| Area mark | `/Square`, border in the mark colour, no fill |
| Text thread | Root: the `/Highlight` that covers the same range, if there is one. Otherwise an `/Underline` with a dotted `/AP`, matching the viewer. `/Contents` = the root comment as plain text, plus a closed `/Popup` |
| Area or figure thread | `/Square` on the rect (the figure outline) as the root, plus a `/Popup` |
| Pin, point or page note | `/Text` (note icon) at the point, or at the top-left margin of the page |
| Document note | `/Text` on page 1 with `/Subj (Document note)` |
| Replies | One `/Text` each with `/IRT` = root, `/RT /R`, and `/F` hidden. Fallback `replies: 'folded'` adds them to the root's `/Contents` instead, chosen after the Foxit and Acrobat round trip |

- **Bodies.** Markdown is flattened to plain text. A `cite:n` link becomes "(p. N)", and a `web:n` link becomes the URL.
- **Import.** Existing PDF annotations import as editable notes, de-duplicated by `/NM` (or the object number) through `pdf_import_refs`, so opening an exported copy never doubles notes.

## 10. Open decisions for the owner

Each item below has a recommended default. A planner uses the default until the owner decides.

| # | Question | Recommended default |
| --- | --- | --- |
| D1 | How does code pick a model without writing a model id? | Code knows the three families by name (Haiku, Sonnet, Opus) and their prices. Setup lists the live models from the Models API, and you pick a default and a Think-harder model. The chosen ids are stored as settings data, never in code. |
| D2 | Forget while offline. The cloud must still be told, but Forget keeps no trace. | Keep the fingerprint in a "waiting to remove from cloud" list in `sop-local` until the cloud confirms. It is the only trace, and it disappears then. |
| D3 | Can Claude delete its own comments through the connector? | Yes, its own comments only, as a soft delete you can undo. Add `delete: true` to `update_comment`. |
| D4 | Does a comment Claude adds in claude.ai also add a highlight? | No. Its thread shows the dotted underline, so 20 comments from Claude don't flood the page with colour. |
| D5 | The five mark colours. The spec line "Colours apply to highlight, underline and strikethrough:" stops before the list. | Drive and Docs-style yellow (default), green, blue, pink and orange, as tokens `--sop-mark-1..5`. The visual critic checks them on the dark canvas. |
| D6 | Backup snapshots. | Keep the last 7 nightly copies of `library.json` (small), so a bad day never overwrites the only good copy. PDFs are not duplicated. |
| D7 | The "Moved" label when a note was placed by a close match. | Show a quiet "Moved" label on the card, with "Show where it was" on hover. |
| D8 | Emptying Trash after 30 days. | Treat it like Forget for that document (no trace), and tell the cloud as in D2. |

## Sources

- Internal: the spec (normative); the Phase 1 plan's Tasks 4, 5, 15, 18, 19, 22, 23, 28, 29 and 30, its Amendments and its Carried requirements (R44); research 04 (A(ii), B.3–B.7), 05 (§1–4, 8, 9, 11) and 06 (§5, 7).
- MCP 2026-07-28 specification release notes (stateless core, `Mcp-Method`/`Mcp-Name`, DCR deprecated for CIMD, RFC 9207 `iss`): https://blog.modelcontextprotocol.io/posts/2026-07-28/ and the changelog at https://modelcontextprotocol.io/specification/2026-07-28/changelog
- Hypothesis on PDF quote anchoring, using the position as a page-order hint: https://github.com/hypothesis/client/issues/3705
- Hypothesis on a fuzzy fallback silently re-anchoring to look-alike text (opened 31 Jul 2026): https://github.com/hypothesis/client/issues/7571
- Hypothesis fuzzy anchoring strategy (position, then quote, then context-aware fuzzy match): https://web.hypothes.is/blog/fuzzy-anchoring/
