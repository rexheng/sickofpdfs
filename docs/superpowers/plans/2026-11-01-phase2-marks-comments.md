# sickofpdfs · Phase 2 plan: marks and comments

Nov 1, 2026. Short plan (CLAUDE.md rules 1–9). The spec wins over the contracts (`docs/superpowers/contracts/2026-11-01-cross-phase-contracts.md`), and the contracts win over this file. Implementers read the spec's "Viewer and commenting" and "How it feels to use", contracts §2–4, research 02 §4.9–4.11, 04 A(ii)–A(iv) and 06 §4–5, and their slice.

**Frontier check (4 searches, 1 Nov 2026):** Drive and Chrome viewer commenting, EmbedPDF releases and Hypothesis anchoring. Nothing since 31 Oct 2026 changes this plan.

## 1. Goal and "done when"

**Goal.** Reading turns into note-taking with no friction. You select text, then right-click or press one key, and the mark or note is there. Every note stays on that PDF and is never lost.

**Done when** (spec gate "No lost text: crash test, your keyboard layouts", plus Release 1 criteria 2 and 3):
1. Select text, then right-click: a Drive-style menu opens at the pointer, and nothing opens on its own. Highlight (5 colours), underline, bold and strikethrough take one click or one key, and appear in under 50 ms. The same style again removes it.
2. Ctrl+Alt+M opens a note box in the right margin in under 100 ms. It sits level with the selection and never covers it. Enter saves a Docs-style card, and replies stack under it. A clicked card turns light, moves 12 px left and darkens its mark.
3. **No lost text.** Kill the tab 100 ms after typing stops, then reopen: the draft is back in its card, with the caret at the end. Esc and clicking away never lose text.
4. After a reload, a moved or renamed file, or a stamped re-download, the notes appear in the same place. A close-match placement shows a quiet "Moved" label. A doubtful one goes to "Couldn't place", never onto the wrong text.
5. Figures outline on hover, select on click and take comments with Ctrl+Alt+M. Pins, Alt+drag areas, and page, point and document notes work, on scans too.
6. Two tabs on one PDF stay in step. Notes on unsaved PDFs follow the save rules (Task 30). Incognito has no marks.
7. Shortcuts never fire while you type. UK, US, German and Polish keyboard layouts are checked by hand.
8. A filled v1 database upgrades to schema v2 with nothing lost.
9. The visual critic passes the menu, marks and cards against the Drive and Docs references.

**Test build 2** (Round 2): highlight, underline, strikethrough, comments, replies, drafts, re-anchoring and the notes panel. Bold comes with it if S11 has merged. **Test build 3** (Round 3): figures, areas, pins and print with marks.

## 2. Slices

**Tiers.**
- **high:** spec-blind tests and a security read of the diff.
- **visual:** the slice goes into the gallery and is built by a strong-model implementer.
- **low:** the gates only.

**Shared viewer files.** Other slices add only one-line mounts or exports to `App.tsx`, `commands.ts`, `runtime.ts`, `Toolbar.tsx` and `packages/ui/src/index.ts`. The slice named below owns any real change to them. Mounts in the same round merge in slice order.

**S1 · Annotation types** · haiku · S · low · **NOW (Round 0)**
- Goal: every slice compiles against one copy of the contract types from day one.
- Owns: the Phase 2 additions in `packages/core/src/ids.ts` and `model/{anchor,rows,figures}.ts`. It also creates `packages/core/src/claude/types.ts`, copied word for word from contracts §3 so `CommentMeta` compiles; P4 owns that file afterwards.
- Produces: `MarkId`, `ThreadId`, `CommentId`, `TabId`, `Author`, the v2 `Anchor` and `FigureFingerprint` fields, `MarkRow`, `ThreadRow`, `CommentRow`, `CommentMeta`, `MarkStyle`, `MarkColor`, `PageFigure` and `DetectedFigure`.

**S2 · Store: schema v2 and annotation methods** · sonnet · M · high · **NOW** (wired in after Task 28)
- Goal: notes, replies and drafts are stored safely, and an existing v1 database upgrades with nothing lost.
- Owns: `apps/extension/src/store/{schema-v2,annotations,page-figures}.ts`, plus the Phase 2 changes to `schema.ts`, `migrate.ts`, `store-api.ts`, `protocol.ts`, `client.ts` and `change-bus.ts`.
- Produces:
  - `SCHEMA_V2`: contracts §4, with the triggers re-created and `comments_fts` rebuilt once;
  - the store methods `listAnnotations`, `writeAnnotations`, `saveDraft`, `sendDraft`, `listDrafts` and `claimDrafts`, plus `getPageFigures`/`putPageFigures` (§7);
  - the extended `StoreChange`.
- Consumes: `SCHEMA_V1`, `migrate`, `createStoreApi` and `Hlc` (Task 28). It starts against `SCHEMA_V1`, copied from the Phase 1 plan into an in-memory database.
- Tests: spec-blind table tests check that:
  - v1 to v2 works on a filled database, and works when run twice;
  - drafts never reach the outbox or `comments_fts`;
  - `sendDraft` clears both rows in one transaction;
  - unknown JSON fields survive a rewrite;
  - a higher `user_version` opens read-only.

  The security read covers data loss, and checks that nothing is written for an unsaved PDF.

**S3 · Anchoring and style planning** · sonnet · M · high · **NOW**
- Goal: a note always comes back on the right words, and adding or removing a style never breaks other marks or comments.
- Owns: `packages/core/src/anchoring/**` and `packages/core/src/annotations/marks.ts`. The anchoring folder holds the vendored Hypothesis `match-quote` and `approx-string-match`, with their licence headers, plus `reanchor.ts`, `quote.ts` and `dhash.ts`.
- Produces: `resolveAnchor`, `FUZZY_MIN_SCORE`, `FUZZY_MIN_QUOTE`, `PlacedBy`, `Resolution`, `AnchorContext`, `planStyle` and `StylePlan`, plus `buildTextAnchor`, `dHash64`, `hammingHex` and `DHASH_MATCH_MAX` (§7).
- Rules:
  - The order is contracts §2, with pages searched nearest first.
  - A figure stays put while its image hash, its caption quote or its dHash (distance ≤ 10) still matches there.
  - Otherwise the figure follows its caption, then its image (research 06 §5).
- Tests: spec-blind table tests for:
  - re-anchoring: a stamped alias that shifts char indices, look-alike text (Hypothesis #7571), the 12-char and 0.8-score floors, quotes across pages, and the figure fallbacks;
  - `planStyle`: toggle, split, ranges across pages, and overlapping styles. It never touches threads.

**S4 · Mark colours, card tokens and icons** · sonnet · S · visual · **NOW**
- Goal: the five mark colours and the cards look right on white pages and on the dark canvas.
- Owns: the Phase 2 additions to `packages/ui/src/tokens/tokens.css` and `packages/ui/src/icons/names.ts`.
- Produces:
  - `--sop-mark-1..5` (D5: yellow by default, then green, blue, pink, orange), each with a highlight fill, an active fill and a line colour;
  - the dark-menu swatches, `--sop-area-outline`, and the figure hover and selected outlines;
  - card tokens: dark surface, light active card, the Docs shadow, 282 px width, 12 px corners, 10 px gaps and the 12 px shift. The notes panel is 320 px wide;
  - the new Material Symbols.

  Hex values live only in this file, and P8 reads its export colours from it.

**S5 · Thread cards and note box** · opus · L · visual · **NOW** (cut from Task 14's branch, the way Task 14 sits on Task 13)
- Goal: comment cards as good as Docs', and a note box that feels like typing in Google Docs.
- Owns: `packages/ui/src/components/comments/**`: `ThreadCard`, `CommentItem`, `NoteBox`, `ReplyBox`, `MarkdownBody` and `MovedLabel`.
- Produces: controlled components with no store code.
  - **Cards.**
    - Inactive cards use Drive's dark surface. The active card turns light, lifts and shifts 12 px left.
    - A card shows its draft or sent state, and its author (you or Claude). Claude's replies show `meta.status` placeholders until P4.
    - It can show "Moved" with "Show where it was" (D7), "Couldn't place", or a figure thumbnail with its label.
  - **`NoteBox`.**
    - Enter and Ctrl+Enter send, Shift+Enter adds a new line, and Esc closes.
    - Ctrl+B and Ctrl+I format the text.
    - It keeps its own undo, and grows to about 8 lines.
  - **`MarkdownBody`.** It renders React elements, never `innerHTML`. It turns `cite:n` and `web:n` links into chips through a callback.
- Consumes: Task 14's components and the S4 tokens.

**S6 · Mark-up menu component** · opus · M · visual · **NOW** (cut from Task 14's branch)
- Goal: the right-click menu looks like Drive's file menu.
- Owns: `packages/ui/src/components/{ContextMenu,ColorSwatches}.tsx`.
- Produces: `ContextMenu(p: { at: { x: number; y: number } | null; items: MenuItemDef[]; swatches?: { value: MarkColor; onPick(c: MarkColor): void }; onClose(): void })`.
  - It uses Task 14's `MenuItemDef` (icon, label, shortcut) and full keyboard control.
  - The swatch row answers keys 1–5 and checks the current colour.
  - Its default style is the dark viewer menu: 288 px wide, `#282a2c`, 36 px rows. The owner decides this; see §7.

**S7 · Page text, mark geometry and card layout** · sonnet · M · high (geometry unit tests only) · **NOW**
- Goal: marks use the same PDFium line rects as the selection (R44), so they look as clean as Chrome's.
- Owns: `packages/viewer/src/text/page-text.ts` and `packages/viewer/src/marks/{geometry,card-layout}.ts`.
- Produces:
  - `PageTextProvider` and `createPageTextProvider`. `rects` wraps `getTextRects` (Task 22), cached per page.
  - Conversions: `PdfRect` to `NormRect` (crop box), and `NormRect` to CSS px for a `PageBox` and a rotation.
  - Paths: one SVG path per style and colour, so overlaps never darken. Underline sits on the bottom of the line rect and strikethrough on its middle. The dotted underline uses the same rects.
  - A hit test, and `sortKey`.
  - `layoutCards`: cards sit at their anchor's top, collisions are pushed down, and the active card stays level with its mark, as in Docs.
- Selection and marks use one path builder. Whichever of this slice and Task 22's selection painter lands second imports the other's.
- Tests: spec-blind table tests for rotations 0, 90, 180 and 270, crop-box offsets, ranges over several lines or pages, and card collisions.

**S8 · Drafts and tab presence (no lost text)** · sonnet · M · high · **NOW**
- Goal: whatever you type survives a crash, a closed tab or a reload.
- Owns: `apps/extension/src/viewer/annotations/{drafts,tab-presence}.ts`.
- Produces: `DraftKeeper` and `TabPresence` (§7).
  - A draft saves within 300 ms of the last key, and at once on blur, Esc, `visibilitychange` (hidden) and `pagehide`.
  - Live tabs answer a roll call on `sop-tabs` within 200 ms. A tab adopts the drafts of tabs that are gone.
  - On a memory-only PDF, drafts stay in memory.
- Consumes: S2's draft methods, mocked until S2 merges.
- Tests: spec-blind tests with fake timers and two simulated tabs, plus a security read.

**S9 · Annotation session** · sonnet · L · high · **NOW** (against mocks)
- Goal: one in-memory model of a document's notes. It draws first, then writes. It undoes cleanly, keeps tabs in step and obeys the save decision.
- Owns: `apps/extension/src/viewer/annotations/{session,undo}.ts`.
- Produces: `AnnotationSession` and `createAnnotationSession` (§7).
  - **Threads.** `startThread` writes a thread, its root comment and a highlight in one transaction. An empty new note cancels its highlight; emptying an existing note keeps it. A selection over an existing comment returns that thread (the most recent, if several overlap).
  - **Undo and redo** apply inverse batches.
  - **Saving.** The first mark calls `firstMark()`, and writes wait while the save question is open. In `memory-only` mode nothing is written. Undoing a first-mark save also removes that mark.
  - **Tabs in step.** Change events for the session's `documentId` reload its rows; events with its own `tabId` are ignored.
  - **Placements** stay in memory and are never written.
- Consumes: `listAnnotations`, `writeAnnotations`, `planStyle`, `resolveAnchor`, `SaveController`, `DraftKeeper`, `TabPresence` and `CharRange` (Task 22).
- Tests: spec-blind tests and a security read.

**S10 · Figure reference set** · sonnet · M · gate data, made without the detector · **NOW**
- Goal: figure detection is judged on real papers it was not tuned on.
- Owns: `e2e/reference/figures/{manifest.json,labels.json,README.md}`.
- Produces:
  - 30 open-licence papers, each with its URL, SHA-256 and licence;
  - hand-drawn boxes and labels for every figure and table, drawn on contact sheets rendered with the spike engine (the sheets stay out of the repo).

  None of the 5 papers the spike was tuned on are in the set.

**S11 · Engine additions and bold** · opus · M · high + visual · **after Task 15** (does not need Tasks 20–23)
- Goal: bold redraws the page's own glyphs, heavier and crisp at any zoom, within 50 ms.
- Owns: the Phase 2 changes to `packages/viewer/src/backend/types.ts` and `backend/embedpdf/{sop-native,engine.worker,rpc}.ts`, plus `packages/viewer/src/marks/BoldLayer.tsx`.
- Produces: `getGlyphOutlines` (contracts §2) and `hashImageObject` (§7). From P0-5:
  - direct wasm-export calls and an em-space outline cache per font and glyph;
  - each glyph in its own fill colour (`FPDFText_GetFillColor`);
  - text with render mode 3 or 7 skipped;
  - ligatures and joined hyphens handled;
  - a 0.03 em stroke, given as a unitless number of points;
  - pages with `/Rotate` handled.
- Tests: the Gate 2 bold checks (§5) and the gallery.

**S12 · Figure detection** · sonnet · M · high (engine) · **after Task 15**
- Goal: figures and tables are found on each page, and finding them never slows page drawing.
- Owns: `packages/viewer/src/figures/{find-figures,figure-service,region-dhash}.ts`.
- Produces:
  - `findFigures`, which returns `PageFigure[]`. It is the spike's detector with its rules, plus "Algorithm" captions;
  - a `FigureService` whose `figures(pageIndex)` and `dHash(pageIndex, rect)` meet `AnchorContext`.
- How it runs:
  - at idle priority, after a page's full render;
  - results are cached in memory, and in `page_figures` for saved documents only;
  - only high-confidence figures get an outline.
- Consumes: `listPageObjects`, `getTextRuns`, `getStructTree`, `renderTile`, `hashImageObject` (mocked until S11 merges) and `getPageFigures`/`putPageFigures`.
- Tests: Gate 2 precision and recall on the S10 set. If precision fails, only caption-linked figures are outlined (research 06 §3.7).

**S13 · Marks in the viewer** · opus · L · visual + high · **needs Phase 1 Tasks 20–23**. Saving also needs Tasks 28 and 30; until then the session runs memory-only.
- Goal: select, right-click, pick a colour, and the highlight is there. Every mark shortcut works and survives a reload.
- Owns:
  - `packages/viewer/src/react/MarkLayer.tsx`;
  - `apps/extension/src/viewer/annotations/{wire,anchor-context,mark-input}.ts` and `MarkupMenu.tsx`;
  - `apps/extension/src/viewer/actions/search-web.ts`;
  - the Phase 2 changes to `App.tsx`, `commands.ts`, `shortcuts.ts` and `runtime.ts`.
- Mark layer: one SVG overlay per page, through `PageList.renderPage`, under the R44 selection overlay.
  - Highlights use multiply blending.
  - It draws the darker active mark, the focus ring, and a dotted underline for a thread with no style left.
- The menu:
  - It opens only after a selection, followed by a right-click, the menu key or Shift+F10. Shift+right-click, or a right-click with nothing selected, gives Chrome's menu.
  - Items: highlight (with colour), underline, bold, strikethrough, comment, Search and Copy. Ask Claude stays hidden until P4.
  - Search opens Google Scholar in a new tab, or the paper itself when the selection holds a DOI or arXiv id.
- Keys:
  - With a selection: H, Ctrl+U, Ctrl+B and Alt+Shift+5.
  - On a focused mark: 1–5 recolour it, Delete removes it, and Tab moves between marks.
  - Ctrl+Z and Ctrl+Y undo and redo. The last colour is remembered (`marks.lastColor`).
- Other:
  - `anchor-context.ts` builds the `AnchorContext` from S7 and S12. An anchor with `rects: []` gets its rects on open.
  - Bold mounts S11's `BoldLayer`, and its command stays disabled until S11 merges.

**S14 · Comments in the viewer** · opus · L · visual + high · **needs Phase 1 Tasks 20–23**
- Goal: Ctrl+Alt+M, type, Enter: the note becomes a card in the margin, with replies, as in Google Docs.
- Owns: `apps/extension/src/viewer/notes/**` (`CardColumn`, `comment-flow.ts`, `note-commands.ts`), plus a one-line mount for a "Comment" text button in the pill toolbar.
- Ctrl+Alt+M:
  - With a selection, it opens a new thread, or the thread already on that passage.
  - With no selection, it makes a point note at the pointer, or failing that a page note.
  - Ctrl+Alt+Shift+M makes a document note.
- The note box sits level with the selection and never covers it. Esc or a click away sends a note that has text, and cancels an empty new one.
- Threads take replies, edits and deletes. The active card and its mark change together. "Moved" shows when a note was placed by `fuzzy`, `caption` or `image`.
- The margin column appears once the document has a thread or a note box opens. The page shifts left in one move, keeping the anchored line in place.
- Consumes: S5, S7's `layoutCards`, S8 and S9.

**S15 · Notes panel and note navigation** · opus · M · visual · **needs Phase 1 Tasks 20–23** (and Task 24 for the jump history)
- Goal: every note is in one Docs-style panel, including any that couldn't be placed, and you can step through notes from the keyboard.
- Owns: `apps/extension/src/viewer/notes-panel/**`.
- Behaviour:
  - Shift+F4 opens the panel: 320 px wide, 16 px corners, All and Mine tabs, thread cards with a reply box, and a "Couldn't place" section.
  - Ctrl+Alt+N and Ctrl+Alt+P go to the next and previous note, with collapsed jump history.
  - At narrow widths the rail collapses first, then the cards fold into the panel.
- Consumes: S5 and S9.

**S16 · Figures, areas and pins in the viewer** · opus · L · visual + high · **needs Tasks 20–24**, S12, S13 and S14
- Goal: click a chart and comment on it, drop a pin, or Alt+drag any rectangle, scans included.
- Owns: `apps/extension/src/viewer/figures/**` and `packages/viewer/src/react/{FigureLayer,FiguresTab}.tsx`, plus one-line mounts for the area-tool button and the Figures tab in the rail.
- Behaviour, following research 06 §4:
  - Hover shows a faint outline in under 100 ms.
  - A click with no drag selects the figure, with a 2 px primary outline. A drag still selects text.
  - The figure's right-click menu has Comment and Copy image. Ask Claude and Explain this figure stay hidden until P4.
  - Ctrl+C copies a PNG rendered at 2×.
  - Ctrl+Alt+M comments on the selected figure, with no highlight. With nothing selected over a figure, it drops a numbered pin.
  - Alt+drag draws an area mark, or a sub-area inside a figure. Links are ignored while Alt is held.
  - Figure cards show a 64 px thumbnail and a label.

**S17 · Print with marks** · sonnet · S · low · **needs Task 27** and S13
- Goal: Ctrl+P can print your marks on the pages.
- Owns: `apps/extension/src/viewer/print/print-marks.ts` and the "with marks" choice in Task 27's print flow.
- It draws the same overlay geometry, including `BoldLayer`, onto each print page.

## 3. Rounds

| Round | Slices | Starts | Ends with |
| --- | --- | --- | --- |
| 0 | S1 | **NOW** | the types merged, within minutes |
| 1 | S2–S10 | **NOW**, against the contracts and mocks. S5 and S6 are cut from Task 14's branch | one merge. S2 is wired in when Task 28 lands |
| 1b | S11, S12 | when Task 15 merges, alongside Phase 1 Tasks 20–23 | one merge |
| 2 | S13, S14, S15 | when Phase 1 Tasks 20–23 merge (Tasks 28 and 30 turn on saving) | **Test build 2**: highlights and comments |
| 3 | S16, S17 | after Round 2, plus Tasks 24 and 27 | **Test build 3**, then the Phase 2 gate: the crash test, the keyboard layouts by hand, and the perf gate |

## 4. Gate 1 walkthrough tests to add

A spec-blind author writes these from the spec, the contracts, and §2 and §7 of this plan. They extend walkthrough 4, plus 3, 6, 9 and 10.

1. **Mark up from the menu.**
   - Select a sentence, right-click, pick green: the sentence is highlighted, and it is still there after a reload.
   - A selection alone opens nothing.
   - Right-click with no selection, or Shift+right-click, shows Chrome's menu.
2. **One key per mark.**
   - H, Ctrl+U, Ctrl+B and Alt+Shift+5 each apply a mark, and pressing one again removes it.
   - Turning a style off in the middle of a mark splits it. Highlight and underline on one passage both show.
   - On a focused mark, 1–5 recolour it and Delete removes it. Ctrl+Z restores it and Ctrl+Y redoes.
   - Ctrl+U with nothing selected does nothing (no page source).
3. **Comment.**
   - Ctrl+Alt+M opens the note box beside the line, not over it. Shift+Enter adds a new line, and Enter saves the card. After a reload the card is back.
   - Esc with text keeps the note. Esc on an empty new note removes its highlight. Emptying an existing note keeps the highlight.
   - Ctrl+Alt+M on an already-commented passage opens that thread.
4. **Replies and the active card.** Click a card: it turns light, moves left, and its highlight darkens. Add two replies. After a reload they are in order.
5. **No lost text (the phase gate).**
   - Type a note and kill the renderer 100 ms after the last key. Reopen: the draft is in its card, with the caret at the end.
   - The same holds after closing the tab mid-draft.
   - With two tabs, the draft stays with tab A. Once tab A is gone, tab B adopts it.
6. **Typing is safe.** Inside the note box:
   - H, 1–5, Delete and Ctrl+Alt+M never touch marks;
   - Ctrl+B formats the note;
   - simulated German and Polish AltGr keys type their characters.
7. **Notes with nothing selected.**
   - Ctrl+Alt+M over a page makes a point note; outside the pages it makes a page note.
   - Ctrl+Alt+Shift+M makes a document note.
   - On `scan-120.pdf`, page, point and area notes work.
8. **Tabs in step.** Open one PDF in two tabs. A highlight and a sent comment in tab A appear in tab B without a reload.
9. **Notes follow the document (walkthrough 9).**
   - A stamped re-download shows the marks on the same words.
   - In a copy where the passage moved, the card says "Moved".
   - In a copy where the passage is gone, the note is under "Couldn't place" in the notes panel, and nothing is drawn.
10. **Save rules (walkthrough 10).**
    - The first mark on a "not sure" PDF saves it, with an Undo chip. Undo removes the save and the mark.
    - On a PDF forced to "not learning", the first mark asks "Save this PDF to keep your notes?". Answer No and close the tab: nothing is stored.
    - In Incognito there are no marks and no menu.
11. **Click a chart (walkthrough 6, Test build 3).**
    - Hover outlines the figure, and a click selects it.
    - Ctrl+Alt+M makes a card with a thumbnail and the label "Figure N · p. M".
    - The figure's right-click menu offers Comment and Copy image, and Ctrl+C copies a PNG.
    - A pin and an Alt+drag area survive a reload. Links don't fire while Alt is held.
12. **Search and the network.** Search opens Google Scholar in a new tab, or doi.org on a reference that has a DOI. The network gate shows nothing else leaving.
13. **Speed smoke.**
    - A mark shows in under 50 ms, the note box in under 100 ms, and a figure outline in under 100 ms.
    - The limits are loose on Linux; the perf gate checks the real ones.
    - Product perf marks: `sop:mark-drawn`, `sop:notebox-open`, `sop:figure-outline`.

## 5. Gate 2 (engine reference set) additions

- **Figures (S10 + S12).** On the 30 labelled papers, a box counts as a match at IoU ≥ 0.7. Precision must be ≥ 95% for outlined figures, and recall ≥ 75% for captioned figures. Text runs plus `findFigures` must take ≤ 20 ms a page (p95) on the reference laptop; Linux is smoke only.
- **Bold (S11).** On 3 reference PDFs, one of them `tl-rotated-page`, at 100% and 200%: a hash of `getGlyphOutlines` for a fixed char range, plus coverage ≥ 0.95 and spill ≤ 0.10, measured as in P0-5.
- **Marks (S7 + S13).** A perceptual hash of fixed highlight, underline and strikethrough marks on `tl-two-column`, ResNet p1 and `tl-rotated-page` at DPR 1.5. Their rects must equal the recorded selection rects.

## 6. Gate 3 screens for the gallery

1. The right-click menu over a selection, next to `crop-34` (the viewer's File menu) and `crop-33` / `live-05` (Drive's right-click menu).
2. The 5 highlight colours, underline, strikethrough and bold on a paper at 100% and 200%, next to Chrome's selection (`live-21`). Look for even line heights and no overlap bands.
3. Highlight plus underline on one passage, a split mark, and a selection over a highlight.
4. The margin cards next to `live-20`, and the active card with its mark darkened next to `live-19`.
5. The note box: empty with its placeholder, with text, and with several lines.
6. A thread with replies from you and from Claude (P4 placeholder), next to `crop-36` and `live-18`.
7. The "Moved" label and its hover, a dotted underline, and the "Couldn't place" section.
8. The notes panel (All and Mine), next to `live-17`.
9. A narrow window at 150% Windows scaling: the rail collapsed and the cards folded into the panel.
10. Figures (Test build 3): a hover outline, a selected figure, its right-click menu, its card with a thumbnail, a numbered pin, an area mark and a sub-area.

## 7. Contract additions and risks

```ts
// packages/core/src/anchoring/quote.ts (S3). A quote across pages joins the page texts with '\n'.
export const QUOTE_CONTEXT = 32;
export function buildTextAnchor(i: { text(pageIndex: number): string; start: CharPos; end: CharPos; rects: { page: number; rects: NormRect[] }[]; textSource?: string }): Extract<Anchor, { kind: 'text' }>;
// packages/core/src/anchoring/dhash.ts (S3), research 06 §5
export const DHASH_MATCH_MAX = 10;
export function dHash64(grey9x8: Uint8Array): string;
export function hammingHex(a: string, b: string): number;
// packages/viewer/src/text/page-text.ts (S7)
export function createPageTextProvider(be: PdfBackend, doc: DocHandle): PageTextProvider;
// PdfBackend (S11): SHA-256 of FPDFImageObj_GetImageDataRaw, computed in the worker; objectIndex is in listPageObjects({ recurseForms: true }) order
hashImageObject(doc: DocHandle, pageIndex: number, objectIndex: number): Promise<Sha256 | null>;
// StoreApi (S2). The store stamps hlc and rev on each write and ignores the caller's values.
writeAnnotations(ops, o?: { tabId?: TabId }): Promise<void>;   // the tabId goes into the published StoreChange (the §3 shape had no slot for it)
getPageFigures(documentId: DocumentId, pageIndex: number, detectorVersion: string): Promise<PageFigure[] | null>;
putPageFigures(documentId: DocumentId, pageIndex: number, detectorVersion: string, figures: PageFigure[]): Promise<void>;   // saved documents only
// apps/extension/src/viewer/annotations/tab-presence.ts (S8). P4 uses it to mark interrupted replies.
export const TABS_CHANNEL = 'sop-tabs';
export interface TabPresence { readonly tabId: TabId; liveTabs(timeoutMs?: number /* 200 */): Promise<TabId[]>; close(): void }
export function createTabPresence(): TabPresence;
// apps/extension/src/viewer/annotations/drafts.ts (S8)
export interface DraftKeeper { change(row: CommentRow & { draftOfTab: TabId }, thread?: ThreadRow): void; flush(): Promise<void>; drop(id: CommentId): void; restore(documentId: DocumentId): Promise<CommentRow[]> }
export function createDraftKeeper(d: { store: StoreApi | null; presence: TabPresence; memoryOnly(): boolean }): DraftKeeper;
// apps/extension/src/viewer/annotations/session.ts (S9). P4 adds its Claude-reply methods here.
export interface AnnotationState { marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[]; drafts: CommentRow[];
  placement: Map<string /* mark or thread id */, Resolution>; active: ThreadId | null; focusedMark: MarkId | null; mode: 'stored' | 'pending-save' | 'memory-only' | 'view-only' }
export interface AnnotationSession {
  readonly tabId: TabId; state(): AnnotationState; subscribe(cb: () => void): () => void;
  applyStyle(ranges: CharRange[], style: Exclude<MarkStyle, 'area'>, color: MarkColor | null): Promise<void>;
  addAreaMark(a: Extract<Anchor, { kind: 'area' }>): Promise<MarkId>; recolor(id: MarkId, c: MarkColor): Promise<void>; removeMark(id: MarkId): Promise<void>;
  startThread(a: Anchor, o: { highlight: MarkColor | null }): { threadId: ThreadId; commentId: CommentId };   // draws at once; the root comment starts as a draft
  startReply(t: ThreadId): CommentId; typeDraft(id: CommentId, body: string): void; send(id: CommentId): Promise<void>; cancel(id: CommentId): Promise<void>;
  editComment(id: CommentId, body: string): Promise<void>; removeComment(id: CommentId): Promise<void>; removeThread(id: ThreadId): Promise<void>;
  threadAt(r: CharRange): ThreadId | null; setActive(t: ThreadId | null): void; setFocusedMark(m: MarkId | null): void;
  undo(): Promise<void>; redo(): Promise<void>; dispose(): void;
}
export function createAnnotationSession(d: { store: StoreClient | null; save: SaveController | null; anchors: AnchorContext; drafts: DraftKeeper; presence: TabPresence;
  makeTextAnchor(ranges: CharRange[]): Promise<Extract<Anchor, { kind: 'text' }>>; documentId(): DocumentId | null; incognito: boolean; now(): number }): AnnotationSession;
// ViewerCommandId (Task 23) gains: 'marks.highlight' | 'marks.underline' | 'marks.bold' | 'marks.strike' | 'marks.comment' | 'marks.documentNote' | 'marks.menu'
//   | 'edit.undo' | 'edit.redo' | 'notes.next' | 'notes.previous' | 'notes.panel' | 'figures.copyImage' | 'tools.area'.
//   P4 adds 'claude.ask' and 'claude.explainFigure'; menus show them only once registered.
// Settings key 'marks.lastColor': MarkColor, default 1, the colour that H and the menu use next.
// Area marks keep color null and draw in --sop-area-outline. P8's "border in the mark colour" means that token.
```

**Owner decision (one): the right-click menu's look.** The default is dark, like our viewer's File menu, because all of the viewer's UI is dark (R48). The other option is light, like Drive's right-click menu in its file list. Either way, the visual critic checks the menu against both references.

**Risks**
- **AltGr layouts.** On a German layout, Ctrl+Alt+M arrives as `µ`. S13 matches it by the physical key's base letter, using `navigator.keyboard.getLayoutMap()`. Alt+Shift+5 is matched by position. Ctrl+U and Ctrl+B call `preventDefault` only when text is selected. The layouts are checked by hand at the gate.
- **The page shifting at fit width.** When the margin column appears, the page shifts left. If the visual critic finds the shift jarring, the column stays open for every document that has notes.
- **Bold speed** grows with the glyph count: about 0.07 ms a glyph with the wrapped calls. S11 needs the direct calls and the outline cache to stay under 50 ms on long selections. OCR text never gets bold.
- **Core types refer to viewer types** through `import type`, as Task 30's filter types already do. If the workspace refuses this, the shared geometry types move to core and the viewer re-exports them.
- **Spots where a spec-blind author may read the spec differently.** The controller triages each one.
  - Esc with text sends the note (the spec says "saves typed text"; research 04 A(ii)).
  - "Moved" shows for `fuzzy`, `caption` and `image` placements.
  - Undoing a first-mark save also removes the mark.
- **Privacy.**
  - Nothing is written for an unsaved or memory-only PDF: no `page_figures` cache, no drafts, no marks.
  - Search sends only the selected words, and only when you press it.
  - Copy image stays local.
  - S2, S8, S9 and S13 each get a security read.
