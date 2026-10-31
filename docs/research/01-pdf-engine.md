# 01 — PDF engine & annotation foundation

Research date: 2026-10-31. Scope: an Electron (React + TS, Windows 11) desktop PDF reader whose main job is highlighting plus Google-Docs-style comment threads, where the same viewer bundle also runs as a Chrome MV3 extension page that replaces Chrome's PDF viewer.

**Legend.** **[V]** means I checked it myself, and the source is given: a file path in a shallow clone under `/tmp/claude-0/-home-user/24aa939a-b5a9-56a1-a55e-601726feabba/scratchpad/research/repos/`, the npm registry, ungh.cc / ecosyste.ms (GitHub metadata mirrors, because direct api.github.com was blocked in this session), or raw.githubusercontent.com. **[U]** means unverified: it comes from docs, memory, or inference, and still needs testing.

Clones read: `embed-pdf-viewer` (main, 3.0.0-next.19 @ fbb76bb), `embed-pdf-viewer-v2` (branch `v2`, 2.15.1 @ dfb2df8), `pdf.js` (main, 6.5 dev @ 743102c), `react-pdf-highlighter-extended` (@ b58a3b3), `reader` (zotero, @ 293d7e1). No install scripts were run.

---

## 1. TL;DR recommendation

| Decision | Pick | Why (short) |
|---|---|---|
| **(a) Rendering/viewer base** | **EmbedPDF v2 (`@embedpdf/*` 2.15.1, PDFium-wasm), headless, with its React bindings.** Gate it with a one-week spike (§6). If the spike fails, fall back to **pdfjs-dist 6.4.x `PDFViewer`**. | PDFium is the engine inside Chrome's own viewer, so rendering matches Chrome by construction. It is MIT/Apache, headless, and has plugins for virtualized scroll, tiling, thumbnails, outline and search. Stirling-PDF (95k★) ships on it [V `Stirling-PDF/frontend/package.json` → `@embedpdf/* 2.15.1`]. |
| **(b) Highlight + comment layer** | **Our own React layer**, built on **EmbedPDF `plugin-annotation`** for the data and the PDF write-back. The thread UI is ported from **EmbedPDF snippet's `comment-sidebar`** (MIT, v2). Anchoring is backed by **Hypothesis-style TextQuote/TextPosition selectors** (copy `match-quote.ts`, BSD-2). UX patterns come from **react-pdf-highlighter-extended**, re-implemented rather than depended on. | EmbedPDF already writes **standard** markup annotations with `/NM`, `/T`, `/Contents`, `/IRT` replies and `/State`. That is the reply-thread model Acrobat and Foxit use, so threads survive outside our app. pdf.js can only store **one comment per annotation, no replies, no /NM, single-page highlights** (§3.2). |
| MV3 interception shell | Copy the logic of **`pdf.js/extensions/chromium`** (Apache-2.0): its DNR redirect rules, file:// fallback and Referer preservation. | It is a production MV3 PDF-viewer replacement already, and it works with any engine [V]. |

Put every engine call behind a thin `PdfBackend` adapter: open, render, text/selection geometry, search, annotation CRUD, save. EmbedPDF is in the middle of a v2 → v3 rewrite, and pdf.js is the fallback. The adapter keeps both swaps cheap.

---

## 2. Comparison table

Stars and last push come from ungh.cc on 2026-10-31 [V]. Licenses come from ecosyste.ms plus the LICENSE files or npm `license` field [V unless noted].

| Project | License | ★ | Last push / latest release | Engine | Text selection | Big-doc perf | Find | Thumbs / outline | Annotation model & **write-back to PDF** | Import existing annots | React | Size (key assets) | Maturity / verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **embedpdf/embed-pdf-viewer** | npm 2.15.1 = **MIT**. Repo main = **Apache-2.0**, except `cloudpdf/server` = FCL fair-source (not needed) [V `LICENSE`, `LICENSING.md`, npm] | 4,576 | push 2026-10-29. `latest` 2.15.1 (2026-09-16). `next` 3.0.0-next.19 (2026-10-30) [V npm] | PDFium → wasm (fork "EmbedPDF Runtime"), AGG rasterizer (`pdf_use_skia=false`), no V8/XFA [V `v2/packages/pdfium/scripts/build.sh:35`] | Glyph-geometry selection from PDFium (`getPageGeometry`), not a DOM text layer. Multi-page selections give one markup per page [V `plugin-selection/src/lib/selection-plugin.ts:721`, `plugin-annotation/.../text-markup.handler.ts`] | Virtualized `plugin-scroll` (vertical/horizontal strategies), `plugin-tiling`, render in a Web Worker (single PDFium worker) plus 2 image-encoder workers (OffscreenCanvas→PNG) [V `engines/src/lib/pdfium/web/worker-engine.ts:77-95`, `image-encoder/worker-pool.ts:117`]. Whole file sits in the wasm heap (`FPDF_LoadMemDocument`), 2 GB cap [V `engine.ts:347`. Issue #649 reports the 2 GB error on a 40k-page doc, U] | `plugin-search` (all pages, progress events) [V] | `plugin-thumbnail`, `plugin-bookmark` [V] | Highlight, Underline, StrikeOut, Squiggly, Caret, Ink, Ink-highlight, FreeText (+callout), Square, Circle, Line, Polygon, Polyline, Stamp, Text (sticky), Link, Redact [V `tools/default-tools.ts`, `handlers/`]. Writes **/NM, /T, /Contents, /Subj, /IRT + /RT, /State**, custom JSON in `/EPDFCustom`, and generates an AP stream [V `engine.ts:1260, 1446-1448, 8673-8704, 8803-8812, 9058-9063, 3294`]. Save = **full rewrite** in v2 (`FPDF_SaveAsCopy(...,0)`); v3 adds incremental [V `pdfium/build/code/cpp/main.cpp:63-66`, v3 `.../save/internal/pdfSaveMode.ts`] | Yes. Reads all annots, assigns /NM if missing, resolves /IRT [V `engine.ts:1014-1017, 8673`] | `@embedpdf/core/react` + per-plugin React hooks/components [V `core/package.json` exports] | `pdfium.wasm` 4.65 MB, `worker-engine.js` 0.71 MB [V jsDelivr]. v3 wasm about 6.4 MB [V v3 `docs/content/viewer/self-hosting.mdx`]. CJK fallback fonts are large (`fonts-sc` 42 MB) [V jsDelivr] | Young: npm created 2025-06-12, 107 versions, 256 open issues. **v3 rewrite in progress, and the README says "not yet recommended for production"** [V `README.md`]. **Best fit.** |
| **mozilla/pdf.js** (`pdfjs-dist`) | Apache-2.0 | 54,060 | push 2026-10-29. 6.4.299 (2026-10-03) [V npm] | JS interpreter + Canvas2D. wasm decoders: OpenJPEG, **JBIG2 (PDFium-derived)**, qcms, QuickJS, with no-wasm fallbacks [V `external/jbig2/README.md`, `src/core/wasm_image.js`] | DOM text layer, native browser selection. Scaled spans via `measureText` + CSS `--total-scale-factor` [V `src/display/text_layer.js:136,429`] | `PDFViewer` renders visible pages, page cache 10 [V `web/pdf_viewer.js:75`], range/stream loading. Main-thread canvas rendering. An experimental renderer worker (OffscreenCanvas/WebGPU) is on main only and off by default [V `src/display/api.js:213,361`, `web/app_options.js:792`; absent from the 6.4.299 build, V grep] | `PDFFindController` [V] | `PDFThumbnailViewer`, `PDFOutlineViewer` (app layer; component build exports `PDFViewer`/`PDFFindController` etc.) [V `web/pdf_viewer.component.js`] | Editors: FreeText, Highlight (+free-draw highlight), Ink, Stamp, Signature, Comment [V `src/shared/util.js:82`]. **No underline/strikeout editors.** Highlight is saved as `/Highlight` with QuadPoints, C, CA, T, AP, plus a Popup with `/Contents` [V `src/core/annotation.js:5157-5183, 1886-1925`]. **Single comment, no reply creation, no /NM** [V no `"NM"` in `src/core`, no `inReplyTo` use in `web/`]. Save = **incremental update** [V `src/core/worker.js:35,919`] | Renders all. Existing Highlight/Ink/FreeText/Stamp are editable (`isEditable`) [V `annotation.js:5120`]. `/IRT` is parsed but not shown as threads [V `annotation.js:1730`] | None official. Imperative `PDFViewer` in a ref (that is what the highlighter libs do) [V] | pdf.min.mjs 459 KB, worker 1.26 MB, pdf_viewer.mjs 320 KB, cmaps 1.17 MB, standard_fonts 0.80 MB, wasm/ 1.54 MB [V jsDelivr 6.4.299] | Very mature, but the editor APIs are semi-internal (`#private`, they change often) [V]. **Fallback base.** |
| DanielArnould/react-pdf-highlighter-extended | MIT | 111 | push 2024-11-22. 8.1.0 (2024-07-05) [V] | pdfjs-dist **^4.4.168** (2 majors behind) [V `package.json`] | pdf.js DOM text layer, multi-page rects [V `src/lib/get-client-rects.ts`] | pdf.js `PDFViewer`. One React root per page highlight layer [V `PdfHighlighter.tsx:230,410`] | No | No | App JSON only: `ScaledPosition{boundingRect, rects[], pageNumber}` plus `content{text,image}`. Text and area highlights. **No PDF write-back** [V `src/types.ts`] | No | **React 18 only** (`^18.3.1` peer) [V npm] | 139 KB [V npm] | Stale. Use for UX ideas only. |
| agentcooper/react-pdf-highlighter | MIT | 1,414 | push 2024-11-22. 8.0.0-rc.0 (2024-09-14) [V] | pdfjs-dist 4.4.168 [V npm] | same as above | same | No | No | Same JSON model, no write-back [U, same lineage] | No | React ≥18 [V npm] | 440 KB | Stale. Ancestor of the above. |
| zotero/reader | **AGPL-3.0** [V `COPYING`] | 205 | push 2026-10-29 [V] | Fork of pdf.js (`zotero/pdf.js` submodule) [V `.gitmodules`] | Custom selection over pdf.js text (`src/pdf/selection.js`) [V file exists] | Good (in production in Zotero) [U] | Yes [V `pdf-find-controller.js`] | Yes [V `pdf-thumbnails.js`] | highlight / underline / note / image / text / ink [V `src/common/reader.js:169-185`]. Stored in the Zotero DB. PDF import/export lives in a separate worker (`zotero/document-worker`) [U] | Via Zotero [U] | React inside, but not a library [V deps] | — | Excellent UX reference. **AGPL means do not copy code.** |
| readest/readest | **AGPL-3.0** [V] | 25,775 | push 2026-10-30 [V] | Tauri + foliate-js → pdf.js [V `foliate-js/pdf.js` imports `pdf.min.mjs`] | pdf.js | Paginated book model, not built for textbooks [U] | Yes [U] | Yes [U] | Own DB, not PDF-native [U] | [U] | React/Next [U] | — | Reference only (AGPL). |
| koodo-reader/koodo-reader | **AGPL-3.0** [V `LICENSE`] | 28,676 | push 2026-10-30 [V] | Electron 34 [V `package.json`]. PDF via pdf.js [U] | — | — | — | — | Own DB [U] | — | — | — | Reference only (AGPL). |
| wojtekmaj/react-pdf | MIT | 11,192 | push 2026-10-28. 11.0.0 (2026-09-10), pdfjs-dist 6.3.289 [V npm] | pdf.js | pdf.js text layer | **No virtualization** (you render `<Page>`s yourself) [U, README has no virtualization section] | No | No | Display only (annotation layer CSS for links) [V README] | Display | Yes | 337 KB | Too low-level for us. |
| pdfslick/pdfslick | MIT | 1,087 | push 2026-10-09. 4.0.3 (2026-10-09), pdfjs-dist ^6.0.227 [V npm] | pdf.js `PDFViewer` + zustand | pdf.js | pdf.js | Yes | Thumbnails yes [V bundle grep `PDFThumbnailViewer`] | Exposes pdf.js editor modes + `saveDocument` [V bundle grep]. No comment manager [V] | pdf.js | Yes | core ESM 140 KB + worker | A decent React wrapper if we fall back to pdf.js. |
| hypothesis/client | **BSD-2** [V `LICENSE`] | 741 | push 2026-10-19 [V] | Rides on the pdf.js viewer (`PDFViewerApplication` global) [V `src/annotator/anchoring/pdf.ts:86`] | — | — | — | — | W3C Web Annotation selectors (TextQuote + TextPosition) with fuzzy re-anchoring (`approx-string-match`) [V `anchoring/match-quote.ts`]. Needs the h service backend [U] | — | Preact | — | **Steal the anchoring code** (BSD-2), not the client. |
| anaralabs/lector *(newcomer)* | MIT | 402 | push 2026-10-29. 3.16.4 (2026-10-28) [V] | pdf.js (peer `^5.5.207`) [V npm] | pdf.js text layer | `@tanstack/react-virtual` [V npm deps] | Yes | Thumbnails yes [V README] | Custom highlight overlays, **not written to PDF** [V README] | — | Headless React **≥19** [V] | 337 KB | Best React-headless pdf.js option, but has no annotation persistence. |
| InkLayer (successor of pdfjs-annotation-extension) *(newcomer)* | MIT [V `inklayer-core/LICENSE`] | 40 (react) / 0 (core). Predecessor 330, archived [V] | core 0.3.2, push 2026-10-10 [V] | pdfjs-dist ^6.2 + konva + pdf-lib [V `package.json`] | pdf.js | — | Yes [U] | — | Comments with replies, export to PDF via pdf-lib [U README] | Yes [U] | Yes | — | Too young. Watch. |
| recogito/pdf-annotator-js | BSD-3 [V npm] | 19 | 4.3.7 (2026-10-12) [V] | pdf.js | pdf.js | — | — | — | W3C model, no write-back [U] | — | `@recogito/react-pdf-annotator` [V npm] | 1.8 MB | Niche. |
| ArtifexSoftware/mupdf.js | **AGPL-3.0-or-later** or commercial [V npm] | 609 | 1.28.1 (2026-09-06) [V] | MuPDF wasm | — | — | — | — | Full annotation API [U] | — | — | 14 MB unpacked | Licensing blocker for a shareable app. |
| @hyzyla/pdfium | MIT [V npm] | 192 | 3.0.0 (2026-10-10) [V] | PDFium wasm (bare bindings) | — | — | — | — | — | — | — | — | Lower-level alternative if EmbedPDF ever dies. |

Commercial SDKs (Nutrient/PSPDFKit, Apryse/PDF.js Express, Syncfusion) were left out because of their licenses.

**License summary for a personal app that may later be shared.** MIT, Apache-2.0, BSD-2 and BSD-3 are all fine; keep their NOTICE and attribution files. Apache-2.0 needs the NOTICE carried along, and EmbedPDF has a `NOTICE` file [V]. **AGPL (Zotero reader, Readest, Koodo, MuPDF)** is different: if any of their code is linked or copied in, the whole app must be distributed under AGPL, including to network users. Read those projects for ideas only. The EmbedPDF/CloudPDF *trademarks* are not licensed [V `LICENSING.md`], so do not ship under that name.

---

## 3. Evidence on the deciding questions

### 3.1 EmbedPDF (v2 stable): annotation code path, confirmed

- **Creating from a selection:** `textMarkupSelectionHandler` loops over the per-page `selections`. For each one it creates an annotation with `rect`, `segmentRects` (which become QuadPoints), `id = uuidV4()`, and `custom.text` = the selected text [V `v2/packages/plugin-annotation/src/lib/handlers/text-markup.handler.ts`]. A selection that spans several pages becomes N linked-by-us annotations.
- **IDs:** the `id` is written to `/NM`. A missing `/NM` on imported annotations is generated and written back [V `engines/src/lib/pdfium/engine.ts:1014-1017, 1260`].
- **Threads:** `setInReplyToId` links `/IRT` to the parent found by NM, and `getInReplyToId` reads it [V `engine.ts:8673-8704`]. The snippet's sidebar creates replies as `/Text` annotations named `Comment`, with `inReplyToId: parent.id` [V `v2/viewers/snippet/src/components/comment-sidebar.tsx:88-112`]. This is the same model Acrobat and Foxit use for replies. Whether Foxit/Acrobat actually show these as threads is **[U]**, so it needs a round-trip test.
- **Author, text and review state:** `/T`, `/Contents`, `/Subj`, `/State` and `/StateModel` are written [V `engine.ts:8803-8812, 3294-3299`]. Arbitrary JSON goes to `/EPDFCustom` [V `engine.ts:9058-9063`]. That key is non-standard: other viewers ignore it, which is fine for our anchors and tags.
- **Appearance streams:** generated for created annotations through the fork API `EPDFAnnot_GenerateAppearance(WithBlend)` [V `engine.ts:1446-1448`]. This matters because some viewers render nothing for a markup annotation that has no AP.
- **Saving:** `saveDocument` → `PDFiumExt_SaveAsCopy` → `FPDF_SaveAsCopy(doc, writer, 0)`, which is a **full rewrite and not incremental** [V `pdfium/build/code/cpp/main.cpp:63-66`]. The bytes are then copied out **one byte per `getValue` call** [V `engine.ts:4533-4547`], which will be slow on 200 MB+ files (U, not measured). A plain `FPDF_SaveAsCopy` with a flags argument **is exported to JS** [V `pdfium/src/vendor/functions.ts:238`], so a small patch-package change could do an incremental save (flag 1) and use `HEAPU8.slice` without rebuilding the wasm (U until tested). v3 already supports `'incremental'` [V v3 `packages/engine/services/src/features/save/internal/pdfSaveMode.ts`].
- **UI reference:** `viewers/snippet` (Preact) has a comment sidebar with annotation cards, replies, edit/delete and avatars [V `comment-sidebar/annotation-card.tsx`]. It is MIT in v2, so it can be ported to React.

### 3.2 pdf.js: annotation code path, confirmed

- `highlightSelection()` takes `document.getSelection()` and computes boxes from the client rects of the text-layer spans. **It refuses any selection that is not entirely inside one `.textLayer`**, so highlights that cross pages are impossible [V `src/display/editor/tools.js:1409-1448, 2947-2965`].
- The comment UI is `CommentManager` / `CommentSidebar` / `CommentPopup` / `CommentDialog` [V `web/comment_manager.js`]. It holds one comment per editor, has no reply code, and is **off by default in built viewers** (`enableComment: typeof PDFJSDev === "undefined"`, which is true only in dev builds) [V `web/app_options.js:348-353`]. `PDFViewer` takes a duck-typed `commentManager` option [V `web/pdf_viewer.js:244,342`], so our own thread UI could plug in there. 6.4.299 ships this plumbing [V grep of the dist build].
- The save path writes standard `/Highlight` + `/Popup` + `/Contents`. It never writes `/NM` or `/IRT` [V `src/core/annotation.js:1886-1925, 5157-5183`; no `"NM"` anywhere in `src/core`]. Saving is an incremental update [V `src/core/worker.js:919`].
- **Conclusion:** Google-Docs-style threads on pdf.js would mean either (a) keeping the threads only in our DB, so Foxit/Acrobat see one comment, or (b) patching pdf.js core to write `/IRT` replies and `/NM`. Both are more work than EmbedPDF, where this already exists.

### 3.3 Rendering quality versus Foxit and Chrome

- EmbedPDF uses PDFium, Chrome's PDF engine (historically Foxit's) [V README]. Differences from Chrome: **AGG instead of Skia** [V build.sh], **no system fonts**, and fallback fonts that must be supplied, by default from the jsDelivr CDN [V `engines/src/lib/pdfium/cdn-fonts.ts:33-37`]. Visual parity on PDFs with embedded fonts should be essentially exact (U, needs a side-by-side check).
- pdf.js now decodes JBIG2 with a PDFium-derived wasm decoder [V `external/jbig2/README.md`], which helps scanned PDFs. Its rendering is good, but it is a separate implementation with its own edge cases (U).

---

## 4. Fork vs depend

| Item | How | Notes |
|---|---|---|
| `@embedpdf/core, engines, pdfium, models, plugin-{scroll,render,tiling,viewport,zoom,selection,search,thumbnail,bookmark,annotation,history,interaction-manager,rotate,export}` **2.15.1** | **Depend (npm), exact pin** | Do not fork the monorepo: it is 239 MB and the PDFium build needs Docker. |
| EmbedPDF engine patches | **patch-package** on `@embedpdf/engines` | (1) incremental save + fast buffer copy; (2) if the MV3 blob worker fails, a file-based worker URL; (3) local default wasm and font URLs. |
| Snippet `comment-sidebar/*` (MIT, v2) | **Vendor + port to React**, keep the license header | It becomes our thread panel. Re-lay it out as margin cards aligned to the highlight's y-position, Docs-style. Nobody ships that layout [V: snippet is a list per page]. |
| Hypothesis `match-quote.ts` + `approx-string-match` | **Vendor** (BSD-2) | Store `{quote, prefix, suffix, start, end}` per highlight next to the QuadPoints, for re-anchoring and a robust sidecar. |
| pdf.js `extensions/chromium/{pdfHandler,contentscript,preserve-referer,extension-router}.js` | **Vendor and adapt** (Apache-2.0) | DNR redirect to `viewer.html?DNR:<url>`, file:// fallback through `webNavigation`, Referer handling [V]. |
| react-pdf-highlighter-extended, Zotero reader, Readest | **Read only** | UX patterns: selection tip, ghost highlight, scroll-to-highlight, sidebar sort. Zotero and Readest are AGPL. |
| pdfjs-dist 6.4.x (+ PDFSlick or Lector) | **Fallback dependency**, behind the `PdfBackend` adapter | Only if the EmbedPDF spike fails. |

---

## 5. Concrete gotchas

**Workers, wasm and assets: Electron**
1. Do not load the app from `file://`. Chromium's `fetch` rejects `file:`, and pdf.js treats only http/https as worker-fetchable [V `src/display/dom_utils.js:197-204`]. Register a privileged custom scheme (`protocol.registerSchemesAsPrivileged` with standard, secure, supportFetchAPI, corsEnabled) and serve the bundle with `protocol.handle` [U, Electron API]. With a non-http scheme, pdf.js falls back to fetching cmaps, fonts and wasm on the main thread (`DOMBinaryDataFactory`) [V `src/display/api.js:315-349`]. That works, but you must still pass `cMapUrl`, `standardFontDataUrl`, `wasmUrl` and `iccUrl` [V `web/app_options.js`].
2. If you set a CSP header in Electron, it needs `script-src 'self' 'wasm-unsafe-eval'` [V EmbedPDF docs, pdf.js manifest].

**Workers, wasm and assets: Chrome MV3**
3. The extension-page CSP is limited to `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`. That is exactly what pdf.js's own MV3 extension ships [V `extensions/chromium/manifest.json`]. **Remote code is banned:** EmbedPDF's React hook defaults `wasmUrl` to jsDelivr [V `engines/src/shared/hooks/use-pdfium-engine.ts:5`] and fallback fonts to jsDelivr [V `cdn-fonts.ts`]. Override both with `chrome.runtime.getURL(...)` and bundle the files.
4. **EmbedPDF v2 creates its PDFium worker and its encoder workers from `blob:` URLs** [V `engines/src/lib/pdfium/web/worker-engine.ts:77-88`]. MV3 CSP cannot add `blob:` to `worker-src`. Blob workers in extension pages reportedly work through undocumented behavior (crbug 1504703) [U]. The failure is silent: `new Worker` does not throw, `onerror` fires with an empty message [U]. Test this on day 1. The fallback is patch-package to `new Worker(chrome.runtime.getURL('embedpdf-worker.js'), {type:'module'})`. v3 exposes `engine.worker` / `engine.encoderWorker` options for exactly this [V v3 `docs/content/viewer/self-hosting.mdx`].
5. `web_accessible_resources` must include `viewer.html`, and `host_permissions: <all_urls>` is needed to fetch cross-origin PDFs from the extension page [V pdf.js manifest]. file:// PDFs need the user to switch on "Allow access to file URLs". Until then, DNR does not fire and you redirect through `webNavigation` [V `pdfHandler.js:279-300`].
6. MV3 cannot save in place to a web URL or file:// path. Keep annotations in a sidecar keyed by a content hash or fingerprint (IndexedDB/OPFS), and offer "Save copy with annotations" through `chrome.downloads` or `showSaveFilePicker` [U API behaviour]. In Electron, write in place (incremental) through the main process.

**Fonts and cmaps**
7. pdf.js needs `cmaps/` (1.17 MB) and `standard_fonts/` (0.80 MB) copied, and their version must match the worker [V jsDelivr]. Mismatched worker and library versions throw [U, well-known].
8. PDFium-wasm has no system fonts. Non-embedded CJK needs the `@embedpdf/fonts-*` packages: `fonts-sc` alone is 42 MB [V jsDelivr]. Ship only Latin, and lazy-load the rest from local disk in Electron.

**Text-layer alignment and zoom (pdf.js)**
9. Span widths are fitted with `ctx.measureText` and a CSS scale, and the layer scales through `--total-scale-factor` / `--min-font-size` [V `src/display/text_layer.js:136,429,512`]. `pdf_viewer.css` from the **same** pdfjs-dist version is mandatory. Zooming with a CSS `transform` on the container (instead of `currentScale`) desynchronizes selection rects. Chrome's "minimum font size" setting interacts with `--min-font-size` [V the code exists to compensate].
10. EmbedPDF avoids DOM drift because selection rects come from PDFium glyph boxes [V]. The cost is that there is no native browser selection, so copy, IME, and screen readers go through the plugin (`copyToClipboard`) [V `selection-plugin.ts:1126`]. We have to build keyboard selection and accessibility ourselves (U, size of gap).

**HiDPI (Windows 125% / 150%)**
11. pdf.js renders at `devicePixelRatio` through `OutputScale` and caps at `maxCanvasPixels = 2**25`, plus `capCanvasAreaFactor` 200 and `maxCanvasDim` 32767. `enableDetailCanvas` re-renders the zoomed viewport region crisply [V `web/app_options.js:596, 217, 99`; `web/pdf_viewer.js:371`]. EmbedPDF reads `window.devicePixelRatio` per render and tile layer [V `plugin-render/.../render-layer.tsx:70`, `plugin-tiling/.../tiling-layer.tsx:54`]. Fractional DPR combined with non-integer CSS page sizes gives slight blur. Re-render on DPR change when a window moves between monitors (U, handled or not).

**Performance and memory**
12. EmbedPDF v2 runs everything on one PDFium worker, with no pthreads, and renders RGBA, then encodes PNG through OffscreenCanvas, then shows an `<img>` [V `worker-engine.ts`, `image-encoder-worker.ts`, `worker-pool.ts:117`]. The PNG encode adds latency per page at DPR 1.5–2 (U, measure it; WebP or JPEG may be configurable [V the type union exists]).
13. EmbedPDF v2 copies the whole file into the wasm heap (`FPDF_LoadMemDocument`) [V `engine.ts:347`]. It is built with `ALLOW_MEMORY_GROWTH` and no `MAXIMUM_MEMORY`, so Emscripten's 2 GB default applies [V `pdfium/build/compile.esm.sh`; default cap U]. That should be OK for 300 MB scanned textbooks and risky above about 1 GB. pdf.js streams and uses range requests instead.
14. pdf.js keeps 10 rendered pages cached [V `web/pdf_viewer.js:75`], and with many thousands of pages the browser can choke on page DOM elements (U, upstream pdf.js discussion).

**Scanned lecture slides**
15. With no text layer there can be no text highlight. Provide area highlights: EmbedPDF `Square` / Ink-highlight [V tools], pdf.js free-draw highlight [V `highlight.js`]. None of the candidates OCRs (Lector says so explicitly [V README]). Plan an OCR add-on (tesseract.js in a worker, or ocrmypdf in Electron) [U].

**Interop details**
16. pdf.js never writes `/NM`, so you cannot reliably join in-file annotations to sidecar rows across sessions [V]. EmbedPDF writes and repairs `/NM` [V].
17. A multi-page highlight is N PDF annotations. Group them in our model (shared thread id in `/EPDFCustom` or the sidecar), and attach the thread to the first one with `/IRT` [design].
18. v2's full-rewrite save **invalidates digital signatures** and rewrites the whole file [V flags 0]. Patch to incremental before shipping.

---

## 6. Riskiest unknowns (test in a one-week spike, in this order)

1. **EmbedPDF v2 → v3 churn.** v3 is a near-total restructure: `plugin-scroll` and `engines` are gone, replaced by `engine-{core,runtime,services}`, `view-manager` and `stage` [V v3 `packages/` listing]. The README says it is not production-ready [V]. The v2 branch's last release was 2026-09-16 [V], so how long v2 will be maintained is **unknown**. Mitigation: the `PdfBackend` adapter, and watching v3 GA.
2. **MV3 blob-worker behaviour** (gotcha 4). If it is blocked and the patch is brittle, MV3 may need v3 or pdf.js.
3. **Scroll smoothness on a 500–800-page scanned textbook** (JBIG2/JPEG, 200–500 MB) at DPR 1.5 on a mid-range Windows laptop, for EmbedPDF (single worker + PNG encode) versus pdf.js. Not measured.
4. **Foxit / Acrobat / Chrome round-trip.** Does a 3-reply `/IRT` thread created by EmbedPDF, plus a highlight AP, display as a thread in Foxit and Acrobat? Do their replies import back correctly? Not tested.
5. **Incremental-save patch** through the exported `FPDF_SaveAsCopy(…,1)`: does it work through the JS wrapper, and is the output valid in Acrobat? Not tested.
6. **Glyph-based selection UX** versus native: double/triple-click, keyboard extend, multi-column order, RTL. Not tested.
7. **Re-anchoring quality.** If PDFium's text extraction differs from what other tools see (ligatures, hyphenation), the quote selectors stored in `/EPDFCustom` need fuzzy matching. That is why Hypothesis's `match-quote` is included.
8. **Large-file ceiling** (2 GB wasm heap) for very large scans.

**Fallback trigger:** if items 2 or 3 fail and cannot be patched within the spike, switch the base to pdfjs-dist 6.4.x `PDFViewer` (or PDFSlick/Lector) with our own React thread UI plugged in through `commentManager`. Keep threads in the sidecar, and write a single `/Contents` to the PDF until we patch pdf.js core for `/IRT` and `/NM`.
