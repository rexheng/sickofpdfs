# 06 — Comments on figures, and sending figures to Claude

Research date: 2026-10-31. Scope: how sickofpdfs lets you comment on a figure (chart, graph, diagram, photo, equation image, image-only table), and exactly what is sent to Claude when you type @Claude in that thread. Read-only research; the spec is not edited here.

**Legend.** **[V]** = checked myself, source given (a file and line in the shallow clones under `/tmp/claude-0/-home-user/24aa939a-b5a9-56a1-a55e-601726feabba/scratchpad/research/repos/`, the `@anthropic-ai/sdk` 1.3.0 tarball from npm, the live Claude docs at platform.claude.com, or a web page). **[U]** = unverified: memory, inference, a forum report, or an estimate to measure.

Clones read: `embed-pdf-viewer-v2` (2.15.1 @ dfb2df8), `embed-pdf-viewer` (3.0.0-next.19 @ fbb76bb), `pdf.js` (main @ 743102c), `reader` (Zotero, AGPL, read for ideas only).

---

## 1. TL;DR

| Question | Recommendation |
|---|---|
| How do you comment on a figure? | **Hover outlines it, click selects it, Ctrl+Alt+M comments.** The figure box is found for you; you never draw it. Alt+drag still draws any rectangle (part of a figure, a scan, an undetected figure). Ctrl+Alt+M with nothing selected, over a figure, drops a pin inside that figure. |
| How are figures found (Release 1)? | **PDFium page objects plus caption rules, no ML.** Image objects, form XObjects (most LaTeX `\includegraphics` PDFs) and clusters of vector paths become candidates. Captions such as "Figure 3:", "Fig. 3.", "Table 2" are matched to the nearest candidate, as AllenAI's pdffigures2 does. Tagged PDFs use their `/Figure` structure elements and alt text. Show the hover outline only for confident boxes. |
| When to add a model? | **Release 3, with text recognition**, for scans and for born-digital pages where the rules miss. Use **PP-DocLayout-S** (Apache-2.0, 4.8 MB, 23 classes) on onnxruntime-web, which is already bundled for MiniLM. PP-DocLayoutV3 (Apache-2.0, 65.5 MB fp16) is the accuracy upgrade. Do not use DocLayout-YOLO or Ultralytics models (AGPL). |
| How is a figure comment anchored? | Page + rectangle normalised to 0–1 in unrotated page space, plus a **figure fingerprint**: caption label and caption quote (re-anchored like any text quote), a SHA-256 of the largest image stream, and a 64-bit perceptual hash of the rendered region. Sub-regions and pins are stored relative to the figure. |
| What does Claude get? | One **PNG crop rendered locally** at a scale chosen from the smallest text inside the figure (150–300 DPI), capped at about 1,600 visual tokens (4,784 on "Think harder"). Plus a citable text pack: caption, the **exact text inside the figure** from PDFium (axis labels, ticks, legend), up to 3 paragraphs that mention "Figure N", the page number, the document map with a list of all figures, and the question. Image before the text it describes. Base64, never the Files API. |
| Cost per figure question | **Haiku 5.5 ≈ $0.001** (0.1 ¢). **Opus 5.5 ≈ $0.05** first question, ≈ $0.027 per follow-up. The image itself is ≈ $0.0002 on Haiku and ≈ $0.007 on Opus. See §8. |
| Citations | Text only. Images cannot be cited [V]. The viewer adds its own "Fig. 3, p. 5" chip that jumps to the figure. |
| EmbedPDF gaps | Neither v2 nor v3 has a public "list page objects" call, although the wasm exports every function needed. v2's internal image reader is buggy. Struct-tree functions are exported but unwrapped. One small patch plus our own worker entry (already needed for MV3) closes all of it. See §11. |

---

## 2. Prior art: how others let you comment on figures

| Product | How you mark a figure | What happens to the image | Evidence |
|---|---|---|---|
| **Google Drive viewer** (our visual model) | PDF: "Select the area you want to comment on." Images: "Click and drag over the area you want to comment on." The web PDF viewer flow is Add comment icon › select area › type › Comment. | Area comment, Docs-style card | [V support.google.com/drive/answer/7650301; V `docs/research/04-features-classifier.md:32`] |
| **Google Docs** | Select an inline image, then Add comment. The anchor is the whole image; there is no sub-region. | Card in the margin | [U: search summary; no official page found] |
| **Zotero 7** | "Select Area" tool draws a rectangle; it becomes an image annotation with comment and tags, resizable, draggable into notes. | Rendered at 4× scale to PNG; ink drawn on top is not included in the captured image | [V `reader/src/pdf/pdf-renderer.js:5,220`; V `reader/src/pdf/page.js:307` resize; V forums.zotero.org/discussion/comment/449216] |
| **Readwise Reader** | "Snapshot": a rectangular selection in the PDF view becomes an image highlight. Not available in the text view. | Image highlight; shareable as image | [V readwise.io/reader/update-august2023] |
| **Adobe Acrobat** | Comment › Drawing Tools › Rectangle, then type in the pop-up note. No "comment on this figure" object. Since January 2025 you can select an image in a scanned PDF and choose Ask AI Assistant. | Square annotation with pop-up | [V helpx.adobe.com/acrobat/using/commenting-pdfs.html via search; U the AI Assistant release note, which now redirects] |
| **LiquidText** | Excerpts dragged out of the document, including image regions. | Excerpt card linked back | [U: no help page found] |
| **Figma** | A comment is a pin at a point. Pins attach to top-level frames and move with them, but not to nested layers. | Pin | [U: Figma forum reports] |
| **AI2 Semantic Reader / "Connecting the Dots" (Feb 2026)** | Figures get "clickable points", body text gets highlights that link passages to parts of figures, and a reference panel shows the figure without scrolling. Readers scored higher on a quiz with no extra time or load. | Figure–text links, not comments | [V arxiv.org/abs/2602.16895 abstract; V Semantic Reader extracts figures and tables separately, arXiv 2303.14334] |

**What makes it low-friction, applied to us:**

1. **No tool mode.** Zotero, Readwise and Acrobat all need a tool or mode before you can mark a figure. Our figure is already outlined on hover, so one click selects it, like an image in Google Docs. Alt+drag stays for anything we did not detect.
2. **The box snaps to the figure.** Nobody has to draw a tidy rectangle around a chart. The caption, the figure number and the text that mentions it come along without any work.
3. **Rectangle first, pin second.** The figure's own box is the anchor (Drive, Zotero, Readwise). A pin (Figma) or a smaller rectangle inside the figure says "this bar". Both are stored relative to the figure, so they stay put if detection later moves the box by a few points.
4. **Captions and mentions are links.** "Figure 3" in body text can jump to the figure and back. This is the AI2 finding and it costs us only the caption matcher we already need.

---

## 3. Finding figures so you can click instead of drawing

### 3.1 What EmbedPDF actually exposes

| Need | v2 2.15.1 | v3 next.19 | Evidence |
|---|---|---|---|
| Enumerate page objects: `FPDFPage_CountObjects`, `FPDFPage_GetObject`, `FPDFPageObj_GetType`, `FPDFPageObj_GetBounds`, `GetRotatedBounds`, `GetMarkedContentID` | **Exported by the wasm. No public engine method.** | Same | [V `v2/packages/pdfium/src/vendor/functions.ts`; V `v3/packages/engine/runtime/src/core/pdf-functions.generated.ts`] |
| Read image objects: `FPDFImageObj_GetImagePixelSize`, `GetImageFilter(Count)`, `GetImageMetadata`, `GetImageDataRaw`, `GetImageDataDecoded`, `GetBitmap`, `GetRenderedBitmap` | Exported. Used only inside annotation reading. | Exported, unused | [V same files] |
| Form XObjects (`FPDFFormObj_CountObjects/GetObject`) and paths (`FPDFPath_CountSegments`, `GetPathSegment`) | Exported. Internal `readFormObject`/`readPathObject` exist but are reached only from stamp-annotation objects | Exported | [V `v2/.../engines/src/lib/pdfium/engine.ts:8265-8417, 8454`] |
| Tagged PDF: `FPDF_StructTree_GetForPage`, `FPDF_StructElement_GetType`, `GetAltText`, `GetActualText`, `GetMarkedContentIdAtIndex` | Exported, **never called** (0 uses in engine.ts) | Exported | [V functions.ts; V `grep -c` on engine.ts] |
| Render a crop | **Yes:** `renderPageRect(doc, page, rect, {scaleFactor, dpr, imageType: png/jpeg/webp, imageQuality, withAnnotations})` | Yes: render target can be a sub-rect of the page | [V `v2/packages/models/src/pdf.ts:3207-3256, 3450`; V `v2/.../engine.ts:860`; V `v3/.../features/render/PageRenderReader.ts:125-138`] |
| Marquee capture (draw a box, get an image) | **Yes:** `plugin-capture` (MIT) calls `renderPageRect` | — | [V `v2/packages/plugin-capture/src/lib/capture-plugin.ts:224-232`] |
| Text inside a region, with font size | **Yes:** `getPageTextRects` returns text with font size (`FPDFText_GetFontSize`); `getPageGlyphs` / `getPageGeometry` give glyph boxes and runs grouped by text object | Yes (`PageTextReader`, `PageGeometryReader`) | [V `v2/.../engine.ts:4870-4927, 4943-4980`] |
| Layout model | `@embedpdf/ai` 0.0.1 + `plugin-layout-analysis` 0.0.1 (MIT, npm Feb 2026): **PP-DocLayoutV3 fp16 ONNX at 800×800 on onnxruntime-web/webgpu, downloaded from huggingface.co by default** | Not present | [V `v2/packages/ai/src/lib/pipelines/layout-detection.ts:18-56`; V `.../runtime/model-registry.ts:4-8`; V npm] |

**What needs a patch:** see §11. In short, the wasm needs no rebuild; we add three engine methods and run our own worker.

### 3.2 Release 1 detection: objects plus captions, no model

Runs in the PDFium worker, per page, at idle priority after the page's tiles are drawn. Results are cached per document fingerprint and page. Budget: about 20 ms for a typical paper page [U, measure in Phase 0]. On pathological pages (maps, scatter plots with 100,000 points) stop at 20,000 objects or 15 ms and keep only caption-based figures.

1. **Tagged PDF first.** If the page has a structure tree, each `Figure` (and `Table`, `Formula`) element gives its marked-content ids, so the objects with those ids give an exact box, and `/Alt` gives the author's description. This is free and exact when present [V functions exported; U how common in papers].
2. **Candidates from objects** (page space, points):
   - each **image object** with area ≥ 2% of the page and both sides ≥ 36 pt. One image covering ≥ 85% of the page means "scan page" (no candidates; see §3.5);
   - each **form XObject** with area ≥ 2% (matplotlib, R and TikZ figures included as PDF usually arrive as one form XObject) [U, common LaTeX behaviour];
   - **vector path clusters**: union paths whose boxes lie within 6 pt of each other; keep clusters with ≥ 8 paths or area ≥ 3%. Drop lone rules (height < 2 pt), page borders and header/footer lines;
   - **absorb text** inside the cluster box expanded by 12 pt when it is not part of a body-text line (line width under 60% of the column, or font smaller than body text). This brings in axis labels, ticks and legends.
3. **Captions.** A text line that starts a block and matches the pattern in §3.3. Pair each caption with the nearest candidate in the same column, above it for figures and below it for tables, with no body text in between. One candidate per caption; no overlaps. This is pdffigures2's method: propose regions next to the caption that contain only graphics and "other" text, score them, prevent overlaps [V pdffigures2 README, Apache-2.0]. A caption with no graphic candidate (a table drawn only with text, or an unusual image structure) gets the region between the caption and the nearest body-text block, marked kind `table` or `unknown`.
4. **Confidence.** High = tagged, or caption-linked, or a single large image/form XObject. Medium = an uncaptioned vector cluster. Only high-confidence figures get the hover outline in Release 1; medium ones appear when you hold Alt. A wrong outline is worse than none.
5. **Mentions.** Scan the page text of the whole document for "Figure 3", "Fig. 3(b)", "Figs. 3 and 4", "Table 2". These give the referencing paragraphs for Claude and clickable "Fig. 3" links in body text (Release 1.x).
6. **Output per page:** `{id, kind: image|vector|mixed|table|equation|unknown, rect, captionId?, label?, confidence, objectSummary}`.

Subfigures (a), (b), (c) stay one figure. Comment on one panel with Alt+drag inside it.

### 3.3 Caption pattern

At the start of a line that starts a block, case-insensitive:

```text
^(figure|fig\.?|table|tab\.?|chart|plate|scheme|exhibit|abbildung|abb\.?|tabelle|figura|tableau|tabla)\s*
 ((?:[A-Z]{1,2}\.?)?\d+(?:[.\-]\d+)*[a-z]?|[IVXLC]+)\s*(?:[:.—–\-|]|\s{2,}|$)
```

This covers "Figure 3:", "Fig. 2.3.", "Table A1", "Figure S4", "TABLE IV". A body sentence such as "Figure 3 shows…" at a line start is the main false positive; reject it when the line continues a paragraph (no block break before it) or when the same label already has a caption on that page. Test on the existing research fixtures [U, needs a labelled set].

### 3.4 Optional layout model (later)

| Model | Licence | Size | Speed | Classes useful to us | Verdict |
|---|---|---|---|---|---|
| **PP-DocLayout-S** (PaddleOCR 3) | **Apache-2.0** [V HF card and tag] | **4.8 MB** weights [V HF file list] | 18.5 ms on Xeon 6271C, 8 threads, Paddle runtime [V PaddleOCR docs]; browser wasm estimated 80–250 ms/page [U] | 23 classes incl. image, figure title, table, table caption, formula [V HF card] | **Pick for Release 3.** Needs a paddle2onnx export at build time; a community ONNX exists (`stefanj0/PP-DocLayout-S-ONNX`) but we should export and pin our own hash. |
| PP-DocLayout-M | Apache-2.0 [V tag] | 23.4 MB [V] | 43 ms [V] | same | If S misses too much. |
| PicoDet-S_layout_3cls | Apache-2.0 [U card not read] | 4.8 MB [V] | 17.6 ms [V] | table, image, stamp | Smallest figure-only option. |
| **PP-DocLayoutV3** | **Apache-2.0** [V HF tag] | **65.5 MB fp16** ONNX, 130 MB fp32 [V EmbedPDF HF dataset listing] | not published; seconds on wasm [U]; WebGPU faster [U] | 25 classes incl. chart, image, figure_title, table, formula [V `layout-detection.ts:24-50`] | Accuracy upgrade; already wired by `@embedpdf/ai`, but must be bundled, not fetched. |
| PP-DocLayout-L / _plus-L | Apache-2.0 [U] | 124–126 MB [V] | 503–635 ms CPU [V] | adds chart (plus-L) | Too big and slow. |
| Docling layout heron (RT-DETRv2) | Apache-2.0 [V HF card] | 42.9 M params (~170 MB fp32) [V] | slow on wasm [U] | Picture, Caption, Table, Formula [V] | Good, but larger than PP-DocLayout-S for similar use. |
| **DocLayout-YOLO** | **Code AGPL-3.0** [V LICENSE]; weights card says Apache-2.0 [V HF], but it runs on an Ultralytics-derived YOLO stack | — | — | — | **Not usable.** Same for any Ultralytics YOLO layout model (Ultralytics is AGPL-3.0 [V LICENSE]). |
| **Surya / Marker** | **Correction to the brief:** code is now **Apache-2.0** [V LICENSE files], but **weights are a modified OpenRAIL-M** (free only for research, personal use and startups under $5M) [V READMEs] | hundreds of MB [U] | PyTorch, not browser-ready | — | **Avoid**: weight licence and size. |

All of these run on onnxruntime-web in a worker. `transformers.js` (already bundled for MiniLM) ships onnxruntime-web, so the runtime cost is already paid [V spec tech stack]. Use single-threaded wasm: multithreading needs cross-origin isolation, which an extension can opt into with the `cross_origin_embedder_policy` / `cross_origin_opener_policy` manifest keys (Chrome 93+) [V developer.chrome.com], but turning COEP on for the whole extension origin may break PDF loading and embeds [U]. Not worth it for one small model.

### 3.5 Scans (no objects)

A scan page is one big image. Release 1 does no detection on scans: Alt+drag and page notes work, as the spec already says. Plain image heuristics (projection profiles, run-length smoothing) are cheap but fragile on photographed pages [U]. Release 3 runs PP-DocLayout-S on the rendered page as the first step of text recognition (PaddleOCR's own pipelines run layout before OCR [V PaddleOCR docs]), which gives figure boxes on scans for free.

### 3.6 pdf.js fallback

If Phase 0 switches to pdf.js: `page.getStructTree()` exists [V `pdf.js/src/display/api.js:1813`], and the main branch can record painted-image positions through the `recordImages` render option → `imageCoordinates` [V `api.js:1579-1601`; V `web/base_pdf_page_view.js:258`] (used for right-click "save image"; release status [U]). Vector clusters would need operator-list walking (`recordOperations` → `recordedBBoxes` is a debugger feature) [V `api.js:1575-1592`, U stability]. So on pdf.js: tagged figures, image figures and captions; no vector clusters.

### 3.7 Recommendation

- **Release 1:** tagged figures, image and form-XObject candidates, vector clusters, caption linking. Hover outline only for high confidence. Alt+drag for the rest.
- **Gate:** on a labelled set of 30 open-licence papers (box IoU ≥ 0.7), precision ≥ 95% for outlined figures and recall ≥ 75% for captioned figures [U targets]. If precision fails, outline only caption-linked figures.
- **Add the model** in Release 3 with OCR, or earlier only if recall on born-digital papers stays below 75%.

---

## 4. Release 1 experience

| You do | You see |
|---|---|
| Rest the pointer on a figure (250 ms) | A faint 1 px outline and a small chip at its top-right corner: Comment · Ask Claude |
| Click the figure (no drag, not on a link) | Solid 2 px `#0b57d0` outline; the selection toolbar appears beside it: Comment, Ask Claude, Explain, Copy image |
| Drag inside the figure | Text selection, as always (axis labels stay selectable) |
| Ctrl+Alt+M with the figure selected | A figure comment; its card lines up with the figure's top edge. The outline stays as the comment's mark (comments on figures do not add a highlight) |
| Ctrl+Alt+M, nothing selected, pointer over a figure | A pin at that point, inside that figure |
| Alt+drag inside a figure | A sub-region of that figure, e.g. one bar or one panel |
| Alt+drag elsewhere | An area mark, as today |
| Esc, or click on empty page | Deselect |
| F4 rail → **Figures** tab | Every detected figure and table with label, thumbnail and page; Enter jumps to and selects it. This is the keyboard path, so no new global shortcut is needed |
| Ctrl+K "fig 3" | Jumps to and selects Figure 3 |
| Ctrl+C with a figure selected | Copies the figure as a PNG (rendered at 2×, local only) [U `ClipboardItem` with `image/png` in an extension page; widely supported] |

Cards for figure comments show a 64 px thumbnail of the figure (rendered on the fly) and the label "Figure 3 · p. 5". Sub-regions draw as a thin rectangle inside the figure; pins as a small numbered dot.

---

## 5. Anchoring that survives zoom, re-render and re-download

```ts
type FigureAnchor = {
  kind: "figure";
  page: number;                         // 0-based
  rect: [x0: number, y0: number, x1: number, y1: number]; // 0–1 of the crop box, unrotated page space, origin top-left
  figure: {
    label?: string;                     // "Figure 3"
    captionQuote?: TextQuoteAnchor;     // same shape as text marks: quote, 32-char prefix/suffix, char position
    imageSha256?: string;               // SHA-256 of FPDFImageObj_GetImageDataRaw of the largest image object
    dHash: string;                      // 64-bit perceptual hash of the region rendered at 9×8 grey
    detector: "tagged" | "objects" | "caption" | "manual" | "layout-model";
    detectorVersion: string;
  };
  sub?: { rect?: [number, number, number, number]; point?: [number, number] }; // 0–1 of the figure box
};
```

- Zoom, DPR and rotation never touch the stored numbers: everything is normalised in unrotated page space and transformed on display.
- **Re-anchoring on open** (same order of strictness as text marks):
  1. Stored page and rect, if any of these still match there: image hash, caption quote, or dHash within Hamming distance 10.
  2. The caption quote found elsewhere (normal text re-anchoring, score ≥ 0.8), then re-detect the figure for that caption.
  3. The image hash found on another page.
  4. Otherwise "Couldn't place". Never a guess.
- Stamped re-downloads (JSTOR) keep page geometry and image streams, so step 1 nearly always succeeds [U, spot-check two JSTOR files]. Manual area marks keep page + rect + dHash.

---

## 6. Claude vision facts (checked 2026-10-31)

| Fact | Value | Source |
|---|---|---|
| Which models see images | Every current model, including Haiku 5.5, Sonnet 5.5, Opus 5.5 and Fable 5.1, is in the vision feature's supported list | [V platform.claude.com/docs/en/build-with-claude/vision.md, `supportedModels`] |
| Resolution tiers | **High-resolution: "Claude 4.7 and later models": 2,576 px long edge, 4,784 visual tokens.** Standard: 1,568 px, 1,568 tokens. So Haiku 5.5, Sonnet 5.5 and Opus 5.5 are all high-resolution. No beta header | [V vision.md "Resolution and token cost"; confirm Haiku with `count_tokens` in Phase 4] |
| Token formula | `ceil(width/28) × ceil(height/28)` visual tokens; then padded to a multiple of 28 (padding is not billed content) | [V vision.md; V vision-coordinates.md] |
| Server resize | Largest aspect-preserving size that fits both the edge and token limits; for most images the token limit decides. Reference `resizedSize()` in TypeScript is in the docs | [V vision-coordinates.md] |
| Stop silent resizing | `transformations: { oversized_image: "error" }` on the image block returns a 400 naming the size that fits | [V vision-coordinates.md; V SDK 1.3.0 `ImageTransformationsParam`] |
| Images per request | 600 (100 on 200k-context models); above 20 images a stricter per-image limit applies (stay ≤ 3,000 px). 8,000 × 8,000 px max | [V vision.md "Request limits"] |
| Size per image | 10 MB base64 on the Claude API; 5 MB on Bedrock; 128 MB request | [V vision.md] |
| Formats | JPEG, PNG, GIF, WebP. Heavy JPEG compression "can make text difficult to read" | [V vision.md] |
| Placement | "Claude works best when images come before text" | [V vision.md] |
| Caching | `cache_control` is allowed on image blocks; images are part of the cached prefix | [V SDK `ImageBlockParam.cache_control`; V skill `prompt-caching.md:128`] |
| Citations | "Only text citations are currently supported. Image citations are not yet possible." PDF images cannot be cited. Citations must be on for all documents or none | [V citations.md] |
| Images inside a document block | A custom-content document's `content` may hold `TextBlockParam | ImageBlockParam` | [V SDK `ContentBlockSourceContent`] |
| Images in tool results | `tool_result.content` accepts image blocks | [V SDK `ToolResultBlockParam`] |
| Capability check | Models API returns `capabilities.image_input.supported` | [V SDK `models.d.ts:124`] |
| Opus 5.5 on charts | Reads charts and diagrams more accurately at every effort level; higher resolution helps most for technical drawings | [V claude-api skill, model-migration "Migrating to Claude Opus 5.5"] |
| Limits | No identifying people; may misread low-quality, rotated or < 200 px images; approximate counting and coordinates | [V vision.md "Limitations"] |
| Prices (per MTok, in / 5-min write / cache read / out) | Haiku 5.5 $0.10 / $0.125 / $0.01 / $0.50 (≤ 100k-token prompts); Sonnet 5.5 $2 / $2.50 / $0.10 / $10; Opus 5.5 $4 / $5 / $0.20 / $20 | [V platform.claude.com/docs/en/about-claude/pricing.md] |
| Cache minimum | 512 tokens on the 5.5 models | [V skill `prompt-caching.md:135`] |
| Haiku fallbacks | No server-side fallback on Haiku 5.5; handle `stop_reason: "refusal"` in the client | [V skill, Migrating to Claude Haiku 5.5] |

---

## 7. The exact payload for "@Claude on a figure"

### 7.1 Rendering the image (in the PDFium worker, locally)

1. **Region.** The figure box plus 4 pt padding, clipped to the page. For a sub-region or pin, still the whole figure (context), with the sub-region drawn as a 3 px magenta outline or the pin as a ring. If the sub-region is under 25% of the figure, add a second image: the sub-region alone, at up to 1,000 tokens.
2. **Scale.** `pxPerPt = clamp(18 / smallestFontPt, 150/72, 300/72)`, where `smallestFontPt` is the smallest text inside the region from `getPageTextRects` (ignore < 3 pt). No text inside → 200 DPI. For raster-only regions, never above the image's native pixels per point (no upsampling).
3. **Budget.** Lower the scale until `ceil(w/28) × ceil(h/28) ≤ budget` and the long edge ≤ 2,576. Budget: 1,600 tokens by default, 3,200 on "Think harder", 4,784 for scans and technical drawings. Check with the docs' `resizedSize()`; set `oversized_image: "error"` so drift fails loudly.
4. **Format.** PNG for rendered vector or mixed figures (sharp text, flat colour). JPEG quality 0.9 when photographic image objects cover over 60% of the region, or on scans. Keep each image under 3.75 MB raw (5 MB base64, Bedrock-safe).
5. **Orientation.** If the main text runs are rotated (landscape tables), rotate the crop so text is upright; EmbedPDF already computes run rotation [V `engine.ts` buildRunsFromGlyphs].
6. **Embedded original bytes** (`FPDFImageObj_GetImageDataRaw`): not sent to Claude in Release 1. Rendering handles masks, clips, vector overlays, CMYK, JPEG 2000 and JBIG2 (which the API does not accept) in one path. The raw bytes are used for the fingerprint and, later, "Save original image".

Examples on the high-resolution tier [V arithmetic with the documented formula]:

| Figure | Render | Visual tokens |
|---|---|---|
| One-column figure, 3.3 × 2.5 in | 1000 × 750 at 300 DPI | 972 |
| Two-column figure, 7 × 3.5 in | 1566 × 783 at 224 DPI (budget-capped) | 1,568 |
| Two-column tall figure, 7 × 5 in | 1314 × 938 at 188 DPI (budget-capped) | 1,598 |
| Display equation strip, 4 × 0.5 in | 1200 × 150 at 300 DPI | 258 |
| Whole Letter scan page | 1275 × 1650 at 150 DPI | 2,714 |
| Page thumbnail, long edge 728 | 563 × 728 | 546 |

### 7.2 The text pack

- **Caption:** full caption text with page.
- **Text inside the figure:** text runs inside the box from PDFium, in reading order, tagged by rough position (`[left, rotated]` = probably y-axis, `[below]` = x-axis, `[inside]` = labels/legend). This is exact, so Claude does not have to read 6 pt tick labels from pixels.
- **Mentions:** up to 3 paragraphs that cite the label, ≤ 200 tokens each, first mention and same-page mentions first.
- **Figure metadata** (not citable, in `context`): kind, label, page, render DPI, crop = whole figure / sub-region / pin, tagged alt text if any.
- **Document map** (shared by all threads, cached): title, abstract, headings, plus one line per detected figure ("Figure 3, p. 5: Event-study estimates…").
- **Retrieved passages:** the spec's local search, reduced to 3 for figure questions.

### 7.3 Request

```ts
const req: Anthropic.MessageCreateParams = {
  model,                                   // the user's choice, e.g. "claude-haiku-5-5"
  max_tokens: 8192,
  thinking: { type: "adaptive" },
  output_config: { effort: "medium" },     // Haiku 5.5 and Opus 5.5 default; set explicitly
  system: [{ type: "text", text: SYSTEM }],          // frozen; includes the figure rules below
  tools: [searchDocument, getPages, getFigure /*, web_search if on */],
  messages: [{
    role: "user",
    content: [
      { // 1. Document map: same bytes for every thread on this document
        type: "document", title: "Document map", citations: { enabled: true },
        source: { type: "content", content: [
          { type: "text", text: "Title: …" }, { type: "text", text: "Abstract: …" },
          { type: "text", text: "Headings: …" },
          { type: "text", text: "Figures and tables: Figure 1 (p. 2) …; Figure 3 (p. 5) …" } ] },
        cache_control: { type: "ephemeral" } },
      { // 2. The figure, before the text that describes it
        type: "image",
        source: { type: "base64", media_type: "image/png", data: cropBase64 },
        transformations: { oversized_image: "error" } },
      { // 3. Figure text pack: one block per piece so each citation maps to a page
        type: "document", title: "Figure 3 (page 5)", citations: { enabled: true },
        context: JSON.stringify({ kind: "vector chart", page: 5, renderDpi: 224, crop: "whole figure", userMark: null }),
        source: { type: "content", content: [
          { type: "text", text: "[p. 5] Figure 3: Event-study estimates of the effect on log wages…" },
          { type: "text", text: "[p. 5] Text inside the figure (exact, from the PDF): [below] Years relative to treatment, -4 -3 -2 -1 0 1 2 3 4; [left, rotated] Effect on log wages; [inside] Treated, Control" },
          { type: "text", text: "[p. 4] …as Figure 3 shows, pre-trends are flat…" },
          { type: "text", text: "[p. 7] …the dip in Figure 3(b)…" } ] } },
      { // 4. Retrieved passages, as for text questions
        type: "document", title: "Relevant passages", citations: { enabled: true },
        source: { type: "content", content: passages } },
      { // 5. The question
        type: "text",
        text: "The user is asking about Figure 3 on page 5 (the image above). Question: why does the line dip at year −1?",
        cache_control: { type: "ephemeral" } },
    ],
  }],
};
```

**System prompt figure rules** (added to the frozen prompt, so caching holds): describe only what is visible; when text inside the figure is given, trust it over what you read from pixels; give values read from a chart as approximate; cite the caption and mentions; if something is too small to read, say so (the user can press Think harder for a sharper image); never name people in photos.

**Citations.** Each `content_block_location` maps back to a block, and each block knows its page and character range, so "p. 4" links work as for text. Claude cannot cite the image; the viewer adds a "Fig. 3 · p. 5" chip on every answer in a figure thread.

### 7.4 Variations

| Case | What changes |
|---|---|
| **Follow-up in the thread** | Append only. The image stays in turn 1 (editing history breaks the cache and, on the 5.5 models, invalidates thinking blocks [V skill]). Cost drops to the cache-read price. |
| **Think harder** (Opus 5.5) | Same payload with the image budget raised to 3,200 tokens. New model = new cache [V skill: caches are model-scoped]. |
| **"Compare Figure 2 and 3"** | Labels found in the question are attached up front: image + text pack per figure, up to 4 figures, budget 1,200 tokens each. Others on demand through `get_figure({label})`, which returns an image plus its text pack as a tool result [V images allowed in `tool_result`]. Keep the whole request at ≤ 20 images. |
| **Sub-region or pin** | Whole-figure image with the mark drawn on it, plus an enlarged crop if the mark is small; the text says "the user's marked region is outlined in magenta". |
| **Area mark outside any figure** | The area crop plus the text inside and around it (the paragraph before and after). |
| **Scanned page (Release 1)** | No text exists. Send the area crop (budget 4,784) and, if the area is under half the page, a page image at long edge 1,092 (~1,209 tokens) for context. No citable documents except the document map, if any. Release 3 adds the recognised text of the area. |
| **Equation image** | Same payload; the system prompt asks for LaTeX, which the note box already renders (`$…$`). |
| **Low-resolution full page for context** | Not by default. Added (long edge 728, ~546 tokens) only when no caption and no mention was found, or the question talks about position ("left panel", "next to"). |
| **Model cannot see images** | None today [V]. At setup, read `capabilities.image_input.supported` [V]; if false, send the text pack only and add a line to the answer: "This model can't see images; answered from the caption and text." |
| **PDF not in the library** | The spec's confirm step says "Send this figure image and 3 passages to Anthropic?" |

---

## 8. Cost per figure question

Assumptions [U, to confirm with `count_tokens` and real `usage` in Phase 4]: system 700, document map 900, figure text pack 800, 3 passages 900, question 100, citations overhead 200 tokens; first turn written to the 5-minute cache. Output = 350-token answer plus thinking at effort medium: 400 (Haiku), 600 (Sonnet), 800 (Opus). Prices from §6 [V]. Script: `/tmp/claude-0/-home-user-sickofpdfs/24aa939a-b5a9-56a1-a55e-601726feabba/scratchpad/calc/cost.py`.

| Case | Input tokens | Haiku 5.5 | Sonnet 5.5 | Opus 5.5 |
|---|---|---|---|---|
| One figure, default image (1,600 visual tokens) | 5,200 | **$0.0010** | $0.023 | **$0.049** |
| One figure, maximum image (4,784) | 8,384 | $0.0014 | $0.031 | $0.065 |
| One figure + page thumbnail | 5,746 | $0.0011 | $0.024 | $0.052 |
| Compare two figures (2 × 1,200) | 6,800 | $0.0012 | $0.027 | $0.057 |
| Area on a scanned page (2,714, no text pack) | 5,514 | $0.0011 | $0.023 | $0.051 |
| Follow-up in the same thread (prefix cached) | 5,800 | $0.0005 | $0.012 | $0.027 |

- The image alone costs about **$0.0002 on Haiku** and **$0.006–0.008 on Opus** at the default budget. Output and thinking dominate on Opus.
- "Explain this figure" costs the same as a one-figure question.
- Describing all 10 figures of a paper on Haiku: about $0.003 [U arithmetic].
- The spec's "about 3 to 4 cents" for Think harder becomes about 5 cents on a figure. The $0.25 estimate prompt is never reached by one figure.

---

## 9. Extra value, by release

| Feature | Value | Cost | Release |
|---|---|---|---|
| **Explain this figure** (toolbar button) | The most common figure question in one click; sends §7 with a fixed prompt: what it shows, how to read it, the main takeaway, with citations | ~0.1 ¢ on Haiku | **1** |
| **Copy image** / Ctrl+C on a selected figure | Paste charts into notes and slides | Local | **1** |
| **Figures tab** in the F4 rail | Browse and jump to figures; also the keyboard path | Local (caption detection) | **1** |
| **Figures searchable by caption** | Ctrl+K "parallel trends figure" finds the figure with its thumbnail; captions and tagged alt text are already local text | Local | **1** |
| **Claude's figure descriptions are searchable** | The spec already indexes Claude's replies; link an Explain reply to its figure so search can show the thumbnail | Free (only figures you asked about) | **1** |
| "Fig. 3" in body text links to the figure, with a hover preview | AI2's finding: better comprehension, no extra time | Local | 1.x |
| Figure comments in the library Notes page with a 240 px thumbnail | Notes look like what they are about. Thumbnail stored locally with the note, saved PDFs only | Local | 1 or 2 |
| **Describe all figures in this paper** (explicit button, cost shown first) | Every figure becomes searchable by what it shows | ~0.3 ¢ per paper on Haiku | 2 |
| **Extract data** from a chart into a Markdown table | Useful but must be labelled "approximate, read from the image". A separate request without citations (citations and structured output cannot be combined [V]). Opus 5.5 recommended | ~5 ¢ | Later |
| Exact data from vector charts (read bar and point coordinates from PDFium paths, map with tick labels) | Exact for matplotlib-style PDFs; hard in general (legends, log axes, series colours) | Local | Research spike only |
| Figures in "Export notes" Markdown | Label, caption and page link in Release 1; image files beside the Markdown later | Local | 1 / later |

Never automatic: no figure leaves the computer for alt text or search unless you press a button.

---

## 10. Privacy and MV3

- Crops are rendered in the PDFium worker inside the viewer tab. No remote model, no remote code.
- Figure images go to Anthropic only inside an @Claude, Explain or Describe request you started, as base64 in that request. **No Files API**: it stores files until deleted and is not ZDR-eligible [V `docs/research/03-platform-claude.md:234`].
- On a PDF not in the library, the confirm step names the image.
- Thumbnails of commented figures are stored locally only for saved PDFs; unsaved PDFs leave no trace, as the spec requires.
- If a layout model is added: bundle the `.onnx` and onnxruntime-web `.wasm` files; override `@embedpdf/ai`'s default Hugging Face URL [V `model-registry.ts:4-8`]. The existing build test ("a build test fails on any other request") catches mistakes.
- The end-to-end network test should also assert that image bytes appear only in `api.anthropic.com` requests that follow an @Claude action.

---

## 11. EmbedPDF API gaps and the patch

| # | Gap | Evidence | Fix |
|---|---|---|---|
| 1 | No public "list page objects" in v2 or v3 | v2: `readPdfPageObject` is private and reached only from annotation objects [V `engine.ts:8265, 8454`]. v3: no objects feature among `features/*` [V directory listing] | Add `getPageObjects(doc, page, {recurseForms: true, maxObjects})` → `{type, bounds, formDepth, markedContentId, image?: {pixelW, pixelH, filters, colorspace}, path?: {segments, filled, stroked}}[]` |
| 2 | v2's image reader is wrong and slow: handles only `Bitmap_BGR`, writes alpha 100 instead of 255, copies one byte per `getValue` call | [V `engine.ts:8351-8378`] | New `getImageObjectData(doc, page, objectPath, "raw" | "rendered")` using `GetImageDataRaw` / `GetRenderedBitmap` and a `HEAPU8.slice` copy |
| 3 | Struct tree exported but unwrapped | [V functions.ts; 0 uses in engine.ts] | Add `getPageStructFigures(doc, page)` → `{type, alt, actualText, mcids}[]` |
| 4 | Our methods cannot run inside the stock worker: its body is a string injected at build time; `RemoteExecutor.send` is private with a fixed method union; `PdfiumNativeRunner` is not exported from the package entries | [V `web/worker-engine.ts:12, 77-78`; V `remote-executor.ts:124, 190`; V `pdfium/index.ts`, `lib/index.ts`] | We already need our own worker file for MV3 (`docs/research/01-pdf-engine.md` gotcha 4). In it, subclass `PdfiumNative` (exported) with the three methods. The runner dispatches any method by name (`this.native[method](...args)`) [V `pdfium-native-runner.ts:175-195`]. patch-package exports `PdfiumNativeRunner` and makes `send` callable for our method names |
| 5 | `@embedpdf/ai` fetches PP-DocLayoutV3 from huggingface.co by default; version 0.0.1, v2 branch only | [V `model-registry.ts`; V npm] | Do not depend on it in Release 1. In Release 3, either pass a bundled model URL or run our own pipeline |
| 6 | v3 migration | v3 has region rendering and text readers but none of 1–3 | Keep `figures(page)`, `renderRegion()`, `regionText()` behind the `PdfBackend` adapter; re-implement in v3 if Phase 0 picks it |

No wasm rebuild is needed: every PDFium function used here is already exported in both versions [V].

---

## 12. Proposed spec changes (plain wording)

| Section | Change | Proposed wording |
|---|---|---|
| Summary, Release 1 criterion 2 | Add figures | "Clicking a figure selects it, and Ctrl+Alt+M comments on it." |
| Summary, Release 1 criterion 5 | Add figures | "Asking about a figure sends the figure image with its caption and the text that mentions it." |
| Requirements table | New row | "Comment on figures and ask Claude about them" → "Figures are found automatically and outlined on hover. Click one to comment or ask Claude. Claude sees the figure image, its caption and the text that cites it." |
| How it feels to use | New moment 10 | "**You click a chart.** It outlines, and a toolbar offers Comment, Ask Claude, Explain and Copy image. You type '@Claude what does the dip at year −1 mean?' Claude answers with links to the caption and the paragraph that discusses it." |
| Tech stack | New row | "Figure detection: PDFium page objects and caption rules in Release 1; PP-DocLayout-S on onnxruntime-web in Release 3, bundled." |
| Tech stack, Claude row | Fix contradiction | "default model claude-opus-5-5" conflicts with "Recommended: Claude Haiku 5.5". Say: "default model chosen at setup; Haiku 5.5 suggested, Opus 5.5 for Think harder." |
| Marks, "Area marks" bullet | Replace | "**Figure marks:** figures, tables and equation images are found on each page. Hovering outlines a figure; a click selects it; Ctrl+Alt+M comments on it. Alt+drag draws any rectangle, including part of a figure or an area of a scan. With nothing selected, Ctrl+Alt+M over a figure drops a pin inside it. A figure comment shows an outline, not a highlight." |
| What a note is made of | Extend the area anchor | "An area anchor holds the page and a rectangle in page units from 0 to 1. A figure anchor adds a fingerprint: the caption label and quote, a hash of the embedded image and a hash of how the region looks. Pins and sub-areas are stored relative to the figure." |
| Re-anchoring on open | Add | "A figure comment stays where it is if its fingerprint still matches there. Otherwise it follows its caption, then its image. Anything else goes to 'Couldn't place'." |
| Shortcuts | Add rows | "Select figure — click — Reading"; "Copy figure as image — Ctrl+C — Figure selected". |
| Reading basics, Navigate | Add | "A Figures tab in the thumbnails rail lists every figure and table." |
| Claude integration, bullet "On an area mark…" | Replace | "**Figures.** On a figure, area or scan, Claude gets the region as an image rendered on your computer, sized to keep small text legible (usually 1,000 to 1,600 image tokens). It also gets the caption, the exact text inside the figure, up to three paragraphs that mention it, and the document map with a list of figures. 'Compare Figure 2 and 3' attaches both. Claude cannot cite an image, so the answer carries a link to the figure." |
| Claude integration, Model and cost | Add | "A figure question costs about 0.1 cent on Haiku 5.5 and about 5 cents on Opus 5.5." |
| Claude integration | Add | "**Explain this figure** in the toolbar asks a fixed question about the selected figure." |
| What leaves your computer | Edit first Anthropic row | "Passages and figure images you ask Claude about (the whole text only if you ask)". |
| Library, one search box | Add | "Figure captions, and Claude's explanations of figures, are searchable; results show the figure's thumbnail." |
| Scanned PDFs | Add to Release 3 sentence | "Layout detection runs first, so figures on scans can be clicked too." |
| Speed budgets | Add | "Figure detection runs after a page is drawn and never delays it. The outline appears within 100 ms of hovering." |
| Phase 0 | Add to the list | "listing PDFium page objects and finding figures within 20 ms a page." |
| Phase 2 | Edit | "Toolbar, all marks, area notes, figure detection and figure comments, threads, re-anchoring". |
| Phase 4 | Edit | "Claude in threads, including figures and Explain this figure". |
| Risks | Add rows | See §13 (wrong outlines; slow detection; cost on Opus; misread chart values). |

---

## 13. Risks

| Risk | Effect | Handling |
|---|---|---|
| Wrong figure boxes | Outlines on headers or text; clicks select the wrong thing | Outline only high-confidence figures; precision gate on a labelled set; Alt+drag always works |
| Slow or huge vector pages | Worker busy, scrolling stutters | Idle priority, 20,000-object / 15 ms cap, caption-only fallback, cache per page |
| Click-to-select conflicts with text selection | Can't select an axis label | Click without movement selects the figure; any drag selects text |
| Chart values misread | Wrong numbers in an answer | Send the exact in-figure text; prompt says values are approximate; Think harder sends a sharper image |
| Cost surprises on Opus | Each figure question ~5 ¢ | Haiku default; budget caps; the spec's estimate prompt and monthly cap |
| Thinking-token usage unknown | Cost table off by up to 2× | Measure `usage` in Phase 4 and update the Settings estimate [U] |
| EmbedPDF v2 → v3 churn | Patch redone | All figure calls behind the adapter; no wasm rebuild either way |
| Detection drift between versions | Stored boxes move | Anchors keep caption, hashes and detector version; re-detect, never guess |
| Sensitive images (photos of people, medical scans) | Data sent, or refusals | Only on request; Claude won't identify people [V]; refusals shown plainly (no fallback on Haiku [V]) |
| Captions in unusual styles or languages | Figures missed | Pattern covers common English, German, French and Spanish forms; the Release 3 model fills gaps |
| Rotated pages and landscape tables | Sideways crops | Normalise in unrotated space; rotate the crop so text is upright |
| Licence slip with layout models | AGPL code in the bundle | Allow-list: PaddleOCR/PP-DocLayout (Apache-2.0) only; DocLayout-YOLO, Ultralytics and Surya/Marker weights blocked |

---

## 14. Sources

- Claude docs: [Vision](https://platform.claude.com/docs/en/build-with-claude/vision), [Coordinates and resizing](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates), [Citations](https://platform.claude.com/docs/en/build-with-claude/citations), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing); claude-api skill (cached 2026-10-06): `shared/prompt-caching.md`, `shared/model-migration.md`, `shared/models.md`.
- `@anthropic-ai/sdk` 1.3.0 type definitions (npm tarball): `resources/messages/messages.d.ts`, `resources/models.d.ts`.
- EmbedPDF v2 and v3 clones (paths in §3.1 and §11); pdf.js main; Zotero reader (AGPL, ideas only).
- [Google Drive: comment on PDFs and images](https://support.google.com/drive/answer/7650301); [Readwise Reader August 2023 update](https://readwise.io/reader/update-august2023); [Zotero forum on Select Area images](https://forums.zotero.org/discussion/comment/449216); [Acrobat commenting help](https://helpx.adobe.com/acrobat/using/commenting-pdfs.html); [Figma forum on pinned comments](https://forum.figma.com/t/comments-pinned-to-a-frame-should-follow-when-frame-moved-to-another-page/12423/5).
- [Connecting the Dots (arXiv 2602.16895)](https://arxiv.org/abs/2602.16895); [Semantic Reader Project (arXiv 2303.14334)](https://www.arxiv.org/pdf/2303.14334); [pdffigures2](https://index.scala-lang.org/allenai/pdffigures2) (Apache-2.0).
- [PaddleOCR layout detection models](https://www.paddleocr.ai/latest/en/version3.x/module_usage/layout_detection.html); Hugging Face model cards and API: PaddlePaddle/PP-DocLayout-S, -M, PicoDet-S_layout_3cls, PP-DocLayoutV2, PP-DocLayoutV3; [docling-layout-heron](https://huggingface.co/docling-project/docling-layout-heron); DocLayout-YOLO, Ultralytics, Surya, Marker and PaddleOCR LICENSE files on GitHub.
- [Chrome manifest: cross_origin_embedder_policy](https://developer.chrome.com/docs/extensions/reference/manifest/cross-origin-embedder-policy).
