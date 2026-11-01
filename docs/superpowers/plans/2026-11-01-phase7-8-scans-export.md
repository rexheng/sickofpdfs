# Phases 7–8 · Scanned PDFs, then export, import and courses (Release 3)

Nov 1, 2026. Spec: `docs/superpowers/specs/2026-10-31-sickofpdfs-design.md`. Contracts: `docs/superpowers/contracts/2026-11-01-cross-phase-contracts.md` (§2 model, §4 version ladder, §9 OCR and export). Rules: `CLAUDE.md`. Implementers commit no tests; they prove work by running it and taking screenshots. Spec-blind authors write the tests in §6–§7.

## 1. Goal and "done when"

**Goal.** A scan reads like any other PDF. A file you download carries your marks and threads into Foxit and Acrobat.

**Release 3 is done when** (spec):
- **Phase 7 gate:** scanned pages can be selected, marked up, searched and asked about like normal text, and the accuracy target is met.
- **Phase 8 gate:** a downloaded PDF shows our marks and threads in Foxit and Acrobat. The round-trip test passes, and you check Foxit and Acrobat by hand.

Also in scope (spec): OCR runs in the hidden page, visible pages first, and keeps going after the tab closes; layout detection runs first so figures on scans can be clicked; English first, then French and German; results are stored per page with engine name and version; an engine upgrade re-runs and re-anchors by quote; "Download with notes" uses PDFium incremental save and never modifies your original; existing PDF annotations import as editable notes without doubling; the Courses page.

**Accuracy target** (planner's proposal; the spike may change it with evidence). "Findability" is the share of true words of 4+ letters that a case-insensitive Ctrl+F would find.
- Synthetic 600-page scan: findability ≥ 98%, character error ≤ 1.5%.
- Real English scan: ≥ 95%, ≤ 3%. Real French and German pages: ≥ 93%.

## 2. Match and beat Chrome's viewer

Our takeover switches Chrome's own OCR off for every PDF we open. So Phase 7 is parity first. Until it ships, a scan is worse in our viewer than in Chrome's. A one-line hint on image-only PDFs ("Open in Chrome's viewer") for Release 1 is the controller's call; it is not in this plan.
- **Match:** pages become selectable and searchable on their own as they come into view; pages that already have text are left alone; copy, Ctrl+F and screen readers use the recognised text.
- **Beat:** visible pages first, then the whole file in the background, so Find covers every page and not only the ones visited. Results are kept: reopening shows text at once, and closing the tab does not stop the work. Marks and comments sit on recognised words and survive reload, engine upgrades and export. Ctrl+K and @Claude can use scan text. A clear "Reading text, 14 of 600 pages" state with Pause. Figures on scans can be clicked.

## 3. Frontier check (1 Nov 2026: 4 searches, and I read 4 of their hits)

- **Chrome does this itself now.** Chrome Help (`support.google.com/chrome/answer/16215622`) says scanned PDFs "are automatically converted to be searchable and selectable using OCR". A Chromium developer says it is "done on-device" (issue 424223118). The `chromium-ocr-wrapper` README adds: it uses the Screen AI component, runs per page as the page loads, skips pages that have text, and writes an invisible text layer. An extension cannot reach Screen AI, so there is no shortcut. This sets the bar in §2.
- **A newer engine exists: PP-OCRv6** (PaddlePaddle, mid-2026): tiny 1.5M, small 7.7M and medium 34.5M parameters; 50 languages, 46 of them Latin-script; runs on ONNX Runtime (`huggingface.co/blog/PaddlePaddle/pp-ocrv6`; I read a Medium summary). It joins the spike.
  - The `ppu-paddle-ocr` SDK runs PP-OCRv5 and v6 on onnxruntime-web in browsers and extensions, WebGPU first and WASM after. Its examples fetch models from GitHub at run time, which our no-download rule forbids.
  - Blog accuracy claims ("99% character accuracy", "5–15 points over Tesseract") are the authors'. The spike measures.
- Tesseract.js: nothing relevant changed. It is still CPU and WASM only.
- **Already settled (installed wasm read now, 630 exports).** Every PDFium function the write path needs is exported by the EmbedPDF 2.15.1 build: create, `SetRect`, `AppendAttachmentPoints`, `SetColor`, `SetStringValue`, `SetAP`, `SetFlags`, `SetBorder`; the fork's `SetLinkedAnnot` (`/IRT`), `SetReplyType`, `SetOpacity`, `GenerateAppearanceWithBlend`; and `FPDF_SaveAsCopy(doc, writer, flags)`. Two catches: the fork's `PDFiumExt_SaveAsCopy` takes no flags, so it is always a full rewrite; and its copy-out reads one byte per call. Incremental save needs `FPDF_SaveAsCopy` with the flag and a bulk copy. `addFunction` is exported, so a tail-only writer is possible. The spike confirms behaviour, not existence.

## 4. Slices

Tier: **high** = spec-blind tests plus a security read; **visual** = in the gallery, strong-model implementer; **low** = gates only. "Modify" marks a file of another phase.

### Phase 7 · Scanned PDFs

**7.0 Spike: OCR engine bake-off** (decision 1) — NOW · low · sonnet · L
- **Goal.** Choose engine, models, backend order and render resolution by measurement.
- **Owns.** `spikes/phase7-ocr/**` (own package and lockfile, as in Phase 0), `docs/spikes/phase7-ocr-report.md`, a fixtures manifest with sha256s (files go to gitignored `test-assets/ocr/`).
- **Candidates**, as thin adapters behind one `recognize(image) → OcrWord[]`, with no SDK default that touches the network: Tesseract.js with fast English, French and German data (`tesseract-wasm` if it is too big); PP-OCRv5 mobile and PP-OCRv6 tiny, small and medium on onnxruntime-web, WebGPU then WASM; reserve, only if all fail: docTR models via OnnxTR.
- **Fixtures.**
  - `spikes/phase0/fixtures/out/scan-600.pdf`: truth is PDFium's text of the source page (page i is source page i mod 518). Extend its generator to write a sidecar of source page and skew. Use pages 0, 25 … 575, plus 8 degraded pages (150 dpi, quality 35, 2° skew).
  - 10 real English pages from a public-domain scanned book with proofread text (Wikisource or Internet Archive), plus 3 French and 3 German. Record every licence.
  - The owner's own scan, by path, never committed.
- **Measures.**
  - Character error, findability, word-box hit rate (a recognised word's centre lies inside the true word's box), and accents on French and German.
  - Seconds per page, cold and warm p50/p95: WASM one thread, WASM threads (needs the manifest's cross-origin-isolation keys; check they do not break the viewer), WebGPU. Visible first: with pages 0–60 queued, how long until page 400 has text. Heap after 100 pages in an offscreen page.
  - Marginal zip size over the Phase 3 build, which already ships onnxruntime-web for MiniLM (same version, one copy).
  - Licences of code, weights, dictionaries and training data. Allow only Apache-2.0, MIT and BSD.
- **Extension checks.** Runs under `script-src 'self' 'wasm-unsafe-eval'`, from extension files only, in a worker started by the offscreen page; `navigator.gpu` is visible there; no request except the PDF.
- **Windows hand runs** (headless Linux has no GPU; accuracy, size and WASM speed run here):
  - W-O1: WebGPU harness page `spike.html?check=ocr-bench`, as in P0-8.
  - W-O2: the Chrome baseline. Run Chrome's own OCR on the same pages with the `chromium-ocr-wrapper` CLI (Apache-2.0, dev tool, never shipped), read its text with PDFium, score it with our scorer. If the tool fails on Windows, count 30 Ctrl+F hits by hand.
- **Decision rule.** Out on licence or below the target floors. Then highest findability on the real scan; within 1 point, smaller marginal bundle, then faster, then one pass for all three languages. With the Chrome baseline, we must be within 1 point of it or better. Speed is reported against proposed targets (visible page ≤ 3 s p95 on WASM; ≥ 20 pages a minute in the background). Flag bundle growth over 60 MB.
- **Output.** A Decision block (`OCR_ENGINE`, `OCR_MODELS`, `OCR_BACKENDS`, `OCR_THREADS`, `OCR_RENDER_DPI`, `OCR_LANGS`) as in the Phase 0 report, the table, and the scorer module (Gate 2 reuses it). Time-box 3 days; stop early if one candidate clearly wins.

**7.1 OCR text merge** — NOW (contract §9, against mocks) · high · sonnet · M
- **Goal.** A recognised page behaves like a text page for selecting, copying, painting, finding and anchoring.
- **Owns.** `packages/core/src/ocr/{types,to-glyphs,char-widths,rects,search,needs-ocr,index}.ts`; `packages/viewer/src/text/ocr-source.ts` (wraps Phase 2's `createPageTextProvider`, so its file is untouched).
- **Produces.**
  - `ocrToPageGlyphs` (contract): each word's box is split by the bundled Noto Sans advance widths, so a word stays in one span; gaps and line ends are `generated` glyphs; `glyphs.length === text.length`.
  - `ocrRects(r, start, count)` (merged line rectangles) and `searchOcr(r, query, opts): SearchHit[]`.
  - `needsOcr({ textChars, imageCoverage, hasInvisibleText })`: fewer than 15 words and a big image; render-mode-3 text counts as text.
  - `withOcr(base, lookup): PageTextProvider`.
- **Consumes.** `PageGlyphs`, `SearchHit`, `PdfRect`, `PageObjectList` (Task 15); `PageTextProvider` (§2).

**7.2 OCR engine adapter, worker and bundled models** — high · sonnet · L
- **Goal.** The winning engine runs in a worker with every file bundled.
- **Owns.** `apps/extension/src/ocr/engine/{engine,<winner>,ocr.worker,preprocess,models}.ts`; `scripts/models/{fetch-models.mjs,ocr.manifest.json}` (build time, sha256-checked); `apps/extension/scripts/copy-ocr-assets.mjs`; `apps/extension/public/ocr/` (gitignored).
- **Produces.** `createOcrEngine(assets): OcrEngine` (§9). **Consumes** `OcrWord`.
- **Depends on** 7.0's Decision, and the onnxruntime-web version Phase 3 pins. Security read: no URL except `chrome.runtime.getURL` files.

**7.3 OCR service: schema v5, store API, scheduler, two hosts** — NOW against a fake engine and page source; merges after Phase 5's v4 · high · opus (scheduling) · L
- **Goal.** Pages are read in the right order, results are kept, and no note is ever lost.
- **Owns.** `apps/extension/src/ocr/{service,scheduler,page-source,progress,adopt,upgrade}.ts`. Modify `apps/extension/src/store/{schema,migrate,store-api}.ts` (SCHEMA_V5 `page_ocr`; methods in §9) and the offscreen entry (starts the service).
- **Behaviour.**
  - Order: visible pages, then near pages in the scroll direction, then the rest outward. One page in flight (an engine cannot stop mid-page).
  - Saved PDFs run in the offscreen page with its own `PdfBackend` over the OPFS copy, so work continues after the tab closes; the tab's `hint()` is a small message. Unsaved PDFs (D7.1): the tab hosts the service in memory and writes nothing; `adopt()` writes what it has if the PDF is saved later.
  - Each page commits atomically with its `page_text` row and `source`, so a crash resumes from `page_ocr`. It respects `index_text = 0` (kept for selection, not in `page_text`).
  - **Upgrade rule (no lost notes).** A new engine version re-reads in the background. A page's new text replaces the old only if every mark and thread on that page re-anchors by exact quote; those anchors are then rewritten with the new `textSource`. Otherwise the page keeps its old text and `keptOld` counts it.
  - Late text must reach the cloud: confirm with Phase 5 that `pendingText()` sees text that arrives after the first sync. If it keys on `has_text`, finishing a document sets it.
- **Consumes** `OcrEngine`, `PageImageSource`, `needsOcr`. **Produces** `OcrService` (§9).

**7.4 Layout detection on scans** — low (labelled set in Gate 2) · sonnet · M
- **Goal.** Figures, charts and tables on scanned pages get click-able outlines.
- **Owns.** `apps/extension/src/ocr/layout/{layout-model,preprocess,decode,to-figures}.ts`; `scripts/models/layout.manifest.json` (our own ONNX export of PP-DocLayout-S, Apache-2.0, 4.8 MB, pinned by hash; not the community one).
- **Produces.** `detectScanFigures(img, pageSize, ocr): Promise<DetectedFigure[]>` with `detector: 'layout-model'`; label and caption come from OCR text. Phase 2's figure service uses it for pages it calls scans. Confident boxes only.
- **Depends on** Phase 3 (onnxruntime-web bundled) and Phase 2 (`PageFigure`, `page_figures`).

**7.5 Viewer wiring, status chip, find and Settings** — visual, and high for the unsaved path · opus · M
- **Goal.** You watch scans become text, and can pause it.
- **Owns.** `apps/extension/src/viewer/ocr/{use-ocr,OcrChip,OcrPopover,wire}.ts(x)`; `apps/extension/src/library/settings/OcrSection.tsx`. Modify the viewer runtime composition (put `withOcr` under find, marks and Claude) and `FindBar.tsx` ("12 so far, still reading 460 pages").
- **Behaviour.** Header chip "Reading text · 14 of 600"; popover with Pause, Resume and "Better recognition available". A language control only if 7.0 needs one: if a single pass reads all three languages, show none. Settings keys in §9. Nothing else pops up on its own.
- **Depends on** 7.1, 7.2, 7.3; Phase 2 (text layer, selection painting); Phase 3 (Settings).

### Phase 8 · Export, import and courses

**8.0 Spike: writing annotations back, and the Foxit/Acrobat file rules** (decision 2) — NOW · low · sonnet · M
- **Goal.** Show that our wasm build writes files Foxit and Acrobat will read, and fix the recipe.
- **Owns.** `spikes/phase8-export/**` (own package), `docs/spikes/phase8-export-report.md`, a first `docs/checklists/release3-foxit-acrobat.md`; samples in gitignored `test-assets/export-samples/`.
- **Questions.**
  1. Does each kind come out right? Highlight, Underline, StrikeOut, Square (bold, area, figure), Text, Popup, and replies with `/IRT` and `/RT`. Check the keys `/NM /T /Contents /Subj /M /CreationDate /C /CA /F /P`, the quad order, and non-ASCII text (Polish, Cyrillic, CJK).
  2. Save paths on paper-50, NBER, `scan-600.pdf` (178 MB), `password-secret.pdf`, a linearized file and a file with existing annotations: full rewrite; incremental via `FPDF_SaveAsCopy` plus bulk copy-out; **tail-only incremental** (a JS `WriteBlock` skips the original's bytes, and the result is a Blob of original plus tail). Measure time and peak memory. Check the original is an exact prefix, an encrypted file stays encrypted with the same password, and what a signed file does.
  3. Does an annotation flagged hidden vanish from `renderTile` in the open handle? Import (8.4) relies on it.
- **Foxit/Acrobat rules** are a written list, each with a source. Start from ISO 32000 §12.5 and Foxit's and Adobe's annotation guides, then add:
  - text-markup quads in Acrobat's order (top-left, top-right, bottom-left, bottom-right);
  - `/AP /N` whose `/BBox` matches `/Rect`;
  - highlights drawn with a Multiply blend; date format; unique `/NM` per page;
  - reply flags, and whether `/Popup` is needed to list a comment.
- **How, since Foxit cannot run here.** A checker applies the rules, then each file is read by every reader that runs: PDFium again, pdf.js, poppler (`pdfinfo`, `pdftoppm`) and `pypdf`; `qpdf --check` via `pikepdf` or `mutool`, as check tools only, if they install. A pixel check on poppler's render confirms each highlight shows at its quads.
- **Hand check W-F1.** The spike writes three samples for Foxit and Acrobat, each with a "what you should see" list: **A** replies threaded with empty-appearance replies (proposed default); **B** threaded, replies hidden by flag (the contract's wording); **C** replies folded into the root note. You can also save one Foxit-made and one Acrobat-made annotated file for the import checks.
- **Output.** A Decision block (`EXPORT_SAVE` = tail-only | incremental-full | full, `REPLIES_DEFAULT`, `POPUP`, `QUADS`), a "recipes" section (the call order that gave a conformant file for each kind), and the checker (8.2 promotes it). Time-box 3 days.

**8.1 PDF export and import mapping (pure)** — NOW (contract §9) · high · sonnet · L
- **Goal.** One tested table says how every note becomes a PDF annotation, and back.
- **Owns.** `packages/core/src/export/{pdf-mapping,pdf-import,nm,note-text}.ts`.
- **Produces.** `planPdfExport` and `planPdfImport` (§9); `note-text.ts` (Markdown flattened to plain text, `cite:n` to "(p. N)", `web:n` to the URL), which Phase 3's Markdown export reuses.
- **Rules.**
  - The §9 table is binding.
  - A thread that cannot be placed becomes a `/Text` note on its stored page, starting with the quote, so nothing is dropped.
  - A highlight carries one thread; a second thread on it gets its own dotted underline.
  - Bold is not offered on recognised text (Phase 2), so none is mapped for it.
  - Normalised 0–1 rectangles convert to PDF user space using the crop box's offset.
  - Replies are `threaded` or `folded`; 8.0 sets the default.
  - Import reuses `sop:<uuid>` ids as row ids and de-duplicates through `pdf_import_refs`.

**8.2 Backend annotation I/O and save** — high (engine, Gate 2) · opus · L
- **Goal.** The engine reads and writes annotations and saves a copy, as 8.0's recipes say.
- **Owns.** Modify `packages/viewer/src/backend/{types.ts,embedpdf/{sop-native,backend,engine.worker,rpc}.ts}` and the engine patch. New: `embedpdf/{annots,ap-streams,save-tail}.ts`; `scripts/verify/annot-conformance.mjs` (the promoted checker plus the sample generator).
- **Produces.** `readAnnotations`, `writeAnnotations`, `getPageGeometry`, `charRangeInRect`, `hideAnnotations` (§9). Each export opens its own fresh handle on the original bytes, so a hidden flag never reaches a file.
- **Depends on** 8.0; Phase 1 Task 15; Phase 2 `getGlyphOutlines`.

**8.3 Export action and dialog** — visual and high · opus · M
- **Goal.** File → "Download with notes" gives a copy with your notes in it.
- **Owns.** `apps/extension/src/viewer/export/{export-pdf,ExportDialog,author-name}.ts(x)`; `scripts/gen-mark-rgb.mjs` (reads mark colours from the token file; no hex in code). Modify `viewer/chrome/menus.ts` and `commands.ts`.
- **Flow.** Gather live, non-draft rows and the in-memory placements; plan; call `getGlyphOutlines` for bold; write; download `<name> (with notes).pdf`. The dialog asks your name on the notes once (`export.authorName`), offers "Replies: as threads | in one note", and shows progress on big files. It also works on an unsaved PDF, from the notes held in memory.
- **Depends on** 8.1, 8.2, Phase 2.

**8.4 Import on open** — high · sonnet · M
- **Goal.** Notes made in other apps show up as editable notes, once.
- **Owns.** `apps/extension/src/viewer/import/{import-annotations,ImportChip}.ts(x)`. Modify store `schema/migrate/store-api` (SCHEMA_V6 `pdf_import_refs`, `applyImport`, `undoImport`).
- **Behaviour.**
  - Saved PDFs only; unsaved ones just display. After the first page is drawn, read annotations on a budget, build anchors with Phase 2's `buildTextAnchor` and `charRangeInRect`, and write rows and refs in one transaction.
  - Hide the originals in the open handle so nothing draws twice. Show "Imported 6 notes from the PDF · Undo"; Undo removes the rows and un-hides.
  - FreeText, Ink, Stamp, Line, links and form widgets stay as they are. Colours map to the nearest of the five slots. Replies become a thread in time order. The PDF's author name is kept as a label (`ImportedMeta`), not as `author`.
- **Depends on** 8.1, 8.2, Phase 2.

**8.5a Course detection (pure)** — NOW · low · sonnet · S
- **Owns.** `packages/core/src/courses/{detect,group}.ts`.
- **Produces.** `detectCourseCode({ canonicalLinks, filePaths, viaPage, title, firstPageText })` (a code, its source, a confidence; patterns like EC1A1, ECON101, MA 3102, CS50, 14.01, 6.006) and `groupByCourse(items, overrides)`.

**8.5b Courses page** — visual · opus · M
- **Goal.** Readings group by course; rename and merge freely.
- **Owns.** `courses/{CoursesPage,CourseCard,MergeDialog,use-courses}.tsx`, placed beside Phase 3's library pages (Phase 5–6 CA6: shared code, no `chrome.*`). Modify library nav and routes ("Courses") and the store (`listCourseInputs`).
- **Storage.** Existing `settings` rows, which already sync and back up: `course.<id>` = { name, codes } and `course.of.<sha>` = course id. No new table.
- **Depends on** 8.5a and Phase 3.

**8.6 Release 3 touch-ups to Phase 3 files** — high (backup and restore) · sonnet · S
- **Goal.** Scan text and the new labels survive backup, restore and Markdown export.
- **Owns.** Modify `packages/core/src/backup/format.ts`, `apps/extension/src/backup/*`, `packages/core/src/export/markdown.ts`.
  - Backup writes `ocr/<sha[0..2]>/<sha>.json`, and "Export library" includes it. Restore merges it and never replaces a newer engine's page.
  - Markdown adds "recognised text" in front matter for scan quotes, an "imported from the PDF" label, and `course:`.
  - `exportMarkdown` stays Phase 3's (contract §5); this slice only touches it, reusing `note-text.ts`.
- **Depends on** Phase 3 and 7.3.

## 5. Rounds

| Round | Slices | Starts |
| --- | --- | --- |
| **A (NOW)** | 7.0, 8.0 (spikes); 7.1, 7.3, 8.1, 8.5a (contract-only, against mocks) | Now. 7.3 merges after Phase 5's v4. |
| **B** | 7.2 (needs 7.0); 8.2 (8.0, Task 15, Phase 2); 7.4 (Phase 3's runtime); 8.5b; 8.6 | When the spike reports land and Phases 2–3 merge. |
| **C** | 7.5; 8.3; 8.4 | After B. Then the Phase 7 gate and the Phase 8 gate. |

- 14 slices; 6 start NOW. Phases 7 and 8 run side by side; the only link is 8.6 needing 7.3.
- A test build goes to the owner after each round. Round C's is the first with scans reading and "Download with notes".

## 6. Gate 1 walkthrough tests to add (spec-blind author)

Walkthrough 3 ("You open a scanned PDF") becomes real; Release 3 adds export, import and courses.
1. Open the saved 600-page scan. Within seconds, double-click a word on page 1, then drag and copy a sentence: the copy is close to the page (≥ 95% of characters). The header says "Reading text · N of 600" and N rises.
2. Jump to page 400: its text is selectable soon, without waiting for earlier pages.
3. Press H on a sentence on page 12: the highlight appears in under 50 ms on the words. Add a note with Ctrl+Alt+M. Reload: same highlight, note and words.
4. Ctrl+F a word: the count grows while the file is read, and the bar says how many pages are unread. Ctrl+K finds a phrase that exists only in the scan, with page and snippet.
5. Close the tab at page 30, wait, reopen from the library: more pages are done, and page 300 has text at once.
6. An unsaved scan (unknown site): text is selectable in the tab; after closing, no history row, page text or search entry exists. A normal paper shows no chip and gets no recognition rows. A text PDF with 5 scanned pages reads only those 5.
7. A figure on a scanned page gets an outline on hover; click it, comment, reload.
8. **Download with notes** on a paper with a highlight, underline, bold, strikethrough, area, a comment with two replies (one from Claude), a page note and a figure comment. The file downloads; the original is byte-identical. Another reader (poppler, pypdf) lists the right annotations, replies point at the right root, and each highlight shows at its place in a render.
9. Open the downloaded copy: every note appears once. Edit one and export again: one each, with the edit.
10. A PDF annotated in Foxit or Acrobat (hand-supplied, else a generated stand-in): "Imported N notes · Undo", editable notes, replies in order; Undo restores the plain view.
11. A password PDF exports and opens with the same password. A highlight on a scan exports at the right place on the scan.
12. Three readings mention EC1A1 (link, folder, first page): one course, "EC1A1 · 3 readings". Rename it, merge it with another, reload: unchanged.

**Spec-blind unit tables (rule 7), tricky logic only:** `needsOcr`; OCR glyph, rect and search offsets; export mapping; import de-duplication; course codes.

## 7. Gate 2 (engine reference set) additions

- **Mixed scan file** (generated): text pages, scan pages, and pages that already carry render-mode-3 text. Expected: exact per-page "needs OCR", no recognition on text pages. Born-digital page text hashes are identical with the OCR service present.
- **Real scan, 10 pages** (public domain) plus the 24 synthetic pages. Judged by thresholds, not hashes, because WASM and WebGPU numbers differ: scores within 1 point of 7.0's Decision using its scorer; word-box hit rate ≥ 97%.
- **Export dump** on 4 PDFs (paper, 600-page scan, one with existing annotations, password) with a fixed note set: hash of the normalised annotation dump; exported bytes start with the original bytes; perceptual hash at the quads; time and peak memory of the 178 MB save.
- **Layout set:** 10 scanned pages with hand-drawn figure boxes; precision and recall at IoU ≥ 0.7.
- **Speed:** the Phase 0 600-page scroll check runs again with OCR running, in the perf gate: no blank page over 150 ms.
- Differences are shown before/after and approved or rejected, never re-recorded.

## 8. Gate 3 screens to add

1. Scanned page with the chip "Reading text · 14 of 600"; the chip popover (progress, Pause, "Better recognition available").
2. Find bar with partial results on a scan.
3. Selection on recognised text beside Chrome's own searchified selection (the owner supplies the Chrome reference). A highlight and comment card on a scan. A figure outline on a scanned page.
4. File menu with "Download with notes"; the export dialog (name, replies choice, progress, done); the "Imported N notes · Undo" chip.
5. Courses: grid and list, inline rename, merge dialog, empty state, nav item. Settings → scanned text (only if a language control exists).

## 9. Contract additions

Where a name differs in practice, the task report says so (rule 5).

```ts
// packages/core/src/ocr/types.ts (adds to §9's OcrWord / OcrPageResult)
export interface OcrEngine { readonly id: string; readonly version: string;
  recognize(img: ImageBitmap, o: { pageSize: PageSize; dpi: number; langs: string[]; signal?: AbortSignal }): Promise<OcrWord[]>; dispose(): void }
export interface PageImageSource { pageCount: number; pageSize(i: number): PageSize; renderForOcr(i: number, dpi: number, signal?: AbortSignal): Promise<ImageBitmap>;
  pageKind(i: number): Promise<{ textChars: number; imageCoverage: number; hasInvisibleText: boolean }> }   // tab: its PdfBackend; offscreen: its own over the OPFS copy
export interface OcrProgress { documentId: DocumentId; state: 'idle' | 'running' | 'paused' | 'done' | 'error' | 'off'; total: number; done: number; error: string | null; upgrading: boolean; keptOld: number }
export interface OcrService { start(j: { documentId: DocumentId; source: PageImageSource; persist: boolean; langs: string[] }): Promise<void>;   // persist:false = memory only
  hint(id: DocumentId, h: { visible: number[]; direction: 1 | -1 }): void; pause(id: DocumentId): void; resume(id: DocumentId): void; stop(id: DocumentId): void;
  adopt(id: DocumentId): Promise<void>; result(id: DocumentId, pageIndex: number): Promise<OcrPageResult | null>; onProgress(cb: (p: OcrProgress) => void): () => void }
// StoreApi (Phase 7): putPageOcr(r, { index: boolean }) writes page_ocr and page_text (source 'ocr:<engine>@<version>') in one transaction and publishes both changes;
//   getPageOcr(id, i); listPageOcr(id); deletePageOcr(id, pageIndexes) (also the matching OCR page_text rows); setHasText(id, on)
// Settings keys (synced rows): ocr.enabled (true), ocr.languages (['en']), ocr.unsavedInMemory (true, D7.1), export.authorName, export.replies ('threaded' | 'folded'), course.<id>, course.of.<sha>
// packages/viewer/src/backend/types.ts (Phase 8)
export interface PageGeometry { crop: [number, number, number, number]; media: [number, number, number, number]; rotation: Rotation }   // PDF user space, origin bottom-left
export interface PdfAnnotation { objectNumber: number; nm: string | null; subtype: string; pageIndex: number; rect: PdfRect; quads: PdfRect[]; rgb: [number, number, number] | null; opacity: number | null;
  contents: string | null; author: string | null; subject: string | null; createdAt: number | null; modifiedAt: number | null; irtObjectNumber: number | null; replyType: 'R' | 'Group' | null; flags: number; hasAppearance: boolean }
// PdfBackend: getPageGeometry(doc, i); readAnnotations(doc, i): PdfAnnotation[]; charRangeInRect(doc, i, rect): { start: number; end: number } | null;
//   hideAnnotations(doc, items: { pageIndex: number; objectNumber: number }[]) (open handle only, never saved);
//   writeAnnotations(source: Blob, plan: PdfAnnotationPlan[], o: { password?: string; save: 'tail' | 'incremental' | 'full' }): Promise<Blob>   // opens its own handle
// packages/core/src/export/pdf-mapping.ts (pure)
export interface PdfAnnotationPlan { nm: string; subtype: 'Highlight' | 'Underline' | 'StrikeOut' | 'Square' | 'Text' | 'Popup'; pageIndex: number; rect: PdfRect; quads: PdfRect[];
  rgb: [number, number, number] | null; contents: string | null; author: string | null; subject: string | null; createdAt: number; modifiedAt: number;
  irt: string | null /* root nm */; popupOf: string | null; flags: number; ap: { kind: 'text-markup' | 'dotted-underline' | 'bold-outlines' | 'box' | 'note-icon' | 'empty'; chars?: { start: number; count: number } } }
export function planPdfExport(i: { marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[]; geometry: PageGeometry[]; place(a: Anchor): NormRectsByPage | null },
  o: { replies: 'threaded' | 'folded'; markRgb: Record<MarkColor, [number, number, number]>; ownerName: string }): { annotations: PdfAnnotationPlan[]; notPlaced: ThreadId[] };
export function planPdfImport(read: PdfAnnotation[], known: { refs: { pdfRef: string; rowId: string }[] }, anchorFor: (a: PdfAnnotation) => Anchor | null):
  { marks: MarkRow[]; threads: ThreadRow[]; comments: CommentRow[]; refs: ImportRef[]; hide: { pageIndex: number; objectNumber: number }[]; skipped: { objectNumber: number; subtype: string }[] };
// /NM: 'sop:<rowId>' on a row's first page; 'sop:<rowId>~<pageIndex>' on later pages of a mark that spans pages. Import merges the parts back by prefix and reuses <rowId> as the id.
// CommentMeta gains ImportedMeta { kind: 'pdf-import'; v: 1; author: string | null; ref: string; modifiedAt: number | null }. Imported rows keep author 'me'.
// Backup (Phase 3 format, still version 1): optional ocr/<sha[0..2]>/<sha>.json = { format: 'sop-ocr', version: 1, engine, engineVersion, pages: OcrPageResult[] }; manifest gains optional ocr: { <sha>: pageCount }
```

**Open decisions** (numbered to avoid the D9/D10 already used in the Phase 5–6 plan; defaults apply until you say).
- **D7.1 Scans you have not saved.** The spec says OCR runs "only for saved PDFs", but Chrome reads any scan, so we would be worse than Chrome on unsaved ones. Default: read unsaved scans in memory, in the open tab only (Incognito too), visible pages first. Nothing is stored, and it is gone when the tab closes. The filter still never reads scans to decide. Switch: `ocr.unsavedInMemory`.
- **D8.1 Reply shape in Foxit and Acrobat.** I cannot run them. Default: threaded replies with empty-appearance replies (sample A) until your 10-minute check of the three samples (W-F1). The fold-into-one-note choice stays in the export dialog.
- **D8.2 Not in this plan:** embedding the recognised text in the downloaded copy so Foxit can search a scan. Default: no.

## 10. Risks

| Risk | Handling |
| --- | --- |
| WebGPU in an offscreen page or worker, and on your PC, is unproven | The spike checks `navigator.gpu` there. The product must work on WASM alone; WebGPU is a speed bonus. Windows run W-O1. |
| A second copy of onnxruntime-web doubles the zip | One version, shared with Phase 3's MiniLM; 7.0 measures the marginal size. |
| An SDK fetches models at run time | All files bundled; the network gate fails on any other request; security read on 7.2. |
| OCR steals CPU from scrolling | One page in flight; the 600-page scroll check runs with OCR on. |
| An engine upgrade breaks anchors | The upgrade rule in 7.3: a page keeps old text unless every note on it re-anchors exactly. |
| Foxit or Acrobat ignore our replies | Three samples, a written rules list, the folded fallback (spec risk row). Final proof is your hand check. |
| Import draws notes twice | Originals hidden in the open handle only; exports start from fresh original bytes. |
| Incremental save on odd files (signed, encrypted, hybrid xref) | 8.0 tests them. On failure a full rewrite keeps the same encryption. A signed file gets a plain warning that its signature will show as changed. |
| Wrong figure outlines on scans | Confident boxes only; labelled set in Gate 2; Alt+drag always works. |
| Bold is not offered on scans (Phase 2); raw annotation reads leak about 240 bytes each (P0-7) | Bold on scans: the spec's "strong" look would be the way, not planned. Import reads once per document, so the leak is accepted. |

## Carried requirements (controller, 1 Nov 2026, from 8.0 + 8.1)

- **Coordinates:** `PdfRect` in both the export plan and the import read shape is PDF user space (y up, origin at the page's lower left, before /Rotate). 8.2 must match this. Recorded in contracts §9.
- **8.2:** write on a fresh document handle that loads only the annotated pages (PDFium rewrites every loaded object). Keep `fixXrefStreamTail`: PDFium writes a broken xref stream in the incremental tail for files that use xref streams (7 of 11 inputs).
- **8.3:** pass `replyAppearance: 'empty'` (sample A, D8.1) until the owner's 10-minute Foxit/Acrobat check (W-F1). Add `ImportedMeta` to `CommentMeta` in `packages/core/src/model/rows.ts`. Imported Claude comments come back as author 'me' with a "from Claude" label.
- **8.1 additions (accepted):** the optional `lineRgb`, `areaRgb`, `threadRgb` and `replyAppearance`, plus `skippedMarks` in the result.
