# Phase 0 spike report

Phase 0 is a throwaway engine proof in `spikes/phase0/`. It has its own package and lockfile, outside the workspace. It checks that EmbedPDF 2.15.1 (PDFium compiled to wasm) works inside a Chrome MV3 extension within the spec's budgets, before production code depends on it. The checks are listed in the plan (`docs/superpowers/plans/2026-10-31-release1-phase0-1.md`, Phase 0).

## How to reproduce

```bash
pnpm -C spikes/phase0 install
pnpm -C spikes/phase0 fixtures            # SOP_FIXTURE_SRC=<folder> copies instead of downloading
pnpm -C spikes/phase0 fixtures:scan       # scan-600.pdf for P0-3 (about 4 minutes, 178 MB)
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
| P0-1 | EmbedPDF renders in MV3 with bundled wasm and fonts | PASS | v2-blob first page 271 ms; v2-file first page 196 ms |  |
| P0-2 | Zero network beyond the PDF | PASS | 2 requested URLs in the net log, all 127.0.0.1:39311: /font-fixture.pdf, /paper-50.pdf | Chromium's own service requests left out: clients2.google.com, accounts.google.com, www.google.com, update.googleapis.com |
| P0-3 | 600-page scan scrolls with no blank page over 150 ms | MIXED | FAIL: maxBlankMs=0, p50BlankMs=0, p95BlankMs=0, pagesEntered=34, pagesOverBudget=0, worstPage=null, worstUntil=null, workers=1, pattern="steady", pageCount=600, openMs=906, scroll={…}, blanks=[34], renderMs={…}, paintMs={…}, longTasks={…}, bitmapSize={…}, droppedFull=0, layout={…}; PASS: workers=1 jump: blank p50 50.3 / p95 50.6 / max 50.6 ms over 3 pages; FAIL: maxBlankMs=0, p50BlankMs=0, p95BlankMs=0, pagesEntered=32, pagesOverBudget=0, worstPage=null, worstUntil=null, workers=2, pattern="steady", pageCount=600, openMs=1335, scroll={…}, blanks=[32], renderMs={…}, paintMs={…}, longTasks={…}, bitmapSize={…}, droppedFull=0, layout={…}; PASS: workers=2 jump: blank p50 52.5 / p95 54 / max 54 ms over 3 pages | Error: expect(received).toBeGreaterThan(expected) Expected: > 40 Received:   34; Error: expect(received).toBeGreaterThan(expected) Expected: > 40 Received:   32 |
| P0-4 | Text-layer selection suite | NOT RUN | | |
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

- **The blank budget is met with both worker counts.** In the steady 3000 px/s scroll, no page was ever blank. A jump shows its page after about 50 ms.
- **The two steady tests fail only on `pagesEntered > 40`, which cannot be reached.** This bound needs a ruling (see below); it is not a budget miss.

| workers | Pattern | Blank p50 / p95 / max | Pages entered | Test |
| --- | --- | --- | --- | --- |
| 1 | steady, 20 s | 0 / 0 / 0 ms | 34 | FAIL: `pagesEntered > 40` |
| 1 | jumps 400, 120, 599 | 50.3 / 50.6 / 50.6 ms | 3 | PASS |
| 2 | steady, 20 s | 0 / 0 / 0 ms | 32 | FAIL: `pagesEntered > 40` |
| 2 | jumps 400, 120, 599 | 52.5 / 54 / 54 ms | 3 | PASS |

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
- **Why `pagesEntered > 40` cannot pass.** The pitch at fit width is 1726 + 16 = 1742 px, and 20 s × 3000 px/s = 60,000 px. Only 60,768 / 1742 ≈ 35 pages can enter, even at a perfect 60 fps.
  - The bound would hold for pages up to about 1500 px tall: about 1160 px wide, or a viewport of about 1190 px.
  - Possible rulings: `toBeGreaterThan(30)` (86% of the reachable distance); 25 s instead of 20; or 4000 px/s.
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

## Handed to the Windows checklist

## Decision

Written at the Phase 0 gate (Task 10).
