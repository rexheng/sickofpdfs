# Phase 0 spike report

Phase 0 is a throwaway engine proof in `spikes/phase0/`. It has its own package and lockfile, outside the workspace. It checks that EmbedPDF 2.15.1 (PDFium compiled to wasm) works inside a Chrome MV3 extension within the spec's budgets, before production code depends on it. The checks are listed in the plan (`docs/superpowers/plans/2026-10-31-release1-phase0-1.md`, Phase 0).

## How to reproduce

```bash
pnpm -C spikes/phase0 install
pnpm -C spikes/phase0 fixtures            # SOP_FIXTURE_SRC=<folder> copies instead of downloading
pnpm -C spikes/phase0 fixtures:scan       # scan-600.pdf for P0-3 (about 4 minutes, 178 MB)
pnpm -C spikes/phase0 fixtures:textlayer  # tl-*.pdf for P0-4 (a few seconds)
pnpm -C spikes/phase0 build
pnpm -C spikes/phase0 exec playwright test
pnpm -C spikes/phase0 report              # rewrites the table below
```

Each check writes `spikes/phase0/results/P0-<n>.json` through `tests/record.ts`. A test that fails writes a FAIL entry with its error, so a failed check still gets a row.

Runs on headless Linux are smoke runs only. The speed budgets are measured on the reference laptop (the `perf-gate` job, Task 32).

## Results

Result values: PASS, FAIL, BLOCKED, NOT RUN, and MIXED. MIXED means some variants of the check passed and some failed; each part of "Measured" then names its own result.

<!-- results:start -->
| Check | Name | Result | Measured | Notes |
| --- | --- | --- | --- | --- |
| P0-1 | EmbedPDF renders in MV3 with bundled wasm and fonts | PASS | v2-blob first page 250 ms; v2-file first page 179 ms |  |
| P0-2 | Zero network beyond the PDF | PASS | 2 requested URLs in the net log, all 127.0.0.1:40845: /font-fixture.pdf, /paper-50.pdf | Chromium's own service requests left out: clients2.google.com, accounts.google.com, www.google.com, update.googleapis.com |
| P0-3 | 600-page scan scrolls with no blank page over 150 ms | PASS | workers=1 steady: blank p50 0 / p95 0 / max 0 ms over 34 pages; workers=1 jump: blank p50 52.9 / p95 56.3 / max 56.3 ms over 3 pages; workers=2 steady: blank p50 0 / p95 0 / max 0 ms over 32 pages; workers=2 jump: blank p50 49.3 / p95 49.6 / max 49.6 ms over 3 pages |  |
| P0-4 | Text-layer selection suite | PASS | two-column@100% drag 20/20; two-column@100% edge 0.509 px, overlap 1; two-column@200% drag 20/20; two-column@200% edge 0.506 px, overlap 1; rotated-table@100% drag 20/20; rotated-table@100% edge 0.472 px, overlap 0.999; rotated-table@200% drag 20/20; rotated-table@200% edge 0.468 px, overlap 1; ligatures@100% drag 20/20; ligatures@100% edge 0.485 px, overlap 1; ligatures@200% drag 20/20; ligatures@200% edge 0.506 px, overlap 1; maths@100% drag 20/20; maths@100% edge 0.477 px, overlap 0.999; maths@200% drag 20/20; maths@200% edge 0.505 px, overlap 0.999; rtl@100% drag 20/20; rtl@100% edge 0.507 px, overlap 1; rtl@200% drag 20/20; rtl@200% edge 0.512 px, overlap 1; rotated-page@100% drag 20/20; rotated-page@100% edge 0.509 px, overlap 1; rotated-page@200% drag 20/20; rotated-page@200% edge 0.506 px, overlap 1; resnet-p1@100% drag 20/20; resnet-p1@100% edge 0.516 px, overlap 0.973; resnet-p1@200% drag 20/20; resnet-p1@200% edge 0.516 px, overlap 0.998; attention-p1@100% drag 20/20; attention-p1@100% edge 0.521 px, overlap 0.973; attention-p1@200% drag 20/20; attention-p1@200% edge 0.509 px, overlap 0.999; attention-p2@100% drag 20/20; attention-p2@100% edge 0.521 px, overlap 0.998; attention-p2@200% drag 20/20; attention-p2@200% edge 0.521 px, overlap 0.999; two-column select-all = PDFium text (2163 chars); = truth; rotated-table select-all = PDFium text (205 chars); = truth but for PDFium line breaks (R26 engine limit); ligatures select-all = PDFium text (57 chars); = truth; maths select-all = PDFium text (202 chars); = truth but for PDFium line breaks (R26 engine limit); rtl select-all = PDFium text (245 chars); rotated-page select-all = PDFium text (2163 chars); = truth; resnet-p1 select-all = PDFium text (4258 chars); attention-p1 select-all = PDFium text (2855 chars); attention-p2 select-all = PDFium text (4249 chars); column drag: 1 range, 37 chars, no column-2 lower text; rtl: 77/85 spans rtl; drags both ways [[0,249]] and [[0,249]] | vs truth first difference at 40: " station Statio n D e pth T e " vs " station Station Depth Tempera"; vs truth first difference at 37: "as an area of x 2 square units" vs "as an area of x2 square units." |
| P0-5 | Bold as a glyph-outline overlay | NOT RUN | | |
| P0-6 | 300 MB tab↔offscreen moves; the 1 GB open limit | NOT RUN | | |
| P0-7 | Form-field detection | NOT RUN | | |
| P0-8 | Backup-folder permission from an extension origin | NOT RUN | | |
| P0-9 | TypeScript 7 with typescript-eslint | NOT RUN | | |
| P0-10 | Page objects find figures within 20 ms a page | NOT RUN | | |
<!-- results:end -->

## Notes

All numbers so far come from Chrome for Testing 153.0.8010.12 on Linux, launched by Playwright 1.63.0 with `channel: 'chromium'` in the new headless mode.

### P0-1 EmbedPDF in MV3

- **Both v2 variants work.** The v3 fallback (`@embedpdf/engine` 3.0.0-next.19) was not needed, so it was not added.
- **`v2-blob`: the blob-worker risk (research 01 §5 gotcha 4) does not occur.** The stock `createPdfiumWorkerEngine` ran inside the extension page under `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`:
  - its PDFium worker and both PNG-encoder workers started from `blob:` URLs;
  - there was no CSP violation, no worker error event, and no console output, so the encoder did not fall back to the main thread.
- **`v2-file`:** our own module worker runs from `chrome-extension://…/assets/engine.worker-*.js`.
- **Both engines draw identical pixels** at scale 1.5 (918 × 1188 px). Ink is 0.0766 on paper-50 page 1 and 0.0295 on the font fixture.
- **Fonts come from the extension.** Both engines asked for exactly `pdf/NotoSans-Regular.ttf` and `pdf/NotoSansHans-Regular.otf` at `chrome-extension://` URLs.
  - `v2-file` reads the list from `SpikeNative.fontRequests()`.
  - `v2-blob` uses an XHR probe that the spike prepends to the stock blob workers. The probe only reports URLs. It is needed because the stock font loader is a synchronous XHR inside a `blob:` worker, which neither the page nor the extension's service worker can see.
- **The font fixture discriminates.** PDFium in Node (same wasm) gives these ink values for the fixture:
  - 0.0027 with no fallback fonts;
  - 0.0031 with the Latin font only;
  - 0.0295 with the bundled CJK font.
  
  So the 0.005 threshold passes only when the bundled CJK font draws 日本語.
- **First page (smoke, from check start to page 1 on the canvas):** 190–215 ms for `v2-file` and 265–450 ms for `v2-blob`. Across runs, `v2-file` splits into about 100 ms worker and wasm start, 40 ms open and 75 ms render. `v2-blob` is slower because each page goes RGBA → PNG (encoder worker) → `ImageBitmap`.
- **For Task 15:**
  - Vite also emits an unused second copy of the wasm as `assets/pdfium-*.wasm` (4.65 MB). It comes from the Emscripten glue's default URL; the spike passes `wasmBinary` fetched from `pdf/pdfium.wasm` instead.
  - `pnpm patch-commit` (pnpm 10.28) writes `patchedDependencies` into a new `pnpm-workspace.yaml`. The spike keeps the entry in `package.json` `pnpm.patchedDependencies`, which pnpm 10 still applies.

### P0-2 Zero network

- **The extension requested exactly the two PDFs.** wasm and fonts never touch the network.
- **Chromium itself is not quiet.** With Playwright's default switches, the browser contacts these services on its own, even with no extension page open:
  - network time (`clients2.google.com/time`);
  - Gaia `ListAccounts` (`accounts.google.com`);
  - the AI Mode eligibility probe (`www.google.com/async/folae`);
  - the component updater (`update.googleapis.com`);
  - after a few idle seconds, GCM check-in (`android.clients.google.com`).
- **Switching those services off is not workable.** Chromium honours only the last `--disable-features` switch, so adding one silently discards Playwright's own list.
- **So `tests/netlog.ts` attributes each request instead.**
  - It keeps every request from a page, worker, service worker or navigation. Those carry an initiator origin, or a frame request type such as a `chrome.tabs.create` navigation.
  - It leaves out requests started by Chromium's own services: initiator "not an origin" and request type "other".
  - The excluded hosts are listed in the P0-2 row.
  - Task 12's network gate needs the same rule.
- **A positive control shows the check is not vacuous.** The same check fetching from `localhost` appears in the reader's output.

### P0-3 600-page scan scroll

- **PASS with both worker counts.** In the steady 3000 px/s scroll, no page was ever blank. A jump shows its page after about 50 ms.
- **The steady tests check `pagesEntered > 30` (ruling R23).** The plan's `> 40` cannot be reached at fit width; see below.

| workers | Pattern | Blank p50 / p95 / max | Pages entered | Test |
| --- | --- | --- | --- | --- |
| 1 | steady, 20 s | 0 / 0 / 0 ms | 34 | PASS |
| 1 | jumps 400, 120, 599 | 49.5 / 50.8 / 50.8 ms | 3 | PASS |
| 2 | steady, 20 s | 0 / 0 / 0 ms | 32 | PASS |
| 2 | jumps 400, 120, 599 | 49.2 / 55 / 55 ms | 3 | PASS |

- **Fixture.** `scripts/make-scan-fixture.mjs` writes `scan-600.pdf`: 600 pages, 178,081,727 bytes, about 4 minutes on 4 cores.
  - Grinstead and Snell (GNU FDL, 518 pages, cycled) is rendered by PDFium in Node at 200 dpi and turned to greyscale.
  - Each page gets a skew of −0.6° to +0.6°, noise of ±8, and a gutter strip of 2% darkened on the binding side.
  - Each page is then encoded with jpeg-js at quality 60 and drawn as one image over a Letter page. There are no text objects.
  - Output is deterministic: two runs give identical bytes.
- **Check (`src/checks/scroll.ts`).**
  - It is a virtual list at fit width. Each page is `viewport − 2 × 16 px` wide, as in Phase 1's `resolveScale`, and pages are mounted for the viewport ±2 screens.
  - Headless scrollbars are overlay, so a 1366×768 viewport gives pages of 1334×1726 CSS px. Full renders are 2001×2590 px and previews (0.15 × DPR) are 138×178 px.
  - Rendering is pulled rather than queued, with one call in flight per worker. Order: previews of the visible pages, then previews of the next 10 pages in the scroll direction (LRU of 300), then full renders of the visible pages. Out-of-range work is therefore never started.
  - "Blank" runs from a page entering the viewport (the scroll position is set in `requestAnimationFrame`) to the first paint of its canvas. A page that leaves the viewport, or is still visible at the end, without a paint counts until then.
  - Each jump starts from a settled screen, with the render queue empty.
- **Why the bound is `> 30` and not the plan's `> 40` (ruling R23).** The pitch at fit width is 1726 + 16 = 1742 px, and 20 s × 3000 px/s = 60,000 px. Only 60,768 / 1742 ≈ 35 pages can enter, even at a perfect 60 fps.
  - `> 40` would hold only for pages up to about 1500 px tall: about 1160 px wide, or a viewport of about 1190 px.
  - With `> 40`, the steady tests failed at 34 and 32 pages while every blank was 0 ms.
  - R23 keeps 20 s at 3000 px/s and sets the bound to `> 30`, which needs about 86% of that distance.
- **What makes the budget: the preview lookahead.**
  - A preview costs about 50 ms of worker time (p50 53, p95 73 ms with one worker), mostly decoding the 200 dpi JPEG. It is ready long before a page arrives.
  - Positive control, with the lookahead set to 0 for one run: steady-scroll blanks become p50 54 ms and max 72–79 ms. So the measure sees blanks, and previews of visible pages alone would still be within budget.
- **Main-thread jank, fixed in the check.**
  - With a 2D `drawImage` of the 2001×2590 full render, painting took p95 68–127 ms. There were about 33 long tasks of 100–180 ms, so the rAF scroll ran at 49 fps (about 2450 px/s).
  - Handing full renders to a `bitmaprenderer` canvas (`transferFromImageBitmap`) brings painting to under 1 ms. The scroll then reaches 2933 px/s with one worker (58.7 fps, 4 long tasks, max 119 ms) and 2835 px/s with two (56.7 fps, 13 long tasks, max 144 ms).
  - Phase 1's `PageView` should do the same.
- **Two workers do not help on this 4-core runner.**
  - Full renders: p50 169 → 179 ms, p95 369 → 480 ms.
  - Preview p95: 73 → 138 ms.
  - Long tasks and dropped frames increase.
  - Detail figures come from a diagnostic run on the same build, right after the recorded run.
- **Not measured: a jump while a full render is in flight.** PDFium cannot stop a render it has started. A jump that lands while the target's worker is drawing a full page (p50 about 170 ms) waits for it, so the worst case on one worker is about 170 + 50 ms. Phase 1 can bound this by tiling full renders, as already planned above 4096 px, or by keeping previews on their own worker.
- **Engine crash handling.** `EngineWorker` used to keep its start-up `error` listener after `ready`. Any later error terminated the worker and left every pending call hanging. The fix:
  - after `ready`, an `error` or `messageerror` rejects every pending and later call with `engine worker crashed: …`;
  - the worker reports unhandled rejections from its async handler with `reportError`.
  
  A render failure ends the scroll check with that message.
- The `engine=pdfjs` variant was not added: the budget passes with both worker counts.

### P0-4 Text layer on PDFium glyph boxes

- **PASS: all 47 tests pass.**
  - The 36 drag and alignment tests pass on 9 pages at 100% and 200%.
  - On all 9 pages, the select-all text equals PDFium's text for the whole page. Ruling R26 makes that text, which Chrome's own viewer copies, the yardstick.
  - On the generated fixtures it also equals the HTML ground truth: exactly on two-column, ligatures and rotated-page, and with all whitespace removed on rotated-table and maths. Those two are an engine limitation (R26): PDFium inserts line breaks of its own there (see below).
  - The two-column and RTL tests pass.
- 100% is 96/72 CSS px per point, at DPR 1. The viewport is sized to hold the whole page, so the mouse reaches every glyph. A "drag" is a mouse-down at glyph a's PDFium centre and a mouse-up at glyph b's, through 8 moves. The expected range is [min, max + 1), and the copied text is compared with `getTextRange` after NFKC and whitespace collapsing. Endpoints are 20 seeded pairs per page: half anywhere, half within 40 glyphs.

| Page | Drag pairs (range and text), 100% / 200% | Max glyph-edge error, 100% / 200% | Min vertical overlap, 100% / 200% | Select-all = PDFium text; = HTML truth |
| --- | --- | --- | --- | --- |
| two-column | 20/20 / 20/20 | 0.509 / 0.506 px | 1 / 1 | yes; exact |
| rotated-table | 20/20 / 20/20 | 0.472 / 0.468 px | 0.999 / 1 | yes; with whitespace removed (R26) |
| ligatures | 20/20 / 20/20 | 0.485 / 0.506 px | 1 / 1 | yes; exact |
| maths | 20/20 / 20/20 | 0.477 / 0.505 px | 0.999 / 0.999 | yes; with whitespace removed (R26) |
| rtl | 20/20 / 20/20 | 0.507 / 0.512 px | 1 / 1 | yes; not compared (RTL) |
| rotated-page (/Rotate 90) | 20/20 / 20/20 | 0.509 / 0.506 px | 1 / 1 | yes; exact |
| ResNet p1 | 20/20 / 20/20 | 0.516 / 0.516 px | 0.973 / 0.998 | yes; no truth |
| Attention p1 | 20/20 / 20/20 | 0.521 / 0.509 px | 0.973 / 0.999 | yes; no truth |
| Attention p2 (inline maths) | 20/20 / 20/20 | 0.521 / 0.521 px | 0.998 / 0.999 | yes; no truth |

- **How the error and overlap are measured.**
  - Edge error is per character: the DOM Range rect against PDFium's loose box (scale and /Rotate applied), along the displayed text direction, on both edges. It covers 56 to 3,634 characters a page.
  - Chars sharing one PDFium box (ligatures) get equal shares of it.
  - Median errors are 0.07–0.18 px. The maximum sits just above the drift limit of 0.5 px, plus DOM rounding.
  - Overlap is the share of PDFium's box height covered by the DOM rect.
- **Other results.**
  - Two-column: a drag from the middle of column 1's bottom line to the middle of column 2's top line gives one range of 37 chars, with no column-2 lower text. A positive control confirms the page text does contain the sentence searched for.
  - RTL: 77 of 85 spans carry `dir="rtl"`, and dragging either way gives [0, 249).
- **How it works.**
  - `getGlyphs` reads every char's loose and tight box, effective font size, angle and generated flag from PDFium.
  - `buildTextItems` drift-splits the page into spans, each keeping all its char edges within 0.5 px of PDFium's.
  - The pdf.js `TextLayer` port renders one transparent, absolutely positioned span per item, scaled to the item's box.
  - `charRangeFromDomRange` maps the selection back to char indices.
- **Choices beyond the brief, with the evidence:**
  1. **Glyph boxes are read unrounded.** `getPageGeometry` rounds every box to whole points (`FPDF_PageToDevice`, integers at 1 px per point), up to 0.67 CSS px off at 100% and 1.33 px at 200%. `getGlyphs` takes `getPageGeometry`'s runs and reads the boxes from the same PDFium calls itself.
  2. **Runs are not split points.** Chromium's PDF output gives each glyph cluster its own text object (two-column: 2,151 runs for 2,212 chars). Splitting at runs would make every glyph its own span. Spans split instead where direction, font size or line band changes, at PDFium line breaks, and by the drift rule. The drift rule also checks each char's left edge, not only its right.
  3. **Glyph-inclusive drag selection** (`enableGlyphSelection`), as Chrome's PDF viewer selects. The browser puts each selection end at the nearest caret position, which is a coin toss at a glyph's centre. Single-click drags only; double and triple clicks keep the browser's word and line selection.
     - With it off (`snap=0`), the same seeded drags match exactly in 0–8 of 20 pairs per page and zoom, and within one char in 5–14 more.
     - Two-column at 100%: 0 exact, 12 within one char, 8 further off.
  4. **Vertical fit.** Each span's content area is scaled to PDFium's loose box (`--scale-y`), with Blink's floored half-leading. Without the floor, a 1.67 pt space on ResNet p1 overlapped only 0.79.
  5. **PDFium's joined line-end hyphen** (U+FFFE in `FPDFText_GetText`, dropped by `getTextRange`) is shown as an unselectable "-". The glyph keeps its box, and copied text drops it as PDFium does.
  6. **The layer font is the bundled `pdf/NotoSans-Regular.ttf`** (Hebrew falls back to a system font). The canvas measurer matched DOM widths within 0.02 px.
  7. **Attention page 2 is an extra fixture.** Page 1 has no inline maths.
- **Why the truth matches only without whitespace on rotated-table and maths: PDFium's text.** The text layer shows PDFium's text exactly, so copying matches what Chrome's PDF viewer (same PDFium) copies. The tests check that for every page: select-all against `getTextRange(0, all chars)`.
  - A control on these two pages, dropping or doubling one char of a span in the DOM, fails both the PDFium check and the whitespace-free truth check. So the known difference cannot hide a layer defect.
  - In the rotated table (one text object per glyph, text at 270°), PDFium inserts generated line breaks inside words: "Statio⏎n⏎D⏎e⏎pth T⏎e⏎m⏎p…".
  - Around every superscript it inserts line breaks too: `x²` copies as "x 2", while the truth has "x2". `a₀` is fine.
  - A fix would be a text model in Task 22 that drops PDFium's generated breaks between glyphs on the same visual line, used for both the DOM and the copied text.
- **Not in the suite: double-click selects whole words only when a word sits in one span.** Each absolutely positioned span is its own block, and word selection stops at block edges.
  - Drift-split cuts many words. Words in more than one span: two-column 269/390 at 100% and 341/390 at 200%; ResNet 443/665 and 479/665; ligatures 8/8, because equal shares of a ligature never match NotoSans' f and i.
  - Double-clicking the middle of a word selected the whole word for 12/44 sampled words on two-column at 100% (3/44 at 200%), and for 0–11 per page elsewhere. Across all pages and zooms, 2 of 517 sampled split words came out whole.
  - pdf.js keeps whole PDF runs in one span and gives up alignment instead.
  - Two fixes for Task 22:
    - a double-click handler that selects PDFium's word (Intl.Segmenter over the char map), like the drag rule;
    - one block per line with the drift items as inline children, so words stay in one formatting context.
- **Cost a page:**
  - `getGlyphs` 17–135 ms (`getPageGeometry`'s per-char calls plus six more per char);
  - `buildTextItems` 3.5–37 ms;
  - building the DOM 5–40 ms;
  - 26–2,550 spans.
- **Controls.** Moving the layer 2 px along the text direction raises the maximum edge error from about 0.5 px to 2.37–2.51 px on every page. On the rotated page the move has to be vertical.

## Handed to the Windows checklist

## Decision

Written at the Phase 0 gate (Task 10).
