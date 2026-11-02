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
| Identity | exists | `packages/core/src/identity/` | store (`findStampAlias`), viewer open, P5 | **exists** (Tasks 18, 19): `createSha256`, `canonicalLink`, `locationId`, `stripStamps`, `stampedTextSimilarity`, `isStampAlias`, `ALIAS_THRESHOLD`. The alias rule is R59 (§4) |
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
  - A draft is saved within 300 ms of the last keystroke, and at once on blur, Esc, `visibilitychange` (hidden) and `pagehide`. The 100 ms crash rule below is stricter and wins: the keeper saves 5 ms after the last keystroke (`DRAFT_DELAY_MS`), and 300 ms is only the cap during continuous typing (`DRAFT_MAX_MS`).
  - Kill the renderer 100 ms after typing stops, then reopen: the draft is back in its card with the caret at the end.
  - A draft disappears only when it is sent, when an empty new note is cancelled, or when the owner discards it.
  - A tab adopts drafts whose owner tab is gone. Live tabs answer a roll call on BroadcastChannel `sop-tabs` within 200 ms.
  - On a memory-only PDF (Task 30 `memory-only`), drafts stay in memory and nothing is written.
- **Saving a PDF, and un-saving it (R67, 1 Nov 2026).** The moment a PDF becomes saved, or stops being saved, must never lose a note or say something untrue. Binding:
  - **(a) Save-pending.** A save takes time: it reads every page's text first, seconds on a long book. Marks and notes made before it lands are kept as *save-pending*.
    - They are written at once, synchronously, to a save-pending record in the extension's localStorage: `sop-pending:<fingerprint>:<tabId>:<page life>` (`save-pending.ts`). The record holds the writes still waiting, the unsent notes and the unsent edits.
    - Rows made before the save lands carry the opened file's fingerprint (its SHA-256) as their `documentId`. Never an empty document id: the draft keeper refuses a row without one.
    - When the save lands, every row and draft is re-stamped with the library id *before* anything is handed on. The drafts go to the keeper (and its journal) under that id; the record keeps only the writes still waiting, and goes once they are written.
    - A record is written only once a save is really on its way: the owner's mark or note started it, the owner pressed Save or answered Yes, or the filter is saving a learning PDF. Nothing is written while "Save this PDF to keep your notes?" is open, or after No.
    - If the tab closes or crashes mid-save, the next open of the same fingerprint (or of a stamped copy, once the document exists) takes the record of a tab that is gone. The pending save completes, because the owner's own action started it (`SaveController.resumeSave`), and the notes come back.
    - If the save fails, the text stays in memory and in the record, and the chip says "Couldn't save. Try again". A click saves.
  - **(b) Only real content saves.** The first applied mark (highlight, underline, bold, strike, area), or the first real keystroke in a new note, triggers the save. Opening an empty note box never saves. Esc on an empty new note leaves nothing saved and nothing stored. A note that was typed, emptied and closed, with nothing else made in any tab, takes back the save it started (`SaveController.withdraw`). On a PDF judged not learning, Ctrl+Alt+M still asks its question at once (asking is not saving).
  - **(c) Undo only removes what it promises.** The first-mark Undo chip goes as soon as there is anything else: another mark, an open note box, or a typed note, in any tab. A tab tells the others on BroadcastChannel `sop-save` (`{ type: 'more-content', ids: [fingerprint, documentId?] }`). A save this tab did not create (another tab got there first) has no Undo either. So Undo only ever removes the save and that one mark (R62), and Undo with a note box open is impossible.
  - **(d) Every open tab follows a forget or Undo.** On a `documents` delete of its own PDF, a tab's save controller goes back to "Not sure", and its session drops the rows the store no longer has. A tab never shows "Saved" for a PDF that isn't saved. Its next mark or keystroke saves again, as a first one.
  - **(e) Forget clears everything.** Undo and Forget also remove the PDF's localStorage: its drafts-journal entries, its save-pending records, and its `sop:notes.marginAtOpen` hint, under both the library id and the file's fingerprint (`forgetLocalTraces`).
  - **(f) A save a note started has no Undo chip at all.** A typed note is deliberate work and must never vanish on a quick Undo; the owner can delete the note itself. The chip exists only for a save a mark started, which is cheap to redo.
  - **R67 tightened (1 Nov 2026, after security read 3).** Binding, and where it differs from the lines above, it wins:
    1. **Undo never deletes content another tab or another fingerprint added.** That includes a second download of the same PDF that is still being identified ("checking") and becomes a stamp alias. While any tab on the same document, or on a copy still being identified, has content, the Undo chip is gone everywhere.
       - A tab tells the others the moment it has content, in any state: `{ type: 'more-content', ids: [fingerprint, documentId?], checking, pageCount }` on `sop-save`. A message with `checking: true` counts for every tab whose PDF has the same page count (a stamp alias always has, R59 a).
       - A change whose save finds the PDF already saved (another tab's save, or a copy of a saved one) calls `contentAdded()`, so every Undo goes.
       - When Undo is pressed, the controller checks again and gives no Undo if another tab said it has content, if another tab left a save-pending record for the fingerprint or the library id, or if the library holds any thread or comment, or more marks than the first mark made (`firstMark({ rows })`).
       - Content a tab made that the store never had, and that survives another tab's Undo, is saved again at once, with no Undo.
    2. **A mark or note made during "checking" is save-pending at once**, keyed to the opened sha256. The record is written before the wait for "checking" to end. It is dropped while "Save this PDF?" is open (not learning, not yet answered) and after No.
    3. **No Undo for any save that carries note text.** That includes the save after a failed save (a mark, or Enter, starts it again) and a save resumed on reopen. A resumed save never offers Undo; on a PDF judged not learning it asks first.
    4. **Save-pending records are never silently dropped.** On reopen the chip shows "Saving your notes…" until the save lands (`SaveControllerImpl.resuming`). A record whose PDF is not opened again shows on the library's "Recovered notes" (R77) once its `at` is 7 days old, with Copy and Delete (`listRecoveredNotes`, `deleteRecoveredNote` in `recovered-notes.ts`, with the journal drafts that have no document). A record goes only when its notes are back in place (the reopened tab takes it over), when the owner deletes it there, on the owner's No, on Forget, or on an Undo that the record's own tab is allowed to make (rule 1).
    5. **The restored draft shows on the first adopt.** Measured: after a crash just as the save lands, the note appears 4–217 ms after the stored marks (the first adopt waits for the 200 ms roll call). The session also looks once more 1.5 s after the PDF is stored.
    6. **A tab that follows a forget clears its own file's margin hint** (a second download's too).
    7. **Re-check of de49e7e (2 Nov).** An empty note box is not content: the `more-content` message carries `content`, `false` for an empty note or reply box. It ends a first-mark Undo chip (or makes a save on its way land without one), and nothing else; only `content: true` (a mark, a keystroke, a send) counts as another tab's content. A save resumed for a tab that crashed keeps its save-pending record while it asks "Save this PDF?" (`SaveController.resuming`), and drops it only on No.
  - **Interfaces (normative).** `SaveController.firstMark(o?: { undoable?: boolean; rows?: number })`: `undoable: false` when the save carries note text, or when more was made before it began; `rows` is how many mark rows the first mark made. Optional members, so a controller without them still fits: `busy` (`'save' | 'forget' | null`), `endUndo()` (c: ends this tab's Undo and tells the others), `announce()` (tightened 1: tells the others only), `withdraw()` (b), `resumeSave()` (a: never with an Undo). The save machine (`reduceSave`) takes `{ type: 'first-mark', undoable? }` and `{ type: 'resume-save' }` (unsure: saves with no Undo; not learning: asks). `SaveControllerImpl.resuming` is true while a resumed save is finished. `SaveControllerImpl.failed` is true after a failed save until something saves the PDF. `SessionDeps` takes `fingerprint` and `pending` (`localPendingSaves()`; none in unit tests). `DraftKeeper.sentEdit?(commentId)`: the edit was sent and its live write is on its way; a new edit of the same note begins a new session, which is journaled at once but reaches the store only after `dropEdit` (the live write closes whatever edit of that tab is open). The session calls `dropEdit` when that write has actually landed, not after a fixed wait.
- **Phase 2 `StoreApi` additions:**
  - `listAnnotations(documentId): Promise<{ marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[] }>`. It returns live, non-draft rows.
  - `writeAnnotations(ops: { table: 'marks' | 'threads' | 'comments'; op: 'upsert' | 'soft-delete' | 'restore'; row: MarkRow | ThreadRow | CommentRow }[]): Promise<void>`. One transaction. Undo and redo are inverse batches.
  - `saveDraft(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): Promise<void>`. It publishes no change event and queues nothing for sync.
  - `sendDraft(commentId): Promise<void>`. It clears `draftOfTab` on the comment and its new thread in one transaction.
  - `listDrafts(documentId, tabId)`, and `claimDrafts(documentId, tabId, liveTabs: TabId[]): Promise<CommentRow[]>`.
- **Draft APIs added during Phase 2** (triage rulings and R54, recorded 1 Nov). They are normative: `apps/extension/src/store/annotations.ts` and `apps/extension/src/viewer/annotations/drafts.ts` implement them, and a store without any of them is a compile error in `DraftStore`.
  - **`StoreApi`**
    - `listDraftThreads(documentId, tabId): Promise<ThreadRow[]>`. The new threads of a tab's drafts, so a restored draft knows where it sits (`listDrafts` returns comments only).
    - `discardDraft(commentId): Promise<void>`. Deletes an unsent draft and its new thread when nothing else is in it. It does nothing to a comment that was sent, so it is safe to call after a send.
    - `writeAnnotations` also sends a stored draft in place: an upsert of a thread or comment whose id is a stored draft, with a row that is not itself a draft (`draftOfTab` null), clears `draft_of_tab` on that same row, keeps the id and stores the final text and `meta`. The outbox and `comments_fts` triggers then queue and index it in the same transaction. A row that is itself a draft is refused (`use-save-draft`); `soft-delete` of a draft deletes it for good. A batch that would leave a sent comment in a thread that is still a draft is refused.
    - A late `saveDraft` for a comment that was sent is refused (`not-a-draft`), and `saveDraft` for a draft owned by another tab is refused (`draft-owned-elsewhere`). Neither can overwrite text.
    - Errors are rejections whose message starts with a code (`read-only: …`, `edit-closed: …`), so the code survives a message port.
  - **Edit drafts (R54): editing a note that was already sent is crash-safe too.** The in-progress edit is a tab-owned edit draft keyed to the comment, in its own table `comment_edits` (§4). It never syncs, is never searched, never shows as the live text, and publishes no change event. One row per comment.
    - `saveEditDraft(e: { commentId; editId: string; draftOfTab: TabId; body: string }): Promise<void>`. `editId` names one edit session and sorts by the time the session began. Refused: an unknown or deleted comment (`not-found`), a comment that is itself a draft (`use-save-draft`), a session that was sent or cancelled or replaced by a newer one of the same tab (`edit-closed`, the late-save guard), an edit owned by another tab (`draft-owned-elsewhere`), and another tab's different edit still open (`edit-in-progress`). A newer session of the same tab takes over from an older one.
    - `listEditDrafts(documentId, tabId): Promise<EditDraft[]>` and `claimEditDrafts(documentId, tabId, liveTabs): Promise<EditDraft[]>`, which adopts the open edits of tabs that are gone, like `claimDrafts`. `EditDraft` is `{ commentId, threadId, documentId, editId, draftOfTab, body, updatedAt }`. An edit of a deleted comment is hidden and comes back with the comment.
    - `discardEditDraft(commentId, editId): Promise<void>`. Closes that session: its text is cleared and a late save of it is refused from now on (a closed row stays as a marker with no text, and is swept after 7 days). It leaves a different session alone and never touches the live text. It leaves the marker even when nothing was stored yet.
    - **Sending an edit** is a `writeAnnotations` upsert of the comment by the same tab (`o.tabId` is the owner of the open edit). The live text is replaced and that tab's open edit closed in the same transaction. A soft-delete of the comment by the owner tab closes it too. A write by another tab, or one with no `tabId`, leaves the edit open.
    - **Cancelling** an edit is `discardEditDraft`.
  - **`DraftKeeper`** (viewer, `createDraftKeeper({ store, presence, memoryOnly, onError? })`)
    - `draftThread(threadId): ThreadRow | undefined`. The new thread of a restored or changed draft.
    - `dispose(): void`. Removes the page listeners and timers. It does not write; `flush()` first if that is wanted.
    - `changeEdit(comment: CommentRow, body: string): void`. The person is editing a sent comment; `comment` is the sent row as it is (its live text is not touched). Saved like a draft (5 ms after the last change, at once on `flush()`, `visibilitychange` (hidden), `pagehide` and `freeze`). The first call starts an edit session.
    - `dropEdit(commentId): void`. The edit is over, sent or cancelled: forget it and close it in the store. Call it after the live write and on cancel.
    - `editDrafts(documentId): EditDraft[]`. The unsent edits this tab holds, restored by `restore` or typed here. `restore` adopts the edits of gone tabs with the same roll call.
    - `onError(id, error)` in the deps is told about every failed write or delete. A failed write stays in memory and is retried; `flush()` rejects while one is unsaved.
    - **The journal (R56 corrected, 1 Nov).** A renderer crash kills the offscreen store with the tab, so `journal` in the deps (`localDraftJournal()` in the viewer, `draft-journal.ts`) gets a copy of every draft and edit draft in the same call as the change, in the extension's localStorage. There is one key per draft: `sop-draft:c:<commentId>` or `sop-draft:e:<commentId>`. It follows the store's rules: nothing for a PDF that is not saved, nothing in Incognito, never synced or searched. `restore` takes a journal text the store has not confirmed (`pending`) over the store's, under a per-document Web Lock. An entry goes when the store confirms the send or the delete, and `forgetDraftJournal(documentId)` runs wherever a document is forgotten. **R77 (1 Nov):** `clear(documentId)` removes only entries that parse and name that document. An entry that cannot be parsed or placed (no document id, as Test build 2 could write) is never deleted by any clear; it shows under "Recovered notes" (`listRecoveredNotes`), and only the owner's Delete there removes it. **R66 (1 Nov):** on restore, an entry whose comment id is already a sent row in the store, with the same text (or, for an edit draft, whose text equals the live text because the edit was already applied), is dropped silently and never shown; an entry whose text differs from the sent text is never dropped.
    - `sent?(commentId)`: the session calls it once the store has confirmed a comment as a sent row (or deleted it). The keeper forgets that draft and its journal entry, and does not touch the store.
    - **For the session (S9):** type each keystroke of an edit with `drafts.changeEdit`, show `drafts.editDrafts()` as the unsent edits after a reload, send with the existing `editComment` write and then `dropEdit`, cancel with `dropEdit`. A restored edit reopens the editor with the unsent text; the live text stays until it is sent.
  - **`TabPresence`**: every tab also holds a Web Lock `sop-tab:<tabId>` for as long as it lives, and `liveTabs` counts holders as live too, so a busy tab that misses the 200 ms roll call is not mistaken for a gone one. `createTabPresence` takes an optional `{ tabId, lockHeld }`.
    - **One tab keeps one id across its own reloads (R65).** `claimTabIdentity()` runs as the viewer page starts. It reuses the id in the tab's sessionStorage (`sop-tab-id`) if no live page holds its lock, and otherwise makes a new one; either way it holds the lock for the life of the page. `tabIdentity()` gives the result to `createTabPresence`. After a crash, each tab that comes back owns its drafts again; a duplicated tab gets a new id.

## 4. Store schema v2 and later steps

```sql
-- SCHEMA_V2 (Phase 2). Additive only, one transaction, then user_version = 2.
ALTER TABLE marks ADD COLUMN author TEXT NOT NULL DEFAULT 'me' CHECK (author IN ('me','claude'));
ALTER TABLE threads ADD COLUMN draft_of_tab TEXT;     -- non-NULL = a new thread whose first comment is unsent; never synced
CREATE INDEX comments_drafts ON comments(draft_of_tab) WHERE draft_of_tab IS NOT NULL;
-- R54: the unsent edit of a comment that was already sent. A table of its own: a column on comments would fire the outbox and
-- comments_fts triggers on every keystroke. Not a synced table, so no triggers; goes with its comment or document (cascade).
CREATE TABLE comment_edits (
  comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  edit_id TEXT NOT NULL,                  -- names one edit session; sorts by start time
  draft_of_tab TEXT,                      -- the owner tab; NULL once closed
  body TEXT NOT NULL,                     -- the unsent text; '' once closed
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed')),   -- a closed row is the marker that refuses a late save
  updated_at INTEGER NOT NULL,
  CHECK (state = 'closed' OR draft_of_tab IS NOT NULL));
CREATE INDEX comment_edits_owner ON comment_edits(document_id, draft_of_tab);
-- Triggers re-created by v2 (DROP TRIGGER, then CREATE):
--   threads outbox triggers: WHEN NEW.draft_of_tab IS NULL (DELETE: OLD.draft_of_tab IS NULL), as v1 already does for comments.
--   comments -> comments_fts: index only rows with draft_of_tab IS NULL AND deleted_at IS NULL. The UPDATE trigger handles
--   draft->sent, soft delete and restore. Then rebuild comments_fts once from comments.
--   R67 minor (1 Nov): the UPDATE trigger is `AFTER UPDATE OF body, draft_of_tab, deleted_at, document_id ...
--   WHEN OLD.draft_of_tab IS NULL OR NEW.draft_of_tab IS NULL`, so saving a draft never touches the index (its DELETE scans
--   it). A database already at v2 gets it on open (`refreshCommentsFtsTrigger`): a re-created trigger, no data change.
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
- **Local keys that hold notes (R67 tightened, 1 Nov).** `sop-draft:c|e:<commentId>` (the drafts journal) and `sop-pending:<fingerprint>:<tabId>:<page life>` (save-pending) are the only localStorage keys that hold note text. Neither is synced, backed up or searched. Both are listed for "Recovered notes" when they can no longer be placed (a journal entry with no document id, a save-pending record 7 days old). `sop:notes.marginAtOpen` holds hash prefixes only, and every tab clears its own file's prefix when it follows a forget.
- **The clock after a restart (R67 minor, 1 Nov).** The store's hybrid clock starts past the newest stamp on any stamped row (`documents`, `aliases`, `locations`, `marks`, `threads`, `comments`, `history`, `settings`, `outbox`), not only the outbox's. Sync empties the outbox from Release 2 on, and a draft's stamp can be newer than the outbox's.
- **Change events** extend Task 28's `StoreChange` without breaking it:

```ts
export type StoreTable = 'documents' | 'aliases' | 'locations' | 'page_text' | 'history' | 'marks' | 'threads' | 'comments' | 'settings' | 'page_figures' | 'page_ocr';
export interface StoreChange { table: StoreTable; ids: string[]; op: 'upsert' | 'delete'; documentId?: DocumentId; origin?: 'tab' | 'sync' | 'restore'; tabId?: TabId }
```

- A viewer listens for changes to its own `documentId`, and ignores an event with its own `tabId` (its own echo). Draft writes publish nothing. Applied sync and restore rows publish with `origin` set, so open tabs redraw. Sync never listens to events: it reads the outbox.

### Identity: when a re-download is the same document (R59, 1 Nov 2026)

- **One rule decides.** `isStampAlias(a, b)` in `packages/core/src/identity/stamps.ts`, with `a` and `b` the text of each page. The store's `findStampAlias` calls it on every candidate with the same page count, and records `stampedTextSimilarity(a, b)` as the alias's `similarity`. Nothing else decides.
- **All four must hold.**
  - (a) The page counts are equal.
  - (b) Once the stamps are removed and the text is folded (`text-fold.ts`: marks that are not text dropped, whitespace and ligatures folded), the **letters and digits are the same, in the same order**. The two texts may differ only in whitespace, punctuation and accents.
  - (c) `stampedTextSimilarity` is at least `ALIAS_THRESHOLD` (0.995). It stays as a sanity floor.
  - (d) Each side has real body text: at least `MIN_ALIAS_CHARS` (200) letters and digits, and `MIN_ALIAS_CHARS_PER_PAGE` (30) per page on average. A blank scan, or a scan whose text layer is only page numbers, never aliases. Its score is 0, never `NaN` or 1.
- **Why (b).** A percentage cannot tell a re-download from a new version. An arXiv v2 that corrects three numbers scores about 0.9999 against v1, and would have shared v1's notes. On 37 real arXiv version pairs with equal page counts, the percentage alone aliased 8, and the rule aliases none. A missed alias costs a re-save; a wrong alias shows the wrong notes.
- **Stamps are looked for after folding**, so a stamp whose line has marks at its edges, or a date split across a line break, is still found. The patterns are phrases, not line anchors. They remove the JSTOR lines, `Downloaded from <link> [by <who>] on <date>`, `Downloaded by [<who>] at <when>`, IP addresses, dates (ISO, `Tue, 31 Oct 2026 10:41:07 UTC`, `31 October 2026`, `October 31, 2026`, `31/10/2026`, `31-10-2026`) and times. The arXiv stamp keeps its version (`arXiv:1706.03762v2`), so two versions never match.
- **A stamp this list does not know** leaves letters or digits that differ, so the copies do not alias. That is the safe direction.

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
// setTitle(documentId, title): Promise<void>   // R76: Rename; trimmed, 1–300 characters, a trashed reading too; publishes a documents upsert
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
- **Backup safety (secread4 rulings, backupfix, 2 Nov 2026).**

```ts
// apps/extension/src/store/backup-api.ts (StoreApi extends BackupApi)
applyRestorePlan(backup: LibraryDump): Promise<RestoreResult>   // was (plan: RestorePlan): Promise<void>. Plans with planRestore against the rows as they are
                                                                // now and writes, in ONE transaction; never deletes; same backup twice changes nothing
interface RestoreResult { summary: RestoreSummary; needsPdf: DocumentId[]; forgotten: number /* readings left out */; skipped: number }
forgottenAmong(ids: readonly string[]): Promise<string[]>        // ≤ 10,000 ids; read-only. Fingerprints that left for good and are not in the library now
// apps/extension/src/backup/restore-read.ts (S17 uses it)
readBackupFolder(folder: FileSystemDirectoryHandle): Promise<{ ok: true; manifest; dump; root } | { ok: false; reason: 'no-backup' | 'no-library' | 'too-big' | 'too-new' | 'damaged'; message }>
openBackupPdf(root, sha, manifest): Promise<File | null>         // caps: manifest 16 MiB, library.json 256 MiB, a PDF 1 GiB and the manifest's size
```

  - **Forgotten list.** Forget, a Trash purge and an Undo of a save record salted SHA-256 hashes of the reading's fingerprint and its aliases in the store's local tables `forgotten (hash, forgotten_at)` and `local_meta` (`forgottenSalt`), in the same transaction as the delete. Never exported, backed up or synced. A restore leaves those readings out, with everything hanging off them.
  - **A restore never moves a note.** A mark, thread, comment or location keeps its reading; a comment keeps its thread and author; a new comment must hang off a thread of its own reading. Such rows are dropped before planning (so no conflict copy is made from them) and again when written.
  - **Scrub (R75, R82).** Removes only the reading's own rows, PDF copy (and `.part`), and notes file. A readable file is rewritten without those rows; another reading's note that mentions the id stays as it is. A file is never deleted to clean it; one that cannot be read is left and named in the status (`unreadable`), and the removal stays pending.
  - **Queue (R82).** A `documents` delete event queues a removal for the chosen folder; each run drains it first, then asks `forgottenAmong` about readings it wrote that the library no longer has (a lost event). Trash alone does not scrub.
  - **Holds (R86).** `HeldReason` = `'other-library' | 'unreadable' | 'many-missing' | 'notes-missing'`: a `library.json` that is there but cannot be read; readings this library never wrote; every known reading gone (any count), or ≥ 5 and > a quarter; notes (live marks + comments) down by ≥ 20 and ≥ half since the last good run. Readings on the scrub list or the forgotten list never count. The badge shows "!" for a hold too, with the reason as its tooltip; the library pill "Backup needs a look" opens a card with the reason, "Not now" and "Back up anyway".
  - **`sop-handles` v2.** `known` holds `{ v: 2, readings: { <id>: <notes at the last good run> } }` (a v1 `string[]` still reads). New store `retired` (auto id): `{ target, scrubs, retiredAt }`, a folder the owner moved away from with removals still waiting. `changeTarget(next, { same })` replaces `clearTarget`: the same folder picked again keeps `known` and its pending list; another folder (or Turn off) moves the pending list to `retired`. "Change folder" and "Turn off" first try to finish the removals (asking Chrome inside the click). Settings says "1 removal is waiting for <folder>" with "Try now" (`backupClient.finishRemovals()`); each run retries.
  - **PDF copies** are written to `<sha>.pdf.part` and moved into place. Each run removes `*.crswap` older than a day and leftover `*.part` files.
  - **Forget dialog:** "Removed from your library and your backups. Google Drive or OneDrive may keep their own copy in their trash for a while." (`FORGOTTEN_EVERYWHERE`).
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
export interface ModelChoice { id: string /* data from the Models API */; displayName: string; line: string | null; imageInput: boolean;
  webSearchTool: string | null /* the tool type probed at setup */; maxInputTokens: number | null; checkedAt: number;
  serverFallback?: boolean /* set at setup when the model's info lists fallback models; only Think harder uses it */ }
export interface CitableBlock { title: string; pageIndex: number; start: number; end: number; textSource: string;   // blocks[i] = the i-th citable text block sent
  via?: { kind: 'document' | 'search_result'; index: number; block: number } /* where in the request it sits */ }
// packages/core/src/claude/request.ts
export interface ThreadTurn { role: 'user' | 'assistant'; content: string | { type: string; [key: string]: unknown }[] }
export function buildRequest(pack: ContextPack, turns: readonly ThreadTurn[], o: { role: ModelRole; model: ModelChoice; webSearch: boolean }): Promise<{ params: MessagesParams; blocks: CitableBlock[] }>;
// packages/core/src/claude/stream-map.ts
export function createStreamMapper(blocks: readonly CitableBlock[], onEvent: (e: ClaudeStreamEvent) => void,
  opts?: { role?: ModelRole | null; questionId?: CommentId | null; scope?: 'passages' | 'whole-document'; figureLabels?: string[]; price?: ModelPrice | null }): StreamMapper;
// StreamMapper: push(rawEvent), finish(finalMessage), fail(error), snapshot(), stopReason(); finish and fail return ClaudeReplyMeta & { body: string }
// packages/core/src/claude/cost.ts
export function decide(i: { estimateUsd: number; spentUsd: number; capUsd: number | null; confirmOverUsd: number | null; saved: boolean;
  scope: 'passages' | 'whole-document'; priceKnown: boolean /* required */; confirmed?: readonly Ask[] }): 'send' | { ask: Ask; usd: number } | { block: 'over-cap' };   // Ask = 'unsaved' | 'over-threshold' | 'whole-document'
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
- **Citations.** Each passage and figure text is its own citable text block. `content_block_location` and `search_result_location` map back through `blocks[i]` (using `via`) to a page and char range. An index that matches no block is dropped, never guessed. Claude cannot cite an image, so a figure answer always carries a "Fig. N · p. M" chip.
  - **A chip follows every cited sentence**, including a chip identical to the one before it, because a sentence with no chip reads as unsourced. The same passage keeps the same `n`. Merging repeated chips for tidiness, if wanted, is done by the UI when it draws them, never in the stored body.
  - **An `error` event ends the reply.** The mapper emits `error` once and never `done` after it; `finish` then returns that error with the partial text kept. A stream that ends with no stop reason finishes as `interrupted`. A refusal finishes as `refused`.
- **The request.**
  - The order is: a frozen system prompt; the document map with `cache_control`; the images before their text packs; the passages; the question.
  - Web search is Anthropic's server tool, at most 1 use per question (`max_uses: 1`, owner 1 Nov 2026). It is sent only when `claude.webSearch` is on **and** the model's stored `webSearchTool` is not null. Otherwise the request carries no web search tool at all.
  - Follow-ups append to the exact blocks held in the tab's memory. After a reload, the thread is rebuilt from stored comments as plain text turns, and a cache miss is accepted. Nothing large is stored in `meta`.
  - **`buildRequest` is asynchronous.** A figure image is a `Blob`, which can only be read asynchronously, so `buildRequest` encodes each `RegionImage` itself. There is no separate encoding step and no `base64` field on `RegionImage`. A model whose `imageInput` is false gets the text pack only.
  - **`ThreadTurn`.** The thread in order, oldest first. `turns[0]` is `role: 'user'` with `content` a plain string: the owner's first question, and `buildRequest` puts the whole pack in front of it. Later turns are appended as they are: in memory, the exact blocks of a reply and the `tool_result` blocks that answered a tool call (these may hold `search_result` blocks, which stay citable); after a reload, plain strings. The last turn is a user turn. Replies go back only as assistant turns, never as user text with citations.
  - The request builder copies the frozen tool list and the held blocks, so changing a built request never changes the next one.
  - Think harder with `serverFallback` set adds `betas: ['server-side-fallback-2026-07-01']` and `fallbacks: 'default'`. The caller then uses the beta endpoint.
- **Settings keys** (synced settings rows):
  - `claude.model.default` and `claude.model.thinkHarder`: the owner's choices, stored as data (D1);
  - `claude.webSearch` (default `true`);
  - `claude.monthlyCapUsd` (default `null`);
  - `claude.confirmOverUsd` (`0.25`).

  The month's spend is kept in `sop-local` as the meta key `claudeSpendMonth`, JSON `{ month: 'YYYY-MM'; usd: number }`. Spend code opens the database only through `openLocalOnlyStore()`, which owns its creation and upgrades, and adds to the total with `LocalOnlyStore.updateMeta(key, change)`: a read-modify-write in one read-write transaction, so two tabs adding at once lose nothing. The total starts again when the local month changes.
- **Before sending** (`decide`):
  - On a PDF that is not in the library, nothing is sent until the owner confirms.
  - An estimate over $0.25 asks first. An estimate or spend that is not a number (NaN or infinite) also asks, and so does any request on a model with no known price (`priceKnown` is a required input; the estimate carries it).
  - Over the monthly cap, the reply fails with `over-cap`: the month's spend is at or over the cap, or this request's estimate would take it over. Spending exactly up to the cap is allowed.
  - Asks come one at a time, in this order: unsaved PDF, whole document, cost. After each yes the caller asks again with that ask in `confirmed`.
- **Tests and scripts.**
  - Tests use the recorded-response double (`e2e/support/claude-replay.ts`) and never a live key. No key-shaped text, even a fake one, is committed: tests and scripts build such values at run time.
  - `scripts/claude/live-check.mjs` skips with exit 0 when `ANTHROPIC_API_KEY_LIVE` is absent. `scripts/claude/record.mjs` is only run on purpose, so it exits 1 when the key is absent.
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
      R58: when one device edits then deletes a note offline while another edits it, the other device's edit wins, and the deleting device's last words go with its delete (the owner chose to delete them).
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

### CA10 (ratified 1 Nov 2026)
`PushResponse.rejected?: RejectedEntry[]` (optional). Each entry has `{ table, id, hlc, code, message, retryable }`. A device drops a non-retryable rejected entry from its outbox, so "N not yet synced" can reach 0. R57: the owner may delete or restore a Claude row but not rewrite it; an owner delete beats a concurrent Claude edit, and Claude's text stays in the tombstone.

### §9 note (1 Nov 2026)
The export plan and the import read shape use `PdfUserRect`, which is PDF user space: y up, origin at the page's lower left, before /Rotate, as written in /Rect and /QuadPoints. It is a different type from the engine's `PdfRect` (top-left origin, line 10), which is unchanged, and the two must never be mixed. The mapping converts from stored `NormRect` and the crop box. `planPdfExport` options gain the optional `lineRgb`, `areaRgb`, `threadRgb` and `replyAppearance` (`'hidden' | 'empty'`, default `'empty'` until W-F1), and its result gains `skippedMarks`.
