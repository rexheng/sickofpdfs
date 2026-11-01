# sickofpdfs · Phase 2 plan: marks and comments

Nov 1, 2026. This is a short plan (CLAUDE.md rules 1–9). Where they disagree, the spec wins, then the contracts (`docs/superpowers/contracts/2026-11-01-cross-phase-contracts.md`), then this file.

Implementers read:
- the spec's "Viewer and commenting" and "How it feels to use";
- contracts §2–4;
- research 02 §4.9–4.11, 04 A(ii)–A(iv) and 06 §4–5;
- their own slice.

**Frontier check (4 searches, 1 Nov 2026).** I searched Drive and Chrome viewer commenting, EmbedPDF releases and Hypothesis anchoring. Nothing since 31 Oct 2026 changes this plan.

## 1. Goal and "done when"

**Goal.** Reading turns into note-taking with no friction. You select text, right-click or press one key, and the mark or note is there. Every note stays on that PDF and is never lost.

**Done when.** These come from the spec gate "No lost text: crash test, your keyboard layouts" and from Release 1 criteria 2 and 3.
1. Selecting text and right-clicking opens a Drive-style menu at the pointer. Nothing ever opens on its own.
2. Highlight (5 colours), underline, bold and strikethrough each take one click or one key, and show in under 50 ms. Applying the same style again removes it.
3. Ctrl+Alt+M opens a note box in the right margin in under 100 ms. It sits level with the selection and never covers it. Enter saves it as a Docs-style card, and replies stack under it.
4. Clicking a card makes it light, moves it 12 px left and darkens its mark.
5. **No lost text.** Kill the tab 100 ms after typing stops, then reopen: the draft is back in its card, with the caret at the end. Esc and clicking away never lose text.
6. The same notes show in the same place after a reload, a move or rename, or a stamped re-download. A note placed by a close match shows a quiet "Moved" label. A doubtful one goes to "Couldn't place", never onto the wrong text.
7. Figures outline on hover, select on click, and take a comment with Ctrl+Alt+M. Pins, Alt+drag areas, and page, point and document notes work, on scans too.
8. Two tabs on one PDF stay in step. Notes on unsaved PDFs follow the save rules (Task 30). Incognito has no marks.
9. Shortcuts never fire while you type. UK, US, German and Polish keyboard layouts are checked by hand.
10. A filled v1 database upgrades to schema v2 with nothing lost.
11. The visual critic passes the menu, the marks and the cards against the Drive and Docs references.

**Test builds.**
- **Test build 2** (after Round 2): highlight, underline, strikethrough, comments, replies, drafts, re-anchoring and the notes panel. Bold too, once S11 has merged.
- **Test build 3** (after Round 3): figures, areas, pins and print with marks.

## 2. Slices

**Tiers.** Each slice has a risk tier, which sets how it is checked:
- **high:** spec-blind tests and a security read;
- **visual:** the gallery, and a strong-model implementer;
- **low:** the gates only.

**Shared viewer files.** These are `App.tsx`, `commands.ts`, `runtime.ts`, `Toolbar.tsx` and `packages/ui/src/index.ts`.
- Other slices only add one-line mounts or exports to them.
- The slice named as their owner makes any real change.
- Mounts made in the same round merge in slice order.

**S1 · Annotation types** · haiku · S · low · **NOW (Round 0)**
- Goal: every slice compiles against one copy of the contract types from day one.
- Owns: the Phase 2 additions in `packages/core/src/ids.ts` and `model/{anchor,rows,figures}.ts`. It also creates `packages/core/src/claude/types.ts`, copied word for word from contracts §3 so that `CommentMeta` compiles. P4 owns that file afterwards.
- Produces:
  - the ids `MarkId`, `ThreadId`, `CommentId` and `TabId`, and `Author`;
  - the v2 `Anchor` and `FigureFingerprint` fields;
  - `MarkRow`, `ThreadRow`, `CommentRow`, `CommentMeta`, `MarkStyle` and `MarkColor`;
  - `PageFigure` and `DetectedFigure`.

**S2 · Store: schema v2 and annotation methods** · sonnet · M · high · **NOW** (wired in after Task 28)
- Goal: notes, replies and drafts are stored safely, and an old v1 database upgrades with nothing lost.
- Owns: `apps/extension/src/store/{schema-v2,annotations,page-figures}.ts`, plus the Phase 2 changes to `schema.ts`, `migrate.ts`, `store-api.ts`, `protocol.ts`, `client.ts` and `change-bus.ts`.
- Produces:
  - `SCHEMA_V2`, as in contracts §4: re-created triggers, then one rebuild of `comments_fts`;
  - the store methods `listAnnotations`, `writeAnnotations`, `saveDraft`, `sendDraft`, `listDrafts` and `claimDrafts`;
  - `getPageFigures` and `putPageFigures` (§7);
  - the extended `StoreChange`.
- Consumes: Task 28's `SCHEMA_V1`, `migrate`, `createStoreApi` and `Hlc`. Until Task 28 merges, it works on `SCHEMA_V1` copied into an in-memory database.
- Tests, spec-blind and table-driven:
  - v1 to v2 on a filled database, run twice;
  - drafts never reach the outbox or `comments_fts`;
  - `sendDraft` is one transaction;
  - unknown JSON fields are kept;
  - a higher `user_version` opens read-only.
- Security read: data loss, and that nothing is written for an unsaved PDF.

**S3 · Anchoring and style planning** · sonnet · M · high · **NOW**
- Goal: a note always comes back on the right words, and adding or removing a style never breaks other marks or comments.
- Owns:
  - `packages/core/src/anchoring/**`: vendored Hypothesis `match-quote` and `approx-string-match` with their licence headers, plus `reanchor.ts`, `quote.ts` and `dhash.ts`;
  - `packages/core/src/annotations/marks.ts`.
- Produces: `resolveAnchor`, `FUZZY_MIN_SCORE`, `FUZZY_MIN_QUOTE`, `PlacedBy`, `Resolution`, `AnchorContext`, `planStyle` and `StylePlan`, plus `buildTextAnchor`, `dHash64`, `hammingHex` and `DHASH_MATCH_MAX` (§7).
- Rules:
  - Re-anchoring follows the order in contracts §2, searching the nearest pages first.
  - A figure stays put while its image hash, caption quote or dHash (distance ≤ 10) still matches there. If none does, it follows its caption, then its image (research 06 §5).
- Tests, spec-blind and table-driven:
  - stamped aliases and look-alike text (Hypothesis #7571);
  - the 12-character and 0.8-score floors;
  - quotes across pages, and the figure fallbacks;
  - `planStyle` toggles, splits and overlaps, never touching threads.

**S4 · Mark colours, card tokens and icons** · sonnet · S · visual · **NOW**
- Goal: the five mark colours and the cards look right on white pages and on the dark canvas.
- Owns: the Phase 2 additions to `packages/ui/src/tokens/tokens.css` and `icons/names.ts`.
- Produces:
  - **mark colours** `--sop-mark-1..5` (decision D5: yellow by default, then green, blue, pink, orange), each with a fill, an active fill and a line colour;
  - **swatches** for the dark menu;
  - **outlines:** `--sop-area-outline`, and the hover and selected figure outlines;
  - **card tokens:** the dark surface, the light active card and the Docs shadow, at 282 px wide, 12 px corners, 10 px gaps and a 12 px shift;
  - **the notes panel** at 320 px wide;
  - **icons:** the new Material Symbols.
- Hex values live only in this file. P8 reads its export colours from here.

**S5 · Thread cards and note box** · opus · L · visual · **NOW** (cut from Task 14's branch)
- Goal: comment cards as good as Google Docs', and a note box that feels like typing in Docs.
- Owns: `packages/ui/src/components/comments/**`: `ThreadCard`, `CommentItem`, `NoteBox`, `ReplyBox`, `MarkdownBody` and `MovedLabel`.
- Produces controlled components with no store code:
  - **Cards.** A card sits on Drive's dark surface. When active, it turns light, lifts and shifts left. It can show a draft; you or Claude as author (with `meta.status` placeholders until P4); "Moved" with "Show where it was" (D7); "Couldn't place"; or a figure thumbnail and label.
  - **`NoteBox`.** Enter or Ctrl+Enter sends, Shift+Enter adds a new line and Esc closes. Ctrl+B and Ctrl+I format. It has its own undo and grows to about 8 lines.
  - **`MarkdownBody`.** It builds React elements, never `innerHTML`, and turns `cite:n` and `web:n` links into chips through a callback.
- Consumes: Task 14's components and the S4 tokens.

**S6 · Mark-up menu component** · opus · M · visual · **NOW** (cut from Task 14's branch)
- Goal: the right-click menu looks like Drive's file menu.
- Owns: `packages/ui/src/components/{ContextMenu,ColorSwatches}.tsx`.
- Produces: `ContextMenu(p: { at: { x: number; y: number } | null; items: MenuItemDef[]; swatches?: { value: MarkColor; onPick(c: MarkColor): void }; onClose(): void })`.
- Behaviour:
  - It takes Task 14's `MenuItemDef` (icon, label, shortcut) and works fully from the keyboard.
  - Swatches answer the keys 1–5 and show a check on the current colour.
  - It looks like the dark viewer menu by default: 288 px wide, `#282a2c`, 36 px rows. The owner decides this; see §7.

**S7 · Page text, mark geometry and card layout** · sonnet · M · high (geometry unit tests only) · **NOW**
- Goal: marks use the same PDFium line rects as the selection (R44), so they look as clean as Chrome's.
- Owns: `packages/viewer/src/text/page-text.ts` and `packages/viewer/src/marks/{geometry,card-layout}.ts`.
- Produces:
  - `PageTextProvider` and `createPageTextProvider`. Its `rects` wraps `getTextRects` from Task 22, cached per page.
  - Conversion from `PdfRect` to `NormRect` (crop box), and from `NormRect` to CSS px at any rotation.
  - One SVG path per style and colour, so overlaps never darken. Underline sits at the rect bottom, strike at the middle, and the dotted underline on the same rects.
  - A hit test, and `sortKey`.
  - `layoutCards`: cards at their anchor tops, with collisions pushed down and the active card kept level with its mark.
- Selection and marks share one path builder. Whichever of this slice and Task 22's painter lands second imports the other's.
- Tests, spec-blind and table-driven: rotations 0, 90, 180 and 270; crop-box offsets; ranges over several lines and pages; card collisions.

**S8 · Drafts and tab presence (no lost text)** · sonnet · M · high · **NOW**
- Goal: whatever you type survives a crash, a closed tab or a reload.
- Owns: `apps/extension/src/viewer/annotations/{drafts,tab-presence}.ts`.
- Produces `DraftKeeper` and `TabPresence` (§7):
  - A draft is saved within 300 ms of the last key, and at once on blur, Esc, `visibilitychange` (hidden) and `pagehide`.
  - Live tabs answer a roll call on `sop-tabs` within 200 ms. A tab adopts drafts whose tab is gone.
  - On a memory-only PDF, drafts stay in memory.
- Consumes: S2's draft methods, mocked until S2 merges.
- Tests: spec-blind, with fake timers and two simulated tabs. Security read.

**S9 · Annotation session** · sonnet · L · high · **NOW** (against mocks)
- Goal: one in-memory model of a document's notes. It draws first and writes second, undoes cleanly, keeps tabs in step and obeys the save decision.
- Owns: `apps/extension/src/viewer/annotations/{session,undo}.ts`.
- Produces: `AnnotationSession` and `createAnnotationSession` (§7).
- Comments:
  - `startThread` writes a thread, its root comment and a highlight in one transaction.
  - An empty new note cancels its highlight. Emptying an existing note keeps its highlight.
  - A selection over an existing comment returns that thread, the most recent if several overlap.
- Undo and redo are inverse batches.
- Saving:
  - The first mark calls `firstMark()`, and writes wait while the save question is open.
  - `memory-only` writes nothing.
  - Undoing a first-mark save also removes that mark.
- Tabs and placement:
  - Change events for the document reload its rows. Events that carry this tab's own `tabId` are ignored.
  - Placements are kept in memory and never written.
- Consumes: `listAnnotations`, `writeAnnotations`, `planStyle`, `resolveAnchor`, `SaveController`, `DraftKeeper`, `TabPresence`, and `CharRange` from Task 22.
- Tests: spec-blind. Security read.

**S10 · Figure reference set** · sonnet · M · gate data, made independently of the detector · **NOW**
- Goal: figure detection is judged on real papers it was not tuned on.
- Owns: `e2e/reference/figures/{manifest.json,labels.json,README.md}`.
- Produces: 30 open-licence papers, each with its URL, SHA-256 and licence, plus hand-drawn boxes and labels for every figure and table.
- Method:
  - Boxes are drawn on contact sheets rendered with the spike engine. The sheets stay out of the repo.
  - The spike's 5 tuning papers are excluded.

**S11 · Engine additions and bold** · opus · M · high + visual · **NOW** (Task 15 has merged)
- Goal: bold redraws the page's own glyphs, heavier, crisp at any zoom, in under 50 ms.
- Owns: the Phase 2 changes to `packages/viewer/src/backend/types.ts` and `backend/embedpdf/{sop-native,engine.worker,rpc}.ts`, and the new `packages/viewer/src/marks/BoldLayer.tsx`.
- Produces: `getGlyphOutlines` (contracts §2) and `hashImageObject` (§7).
- Must follow the P0-5 findings:
  - direct wasm-export calls, with an em-space outline cache per font and glyph;
  - each glyph drawn in its own fill colour (`FPDFText_GetFillColor`);
  - render modes 3 and 7 skipped;
  - ligatures, joined hyphens and `/Rotate` pages handled;
  - a stroke of 0.03 em, given as a unitless number of points.
- Tests: the Gate 2 bold checks (§5), plus the gallery.

**S12 · Figure detection** · sonnet · M · high (engine) · **NOW** (Task 15 has merged)
- Goal: figures and tables are found on each page, and finding them never slows page drawing.
- Owns: `packages/viewer/src/figures/{find-figures,figure-service,region-dhash}.ts`.
- Produces:
  - `findFigures` returns `PageFigure[]`. It is the spike's detector with its rules, plus "Algorithm" captions.
  - `FigureService` meets `AnchorContext` with `figures(pageIndex)` and `dHash(pageIndex, rect)`.
- Running:
  - It runs at idle priority, after each page's full render.
  - Results are cached in memory, and in `page_figures` for saved documents only.
  - Only high-confidence figures get outlined.
- Consumes: `listPageObjects`, `getTextRuns`, `getStructTree`, `renderTile`, `hashImageObject` (mocked until S11 merges), and `getPageFigures`/`putPageFigures`.
- Tests: Gate 2 precision and recall on S10. If precision fails, only caption-linked figures are outlined (research 06 §3.7).

**S13 · Marks in the viewer** · opus · L · visual + high · **needs Phase 1 Tasks 20–23**
- Saving also needs Tasks 28 and 30. Until they merge, the session stays memory-only.
- Goal: select, right-click, pick a colour, and the highlight is there. Every mark shortcut works and survives a reload.
- Owns:
  - `packages/viewer/src/react/MarkLayer.tsx`;
  - `apps/extension/src/viewer/annotations/{wire,anchor-context,mark-input}.ts` and `MarkupMenu.tsx`;
  - `viewer/actions/search-web.ts`;
  - the Phase 2 changes to `App.tsx`, `commands.ts`, `shortcuts.ts` and `runtime.ts`.
- **Marks layer.** One SVG overlay per page, mounted through `PageList.renderPage` under the R44 selection overlay.
  - Highlights use multiply blending.
  - The active mark is drawn darker, a focused mark gets a focus ring, and a thread with no style left gets a dotted underline.
- **Menu.** It opens only after a selection and then a right-click, the menu key or Shift+F10.
  - Shift+right-click, or a right-click with nothing selected, gives Chrome's menu.
  - Items: highlight with colour, underline, bold, strikethrough, comment, Search and Copy. Ask Claude stays hidden until P4.
  - Search opens Google Scholar in a new tab, or the paper itself when the selection has a DOI or arXiv id.
- **Keys.**
  - With text selected: H, Ctrl+U, Ctrl+B and Alt+Shift+5.
  - On a focused mark: 1–5 recolour it, Delete removes it, and Tab moves between marks.
  - Ctrl+Z and Ctrl+Y undo and redo. The last colour used is remembered (`marks.lastColor`).
- **Anchors.** `anchor-context.ts` builds `AnchorContext` from S7 and S12. An anchor saved with `rects: []` gets its rects on open.
- **Bold.** Uses S11's `BoldLayer`. The command stays disabled until S11 merges.

**S14 · Comments in the viewer** · opus · L · visual + high · **needs Phase 1 Tasks 20–23**
- Goal: Ctrl+Alt+M, type, Enter. The note becomes a card in the margin with replies, as in Google Docs.
- Owns: `apps/extension/src/viewer/notes/**` (`CardColumn`, `comment-flow.ts`, `note-commands.ts`), plus a one-line mount for a "Comment" text button in the pill toolbar.
- **Ctrl+Alt+M.**
  - With text selected, it opens a new thread, or the existing one on that text.
  - With nothing selected, it makes a point note at the pointer, or else a page note.
  - Ctrl+Alt+Shift+M makes a document note.
- **The note box.**
  - It sits level with the selection and never covers it.
  - Esc or a click away sends a note that has text, and cancels an empty new one.
- **Cards.**
  - Each card supports replies, editing and deleting.
  - The active card and its mark change together.
  - "Moved" shows for notes placed by `fuzzy`, `caption` or `image`.
- **Layout.** The margin column appears once the document has a thread or a note box opens. The page shifts left in one move, keeping the anchored line in place.
- Consumes: S5, S7's `layoutCards`, S8 and S9.

**S15 · Notes panel and note navigation** · opus · M · visual · **needs Phase 1 Tasks 20–23** (and Task 24 for the jump history)
- Goal: every note is in one Docs-style panel, including any that couldn't be placed, and you can step through them from the keyboard.
- Owns: `apps/extension/src/viewer/notes-panel/**`.
- **The panel.** Shift+F4 opens it: 320 px wide, 16 px corners, All and Mine tabs, thread cards with a reply box, and a "Couldn't place" section.
- **Note navigation.** Ctrl+Alt+N and Ctrl+Alt+P move to the next and previous note, using collapsed jump history.
- **Narrow windows.** The rail collapses first, then the cards fold into the panel.
- Consumes: S5 and S9.

**S16 · Figures, areas and pins in the viewer** · opus · L · visual + high · **needs Tasks 20–24, S12, S13 and S14**
- Goal: click a chart and comment on it, drop a pin, or Alt+drag any rectangle, scans included.
- Owns: `apps/extension/src/viewer/figures/**` and `packages/viewer/src/react/{FigureLayer,FiguresTab}.tsx`, plus one-line mounts for the area tool and the rail's Figures tab.
- Behaviour, following research 06 §4:
  - **Hover and click.** Hover shows a faint outline within 100 ms. A click without a drag selects the figure with a 2 px primary outline. A drag still selects text.
  - **Menu and copy.** Right-click gives Comment and Copy image. Ask Claude and Explain this figure stay hidden until P4. Ctrl+C copies a PNG rendered at 2×.
  - **Comments and pins.** Ctrl+Alt+M comments on the figure, with no highlight. With nothing selected over a figure, it drops a numbered pin.
  - **Areas.** Alt+drag draws an area mark, or a sub-area inside a figure. Links are ignored while Alt is held.
  - **Cards.** Figure cards show a 64 px thumbnail and a label.

**S17 · Print with marks** · sonnet · S · low · **needs Task 27 and S13**
- Goal: Ctrl+P can print your marks on the pages.
- Owns: `apps/extension/src/viewer/print/print-marks.ts`, and the "with marks" choice in Task 27's print flow.
- It draws the same overlay geometry, `BoldLayer` included, on each print page.

## 3. Rounds

| Round | Slices | Starts | Ends with |
| --- | --- | --- | --- |
| 0 | S1 | **NOW** | the types merged, within minutes |
| 1 | S2–S12 | **NOW**, against the contracts and mocks. S5 and S6 are cut from Task 14's branch. S11 and S12 use the merged Task 15 | one merge. S2 is wired in when Task 28 lands |
| 2 | S13, S14, S15 | when Phase 1 Tasks 20–23 merge. Tasks 28 and 30 turn on saving | **Test build 2: highlights and comments** |
| 3 | S16, S17 | after Round 2, plus Tasks 24 and 27 | **Test build 3**, then the Phase 2 gate: the crash test, keyboard layouts by hand, and the perf gate |

## 4. Gate 1 walkthrough tests to add

A spec-blind author writes these from the spec, the contracts, and §2 and §7 of this plan. They extend walkthrough 4, plus walkthroughs 3, 6, 9 and 10.

1. **The menu.** Select a sentence, right-click and pick green: the sentence is highlighted, and stays highlighted after a reload. A selection on its own opens nothing. A right-click with no selection, or Shift+right-click, shows Chrome's own menu.
2. **The keys.**
   - H, Ctrl+U, Ctrl+B and Alt+Shift+5 each apply a style, and the same key again removes it.
   - Removing a style from the middle of a mark splits it. Highlight and underline can show together.
   - On a focused mark, 1–5 recolour it and Delete removes it. Ctrl+Z undoes and Ctrl+Y redoes.
   - Ctrl+U with nothing selected does nothing.
3. **Comments.**
   - Ctrl+Alt+M opens the note box beside the line, not over it. Shift+Enter adds a new line, and Enter saves. The card is still there after a reload.
   - Esc with text keeps the note. Esc on an empty new note drops its highlight. Emptying an existing note keeps the highlight.
   - Ctrl+Alt+M on a passage that already has a comment opens that thread.
4. **Replies.** Clicking a card makes it light, moves it left and darkens its highlight. Two replies stay in order after a reload.
5. **No lost text (the phase gate).**
   - Kill the renderer 100 ms after the last key, and reopen: the draft is back, with the caret at the end.
   - Closing the tab mid-draft gives the same result.
   - With two tabs open, a draft stays with tab A. Once tab A is gone, tab B adopts it.
6. **Typing is safe.**
   - In the note box, H, 1–5, Delete and Ctrl+Alt+M never touch marks, and Ctrl+B formats the text.
   - Simulated German and Polish AltGr keys type their characters.
7. **Notes with nothing selected.**
   - Ctrl+Alt+M makes a point note over a page, or a page note off the pages.
   - Ctrl+Alt+Shift+M makes a document note.
   - On `scan-120.pdf`, page, point and area notes all work.
8. **Tabs in step.** A highlight and a sent comment made in tab A appear in tab B without a reload.
9. **Re-anchoring (walkthrough 9).**
   - A stamped re-download shows the marks on the same words.
   - If the passage moved, the card says "Moved".
   - If the passage is gone, the note sits under "Couldn't place" and nothing is drawn.
10. **Save rules (walkthrough 10).**
    - The first mark on a "not sure" PDF saves it and shows an Undo chip. Undo removes the save and the mark.
    - On a PDF forced to "not learning", the first mark asks whether to save. Answer No and close the tab: nothing is stored.
    - In Incognito there are no marks and no menu.
11. **Figures (walkthrough 6, Test build 3).**
    - Hover outlines a figure and a click selects it. Ctrl+Alt+M makes a card with a thumbnail and the label "Figure N · p. M".
    - The figure's menu offers Comment and Copy image, and Ctrl+C copies a PNG.
    - A pin and an Alt+drag area both survive a reload. Links don't fire while Alt is held.
12. **Search and the network.** Search opens Google Scholar in a new tab, or doi.org for a reference that has a DOI. The network gate shows nothing else leaving.
13. **Speed smoke.**
    - A mark shows in under 50 ms, the note box in under 100 ms, and a figure outline in under 100 ms.
    - Linux limits are loose; the perf gate checks the real budgets.
    - Perf marks: `sop:mark-drawn`, `sop:notebox-open`, `sop:figure-outline`.

## 5. Gate 2 (engine reference set) additions

- **Figures (S10 + S12).** On the 30 labelled papers, with a box counted as correct at IoU ≥ 0.7:
  - precision ≥ 95% for outlined figures;
  - recall ≥ 75% for captioned figures;
  - text runs plus `findFigures` take ≤ 20 ms a page at p95 on the reference laptop (Linux is a smoke check only).
- **Bold (S11).** On 3 reference PDFs, including `tl-rotated-page`, at 100% and 200%:
  - a hash of `getGlyphOutlines` for a fixed character range;
  - coverage ≥ 0.95 and spill ≤ 0.10, measured as in P0-5.
- **Marks (S7 + S13).** A perceptual hash of fixed highlight, underline and strike marks on `tl-two-column`, ResNet p1 and `tl-rotated-page`, at DPR 1.5. The mark rects must equal the recorded selection rects.

## 6. Gate 3 screens for the gallery

1. The right-click menu over a selection, next to `crop-34` (the viewer's File menu) and `crop-33` / `live-05` (Drive's right-click menu).
2. The 5 highlight colours, underline, strikethrough and bold on a paper at 100% and 200%, next to Chrome's selection (`live-21`): even line heights, no darker bands where lines overlap.
3. Highlight and underline on one passage, a split mark, and a selection drawn over a highlight.
4. The margin cards next to `live-20`; the active card, with its mark darkened, next to `live-19`.
5. The note box: empty with its placeholder, with text, and with several lines.
6. A thread with replies from you and from Claude (a P4 placeholder), next to `crop-36` and `live-18`.
7. The "Moved" label and its hover, a dotted underline, and "Couldn't place".
8. The notes panel (All and Mine), next to `live-17`.
9. A narrow window at 150% Windows scaling: the rail collapsed and the cards folded into the panel.
10. Figures (Test build 3): hover outline, selected, its menu, its card, a numbered pin, an area and a sub-area.

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
// StoreApi (S2). The store stamps hlc and rev on every write and ignores the caller's values.
writeAnnotations(ops, o?: { tabId?: TabId }): Promise<void>;   // tabId goes into the published StoreChange; the §3 shape has no slot for it
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
//   P4 adds 'claude.ask' and 'claude.explainFigure'; the menus show them only once they are registered.
// Settings key 'marks.lastColor': a MarkColor, default 1. It is the colour that H and the menu use next.
// Area marks keep color null and draw in --sop-area-outline. P8's "border in the mark colour" means that token.
```

**The one owner decision: how the right-click menu looks.**
- The default is dark, like our viewer's File menu, because the whole viewer UI is dark (R48).
- The alternative is light, like Drive's right-click menu in its file list.
- The visual critic checks it against both references.

**Risks**
- **AltGr layouts.**
  - On a German layout, Ctrl+Alt+M arrives as `µ`. S13 matches the physical key's base letter, using `navigator.keyboard.getLayoutMap()`.
  - Alt+Shift+5 is matched by key position.
  - Ctrl+U and Ctrl+B call `preventDefault` only when text is selected.
  - The layouts are checked by hand at the gate.
- **Page shift at fit width.** When the margin column first appears, the page moves left. If the visual critic finds that jarring, the column stays open for every document with notes.
- **Bold speed.** The cost grows with the number of glyphs: about 0.07 ms a glyph with the wrapped calls. S11 needs the direct calls and the outline cache to stay under 50 ms on long selections. OCR text never gets bold.
- **Core types reference viewer types** through `import type`, as Task 30's filter types already do. If the workspace refuses this, the shared geometry types move to core and the viewer re-exports them.
- **Spec readings a test author may guess differently.** The controller triages each one.
  - Esc with text sends the note (the spec says Esc "saves typed text"; research 04 A(ii)).
  - "Moved" shows for `fuzzy`, `caption` and `image` placements.
  - Undoing a first-mark save also removes the mark.
- **Privacy.**
  - Nothing is written for an unsaved or memory-only PDF: no `page_figures`, no drafts, no marks.
  - Search sends only the selected words, and only when you press it.
  - Copy image stays local.
  - S2, S8, S9 and S13 each get a security read.
