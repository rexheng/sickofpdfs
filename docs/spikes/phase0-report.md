# Phase 0 spike report

Phase 0 is a throwaway engine proof in `spikes/phase0/`. It has its own package and lockfile, outside the workspace. It checks that EmbedPDF 2.15.1 (PDFium compiled to wasm) works inside a Chrome MV3 extension within the spec's budgets, before production code depends on it. The checks are listed in the plan (`docs/superpowers/plans/2026-10-31-release1-phase0-1.md`, Phase 0).

## How to reproduce

```bash
pnpm -C spikes/phase0 install
pnpm -C spikes/phase0 fixtures            # SOP_FIXTURE_SRC=<folder> copies instead of downloading
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
| P0-3 | 600-page scan scrolls with no blank page over 150 ms | NOT RUN | | |
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

## Handed to the Windows checklist

## Decision

Written at the Phase 0 gate (Task 10).
