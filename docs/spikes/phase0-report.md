# Phase 0 spike report

Phase 0 is a throwaway engine proof in `spikes/phase0/`. It has its own package and lockfile, outside the workspace. It checks that EmbedPDF 2.15.1 (PDFium compiled to wasm) works inside a Chrome MV3 extension within the spec's budgets, before production code depends on it. The checks are listed in the plan (`docs/superpowers/plans/2026-10-31-release1-phase0-1.md`, Phase 0).

## How to reproduce

```bash
pnpm -C spikes/phase0 install
pnpm -C spikes/phase0 fixtures            # SOP_FIXTURE_SRC=<folder> copies instead of downloading; also forms/*.pdf for P0-7
pnpm -C spikes/phase0 fixtures:scan       # scan-600.pdf for P0-3 (about 4 minutes, 178 MB)
pnpm -C spikes/phase0 fixtures:textlayer  # tl-*.pdf for P0-4 (a few seconds)
pnpm -C spikes/phase0 fixtures:objects    # objects.pdf and tagged.pdf for P0-10 (a few seconds)
pnpm -C spikes/phase0 build
pnpm -C spikes/phase0 exec playwright test
pnpm -C spikes/phase0 report              # rewrites the table below
```

Each check writes `spikes/phase0/results/P0-<n>.json` through `tests/record.ts`. A test that fails writes a FAIL entry with its error, so a failed check still gets a row.

Runs on headless Linux are smoke runs only. The speed budgets are measured on the reference laptop (the `perf-gate` job, Task 32).

## Results

Result values: PASS, FAIL, BLOCKED, NOT RUN, and MIXED. MIXED means some variants of the check passed and some failed; each part of "Measured" then names its own result. ", PART DEFERRED" after a result means a part of the check was not run, by decision; the Notes cell says which part and why.

<!-- results:start -->
| Check | Name | Result | Measured | Notes |
| --- | --- | --- | --- | --- |
| P0-1 | EmbedPDF renders in MV3 with bundled wasm and fonts | PASS | v2-blob first page 250 ms; v2-file first page 179 ms |  |
| P0-2 | Zero network beyond the PDF | PASS | 2 requested URLs in the net log, all 127.0.0.1:40845: /font-fixture.pdf, /paper-50.pdf | Chromium's own service requests left out: clients2.google.com, accounts.google.com, www.google.com, update.googleapis.com |
| P0-3 | 600-page scan scrolls with no blank page over 150 ms | PASS | workers=1 steady: blank p50 0 / p95 0 / max 0 ms over 34 pages; workers=1 jump: blank p50 52.9 / p95 56.3 / max 56.3 ms over 3 pages; workers=2 steady: blank p50 0 / p95 0 / max 0 ms over 32 pages; workers=2 jump: blank p50 49.3 / p95 49.6 / max 49.6 ms over 3 pages |  |
| P0-4 | Text-layer selection suite | PASS | two-column@100% drag 20/20; two-column@100% edge 0.509 px, overlap 1; two-column@200% drag 20/20; two-column@200% edge 0.506 px, overlap 1; rotated-table@100% drag 20/20; rotated-table@100% edge 0.472 px, overlap 0.999; rotated-table@200% drag 20/20; rotated-table@200% edge 0.468 px, overlap 1; ligatures@100% drag 20/20; ligatures@100% edge 0.485 px, overlap 1; ligatures@200% drag 20/20; ligatures@200% edge 0.506 px, overlap 1; maths@100% drag 20/20; maths@100% edge 0.477 px, overlap 0.999; maths@200% drag 20/20; maths@200% edge 0.505 px, overlap 0.999; rtl@100% drag 20/20; rtl@100% edge 0.507 px, overlap 1; rtl@200% drag 20/20; rtl@200% edge 0.512 px, overlap 1; rotated-page@100% drag 20/20; rotated-page@100% edge 0.509 px, overlap 1; rotated-page@200% drag 20/20; rotated-page@200% edge 0.506 px, overlap 1; resnet-p1@100% drag 20/20; resnet-p1@100% edge 0.516 px, overlap 0.973; resnet-p1@200% drag 20/20; resnet-p1@200% edge 0.516 px, overlap 0.998; attention-p1@100% drag 20/20; attention-p1@100% edge 0.521 px, overlap 0.973; attention-p1@200% drag 20/20; attention-p1@200% edge 0.509 px, overlap 0.999; attention-p2@100% drag 20/20; attention-p2@100% edge 0.521 px, overlap 0.998; attention-p2@200% drag 20/20; attention-p2@200% edge 0.521 px, overlap 0.999; two-column select-all = PDFium text (2163 chars); = truth; rotated-table select-all = PDFium text (205 chars); = truth but for PDFium line breaks (R26 engine limit); ligatures select-all = PDFium text (57 chars); = truth; maths select-all = PDFium text (202 chars); = truth but for PDFium line breaks (R26 engine limit); rtl select-all = PDFium text (245 chars); rotated-page select-all = PDFium text (2163 chars); = truth; resnet-p1 select-all = PDFium text (4258 chars); attention-p1 select-all = PDFium text (2855 chars); attention-p2 select-all = PDFium text (4249 chars); column drag: 1 range, 37 chars, no column-2 lower text; rtl: 77/85 spans rtl; drags both ways [[0,249]] and [[0,249]] | vs truth first difference at 40: " station Statio n D e pth T e " vs " station Station Depth Tempera"; vs truth first difference at 37: "as an area of x 2 square units" vs "as an area of x2 square units." |
| P0-5 | Bold as a glyph-outline overlay | PASS | 17/17 PDFium functions that getGlyphOutlines calls are in the wasm and the wrapper; @100%: 20 words (116 glyphs) p95 22.5 ms (first 22.5, p50 12.4), ink coverage 0.966, spill 0.003; glyph argument: unicode 116; whole page 2458 glyphs in 174.2 ms, coverage 0.956, spill 0.076, unicode 2453, ligature 4, hyphen 1, 0 undrawn; @200%: 20 words (116 glyphs) p95 18.1 ms (first 18.1, p50 9.9), ink coverage 0.985, spill 0.002; glyph argument: unicode 116; whole page 2458 glyphs in 180.9 ms, coverage 0.993, spill 0.067, unicode 2453, ligature 4, hyphen 1, 0 undrawn | @100% screenshots: spikes/phase0/results/bold-zoom1.png, spikes/phase0/results/bold-zoom1-detail.png, spikes/phase0/results/bold-zoom1-page.png; @200% screenshots: spikes/phase0/results/bold-zoom2.png, spikes/phase0/results/bold-zoom2-detail.png, spikes/phase0/results/bold-zoom2-page.png |
| P0-6 | 300 MB tab↔offscreen moves; the 1 GB open limit | PASS, PART DEFERRED | 6a port: 300 MiB to offscreen 2 ms, back 0.4 ms, round trip with the offscreen hash 1326.4 ms; detached after each send true; SHA-256 matches both ways; 6b OPFS: 300 MiB in 2691.4 ms (tab write 1164.2 ms, offscreen stream and hash 1526.5 ms); SHA-256 matches; 6c runtime.sendMessage: the 300 MiB ArrayBuffer arrived as object {} (receivedBytes null, error none) in 1.1 ms; small control message answered | DEFERRED: 1 GiB open limit not measured (stubbed by user decision); MAX_OPEN_BYTES stays 1 GiB, and larger files go to Chrome's viewer per the spec |
| P0-7 | Form-field detection | PASS | nber-w29000: formType acroform, firstFillablePage null, 133/133 pages walked, widgets {}, 40.3 ms, fillable false; lse-cep-dp1800: formType acroform, firstFillablePage null, 89/89 pages walked, widgets {}, 1 ms, fillable false; nature-s41586-021-03819-2-alphafold: formType acroform, firstFillablePage null, 12/12 pages walked, widgets {}, 7.9 ms, fillable false; lecture-notes-mit-6.006-lec1: formType acroform, firstFillablePage null, 5/5 pages walked, widgets {}, 6.4 ms, fillable false; HMRC SA100: formType acroform, firstFillablePage 2, 3/10 pages walked, widgets {"TEXTFIELD":4}, 6 ms, fillable true; IRS W-9: formType xfa-foreground, firstFillablePage null, 0/6 pages walked, widgets {}, 0.4 ms, fillable true; NBER w29000 (133 pages): detection 26.6 ms, 133 pages walked; pdf-lib textfield (push button on page 1, field on page 2): formType acroform, firstFillablePage 1, 2/2 pages walked, widgets {"PUSHBUTTON":1,"TEXTFIELD":1}, 2.4 ms; pdf-lib checkbox (push button on page 1, field on page 2): formType acroform, firstFillablePage 1, 2/2 pages walked, widgets {"PUSHBUTTON":1,"CHECKBOX":1}, 1.7 ms; pdf-lib radiobutton (push button on page 1, field on page 2): formType acroform, firstFillablePage 1, 2/2 pages walked, widgets {"PUSHBUTTON":1,"RADIOBUTTON":2}, 1.6 ms; pdf-lib combobox (push button on page 1, field on page 2): formType acroform, firstFillablePage 1, 2/2 pages walked, widgets {"PUSHBUTTON":1,"COMBOBOX":1}, 1.6 ms; pdf-lib listbox (push button on page 1, field on page 2): formType acroform, firstFillablePage 1, 2/2 pages walked, widgets {"PUSHBUTTON":1,"LISTBOX":1}, 3.7 ms; pdf-lib push button + signature: formType acroform, firstFillablePage null, 2/2 pages walked, widgets {"PUSHBUTTON":1,"SIGNATURE":1}, 1.8 ms, fillable false; pdf-lib widgets outside /Fields: formType acroform, firstFillablePage 1, 2/2 pages walked, widgets {"PUSHBUTTON":1,"TEXTFIELD":1}, 3 ms; no /AcroForm (paper-50): none; /XFA: xfa-foreground; /XFA + /NeedsRendering: xfa-full; 0/0/0 pages walked; empty /AcroForm (3 pages, no annotations) ×20001: wasm heap in use 1931264 → 1959936 bytes (28672 = 1.4 bytes a call); EPDFPage_GetAnnotRaw leak on NBER (1026 annotations a call, ×100 calls): wasm heap in use +24538112 bytes = 239 bytes an annotation, 245381 bytes for the one call a document gets |  |
| P0-8 | Backup-folder permission from an extension origin | BLOCKED | BLOCKED: 8a: the directory picker cannot be driven. showDirectoryPicker() rejected at once with "AbortError: Failed to execute 'showDirectoryPicker' on 'Window': Intercepted by Page.setInterceptFileChooserDialog()."; Playwright's filechooser event did not fire in 5 s; CDP Page.fileChooserOpened fired 1× (mode selectSingle, backendNodeId none); Chrome/153.0.8010.12 (HeadlessChrome, Playwright 1.63.0); BLOCKED: 8b: no handle to restart with, because 8a's picker cannot be driven. Not an 8b result: a folder dropped with CDP and stored in IndexedDB: read granted, readwrite prompt when dropped; after a restart read prompt, readwrite prompt; PASS: 8c: handle: a folder dropped with CDP (read granted, readwrite prompt), the picker being undrivable. requestPermission({mode:'readwrite'}) with no user activation (userActivation.isActive false, handle was prompt) -> "SecurityError: Failed to execute 'requestPermission' on 'FileSystemHandle': User activation is required to request permissions."; after: prompt. Control with a user gesture (userActivation.isActive true) -> "pending" after 3003 ms | Playwright's crPage ignores Page.fileChooserOpened without a backendNodeId, which a File System Access picker never has, and CDP has no command that answers one. Picking is left to the Windows run: W-B1..W-B3; Whether the picker's handle reports granted or prompt after a restart, and whether the "Allow on every visit" prompt appears, is left to W-B1 |
| P0-9 | TypeScript 7 with typescript-eslint | FAIL | Version 7.0.2; tsc --noEmit -p . exit 0, no output; eslint --format json src exit 2, no JSON report: typescript-eslint does not support TS 7.0. Please see https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0 to run typescript-eslint using the TS 6 API. See also https://github.com/typescript-eslint/typescript-eslint/issues/10940 for tracking typescript-eslint's support for TS >=7.1 Oops! Something went wrong! :( ESLint: 10.14.0 Error: typescript-eslint does not support TS 7.0. | typescript-eslint 8.72.1 declares the peer typescript ">=4.8.4 <6.1.0"; installed typescript 7.0.2 is outside that range |
| P0-10 | Page objects find figures within 20 ms a page | PASS | objects.pdf p1: 93 objects (1 image, 48 path, 44 text) in 1 ms, truncated false; image (72, 90, 216 × 144) 432×288 px DCTDecode; PDFium functions not exported: none; objects.pdf p1 detection in 13.7 ms: Figure 1 image high (72, 90, 216 × 144) IoU 1; Figure 2 vector high (330, 90, 200 × 140) IoU 1; Table 1 table high (72, 416.9, 302 × 85.2) IoU 0.933; tagged.pdf p1 structure tree: 11 elements (Document, H1, NonStruct, P, Figure, Caption); Figure alt "Bar chart of test scores", marked-content ids [2]; detection: Figure 1 image high (72, 142.5, 225 × 135); objects.pdf p1: 44 text runs; caption run "Figure 1: A photo." at (72, 238.9, 74.9 × 14.2), 9 pt, chars 0+18; 50 paper pages (5 papers × 10): objects + detection p50 1.7 / p95 5.5 / max 7.5 ms (first call, text page still to load: p50 3.6 / p95 9.7 / max 20.2 ms); objects a page median 285, max 1079; 45 figures (43 captioned); slowest nature-s41586-021-03819-2-alphafold p4 7.5 ms; ResNet p1 labels [Figure 1]; objects.pdf p2 (50,000 rectangles): stopped at 11072 objects in 15.3 ms, truncated true |  |
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

### P0-5 Bold as a glyph-outline overlay

> `embed-pdf-viewer-v2/packages/pdfium/src/vendor/functions.ts` exports these in the wasm wrapper: `FPDFFont_GetGlyphPath` (l.404), `FPDFFont_GetGlyphWidth` (405), `FPDFGlyphPath_CountGlyphSegments`/`GetGlyphPathSegment` (412–413), `FPDFPathSegment_GetPoint/GetType/GetClose` (541–543), `FPDFText_GetMatrix` (568), `FPDFText_GetTextObject` (575), `FPDFTextObj_GetFont`/`GetFontSize` (586–587).
>
> `PdfiumNative` (`engines/src/lib/pdfium/engine.ts`) wraps none of them. Its only page-object bounds call is at l.8291. v3 exports the same functions (`engine/runtime/src/core/pdf-functions.generated.ts`).
>
> So bold needs our subclass and no wasm rebuild.

- **Correction from re-grepping (the conclusion stands).** `PdfiumNative` does call a few of these internally: `FPDFText_GetTextObject` (l.4996, 5130) to group runs, `FPDFTextObj_GetFont` (l.5231) for font info, and `FPDFPathSegment_GetType/GetClose/GetPoint` (l.8327–8331) for annotation path objects. It never calls `FPDFFont_GetGlyphPath` or `FPDFGlyphPath_*`, and it exposes no glyph-outline method. The other functions `getGlyphOutlines` needs are also in the wrapper: `FPDFText_GetCharOrigin` (l.562), `FPDFText_GetUnicode` (576), `FPDFText_HasUnicodeMapError` (577) and `FPDFText_IsHyphen` (579). All of them are in v3's list too, and the probe test finds all 17 in the installed 2.15.1 wasm and wrapper.
- **PASS.** 20 words (116 glyphs) of the attention paper's abstract, page 1, timed over 10 reps from the request to the `<path>` elements in the DOM:

| Zoom | p95 (= the cold first rep) | p50 | Ink coverage | Spill | Whole page (2,458 glyphs, one call), diagnostic |
| --- | --- | --- | --- | --- | --- |
| 100% | 22.5 ms | 12.4 ms | 0.966 | 0.003 | 174 ms; coverage 0.956, spill 0.076 |
| 200% | 18.1 ms | 9.9 ms | 0.985 | 0.002 | 181 ms; coverage 0.993, spill 0.067 |

- **Screenshots for the gate review** (in `spikes/phase0/results/`, not committed):
  - `bold-zoom1.png` and `bold-zoom2.png`: the page with the 20 words in bold;
  - `bold-zoom1-detail.png` and `bold-zoom2-detail.png`: those lines, close up;
  - `bold-zoom1-page.png` and `bold-zoom2-page.png`: every glyph on the page in bold, as a diagnostic.
- **What bold is here.** `getGlyphOutlines(docId, page, charStart, charCount)` returns `{ charIndex, d }` per char: the glyph's outline as SVG path data in points, origin top-left (unrotated page space, like `Glyph` boxes). Per char it does the following:
  1. It reads the text object, its font and size (`FPDFText_GetTextObject`, `FPDFTextObj_GetFont`, `FPDFTextObj_GetFontSize`).
  2. It gets the outline with `FPDFFont_GetGlyphPath(font, argument, size)`. The outline is in ems.
  3. It scales the segments by size × the char matrix's linear part (`FPDFText_GetMatrix`, whose translation is the text object's, not the char's) and moves them to `FPDFText_GetCharOrigin`.
  4. It flips the result to a top-left origin.

  The check draws one `<path fill="currentColor" stroke="currentColor">` per char in an SVG over PDFium's render. Each path's stroke width is 0.03 × the char's effective font size, with round joins. Nothing is re-rendered by PDFium, and text render modes are not touched.
- **Glyph argument: `GLYPH_ARG = unicode`.** `FPDFFont_GetGlyphPath` takes a Unicode value and maps it to the font's char code itself. PDFium has no call that returns a char's code. For a char without Unicode, `FPDFText_GetUnicode` returns the code itself (`FPDFText_HasUnicodeMapError`), so "retry with the char code" is the same call. On this page no char needed it. Two cases need a different argument, and `glyphArgForms` counts them:
  - **Ligatures.** PDFium expands one "fi" glyph into two chars, "f" and "i", which share the text object and the origin. Passing "f" draws an f where the fi ligature is (width 3.98 pt against the glyph's 6.65 pt). `getGlyphOutlines` groups such chars and asks for U+FB01, which matches. There were 4 on the page. Surrogate pairs and decomposed accents are grouped the same way, but this page has none, so that path is untested.
  - **The joined line-end hyphen.** In "English-⏎to-German", `FPDFText_GetUnicode` gives 0x2 (the hyphen PDFium joins, `FPDFText_IsHyphen`), which has no glyph. U+002D draws it: its width × the line's 1.02 horizontal scale equals the char's box.
  - Whole page: unicode 2,453, ligature 4, hyphen 1, charcode 0, and **0 visible chars undrawn**. The passage is all unicode.
- **How it is measured.**
  - **Speed.** Each rep removes the bold, waits for a frame, then times `engine.call('getGlyphOutlines')` plus building and appending the paths. p95 is nearest-rank, so with 10 reps it is the slowest: the first rep, with a cold JIT and a cold PDFium glyph cache.
  - A diagnostic run on the same build gave this breakdown:
    - warm reps 7–13 ms;
    - the worker round trip 7–17 ms of each rep, and the DOM 0.4–1.9 ms;
    - the next animation frame 16–19 ms after the request.
  - **Coverage.** Glyph ink is the pixels of PDFium's render (same scale) with luminance < 128 inside the covered chars' tight boxes (`FPDFText_GetCharBox`, taken to every pixel each box touches). Coverage is the share of those pixels where the rasterised overlay (the serialised `<svg>` drawn into a canvas) has alpha ≥ 128.
  - **Spill.** The share of overlay pixels (alpha ≥ 128) whose centre is more than 2 px from every ink pixel on the page.
  - **Device px are CSS px.** This run uses DPR 1.
- **Controls** (temporary edits, not committed):

| Control | Passage coverage, 100% / 200% | Passage spill, 100% / 200% |
| --- | --- | --- |
| As committed | 0.966 / 0.985 | 0.003 / 0.002 |
| Overlay moved 1 pt along the line | 0.288 / 0.273 | 0.012 / **0.155** |
| Fill only, no stroke | **0.760 / 0.848** | 0.001 / 0 |
| Empty paths | 0 / 0 | 1 / 1 |

  - The fill alone covers only 76% (100%) and 85% (200%) of PDFium's ink. PDFium's glyph pixels reach up to about half a pixel past the exact outline. A likely cause, not verified, is glyph bitmaps placed at whole pixels. The 0.03 em stroke, 0.2 px a side at 100%, closes that gap, so the 95% bar holds only with the stroke.
  - The whole page's higher spill comes from the grey arXiv stamp in the margin: its pixels are lighter than the ink threshold, so the overlay on it counts as spill. Coverage everywhere else is high: title, CMSY superscripts, typewriter e-mails, rotated text and the non-embedded Times substitute all sit on their glyphs.
- **Look.** In the screenshots the 20 words read as bold next to regular text, with crisp edges at both zooms and no doubled outlines. Bold on text that is already bold (author names, title) gets heavier still. On this evidence the "strong" fallback is not needed; the gate decides on the screenshots.
- **For Phase 2:**
  - **Colour.** `currentColor` black turns coloured text black. The red licence line and the grey arXiv stamp show it in `bold-zoom*-page.png`. Draw each glyph in its own fill colour: `FPDFText_GetFillColor` is exported.
  - **Invisible text.** Skip text with render mode 3 or 7, for example the OCR layer of a scan. Its outlines would draw an OCR font over the scan image, and for scans bold has to be the "strong" style. Not tested here.
  - **Speed scales with glyph count.** The spike's wrapped calls cost about 0.07 ms a glyph: the whole page took 174–181 ms, and about 600 glyphs (≈ 100 words) would reach the 50 ms budget.
    - In Node, for the same page, direct `wasmExports` calls instead of the `ccall` wrappers took 81–101 ms against 243–255 ms.
    - Adding a cache of each glyph's em-space outline by (font, argument) took it to 29–38 ms.
    - The `PdfBackend` port should do both.
  - **Stroke width unit.** With the viewBox in points, the stroke width must be a unitless number of points. A literal `pt` suffix is converted at 96/72 before the viewBox scale, so it draws a third heavier.
  - **Not covered:** pages with /Rotate (the check refuses them; outlines are in unrotated space), Type3 fonts (`FPDFFont_GetGlyphPath` needs a font program), vertical CJK text, and DPR 1.5.
- **Test title.** "the nine glyph-path functions" is verbatim from the plan. The probe checks all 17 functions `getGlyphOutlines` calls, in both the wrapper and the wasm.

### P0-6 300 MB between a tab and the offscreen document

- **6a–6c PASS. 6d and 6e (the 1 GiB open limit) were not run: the user stubbed them.** There are no 1 / 1.5 / 1.9 GiB fixtures and no `big-open` check. `MAX_OPEN_BYTES` stays 1 GiB, and larger files go to Chrome's viewer, as the spec says. The Task 10 engine rule asks for a P0-6d PASS, so the gate needs a ruling on that rule.
- **Results**, all 300 MiB of `crypto.getRandomValues` bytes, with SHA-256 compared on both sides:

| Transport | Recorded run | Four earlier runs | Bar |
| --- | --- | --- | --- |
| 6a SW-brokered MessagePort, ArrayBuffer transferred | to the offscreen document 2 ms, back 0.4 ms | 1.8–6.2 ms, 0.2–0.4 ms | < 1000 ms each way |
| 6b OPFS: `createWritable` in 16 MiB slices, then `getFile().stream()` | 2691 ms: write 1164 ms, stream and hash 1527 ms | 2670–3689 ms | < 5000 ms |
| 6c `chrome.runtime.sendMessage({ buffer })` | arrived as `{}`, no error, 1.1 ms | the same | must not arrive |

- **`STORE_TRANSPORT = sw-brokered-port` works.** The steps, as built in `entrypoints/background.ts`:
  1. The tab calls `(await navigator.serviceWorker.ready).active.postMessage({ type: 'connect-offscreen' }, [port2])`. This works from an extension page.
  2. The service worker checks `runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })` and, if there is none, calls `offscreen.createDocument` with reason `WORKERS`. Concurrent callers share one creation.
  3. `clients.matchAll({ includeUncontrolled: true })` lists the offscreen document, and `client.postMessage({ type: 'port' }, [port])` hands it the port.
  4. The offscreen document gets the port in `navigator.serviceWorker.onmessage`.

  If any step fails, the service worker answers `{ type: 'error' }` on the port, so the tab never waits forever. Task 28 should keep that.
- **The port move is a zero-copy transfer.** After each `postMessage` the sender's ArrayBuffer is detached, and 6a asserts that on both sides. 300 MiB arrives in about 2 ms and returns in 0.4 ms, which is possible only without a copy. The viewer tab and the offscreen document are both pages of the extension, in one renderer process. That is inferred from the timing, not observed. If Chrome ever puts them in separate processes, the bytes are copied; this spike does not measure that case.
  - **Control** (temporary, not committed): with the tab's transfer list dropped, the buffer is copied. It arrives in 447 ms, inside the 1000 ms bar, so only the detach assertion turns 6a red.
- **The 1.2–1.4 s "round trip" in 6a is almost all hashing.** It includes the offscreen document's SHA-256 of 300 MiB with hash-wasm, which runs at about 220–250 MB/s here (`sha256sum`, with SHA-NI, does 1.2 GB/s on the same machine). That hash only verifies the spike. Phase 1 hashes the PDF while it streams into the viewer, so the store never needs to hash it again.
- **OPFS needs large writes.** A diagnostic (temporary, not committed) wrote 300 MiB through `createWritable` in a fresh profile, timed from `createWritable` to `close`:

| Size of each `write()` | Write time |
| --- | --- |
| the whole 300 MiB buffer | 1.0–4.0 s (2.3–4.0 s the first time in a profile) |
| 16 MiB | 1.05–1.44 s |
| 4 MiB | 1.15–1.23 s |
| 1 MiB | 1.35–1.61 s |
| 64 KiB (a fetch stream's chunk size) | 6.0–6.3 s |

  - Reading the file back with `getFile().stream()` took 0.33–1.65 s.
  - The first 6b run wrote the whole buffer in one `write()` and failed the bar: 5992 ms (write 3954 ms, stream and hash 2037 ms). The check now writes 16 MiB slices.
  - **For Phase 1** ("PDF bytes go straight to OPFS"): do not `pipeTo` a fetch body straight into the writable. Gather its chunks into writes of at least 4 MiB.
  - For scale, `dd` with `fsync` writes 300 MiB to this disk in 1.8 s.
- **`chrome.runtime.sendMessage` cannot carry bytes.** The 300 MiB ArrayBuffer arrived as `{}`, with no error and no bytes, in about 1 ms. A small control message was answered first, so the channel itself worked.
  - The 64 MB message limit was never reached, because the buffer serialises to two characters. This spike does not measure that limit.
  - `chrome.runtime.connect` ports are documented to serialise the same way (not tested here). So with `STORE_TRANSPORT = runtime-port`, PDF bytes would have to go through OPFS.
- **How it is measured.** All times come from the tab's `performance.now()`.
  - `toOffscreenMs` runs from the tab's `postMessage` to the offscreen document's `got` reply. `backMs` runs from the tab's `send-back` request to the buffer's arrival. Each includes one small control message, so both are upper bounds.
  - 6b's time runs from `createWritable` to the offscreen document's reply after it has read and hashed the whole file. The hash is included, so the number is conservative.
- **Fixture server** (`tests/server.mjs`, checked by `tests/server.spec.ts`).
  - Files are streamed with `pipeline()`. A client that leaves mid-file now closes the file; before, its read stream stayed open. A read error no longer goes unhandled.
  - A single byte range gets 206 with `Content-Range`.

### P0-7 Form-field detection

- **PASS.** `getFormInfo` runs in the engine worker. The 7 brief tests pass with their assertions unchanged; 10 more pin down the rule and the leak (below). Cold worker, timed inside the worker:

| Fixture | Pages | formType | firstFillablePage | Pages walked | Time |
| --- | --- | --- | --- | --- | --- |
| NBER w29000 | 133 | acroform | none | 133 | 24–40 ms (bar: < 200 ms) |
| LSE CEP dp1800 | 89 | acroform | none | 89 | 1–2 ms |
| Nature AlphaFold | 12 | acroform | none | 12 | 8–11 ms |
| MIT 6.006 lec 1 | 5 | acroform | none | 5 | 2–6 ms |
| HMRC SA100 (4 text fields) | 10 | acroform | 2 (the third page) | 3 | 3–6 ms |
| **IRS W-9** | 6 | **xfa-foreground** | none (XFA is not walked) | 0 | 0.4 ms |

  - **The W-9 reports `xfa-foreground`** (`/AcroForm` has `/XFA`, and the catalog has no `/NeedsRendering true`). `hasFillableFields` is true by the `xfa` prefix. A scratch walk of its AcroForm layer found 8 checkboxes and 15 text fields on page 1.
  - **The four hyperref-style papers have no widgets at all** (`widgets {}`), not just no fillable ones. The SA100 has 4 text fields on its first three pages.
- **Field types.** EmbedPDF's `PDF_FORM_FIELD_TYPE` has the same values as PDFium's `FPDF_FORMFIELD_*` for 0–7: UNKNOWN 0, PUSHBUTTON 1, CHECKBOX 2, RADIOBUTTON 3, COMBOBOX 4, LISTBOX 5, TEXTFIELD 6, SIGNATURE 7 (8–15 are its XFA kinds). PDFium's own answers on pdf-lib documents (`fixtures/out/forms/`, made by `scripts/make-forms-fixture.mjs`) confirm the numbers: each of the five fillable kinds counts after a push button on page 1 (`firstFillablePage` 1), and a push button plus a signature field make no form.
- **Form types.** `FPDF_GetFormType` gives `none` for a file without `/AcroForm` (paper-50), `xfa-foreground` for `/XFA`, and `xfa-full` for `/XFA` with `/NeedsRendering true`. Only the W-9 and these synthetic files cover the XFA values.
- **The walk differs from the plan, which says `getPageAnnoWidgets` on each page.** It reads each page's `/Annots` raw (`EPDFPage_GetAnnotCountRaw`, `EPDFPage_GetAnnotRaw`), asks each Widget its type with `FPDFAnnot_GetFormFieldType`, through one form-fill environment per call, and loads no page. NBER, first call in a cold worker (8 runs of each):

| Walk | Time |
| --- | --- |
| Raw annotations (recorded) | 25–50 ms |
| `FPDF_LoadPage` + `FPDFPage_GetAnnot` on every page, one environment | 183–232 ms |
| The same, skipping pages whose raw annotation count is 0 | 140–208 ms |
| EmbedPDF's `getPageAnnoWidgets` on every page (9 fresh documents in a warm worker; it also writes an `/NM` into every annotation) | 127–215 ms |

  The page walks miss or graze the 200 ms bar. Loading a page costs about 1 ms on this paper and 6–12 ms on a drawing-heavy one (Nature), so a 600-page book with links would hold the worker for about 0.6 s (extrapolated). EmbedPDF's walk and the raw walk give the same answers on the six PDFs.
- **A known engine leak.** `EPDFPage_GetAnnotRaw` leaks 130–240 bytes an annotation (133 B by heap growth, 239 B by bytes in use) even though each annotation is closed with `FPDFPage_CloseAnnot`.
  - Probed in Node on the same wasm: closing frees 63 of about 196 bytes; a page-based annotation (`FPDFPage_GetAnnot`) leaks nothing; the memory is not given back when the document closes.
  - The walk reads each annotation once, so a document costs 136–245 KB for NBER's 1,026 link annotations. `EPDFPage_GetAnnotCountRaw` and the form-fill environment leak nothing: 20,001 calls on an empty `/AcroForm` grew the heap by 1.4 bytes a call, and leaving the environment or its info struct open shows as +128 and +144 bytes a call (controls run, then removed).
  - EmbedPDF's own `getPageAnnotationsRaw` uses the same call, so any Phase 2 feature that reads annotations raw hits it too.
  - A spec test fails if the rate passes 400 bytes an annotation.
- **Widgets that `/Fields` leaves out.** PDFium links such a widget to its field only once the page is loaded (`FORM_OnAfterLoadPage`, its `FixPageFields`), so the raw read gives -1 (`NO_FIELD`). A page with one is read again loaded, as PDFium shows it. Without that, a form with a broken field tree would not count; the test (`orphan-widget.pdf`) fails without it.
- **PDFium functions.** All 14 are exported by the installed 2.15.1 wasm (`missingFormFunctions()` returns []) and called as wasm exports: `FPDF_GetFormType`; `PDFiumExt_OpenFormFillInfo`, `_InitFormFillEnvironment`, `_ExitFormFillEnvironment`, `_CloseFormFillInfo`; `EPDFPage_GetAnnotCountRaw`, `EPDFPage_GetAnnotRaw`; `FPDFPage_GetAnnotCount`, `FPDFPage_GetAnnot`, `FPDFPage_CloseAnnot`; `FPDFAnnot_GetSubtype`, `FPDFAnnot_GetFormFieldType`; `FORM_OnAfterLoadPage`, `FORM_OnBeforeClosePage`. No wasm rebuild is needed.
- **For Task 15 and Phase 1:**
  - port `getFormInfo` as it is: one form-fill environment per call, closed in `finally`, no page loaded unless a widget has no field;
  - run it after the first page is drawn: it is synchronous, and its cost grows with the page and annotation count (a 3,000-page book with links is about 0.1–1 s, extrapolated from NBER's warm and cold times, not measured);
  - not covered: hidden or no-view widgets count like visible ones, and an XFA document is never walked, so its `firstFillablePage` is null.

### P0-8 Backup-folder permission from an extension origin

- **8a and 8b BLOCKED, 8c PASS.** Headless Playwright Chromium cannot drive the directory picker, so the questions that need a picked folder go to the Windows run (W-B1 to W-B3, below). The three tests are in `tests/p0-8-backup-folder.spec.ts`; the page is `spike.html?check=backup-folder` (`src/checks/backup-folder.ts`). Its buttons "Pick backup folder", "Check permission" and "Request permission" call the same functions, for the manual run. "Request permission" waits for the person's answer to the prompt; the tests cap the same call at 3 s, because headless Chromium never answers it.
- **Why the picker cannot be driven** (Chrome/153.0.8010.12, Playwright 1.63.0):
  - `showDirectoryPicker()` is defined in the extension page and accepts the user activation that `page.evaluate` carries. Without file-chooser interception it rejects at once (17 ms) with `AbortError: … The user aborted a request.`
  - With interception, which `page.waitForEvent('filechooser')` turns on, it rejects with `AbortError: … Intercepted by Page.setInterceptFileChooserDialog().` Chromium does send CDP `Page.fileChooserOpened` (`mode: "selectSingle"`, no `backendNodeId`), but Playwright's `crPage` ignores that event without a `backendNodeId`, so `filechooser` never fires. CDP has no command that answers such a chooser: `DOM.setFileInputFiles` needs a node.
  - Not tried: a headed Chromium under Xvfb with an X automation tool. `xdotool` is not installed, and it would drive a native dialog, not Playwright.
- **What 8b and 8c use in its place.** CDP `Input.dispatchDragEvent` can drop a folder on the page. `DataTransferItem.getAsFileSystemHandle()` then returns a real `FileSystemDirectoryHandle`: read `granted`, readwrite `prompt`. The page stores it in IndexedDB `spike-backup`. It is not the picker's handle, so it never counts as an 8a or 8b result.
  - **8b, measured in its place.** The dropped handle is stored, the browser restarted on the same profile, and the handle read back from IndexedDB in the extension origin: read `prompt`, readwrite `prompt`. So a stored directory handle does survive a restart there. Whether a picker's handle reports `granted` (after "Allow on every visit") or `prompt` is W-B1.
  - **8c.** The handle is `prompt` for readwrite, `userActivation.isActive` is false, and `requestPermission({ mode: 'readwrite' })` rejects with `SecurityError: Failed to execute 'requestPermission' on 'FileSystemHandle': User activation is required to request permissions.` The state is still `prompt` afterwards. `page.evaluate` carries a user gesture, so the page waits about 5 s for its activation to lapse before it calls.
  - **Control.** The same call with a user gesture is not refused: it stays pending after 3 s, because headless Chromium cannot show or answer the permission prompt. That puts the refusal on the missing gesture.
- **For the product.** After a restart the stored handle is `prompt`, and only a click can ask again. A backup that runs without a click (an alarm, page load) cannot ask again: when the state is not `granted`, it can only tell the person and offer a button.

### P0-10 Page objects find figures within 20 ms a page

- **PASS.** Objects plus detection on 50 real paper pages (the first 10 pages of ResNet, Attention, XGBoost, AlphaFold and Deep hedging), timed inside the engine worker:

| Run | p50 | p95 | max | First call on the page (its text page still to load): p50 / p95 / max |
| --- | --- | --- | --- | --- |
| Recorded | 1.7 ms | **5.5 ms** | **7.5 ms** | 3.6 / 9.7 / 20.2 ms |
| Five earlier runs, same detector | 1.7–2 ms | 5.3–6.6 ms | 6.6–11.9 ms | 3.5–4.2 / 9.6–14.4 / 18.6–26.3 ms |

  - **What is timed.** The check draws each page first, because the viewer draws a page before it looks for figures. It then calls `detectFigures` twice:
    - the first call also loads PDFium's text page;
    - the second is the asserted number: the page and its text page are loaded, as after the page is drawn and its text layer built.
  - **The first-call maximum.** It is always the first page of the run, with a cold JIT.
  - **Per page.** 50–1,079 objects (median 285).
  - **Cost split** (median / max over the 50 pages): objects 0.2 / 1.5 ms, structure tree 0.0 / 0.1 ms, text runs 0.8 / 3.9 ms, finding 0.6 / 6.1 ms. Text runs are the largest part on text-heavy pages; finding is the largest on AlphaFold's figure pages.
  - **The cap.** On the 50,000-rectangle page, `getPageObjects` stops at 8,300–11,500 objects after 15.3–16.2 ms (`truncated`). The budget, not the 20,000-object cap, stops it.
  - **Per-page rows.** `results/P0-10-pages.json` (not committed).
- **PDFium functions.** All 33 are exported by the installed 2.15.1 wasm (`missingObjectFunctions()` returns []) and listed in v2's `packages/pdfium/src/vendor/functions.ts`:
  - `FPDFPage_CountObjects` (l.446), `FPDFPage_GetObject` (460);
  - `FPDFPageObj_GetType` (502), `GetBounds` (487), `GetMarkedContentID` (497), `GetMatrix` (498);
  - `FPDFFormObj_CountObjects`/`GetObject` (409–410);
  - `FPDFImageObj_GetImagePixelSize` (421), `GetImageFilterCount`/`GetImageFilter` (419, 418);
  - `FPDFPath_CountSegments`/`GetDrawMode` (535–536);
  - `FPDF_StructTree_GetForPage`/`CountChildren`/`GetChildAtIndex`/`Close` (271–274);
  - `FPDF_StructElement_CountChildren`/`GetChildAtIndex`/`GetType`/`GetAltText`/`GetActualText`/`GetMarkedContentIdCount`/`GetMarkedContentIdAtIndex` (254–270);
  - `FPDFText_CountChars`/`GetText`/`IsGenerated`/`GetTextObject`/`GetCharOrigin`/`GetLooseCharBox`/`GetMatrix` (551–578), `FPDFTextObj_GetFontSize` (587), `FPDF_GetPageBoundingBox` (200).

  The P0-10 methods call the wasm exports directly, not the cwrap wrappers (P0-5 measured the wrappers at about 3× the cost). No wasm rebuild is needed.
- **`getPageObjects`.**
  - **Form XObjects.** PDFium gives an object inside a form XObject its bounds in the form's own space. ResNet page 1's figure children span 0–323 × 0–109 while the form sits at 309–545 × 490–569 with a 0.731 matrix. Each child is mapped through the chain of form matrices (`FPDFPageObj_GetMatrix` on the form).
  - **The budget.** The 15 ms clock starts once the page is loaded, so loading an unloaded page does not use up the walk; `elapsedMs` covers the whole call.
  - **Fixture.** `objects.pdf` page 1: 93 objects (1 image at exactly (72, 90, 216 × 144), 432 × 288 px DCTDecode; 48 paths; 44 text) in about 1 ms.
- **`getStructTree`** on `tagged.pdf` (Chromium `page.pdf({ tagged: true })`): Document > H1, P, Figure > (Figure alt "Bar chart of test scores" [MCID 2], Caption > NonStruct [MCID 3]), P. Chromium nests the `<img>` Figure inside the `<figure>` Figure. PDFium returns an empty string for a missing /Alt, so `altText` reads null when empty. Detection on this page uses the tagged path: "Figure 1", image, (72, 142.5, 225 × 135), with the Caption's MCIDs kept out of the box.
- **`getPageTextRuns`.**
  - **Runs.** Split as the plan says: by text object, or a baseline move of more than half the font size. PDFium's generated line breaks end a run, and a generated space stays inside a run only when the run goes on after it.
  - **`fontSize`.** `FPDFTextObj_GetFontSize` × the char matrix's vertical scale, as `Glyph.fontSize`. Chromium writes Tf 32 under a 0.75 matrix, which reads 24.
  - **`rect`.** The union of loose char boxes. These are taller than the font size: 14.2 pt for 9 pt Helvetica in the extension.
  - **Name clash.** `PdfiumNative` already has `getPageTextRuns(doc, page)` (runs split by font, size and colour). The spike's method replaces it with a documented `@ts-expect-error`; nothing in the engine calls the base one. Task 15's `getTextRuns` may build on the stock method or port the spike's.
- **Detection (`src/figures/find-figures.ts`, research 06 §3.2 steps 1–4).** Every value from 06 is as written:
  - 2% / 36 pt for images and forms;
  - 6 pt path clusters with ≥ 8 paths or ≥ 3%;
  - 12 pt text absorption;
  - the §3.3 caption pattern;
  - high confidence for tagged, caption-linked or single image/form figures.

  What the real pages needed beyond 06 (each found on these pages and named in `RULES`):
  - **Pairing on either side.** A caption pairs on either side, with its usual side preferred by 4 pt: ResNet's CVPR tables have their captions below. The pairs are solved as one assignment (Hungarian, most pairs at the least distance), because a caption between two tables must take its own.
  - **Caption blocks.** A block continues only after a full line, and only to a line alone on its row, so table header cells stay out. Nature sets captions across two columns, and the second column is joined. A caption may overlap its figure by 40% of a line, because loose boxes overhang.
  - **Absorption.** Half inside counts, because subcaptions poke out a point. A figure also takes the free graphics in its band above the caption (side-by-side panels more than 24 pt apart).
  - **Body text.** A body line needs a body-wide neighbour: a lone wide line is a subcaption, heading or header row. A run-in heading on a body line's row is body text.
  - **Clusters.** They do not join across a column gutter (XGBoost's Tables 2 and 3 are 5.9 pt apart). Page-high rules and graphics inside a caption are dropped. A form with no image and fewer than 3 paths is looked through.
  - **Text-only tables.** The caption-region fallback stops at a gap over twice the region's median row gap.
  - **The caption pattern** gains one lookahead. Without it "Figure 3.1 shows…" matches as "Figure 3": the pattern backtracks into the dotted number.
- **Detection quality, labelled by eye from overlays of every page.**
  - **The 50 timing pages** hold 43 captioned figures and tables (ResNet 7 figures and 8 tables, Attention 2 and 4, XGBoost 13 and 4, AlphaFold 5, Deep hedging 0):
    - 43 found, with the right labels;
    - 0 false caption-linked figures;
    - 2 medium-confidence uncaptioned clusters: a real uncaptioned inline table on ResNet p7, and a small 42 × 15 pt cluster on AlphaFold p7;
    - every box encloses its figure or table, with axis labels, legends and subfigure captions, and not its caption, judged at contact-sheet scale. No hand-drawn boxes exist, so there is no IoU number for real pages.
  - **These pages were used to tune the rules**, so this is a training-set result.
  - **Held out, rules frozen.** PLOS ONE pp. 1–5, the DiD paper pp. 31–45 (maths-heavy proofs) and Sutskever's thesis pp. 21–35:
    - 9 of 9 captioned figures and tables found;
    - 1 false caption: the thesis paragraph "Figure 3.1 shows…", fixed afterwards by the lookahead above;
    - no false clusters from fraction bars.
  - **Not detected by design.** XGBoost's Algorithm boxes ("Algorithm" is not in the pattern).
  - **Fixture IoU:** Figure 1 1.000, Figure 2 1.000, Table 1 0.933 (the text table's loose boxes).
- **For Task 15 and Phase 2:**
  - port the direct-export calls and the form-matrix mapping;
  - keep the budget clock after page load;
  - evaluate on 06 §3.7's labelled set of 30 papers with hand-drawn boxes before trusting precision;
  - add "Algorithm" captions if wanted;
  - scans, rotated pages (/Rotate) and vertical text are not covered.

## Handed to the Windows checklist

- P0-5: bold timing and look at 150% scaling on Windows. The overlay and its rasterisation grow with DPR, and Windows text rendering may differ from PDFium's bitmaps.
- P0-6b: the OPFS move on Windows, where real-time antivirus scanning of the profile folder may slow writes. Headless Linux uses 2.7–3.7 s of the 5 s bar.
- P0-7: detection time on the NBER paper (25–50 ms here, bar 200 ms) and the raw-annotation leak rate, on the reference laptop.
- W-B1 (P0-8): pick a folder, restart Chrome and note `queryPermission`, and whether the three-way "Allow on every visit" prompt appears. Open `chrome-extension://<id>/spike.html?check=backup-folder` of the built extension (the id is on chrome://extensions) and use its "Pick backup folder", "Check permission" and "Request permission" buttons. "Request permission" waits for your answer to the prompt and shows it.
- W-B2 (P0-8): pick a folder inside `G:\My Drive` (Google Drive for desktop), write `backup-probe.txt`, and confirm it appears on drive.google.com within 2 minutes. Use the same page (`chrome-extension://<id>/spike.html?check=backup-folder`) and its "Pick backup folder" button, which writes `backup-probe.txt`. Chrome may refuse the root of `G:\My Drive`; if it does, pick a sub-folder of it.
- W-B3 (P0-8): the same for a OneDrive folder. Chrome may refuse the OneDrive root; if it does, pick a sub-folder of it.
- P0-10: detection time per page on the reference laptop (the perf-gate job), with the page and its text page loaded and with the text page still to load. Headless Linux gives p95 5–7 ms and 10–14 ms.

## Decision

Written at the Phase 0 gate (Task 10).
