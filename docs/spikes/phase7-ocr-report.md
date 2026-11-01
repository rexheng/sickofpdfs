# Phase 7.0 report: OCR engine bake-off

Run on 2026-11-01, branch `wt/p7ocr` (`/home/user/wt-p7ocr`), cut from `release1/phase0-1` at 48a7fab. Everything is in `spikes/phase7-ocr/`. The scorer is `spikes/phase7-ocr/src/scorer.mjs`; Gate 2 can import it as it is.

**Status: DONE_WITH_CONCERNS.** The engine is chosen and measured. Four things could not be done here and are written down below as open items: Chrome's own OCR as a baseline, a real GPU, multi-thread speed, and a check against the real viewer.

The recommendation and the owner summary are at the end (sections 10 and 11).

---

## 0. Read this first

- **I could not run Chrome's own OCR.** So "within 1 point of Chrome" is not checked. The Decision below is conditional on the Windows hand run W-O2 (section 9). Everything else the plan asked for was measured, or is listed in section 7 as not run.
- **The machine was shared.** The sandbox has 4 cores. Other agents ran test suites on it the whole time, so the load average was 5 to 25. Wall-clock times are inflated, and runs with more than one thread were slower than runs with one. I report **CPU seconds per page** as the speed number (user plus system time of the whole browser, from `/proc`). For a one-thread run that is the real compute time. Where I give a wall time, I give the load next to it.
- **Accuracy numbers are not affected by the load.** They are the same on a quiet machine.
- **No candidate meets the German floor, and none meets the whole-fixture CER target.** Reasons in section 6. The planner said the targets may change with evidence; I propose the changes.

---

## 1. What was run

| Item | Value |
| --- | --- |
| Browser | Chrome for Testing 153.0.8010.12 (the preinstalled Playwright Chromium), new headless, our test extension loaded |
| Machine | 4 vCPU, 16 GB, Linux 6.18, no GPU |
| Where the engines ran | An MV3 extension page (and its module worker), CSP `script-src 'self' 'wasm-unsafe-eval'`. Files come from the extension folder only. Plus a check from an offscreen document (section 4.4) |
| Page images | The merged engine: `createEmbedPdfBackend(...).renderTile(...)` from `packages/viewer/src/backend`, run inside the extension page. PNGs are cached under `test-assets/ocr/rendered/` |
| Tesseract.js | 7.0.0, core 7.0.0, LSTM-only SIMD core, `tessdata_fast` eng, fra, deu. `workerBlobURL: false`, so no `blob:` worker is needed (the CSP would refuse one). One worker |
| PP-OCR | PP-OCRv5 and v6 ONNX files from `huggingface.co/PaddlePaddle` (official exports), on onnxruntime-web 1.31.1. **The det and rec pipeline is our own code** (`src/ocr/ppocr.ts`): DB post-processing, minimum-area rectangles, rotated line crops, CTC decode with the model's own dictionary, word boxes from the CTC time steps, XY-cut reading order. No SDK, no network |

### Fixtures (`spikes/phase7-ocr/fixtures.manifest.json` has sha256 of every file)

| Set | What | Truth |
| --- | --- | --- |
| `syn` | 24 pages of the 600-page synthetic scan: 0, 25 ... 575. 200 dpi, JPEG q60, small skew, noise, dark gutter | PDFium's text and word boxes of source page *i* mod 518 |
| `deg` | 8 degraded pages: 150 dpi, JPEG q35, 2 degree skew | same |
| `real` EN | 10 pages from 3 public-domain books (A Brief History of Modern Philosophy, The Prince and the Pauper, A Book of Dartmoor). Scans from Wikimedia Commons, text from Wikisource pages marked proofread or validated | the Wikisource text |
| `real` FR | 3 pages of Madame Bovary (Conard, 1910). The scan is only 960 px wide | same |
| `real` DE | 3 pages of Kafka, In der Strafkolonie (1919). A blurry scan with large, heavy type | same |
| `rcpt` | The two receipt scans from `test-assets/classifier`: a phone photo of a German Starbucks receipt, and a ScanSnap Whole Foods receipt | my own transcription from the picture (`truth/receipt-*.txt`). A token or two may be misread |

Notes on the fixtures:
- I extended the Phase 0 generator `spikes/phase0/scripts/make-scan-fixture.mjs` with `--sidecar`, `--sidecar-only`, `--pick` and `--skew`. Without those options its output is unchanged. I checked this: a page regenerated with `--pick 25` is byte-identical to page 25 of `scan-600.pdf`.
- The real pages are built into one PDF per book, one JPEG per page and no text, like a scanning app writes. Licences: every scan is "Public domain" on Commons; the text is Wikisource (CC BY-SA 4.0).
- The Whole Foods PDF already has a text layer (ScanSnap wrote one). Chrome would skip OCR on it. I OCR'd its picture anyway.
- A second German book was tried and dropped. One was 547 px wide, the other had no page that passed my filter. **The German sample is only the Kafka scan**, and it is hard.
- I could not get word boxes for the real pages (the proofread text has none). Box scores are for `syn` and `deg` only.

### Measures (all in the scorer)

- **Findability:** the share of true words of 4 or more letters that a case-insensitive Ctrl+F finds in the recognised text. Line-end hyphens are joined first ("illus-" + "trated"), as PDFium does for real text. The same rule is used for every engine.
- **CER:** character error rate on normalised text, order-sensitive.
- **Word recall:** share of all true words present, any order.
- **Box hit rate:** share of recognised words whose centre lies inside some true word's box (plan wording). **Box coverage:** share of true words whose box holds some recognised word's centre.
- **Accents:** share of true words that contain an accent and are found exactly, and found once accents are ignored.
- The truth boxes of the synthetic pages are moved to the scan's space (rotate by the skew, stretch to Letter). I checked the sign of the rotation on the degraded pages: the right sign gives 96.9% hits, the wrong one 55%. I also drew both sets of boxes over a page to look at them.
- **Why not one pooled number for `syn`:** the textbook has many formula and figure pages. PDFium's text for those is not reading order, and its "words" are single math glyphs. So `syn` CER is dominated by them. I also report `syn-prose`: the pages with 1500 or more characters in which under 1% of the characters are not plain letters, digits or common punctuation. That is 5 of the 24 pages.

---

## 2. Accuracy

Native DPI for each set (syn 200, deg 150, real 300, receipts 200 or 300). Single-thread WASM, detector side 1280. n = pages.

**Findability (higher is better)**

| Engine | syn (24) | syn-prose (5) | deg (8) | real EN (10) | real FR (3) | real DE (3) | rcpt EN | rcpt DE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tesseract.js fast, eng only | 99.8% | 100.0% | 99.6% | 99.3% | not run | not run | 100.0% | not run |
| Tesseract.js fast, fra only / deu only | | | | | 96.7% | 75.7% | | 94.1% |
| Tesseract.js fast, eng+fra+deu in one pass | 99.7% | 100.0% | 99.6% | 99.6% | 97.0% | 76.8% | 100.0% | 91.2% |
| **PP-OCRv6 tiny** | 99.7% | 100.0% | 99.5% | 99.3% | 98.1% | 84.1% | 100.0% | 91.2% |
| PP-OCRv6 small | 99.9% | 100.0% | 99.8% | 99.6% | 98.6% | 88.4% | 100.0% | 97.1% |
| PP-OCRv5 latin | 99.6% | 99.6% | 99.9% | 99.6% | 99.1% | 89.0% | 100.0% | 94.1% |

**Character error rate (lower is better)**

| Engine | syn | syn-prose | deg | real EN | real FR | real DE | rcpt EN | rcpt DE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tesseract.js eng only | 7.7% | 2.2% | 7.3% | 1.0% | | | 6.0% | |
| Tesseract.js eng+fra+deu | 7.5% | 2.2% | 7.0% | 0.8% | 2.7% | 33.7% | 4.0% | 7.1% |
| **PP-OCRv6 tiny** | 5.3% | 1.4% | 6.2% | 2.7% | 1.8% | 20.8% | 2.1% | 8.8% |
| PP-OCRv6 small | 4.3% | 1.3% | 4.8% | 2.3% | 1.7% | 20.4% | 1.4% | 5.0% |
| PP-OCRv5 latin | 5.0% | 1.5% | 5.8% | 2.4% | 1.5% | 20.0% | 1.1% | 7.1% |

**Word recall (all words)**

| Engine | syn | syn-prose | deg | real EN | real FR | real DE | rcpt EN | rcpt DE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Tesseract.js eng only | 88.8% | 96.9% | 86.5% | 98.1% | | | 95.7% | |
| Tesseract.js eng+fra+deu | 89.2% | 97.2% | 87.4% | 98.6% | 95.4% | 71.8% | 95.0% | 83.3% |
| **PP-OCRv6 tiny** | 92.0% | 98.1% | 89.2% | 97.9% | 96.8% | 82.2% | 92.1% | 66.7% |
| PP-OCRv6 small | 94.1% | 98.6% | 94.4% | 99.0% | 97.7% | 84.2% | 98.6% | 97.2% |
| PP-OCRv5 latin | 93.5% | 98.2% | 93.2% | 98.8% | 99.0% | 83.8% | 98.6% | 90.3% |

**Accents and boxes**

| Engine | FR accents exact / ignoring accents | DE accents exact / ignoring | syn box hit | syn box coverage | deg box hit | deg box coverage |
| --- | --- | --- | --- | --- | --- | --- |
| Tesseract.js fra only / deu only | 95% / 98% | 70% / 70% | | | | |
| Tesseract.js eng+fra+deu | 92% / 97% | 63% / 77% | 94.0% | 83.5% | 98.0% | 89.4% |
| **PP-OCRv6 tiny** | 98% / 99% | 97% / 100% | 95.7% | 82.7% | 96.9% | 88.8% |
| PP-OCRv6 small | 99% / 99% | 100% / 100% | 95.9% | 87.1% | 98.1% | 93.8% |
| PP-OCRv5 latin | 99% / 99% | 100% / 100% | 95.8% | 86.2% | 96.2% | 93.7% |

What the tables say:
- **Findability saturates.** Every engine is at 99.3% to 99.9% on English and synthetic pages. It does not separate them. Word recall, CER and German do.
- **On clean book pages Tesseract copies text a little more exactly, but most of the CER gap is one footer line.** As scored, CER on real English is 0.95% for Tesseract and 2.7% (tiny) or 2.3% (small) for PP-OCR. PP-OCR reads the faint "Digitized by Microsoft" line printed at the foot of all ten English scans; the transcription does not have it and Tesseract's binarisation ignores it. With that one line removed from each page, PP-OCR is at **1.33% (tiny) and 0.98% (small)**, and Tesseract stays at 0.95%. Findability does not change. (I left the as-scored numbers in the tables.)
- **On everything harder PP-OCR wins:** degraded pages, formula pages (word recall 92% against 89%), French and German accents, the German pages (84 to 89% findability against 77%), the phone-photo receipt.
- **The 3-language Tesseract pass costs German accents** (63% exact) but gives the best English CER (0.8%).
- **Box hit rate.** Pooled over the 24 synthetic pages it is 95.7% for tiny, under the plan's 97%. The median page is 98.8%, and text-only pages are 99 to 100% (pages 25, 225, 250: 100%). The misses are on formula and figure pages, where PDFium's "words" are single math glyphs. I propose the 97% gate is defined on text pages.
- **PP-OCRv6 small** is the best engine on almost every row. **Medium** (132 MiB) is no better than small on the 10 pages I ran: mean findability 98.5% against 98.1% for small and 96.5% for tiny, at 72 CPU seconds a page. **Out.**
- **PP-OCRv5 mobile** (the multi-script model) loses accents: 27% exact on French words, 3% on German. **Out.** (It ran on my first build. Its raw files were deleted when I rebuilt after fixing reading order, so there is no table row. Findability, accents and recall do not depend on reading order.)
- A confidence filter on recognised words did not help (checked at 0.3, 0.5, 0.7, 0.85). PP-OCR is confident when it is wrong.

### Sweeps

**Render DPI** (tiny, and Tesseract eng; same pages)

| Set | Engine | 100 dpi | 150 dpi | 200 dpi | 300 dpi |
| --- | --- | --- | --- | --- | --- |
| syn findability | PP tiny | 99.7% | 99.7% | 99.7% | |
| syn findability | Tesseract | 99.2% | 99.7% | 99.8% | |
| real EN findability | PP tiny | | 99.3% | 99.4% | 99.3% |
| real EN findability | Tesseract | | 99.4% | 99.1% | 99.3% |
| real EN CER | PP tiny | | 2.6% | 2.7% | 2.7% |
| real EN CER | Tesseract | | 0.8% | 0.9% | 1.0% |

DPI makes no difference to PP-OCR from 100 up, because every line is resized to 48 px high before recognition. It also costs nothing in time (below). Tesseract needs at least 150.

**Detector side** (tiny, the 10-page subset at native DPI)

| Longest side | 960 | 1280 | 1600 | 2048 |
| --- | --- | --- | --- | --- |
| mean findability | 97.2% | 96.5% | 97.0% | 97.6% |
| mean word recall | 92.0% | 91.2% | 92.4% | 92.9% |
| CPU s/page | 3.5 | 3.5 | 4.3 | 4.8 |

The differences are inside the noise of ten pages. I keep 1280.

---

## 3. Speed

CPU seconds per page, one thread, the whole 50-page set at native DPI. Wall time is under load. A page is a dense page of text; real pages have 35 to 45 lines.

| Engine | CPU s/page | Wall mean / p50 / p95 / max (s) | Load average |
| --- | --- | --- | --- |
| **PP-OCRv6 tiny** | **3.5** | 4.0 / 4.0 / 5.7 / 7.3 | 6 rising to 14 |
| PP-OCRv5 latin | 10.5 | 15.9 / 16.5 / 26.9 / 29.4 | 14 |
| PP-OCRv6 small | 14.1 | 17.2 / 17.1 / 30.2 / 35.8 | 18 |
| PP-OCRv6 medium (10 pages) | 72.3 | 89 / 92 / 132 | 14 |
| Tesseract.js eng, 200 dpi (100-page run) | 4.2 | 5.2 / 4.6 / 9.5 | 8 |
| Tesseract.js eng, 150 dpi / 100 dpi | 2.9 / 1.7 | 5.7 / 4.2 (load 22 to 25) | |
| Tesseract.js eng+fra+deu, native | 5.3 | 5.8 / 5.2 / 10.2 / 12.8 | 8 to 12 |

- **Where the time goes in PP-OCR tiny:** recognition 3.0 s, detection 0.8 s, everything else 0.13 s. Recognition cost follows the amount of text, not the DPI. The detector side changes little (CPU 3.5 s at 960 and 1280, 4.3 s at 1600, 4.8 s at 2048).
- **Targets in the plan** (visible page at most 3 s p95 on WASM; at least 20 pages a minute in the background). **PP-OCRv6 tiny on one thread misses both on dense pages:** p50 4.0 s, p95 5.7 s, about 15 to 17 pages a minute. Tesseract at 150 dpi is about the same. Small and the v5 models are far from the targets. Multi-thread and GPU might reach them; I could not measure that (next point).
- **Threads could not be measured.** On the loaded machine, 2 threads gave CPU 5.5 s and wall 6.5 s (load 17), and 4 threads gave CPU 9.1 s and wall 15.5 s (load 14). Worker threads spin while they wait, and the machine had no spare cores. The same happened for small. This is a measurement failure, not a result about quiet machines. W-O1 measures it. A background job that competes with scrolling is the busy-machine case, so I default to one thread.
- **Cold start (time to a first selectable page).** Tiny: 0.56 s to create the sessions (10 ms to load onnxruntime-web, 50 ms to read the models, 0.5 s to build sessions). Small: 2.6 s. Tesseract.js: 0.25 s. After that the first page itself: 1.7 s for a light title page, about 4 s for a dense page. So **about 4 to 5 s from opening a tab to selectable text on the first page, with tiny on one thread.** The render is 50 to 130 ms through the merged engine at 100 to 300 dpi.
- **Visible page first** (queue of background pages, then a request for one page). The scheduler took the visible page next in 3 of 3 trials. At most one background page finished first: the page already in flight. So the wait is the rest of that page plus the visible page's own time, about two page-times, whatever the queue length. The pages 0 to 60 queued, page 400 wanted case is the same. Measured 14 to 17 s with 4 threads under load 20. On one thread, expect about 4 to 8 s. To make it shorter, 7.3 can yield between recognition batches: one page is 5 to 8 batches, so the wait drops to under a second.
- **WebGPU speed is unknown here** (section 4.5).

---

## 4. Memory, size, licence, extension checks

### 4.1 Memory

RSS of the extension's renderer process, which holds the page and the engine worker, read from `/proc` at the end of each run. The empty extension page is about 100 MB.

| Run | Pages | RSS end / peak |
| --- | --- | --- |
| PP-OCRv6 tiny, 200 dpi | 100 | 589 / 661 MB. 548, 547, 572, 514, 589 MB after 20, 40, 60, 80, 100 pages: **flat**. The JS heap stayed at 16.6 MB |
| PP-OCRv6 small | 50 | 802 / 1041 MB |
| PP-OCRv5 latin | 50 | 497 / 639 MB |
| PP-OCRv6 medium | 10 | 941 / 1170 MB |
| Tesseract.js eng, 200 dpi | 100 | 1877 / 2075 MB, flat after the first 20 pages |
| Tesseract.js, native DPI (real pages are 1920 px wide) | 43 and 50 | 2330 to 2449 / 3083 to 3106 MB |
| Tesseract.js eng, 150 dpi / 100 dpi | 10 / 24 | 696 / 703 MB and 472 / 572 MB |

Tesseract.js memory follows the image size. At 150 dpi it is close to PP-OCR tiny. At 200 dpi and above it is 2 to 5 times as much.

### 4.2 Size (`results/sizes.json`; MiB, raw and zip deflate level 9)

| Part | Raw | Zip |
| --- | --- | --- |
| onnxruntime-web 1.31.1, plain WASM (`ort.wasm.min.mjs`, threaded wasm) | 14.24 | 3.68 |
| onnxruntime-web 1.31.1, WebGPU build (loads the `asyncify` wasm) | 27.53 | 6.84 |
| PP-OCRv6 tiny, det + rec | 6.01 | 5.45 |
| PP-OCRv6 small, det + rec | 29.75 | 24.83 |
| PP-OCRv6 medium, det + rec | 132.31 | 95.30 |
| PP-OCRv5 latin, det + rec | 12.28 | 11.30 |
| Tesseract.js worker + SIMD LSTM core | 3.82 | 1.42 |
| tessdata_fast eng / fra / deu | 3.92 / 1.08 / 1.45 | 1.87 / 0.58 / 0.81 |
| Tesseract.js, eng+fra+deu in total | 10.27 | 4.68 |
| our PP-OCR code (unminified) | 0.02 | 0.01 |

- **Marginal size over Phase 3.** Phase 3 already ships onnxruntime-web for MiniLM. If it is the plain WASM build, **PP-OCRv6 tiny adds 6.0 MiB raw, 5.5 MiB zipped**. Small adds 29.8 raw, 24.8 zipped. Tesseract.js adds 10.3 raw, 4.7 zipped for three languages (3.3 zipped for English only). Models are 32-bit floats and compress badly, so by zip size Tesseract is smaller. By raw size PP-OCRv6 tiny is smaller.
- **No candidate comes near the plan's 60 MB flag.** The largest sensible one (small) adds under 30 MiB.
- **WebGPU is not free.** Shipping the WebGPU entry means the 28.7 MB `asyncify` wasm in place of the 14.8 MB plain one: +13.3 MiB raw, +3.2 MiB zipped. In 1.31 the WebGPU entry loads the `asyncify` build, not the `jsep` one. My first try failed on that.
- Phase 3 and 7.2 should agree on one onnxruntime-web build. If either one wants WebGPU, both use the larger file.
- Models are downloaded at build time by `scripts/fetch-models.mjs` and checked against `models.manifest.json` (pinned commits and sha256). Nothing over a few MB is committed.

### 4.3 Licences

| Part | Licence | Source |
| --- | --- | --- |
| onnxruntime-web 1.31.1 | MIT. Its ThirdPartyNotices also list Eigen under MPL-2.0 (file-level copyleft), plus Apache, BSD and MIT parts | package.json; ORT ThirdPartyNotices.txt |
| Tesseract.js 7.0.0 and tesseract.js-core 7.0.0 | Apache-2.0. The worker bundle also carries MIT and BSD-3 notices | package.json; `worker.min.js.LICENSE.txt` |
| tessdata_fast | Apache-2.0 | repo LICENSE |
| PP-OCRv5 and v6 weights (official ONNX exports) | Apache-2.0 | Hugging Face model cards; PaddleOCR LICENSE |
| PP-OCR dictionaries | ship in the model `inference.yml`; same licence as the weights | |

- **Eigen (MPL-2.0) is in onnxruntime-web itself,** which Phase 3 ships anyway, so it is not a new issue. It is the one licence outside "Apache-2.0, MIT, BSD" that I found. Someone should decide whether MPL-2.0 at file level is acceptable.
- **Training data:** the PP-OCRv6 model cards and the paper's abstract do not list the training data (the abstract only says its accuracy numbers are from "in-house benchmarks"). The weights are Apache-2.0. I could not check where the training data came from. Tesseract's training data is documented in its repos.

### 4.4 Extension checks (plan 7.0)

- **CSP.** Both engines run under `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. Tesseract.js needed `workerBlobURL: false`.
- **Files and requests.** All runs load every script, wasm and model from `chrome-extension://` files. Across 27 recorded runs and the offscreen check, Playwright saw **no request except the extension's own files and my local file server** (page images, results). The engines themselves made none.
- **Worker started by the offscreen document.** Done (`bench/run.mjs selfcheck`). The offscreen document created the OCR worker, loaded the tiny models, and read a synthetic line correctly: "Offscreen document check: the quick brown fox jumps over the lazy dog 0123456789".
- **`navigator.gpu`** is visible in the offscreen document and in its worker. Without GPU flags `requestAdapter()` returns `null` here.
- **Cross-origin isolation.** The manifest keys `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin` made `crossOriginIsolated` true in the offscreen document, the page and the worker, with `SharedArrayBuffer`. That is what onnxruntime-web threads need. **I did not check that these keys do not break the viewer.** They apply to every extension page. The viewer at this commit is not at a state where I could test it. My reading: `fetch()` of the PDF with host permissions is not affected, and only no-cors cross-origin subresources are. Task 7.2 must test it. The default of one thread does not need the keys.
- **Not checked:** onnxruntime-web's WASM threads in a second worker (page-level parallelism) as an alternative to threads.

### 4.5 WebGPU

There is no GPU here. The default headless Chromium gives no adapter. With the software Vulkan adapter (SwiftShader) and the flags in `results/webgpu-check.json`:
- A WebGPU session was created for all three model pairs (tiny, small, v5 latin), in 8 to 10 s. ORT warned that some shape operators run on the CPU, as it always does.
- **PP-OCRv6 tiny on page `syn-p0` gave exactly the same 65 words as WASM.** It took 182 s, because the "GPU" is software at load 20. That time means nothing.
- **Not measured:** any real WebGPU speed. W-O1 does it.

---

## 5. Chrome's own OCR (the bar in the plan)

What the plan says, and what I could find (Chrome Help, a Chromium developer, the `chromium-ocr-wrapper` README): Chrome runs OCR on the device with its Screen AI component, page by page as the page loads, skips pages that already have text, and writes an invisible text layer. Our takeover turns it off. An extension cannot reach Screen AI.

**What I did not do: measure it.** I looked at it, and then I stopped. Details:
- I downloaded the Screen AI component (version 153.4, 127 MB) from Chrome's component update service, to see its size and file list. Its general line recogniser (`gocr_mobile_und.tflite`) is a 3 MB TFLite file, the text detector 2 MB, the layout models 0.4 and 0.9 MB, and the native library 49 MB. The rest is recognisers and language models for other scripts. So the part of Google's engine that reads Latin text is in the same size class as PP-OCRv6 tiny. The download is large because it holds every script.
- I wrote a driver for Chrome's PDF viewer in the style of `chromium-ocr-wrapper` and tried to run it. **The sandbox's permission check refused to run it** (it runs code from an external source). I did not work around that. I deleted the downloaded component and the script. Nothing from it is in the repo.
- I did not find a published, measured accuracy for Screen AI. Only opinions (a forum post, the `locro` README).
- **What is ready for you:** `scripts/make-chrome-inputs.mjs` builds the input PDFs, and `bench/run.mjs readtext` reads a "searchified" PDF's text with PDFium, as the plan says, and `scripts/score.mjs` scores it with our scorer. I tested the reading and scoring path with a text PDF standing in for Chrome's output (CER 0.0%, findability 100%). **It is not tested against real Chrome output.** Steps are in section 9.
- **Behaviour that matters for parity** (from the plan, not measured): Chrome reads pages as they load and skips pages with text, so a scan is searchable only where you have been. Our design reads visible pages first and then the whole file. Chrome has no store, so it reads again each time; we keep results.

---

## 6. Decision rule, applied

1. **Licence:** all pass. One note on Eigen (section 4.3).
2. **Floors** (planner's proposal):
   - Synthetic findability at least 98%: **all pass** (99.6 to 99.9%).
   - Synthetic CER at most 1.5%: **no candidate passes on all 24 pages** (4.3 to 7.7%). On the 5 prose pages the PP models reach 1.3 to 1.5% and Tesseract 2.2%. The textbook's formula and figure pages make the target unreachable for any engine. **Proposal:** apply the CER target to prose pages, or drop it for the synthetic set.
   - Real English at least 95% findability and at most 3% CER: **all pass** (CER: PP 2.3 to 2.7%, Tesseract 0.8 to 1.0%).
   - Real French at least 93%: **all pass** (96.7 to 99.1%).
   - Real German at least 93%: **no candidate passes** on the Kafka pages (best 89.0%, Tesseract 75.7 to 76.8%). The sample is three pages of blurry large type. I do not think it shows what German typeset books give. **Proposal:** find another German scan before the gate, and keep the floor.
3. **Highest findability on the real English scan.** Top is 99.6% (small, v5 latin, Tesseract 3-language). Within 1 point of it: tiny and Tesseract English-only at 99.3%.
4. **Within 1 point: smaller marginal bundle.** By zip size Tesseract wins by 0.8 MiB (4.68 against 5.46; English only, 3.3 against 5.5). By raw size tiny wins (6.0 against 10.3).
5. **Then faster.** Tiny 3.5 CPU s/page. Tesseract 5.3 for three languages at native DPI, 2.9 at 150 dpi for English.
6. **Then one pass for all three languages.** Tiny and v5 latin: yes. Tesseract: only with a 3-language pass, which costs German accents.
7. **Chrome within 1 point:** not measured.

**So the letter of the rule ends at step 4 and picks Tesseract.js by 0.8 MiB of zip.** I recommend **not** following it here. The reasons are all measured:
- PP-OCR is better on every harder set (formula and degraded pages, receipts, French and German), and on German accents it is 97 to 100% against 63 to 70%.
- Tesseract.js memory grows with the image: 1.9 GB at 200 dpi and up to 3.1 GB at the real pages' native DPI. PP-OCR tiny stays at about 0.55 GB at any DPI.
- Findability, the metric in the rule, cannot separate them (99.3 against 99.3).
- onnxruntime-web is already in the build (Phase 3), and the layout model of 7.5 needs it too. Tesseract.js would be a second wasm stack.
- PP-OCR can go on to the small model and to WebGPU. Tesseract.js has no GPU path, and its better model (`tessdata_best`, 14.7 MiB for English) did not run on the LSTM-only core.

What it costs: PP-OCR copies clean book pages a little less exactly (CER 1.3% against 0.95% once the scan footer is ignored; 2.7% as scored), and the reading order and word boxes are our code (`src/ocr/ppocr.ts`, about 450 lines, XY-cut). **This is a call for the controller.** If you prefer the rule as written, the Tesseract.js settings are at the end of section 10.

---

## 7. Deviations and what the plan should change

- The plan says `docs/spikes/phase7-ocr-report.md` owns the report. You asked for the report here in `.superpowers/sdd/`, which is gitignored. I committed a copy at `docs/spikes/phase7-ocr-report.md` so the Decision survives.
- **The Decision's speed targets are not met on one thread** (section 3). The plan should say whether a one-thread result is acceptable, or whether 7.2 must add threads or WebGPU first.
- **Candidates not run:** `tesseract-wasm` (not needed: Tesseract.js's core is 3.8 MiB); the docTR reserve (not needed: the candidates passed); `tessdata_best` (it fails on the LSTM-only core, `missing function DotProductSSE`; it needs the full core, 4.5 MiB more; it is only an accuracy ceiling); PP-OCRv5 mobile and `en` recognisers (mobile loses accents; `en` is covered by `latin`).
- **PP-OCRv6 medium** ran on 10 pages only (72 CPU s a page).
- **The 600-page scroll check with OCR on** (plan section 6) is not part of 7.0.
- **Not measured:** Windows runs W-O1 and W-O2; real GPU; real thread scaling; the viewer with the isolation keys; a 100-page run for small.
- **Reading-order bug, fixed.** My first XY-cut grouped skewed lines into one row, which hurt CER on the 2-degree pages (tiny 10.2% to 6.2%). The numbers above are from the fixed build. v5 mobile is the one result from the earlier build.
- The ORT build I used is 1.31.1. If Phase 3 pins another, repeat the size table.

---

## 8. Reproduce

```text
cd spikes/phase7-ocr
pnpm install --ignore-workspace
pnpm models            # downloads 237 MiB into models/ (huggingface.co, raw.githubusercontent.com); sha256 checked
pnpm fixtures          # real pages from Wikisource and Commons, about 1 request a second, retries on 429
# synthetic fixtures: the Phase 0 outputs scan-600.pdf, and the textbook, are linked into test-assets/ocr/ ;
#   node ../phase0/scripts/make-scan-fixture.mjs --source <textbook.pdf> --pages 8 --dpi 150 --quality 35 --skew 2 \
#     --pick 12,71,130,199,262,331,404,487 --sidecar ../../test-assets/ocr/degraded-8.sidecar.json --out ../../test-assets/ocr/degraded-8.pdf
#   node ../phase0/scripts/make-scan-fixture.mjs --source <textbook.pdf> --pages 600 --dpi 200 --quality 60 --sidecar-only --sidecar ../../test-assets/ocr/scan-600.sidecar.json
node scripts/hash-fixtures.mjs
pnpm build             # vite build + scripts/copy-assets.mjs into dist/ (SOP_DIST=<folder> to use another)
node bench/run.mjs render                                   # PNGs and PDFium truth through the merged engine
node bench/run.mjs ocr pp-v6-tiny-wasm1-d1280 --dpi native  # one configuration; ids: pp-<set>-<wasm|webgpu><threads>-d<side>, tess-<fast|best>-<langs>
node bench/run.mjs selfcheck                                # the offscreen-document check
node scripts/score.mjs && node scripts/tables.mjs           # scores and tables;  node scripts/sizes.mjs
```

Files: `spikes/phase7-ocr/`: `src/ocr/` (`ppocr.ts`, `geom.ts`, `types.ts`), `src/bench/` (page, worker, Tesseract adapter, offscreen check), `src/scorer.mjs`, `bench/` (driver, server, configs, fixtures, campaign scripts), `scripts/`, `results/` (`scores.json`, `sizes.json`, `webgpu-check.json`, `runs/`, campaign logs). Raw per-page outputs (`results/raw/`) are not committed. `spikes/phase0/scripts/make-scan-fixture.mjs` gained the four options above.

---

## 9. Windows hand runs (not done here)

**W-O1: real GPU, threads, WASM speed.** Use Playwright's Chromium, not branded Chrome: branded Chrome 137 and later no longer honours `--load-extension`.
```text
cd spikes/phase7-ocr ; pnpm install --ignore-workspace ; pnpm models ; pnpm build
set SOP_HEADED=1
node bench/run.mjs render        # needs test-assets/ocr/ copied from the container, or rebuilt as in section 8
node bench/run.mjs ocr pp-v6-tiny-wasm1-d1280   --sets syn,real --dpi 200 --limit 12 --repeat 2
node bench/run.mjs ocr pp-v6-tiny-wasm4-d1280   --sets syn,real --dpi 200 --limit 12 --repeat 2
node bench/run.mjs ocr pp-v6-tiny-webgpu-d1280  --sets syn,real --dpi 200 --limit 12 --repeat 2
node bench/run.mjs ocr pp-v6-small-webgpu-d1280 --sets syn,real --dpi 200 --limit 12 --repeat 2
node bench/run.mjs ocr pp-v6-tiny-wasm1-d1280 --sets syn --dpi 200 --limit 12 --vis
```
Send back `results/runs/*.json` and `results/raw/`. The quiet-machine numbers answer: do 2 or 4 threads help, how fast is WebGPU, and is the visible-page target met.

**W-O2: Chrome's own OCR.** Needs desktop Chrome with the Screen AI component downloaded (open any scan once).
```text
node scripts/make-chrome-inputs.mjs
npx chromium-ocr-wrapper "test-assets/ocr/chrome-in/*.pdf" -o test-assets/ocr/chrome-out/
node bench/run.mjs readtext chrome-screenai chrome-out     # reads <name>.pdf or <name>_searchable.pdf with PDFium
node scripts/score.mjs chrome-screenai pp-v6-tiny-wasm1-d1280 && node scripts/tables.mjs chrome-screenai pp-v6-tiny-wasm1-d1280
```
The Whole Foods receipt already has text, so Chrome will leave it alone. If the wrapper fails, count Ctrl+F hits by hand on 30 words, as the plan says. **Pass:** tiny's findability and word recall are within 1 point of Chrome's on `syn`, `real` EN and `real` FR.

---

## 10. Recommendation

```text
OCR_ENGINE      = ppocr         (PaddleOCR PP-OCRv6 on onnxruntime-web 1.31.1; our own det + rec pipeline)
OCR_MODELS      = PP-OCRv6_tiny_det + PP-OCRv6_tiny_rec   (6.0 MiB; Apache-2.0)
OCR_UPGRADE     = PP-OCRv6_small_det + PP-OCRv6_small_rec (29.8 MiB): "Better recognition available"
OCR_BACKENDS    = [wasm]        (WebGPU only after W-O1 shows a gain on a real GPU)
OCR_THREADS     = 1
OCR_RENDER_DPI  = 150
OCR_DET_MAX_SIDE= 1280
OCR_LANGS       = one pass for all (English, French, German and 46 other Latin-script languages); no language control
```

**Settings and why**
- **Engine and models:** PP-OCRv6 tiny. It is the only PP model that runs near the speed targets. Small is better by about one point of word recall (92.0 to 94.1% on synthetic, 97.9 to 99.0% on real English, 89.2 to 94.4% on degraded pages, 66.7 to 97.2% on the German receipt) but costs 4 times the CPU and 5 times the size. Plan 7.4 already has a "Better recognition available" upgrade; small is the natural next version, re-run and re-anchored by quote.
- **One model for all three languages.** The v6 recogniser covers 49 languages with one dictionary, so 7.4 needs no language switch.
- **Backends:** WASM. Keep a WebGPU slot in the engine interface, but ship the plain WASM build until a Windows run proves it is worth +13.3 MiB.
- **Threads:** one. Under load, threads made it slower. One thread also needs no cross-origin-isolation keys in the manifest. Revisit with W-O1.
- **DPI 150, detector side 1280.** Accuracy is the same from 100 to 300 dpi; 150 keeps the image at 1275 by 1650 for Letter (8 MB) and small print readable. This also keeps memory low.
- **Scheduling for 7.3:** one page in flight, and a way to hand the visible page the next slot at a recognition-batch boundary, so the wait is under a second. PP-OCR memory is flat over 100 pages, so the worker does not need recycling.
- **Text assembly for 7.1:** join line-end hyphens before the text is stored (the scorer does it, and Find needs it). A line with only symbols from a figure should be dropped by 7.1 or the engine; the engine emits junk lines for plots.

**Expected accuracy (tiny)**

| | Findability | CER | Word recall |
| --- | --- | --- | --- |
| English book pages (real) | 99.3% | 2.7% (1.3% without the scan footer line) | 97.9% |
| French book pages (real) | 98.1% | 1.8% | 96.8%; accents 98% exact |
| Synthetic textbook pages | 99.7% | 5.3% (1.4% on prose pages) | 92.0% |
| Degraded pages (150 dpi, q35, 2 degrees) | 99.5% | 6.2% | 89.2% |
| German, blurry large-print sample | 84.1% | 20.8% | 82.2% |
| Word boxes on synthetic pages | hit 95.7% (median page 98.8%, text pages 99 to 100%) | | |

**Expected speed:** 3.5 CPU seconds a page on one thread (0.7 to 7.3), about 15 to 17 pages a minute. 4 to 5 s from opening a tab to selectable text on the first page. The page you scroll to waits about two page-times. **Both plan targets (3 s p95 visible, 20 pages a minute) are missed on one thread.** Memory about 0.55 GB, flat. Models 6.0 MiB, zip 5.5 MiB over the Phase 3 build.

**What must be true before 7.2 ships**
1. W-O2 passes (within 1 point of Chrome), or the owner accepts the gap.
2. W-O1 shows how many threads, or WebGPU, are needed to meet the speed targets. If neither helps, the plan's targets should change, or the engine splits recognition into batches that yield.
3. The manifest isolation keys are tested against the viewer (only if threads are used).
4. A better German scan is added for the gate.

**If you prefer the decision rule as written:** Tesseract.js 7.0.0 with `tessdata_fast` eng, fra, deu in one pass; one worker; render at 150 dpi (2.9 CPU s a page, findability 99.4% on real English, memory about 0.7 GB); recreate the worker after about 50 pages and keep pages at or below 150 dpi, because memory grows with the image (3 GB at 300 dpi). Adds 10.3 MiB raw, 4.7 MiB zipped. Expect German accents to suffer (63% exact) and degraded pages to be a point or two worse.

---

## 11. Summary for the owner

I compared two ways to read text from scanned pages: Tesseract, the old standard, and PaddleOCR, a newer one. I ran both inside a test copy of the extension on real scanned book pages, on a 600-page fake scan, and on two receipts. For searching a page with Ctrl+F they are almost the same: both find about 99 of 100 words on English book pages. The difference shows on harder pages. PaddleOCR is better on blurry pages, on formulas, on French and German accents, and on a photographed receipt. It also uses about a fifth of the memory when pages are scanned at a high resolution. Tesseract copies clean book text a little more exactly (about a third of a point of errors in it). I recommend the small PaddleOCR model ("tiny", 6 MB). It reads every language we need in one pass. A bigger model ("small", 30 MB) is about one point more accurate but four times slower; it fits the "Better recognition available" button already in the plan. Two things are not done and need your Windows machine. First, I could not run Chrome's own scan reader, so I cannot say yet that we match it. The steps are in section 9, and I would not ship before that run. Second, on this shared test machine the engine reads about one page every four seconds, which misses the speed goal of three seconds, so the Windows run also checks whether more threads or the graphics chip fix that. One more caution: the German sample was a very blurry scan and every engine did badly on it, so we need a better German test page.
