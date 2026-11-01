# Phase 8 · spike 8.0: writing notes back into a PDF

Date: 1 Nov 2026. Code: `spikes/phase8-writeback/` (its own package, outside the workspace, like `spikes/phase0`). Output files: `test-assets/export-samples/` (gitignored). Plan: `docs/superpowers/plans/2026-11-01-phase7-8-scans-export.md`, slice 8.0. Contract: §9. Export and import rectangles are `PdfUserRect` (PDF user space, y up), never the engine's `PdfRect`.

## In plain words

- Our PDF engine can write highlights, underlines, strikethroughs, bold, areas, comments and replies into a **copy** of a PDF.
- The copy is the original file plus a short tail. The original bytes are never changed. We checked this on every file, by bytes and by SHA-256.
- PDFium gets two things wrong when it saves this way, and we fix both (see "Two PDFium faults").
- Seven readers read the copies and agree with what we meant: our own PDFium, pdf.js, poppler, MuPDF, stock PDFium (pypdfium2), pypdf and qpdf.
- We cannot run Foxit or Acrobat here. The three sample files for your hand check are in `test-assets/export-samples/`, and the steps are in `docs/checklists/release3-foxit-acrobat.md`.

## Decision

```
EXPORT_SAVE      = tail-only             (FPDF_SaveAsCopy with FPDF_INCREMENTAL; a JS WriteBlock drops the original's bytes)
                   + fixXrefStreamTail   (repairs PDFium's xref stream; see "Two PDFium faults")
                   + a FRESH handle per export, made only for the pages that get notes
                   + FPDF_LoadCustomDocument over the Blob for files over 64 MB (memory: 183 MB instead of 482 MB RSS on 170 MB)
REPLIES_DEFAULT  = threaded, replies drawn empty (sample A) until the hand check W-F1 (decision D8.1)
                   planPdfExport's replyAppearance defaults to 'empty' (contracts §9); 'hidden' (replies hidden by /F) is sample B
POPUP            = one closed /Popup on every text, area and figure root; none on pins, page notes, the document note or replies
QUADS            = Acrobat's order: top-left, top-right, bottom-left, bottom-right, as the page is displayed
SIGNED           = warn: a signed file is saved the same way, but its signature shows as changed (see "What the files do")
BOLD             = /Square, /Border [0 0 0], /Subj (Bold), appearance = glyph outlines (fill and 0.03 em stroke in the text's own colour)
```

## What was built

| File | What it is |
| --- | --- |
| `src/engine.ts` | Loads the product's `SopPdfiumNative` (`packages/viewer/src/backend/embedpdf/sop-native.ts`) in Node on the shipped `pdfium.wasm`. |
| `src/writeback.ts` | The recipes: create annotations through PDFium's own exports, then save. `saveWith` is the tail-only save. |
| `src/tail.ts` | `fixXrefStreamTail`. |
| `src/readback.ts` | `readAnnotations` (the contract's `PdfAnnotation`), through PDFium. |
| `src/plan-writer.ts` | A `PdfAnnotationPlan` (slice 8.1) to the writer's calls. |
| `src/geometry.ts`, `src/svgpath.ts` | Crop box, rotation, glyph outline path data to content stream. |
| `check/check_file.py` | The checker: bytes, qpdf, our PDFium, pypdf, pdf.js, the rules, and pixels from poppler, MuPDF and stock PDFium. |
| `check/verify_matrix.py`, `scripts/write-matrix.ts` | The save matrix (linearized, encrypted, signed, existing annotations, rotated, forms). |
| `scripts/measure-save.ts` | Time and memory of the save paths. |
| `scripts/make-hand-samples.ts` | The three owner samples, made by `planPdfExport`. |
| `scripts/roundtrip.ts` | Slice 8.1's proof: model, PDF, model. A throwaway driver; the controller may delete it. |

Run: `pnpm -C spikes/phase8-writeback samples` (needs `pnpm install --ignore-workspace` there once). Node 22 runs the repo's TypeScript directly through `loader/register.mjs`. Checker needs `pypdf`, `pypdfium2`, `numpy`, `pillow`, `qpdf`, `mutool` and poppler.

## Recipes (the call order that gave a conformant file)

Every export opens its own handle on the original bytes (`FPDF_LoadMemDocument`, or `FPDF_LoadCustomDocument`). It loads only the pages that get notes. Nothing is read from it first (see "Tail size").

```
page = FPDF_LoadPage(doc, i)
a    = EPDFPage_CreateAnnot(page, subtype)         1 Text, 5 Square, 9 Highlight, 10 Underline, 12 StrikeOut, 16 Popup
FPDFAnnot_SetStringValue(a, 'NM' | 'T' | 'Contents' | 'Subj' | 'M' | 'CreationDate', utf16)
FPDFAnnot_SetRect(a, FS_RECTF)                      memory order is LEFT, TOP, RIGHT, BOTTOM (top is the larger y)
FPDFAnnot_SetFlags(a, flags)
EPDFAnnot_SetColor(a, 0, r, g, b)                   /C. (FPDFAnnot_SetColor also writes /CA from its alpha.)
FPDFAnnot_AppendAttachmentPoints(a, 8 floats)       /QuadPoints, one call per quad, in Acrobat's order
EPDFAnnot_SetLinkedAnnot(a, 'IRT', root)            a reply: the root must already exist
EPDFAnnot_SetReplyType(a, 1)                        1 = /R, 2 = /Group
EPDFAnnot_SetLinkedAnnot(root, 'Popup', popup)      and
EPDFAnnot_SetLinkedAnnot(popup, 'Parent', root)
EPDFAnnot_SetName(a, 0 | 2)                         /Name /Comment | /Note
<appearance, below>
FPDFPage_GenerateContent(page); FPDFPage_CloseAnnot(a); FPDF_ClosePage(page)
FPDF_SaveAsCopy(doc, FPDF_FILEWRITE{ version 1, WriteBlock }, FPDF_INCREMENTAL)
```

`WriteBlock` is a JS function made with `addFunction(fn, 'iiii')`; the struct is two 32-bit words in the wasm heap.

| Kind | Appearance |
| --- | --- |
| Highlight | `EPDFAnnot_GenerateAppearanceWithBlend(a, 1)`: a form XObject, `/BBox` = `/Rect`, `/ExtGState /BM /Multiply`. |
| Underline, StrikeOut | `EPDFAnnot_GenerateAppearance(a)`. |
| Dotted underline (thread, no highlight) | `FPDFAnnot_SetAP(a, 0, stream)`: `[1.2 1.8] 0 d`, `1 w`, `x y m  x y l  S` along each quad's bottom, in the thread colour. |
| Bold | `FPDFAnnot_SetBorder(a, 0, 0, 0)`, then `FPDFAnnot_SetAP` with each glyph outline as `rg RG w  m l c h  B` (fill and stroke in the glyph's own colour, stroke 0.03 em). |
| Area, figure outline | `EPDFAnnot_SetColor(a, 0, rgb)`, `EPDFAnnot_SetBorderStyle(a, 1, 1.5)` (solid), no `/IC`, then `EPDFAnnot_GenerateAppearance`. |
| Note (pin, page, document) | `EPDFAnnot_SetName`, `/C`, `EPDFAnnot_GenerateAppearance`: PDFium's note icon. |
| Reply | `FPDFAnnot_SetAP(a, 0, "q Q")`: an empty appearance. Flags 28 (sample A) or 2 (sample B). |
| Popup | None. A pop-up has no appearance (ISO 32000-1 12.5.6.14). Flags 0. |

Two dead ends:

- `FPDFAnnot_AppendObject` (draw page objects into the appearance) returns false on a Square or an Underline. PDFium only supports it for Ink and Stamp. Use `FPDFAnnot_SetAP` with a content stream.
- `FPDFAnnot_SetAP` makes the stream's `/BBox` equal to `/Rect` and gives it no `/Resources`. So a content stream can only use operators that need no resource: colours, line width, dash, paths. (Transparency and blend need a resource, which is why the highlight uses PDFium's own generator.)

## Save and read-back

- **Tail only.** PDFium copies the original in 32 KB chunks, then writes the new objects. `WriteBlock` counts bytes and drops the first `originalLength`. The Blob is `[original, tail]`. The tail ended up at 1.4 to 175 KB on every file we tried.
- **Read back.** `FPDFAnnot_GetColor` returns false for a markup annotation that has an appearance, so use `EPDFAnnot_GetColor`. `EPDFAnnot_GetObjectNumber` gives the object number; `FPDFAnnot_GetLinkedAnnot(a, 'IRT' | 'Popup')` gives the links; `FPDFAnnot_GetAttachmentPoints` the quads.

## Two PDFium faults, and what to do

1. **A file with a cross-reference stream (every Word, LaTeX 1.5+ or Chrome-saved PDF) gets a broken one in the tail.** PDFium writes the new xref object without `/Type /XRef` and without `endobj`. qpdf says "xref not found, file is damaged" and rebuilds the table. Acrobat would very likely offer to repair the file. `fixXrefStreamTail` (`src/tail.ts`) adds the two missing pieces inside the tail. Nothing before the xref object moves, so every offset PDFium wrote stays right, including `startxref`. After the repair, qpdf has no complaint except a harmless one: `/Size` counts the xref object, which has no entry for itself. A file with a classic xref table is written correctly and the fix does nothing.
2. **An incremental save rewrites every object the handle has loaded**, not only the ones we changed. Opening a document through the engine loads every page (for its size), so the tail was as big as the file (564 KB of tail on a 600 KB file). A fresh handle that loads only the annotated pages gives 49 KB for the 1 MB paper and 173 KB for the 170 MB scan. Rule for 8.2: never read other pages on the write handle. Count annotations or read text on a different handle.

## What the files do

Every row is the same note set (a highlight, its popup and a reply) written into the input, tail only, on a fresh handle. "Clean" means qpdf finds nothing new.

| Input | Result |
| --- | --- |
| NBER paper, 50 pages, xref stream, 504 existing link annotations | Clean. All 504 kept. 49.5 KB tail. |
| Same, linearized | Clean, but no longer linearized (the update goes after the end; "fast web view" is off). Harmless. |
| Same, with existing notes made by MuPDF (no `/NM`) | Clean. All kept. |
| `wt-password.v1.pdf`, encrypted | Clean. Same encryption dictionary. Opens with the same password, a wrong one is refused. The new text is encrypted in the tail. |
| Classic xref (`objects.pdf`, `tagged.pdf`) | Clean. No repair needed. |
| Page with `/Rotate 90`, and crop boxes with an offset, `/Rotate` 0, 90, 180, 270 | Highlight and bold land on the words (checked against poppler's own word boxes, within 2 pt). Import maps back to the same chars. |
| Signed, three kinds (approval, certified with form-fill only, certified with annotations allowed), made with pyHanko | The signature stays intact: the signed bytes are untouched. But pyHanko's check of the update (a software stand-in for Acrobat's rules) says `ILLEGAL_MODIFICATIONS` for all three, even the one that allows annotations. The cause is fault 2: PDFium rewrites existing objects, so "objects of revision 1 were replaced without justification". **Warn** before saving a signed file. A writer that emits only the new annotation objects and the changed page dictionary could keep a certified signature valid; it is not needed for Release 3. |
| 170 MB, 600-page scan | Tail 173 KB. See the table below. |

Existing annotations stay as they are: we only add to the page's `/Annots`.

**Hidden flag (plan question 3).** Setting `/F` Hidden on the OPEN handle makes the annotation vanish from a render of that handle. After hiding all 16 of ours, the page matched the unannotated original exactly (0 pixels different). The saved copy comes from another handle, so the flag never reaches a file (checked: 0 of 16 hidden in a fresh handle on the same bytes).

## Save paths: time and memory (Node 22, one mode per process)

| File | Mode | Time | Peak RSS | Wasm heap | Output kept |
| --- | --- | --- | --- | --- | --- |
| scan-600, 169.8 MB | full rewrite | 1076 ms | 819 MB | 356 MB | 170 MB |
| | incremental, whole file collected | 678 ms | 646 MB | 206 MB | 170 MB |
| | **tail only** | **358 ms** | 482 MB | 206 MB | **173 KB** |
| | **tail only, FPDF_LoadCustomDocument** | **347 ms** | **183 MB** | **18 MB** | 173 KB |
| scan-120, 35 MB | full / incremental / tail / tail + custom | 534 / 518 / 268 / 163 ms | 280 / 283 / 213 / 162 MB | 76 / 44 / 44 / 18 MB | tail 169 KB |
| paper-50, 1 MB | full / incremental / tail / tail + custom | 844 / 360 / 427 / 288 ms | 145 to 150 MB | 18 MB | tail 49 KB |

`FPDF_LoadCustomDocument` pulls the file in 4 KB blocks through a callback (43,492 reads for the 170 MB file; in Node the callback reads the disk). In the extension the callback must be synchronous, so it would use `FileReaderSync` on the Blob inside the engine worker. **Not measured:** the time of 43k `FileReaderSync` reads in a real worker. Slice 8.2 measures it; if it is slow, read bigger blocks and cache them.

The password file saved in 252 ms. `scan-600.pdf` is the Phase 0 fixture; the wasm heap limit is 2 GiB, so a copy held in memory is fine up to the 1 GiB limit the product already has.

## Rules (each with its source and its status)

Status: **checked** = checked here with the readers that run; **standard** = from the standard, followed, not seen in Foxit or Acrobat; **hand** = needs the W-F1 hand check.

| # | Rule | Source | Status |
| --- | --- | --- | --- |
| R1 | `/NM` is a text string that names the annotation uniquely among those on its page. We write `sop:<row id>`; a mark on a later page gets `sop:<id>~<page>`. | ISO 32000-1 Table 164 | checked (unique per page, every file) |
| R2 | `/Rect` is required, in default user space (y up, origin at the page's lower left, `/Rotate` not applied). | Table 164 | checked, with crop boxes that do not start at 0 and all four rotations |
| R3 | `/QuadPoints`: 8 × n numbers, one quad per line. The standard's text says counterclockwise. **Acrobat writes and reads top-left, top-right, bottom-left, bottom-right (a Z), and the standard's order can draw wrongly in Acrobat.** iText recommends the Z order after testing Acrobat 10, 11 and Reader 11. Seen in a PDFium highlight: it draws the right box from the Z order. For a rotated page we write the Z as the page is displayed (`quadPoints` in `pdf-mapping.ts`). | ISO Table 179 and Figure 64; iText `PdfTextMarkupAnnotation` documentation | checked in PDFium, pdf.js, poppler and MuPDF (all draw from the AP, so they do not test the order on a rotated page). **hand** for Acrobat and Foxit, and a rotated page |
| R4 | `/AP /N` is a form XObject. The viewer maps its `/BBox` (through `/Matrix`) onto `/Rect`. We keep `/BBox` equal to `/Rect` and no `/Matrix`, so the map is the identity. | ISO 12.5.5, Algorithm: Appearance streams | checked (every annotation, `rules` group) |
| R5 | A highlight must be drawn with `/BM /Multiply`, or its colour would cover the text. The implicit blend mode of an annotation is Normal. | ISO Table 170 (CA); 11.3.5 | checked (text stays dark in three renderers) |
| R6 | `/M` and `/CreationDate` are PDF dates: `D:YYYYMMDDHHmmSSOHH'mm`. A reader must accept any text in `/M`. We write `D:YYYYMMDDHHmmSSZ` (UTC), one-second resolution. | ISO 7.9.4; Table 164, Table 170 | checked (parsed by PDFium, pdf.js, pypdf) |
| R7 | `/C` is 0, 1, 3 or 4 numbers from 0 to 1. It colours the icon background, the popup's title bar, and, for a text markup, the mark. We write three (RGB). `/CA` is not written (1.0). | Table 164 | checked |
| R8 | A reply has `/IRT` (the annotation it answers, **on the same page**) and `/RT /R`. "A reader shall not display replies individually but together in the form of threaded comments." `/RT /Group` is something else: an annotation grouped with another. We write replies to the root only (our model has no nested replies). | ISO Table 170 and the text after it | checked (PDFium, pypdf, pdf.js read `inReplyTo` and `replyType`). **hand** for how Foxit and Acrobat show them |
| R9 | A `/Popup` has `/Parent` (an indirect reference) and `/Open` (default false). It has no appearance and no actions. The parent's `/Contents`, `/M`, `/C` and `/T` override the popup's. The parent points back with `/Popup`. | ISO 12.5.6.14, Table 183; Table 170 | checked (both links, in PDFium, pypdf, pdf.js). **hand** for Foxit and Acrobat |
| R10 | `/F`: Print (4) is needed to print. A Text note behaves as if NoZoom (8) and NoRotate (16) are set, so a note gets 28 (Print + 8 + 16). Hidden (2) means "do not display or print or allow interaction". We write 4 for marks, 28 for notes, 0 for popups, and 28 (sample A) or 2 (sample B) for replies. | ISO Table 165, 12.5.6.4 | checked (flags read back; replies draw nothing in all three renderers). **hand**: which reply flag Foxit and Acrobat list |
| R11 | `/T` is the author, shown in the popup's title bar. `/Subj` is a short description. We write the owner's name or "Claude", and `/Subj` `Bold`, `Document note`, `Page note` or `Comment` (the last tells import that the root is a thread's own, not a mark). | Table 170 | checked |
| R12 | `/Contents` is a text string; non-ASCII is stored as UTF-16BE with a byte order mark. PDFium does this itself. | ISO 7.9.2 | checked (Polish, Cyrillic, Chinese, Japanese in PDFium, pypdf and pdf.js) |
| R13 | `/P` (the page) is optional. PDFium does not write it, and many other writers do. | Table 164 | not written. **hand**: Foxit and Acrobat must open the notes without it |
| R14 | An incremental update is appended after the old `%%EOF` with a `/Prev` that points at the old xref. | ISO 7.5.6 | checked (qpdf, MuPDF, pdf.js, poppler, PDFium all open it) |
| R15 | A cross-reference stream dictionary needs `/Type /XRef`, `/Size`, `/W`, and the object must be closed with `endobj`. | ISO 7.5.8.2, Table 17 | PDFium breaks two of these; fixed in the tail (checked) |
| R16 | An encrypted file stays encrypted: the update repeats `/Encrypt`, and the new strings are encrypted with the same handler. | ISO 7.6 | checked (qpdf `--show-encryption` unchanged; text not in the clear in the tail) |
| R17 | A signature covers the bytes of its `/ByteRange`. A later update must leave them alone; a certified file also limits what the update may change (DocMDP). | ISO 12.8 | bytes checked; the change check says illegal (see "What the files do") |
| R18 | Foxit shows replies inside the original's pop-up note, listed under it, and lets a person reply to a reply; the Comments panel lists them. Foxit's pages do not say how this is stored in the file. Its SDK exposes a markup's replies and popup (`getReplies`, `getPopup`), which matches `/IRT` + `/RT` and `/Popup`. | Foxit PDF Editor user guide, "Reply to comments", "About pop-up notes"; Foxit PDF SDK for Web, class `Markup` | hand |
| R19 | A sub-thread of "state" annotations (`/State`, `/StateModel`: Marked, Review) is another use of `/IRT`. We do not write it. Import must not read a state note as a comment. | ISO 12.5.6.3, Table 171 | standard (import skips replies with no text) |
| R20 | A reader's SDK may take the reply text from the reply's own popup, not from its `/Contents`. A developer who gave replies their own rectangle saw an extra popup; sharing the original's rectangle fixed it. | Apryse (PDFTron) community thread "Comments for Annotations => Support for Displaying" | hand: sample A gives replies the root's top-left corner and no popup of their own |

Sources, as links:

- ISO 32000-1:2008 (Adobe's public copy), the tables and clauses named above: https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/PDF32000_2008.pdf (read here as text; page numbers in the quoted tables: 383 to 406).
- iText, `PdfTextMarkupAnnotation`: https://api.itextpdf.com/iText/java/8.0.0/com/itextpdf/kernel/pdf/annot/PdfTextMarkupAnnotation.html
- Foxit, "Reply to comments": https://resource-cms.foxit.com/foxit-pdf-editor-for-windows/reply-to-comments and "About pop-up notes": https://resource-cms.foxit.com/foxit-pdf-editor-for-windows/about-pop-notes
- Foxit PDF SDK for Web, `Markup`: https://webviewer-demo.foxit.com/docs/API_Reference/html/class_markup.html
- Apryse thread: https://community.apryse.com/t/comments-for-annotations-support-for-displaying/2225
- pyHanko (signature and update analysis): https://pyhanko.readthedocs.io/

## What the checker covers

`check/check_file.py` runs on each exported file. On the three owner samples (A, B, C), on the plan-driven round trip files and on the matrix it reports:

| Group | Checks (sample A, as an example) |
| --- | --- |
| bytes | The original is an exact prefix; its SHA-256 is unchanged; the tail is appended only (3). |
| qpdf | `--check` finds no damage the original did not already have (1). |
| our PDFium | Every note found by `/NM`; subtype, page, flags, `/Rect`, `/Contents`, `/T`, `/Subj`, `/C`, quads, `/IRT` and `/RT`, popup links, appearance present, dates (160). |
| pypdf | The same from the raw dictionaries, and quads in Acrobat's order, `/AP /BBox` = `/Rect` (137). |
| rules | R1 to R11 above (163). |
| pdf.js | Listed, contents, title, colour, `inReplyTo`, `replyType`, popup, quad count (89). |
| pixels | Poppler, MuPDF and stock PDFium each draw the page and the result is compared with the original at each note: the paper in a highlight takes the mark colour, a line crosses an underline or strikethrough, bold is heavier, an outline is drawn on four sides, an icon shows. Replies and popups draw nothing (page identical to the folded copy) (13 each). |

All pass on A, B and C, on the three round-trip variants and on the matrix. Bold: the count of dark pixels rises by 1.8 to 2.0 times at 144 dpi (threshold on the sum of the channels, so it counts the soft edge). The stroke is the viewer's own, `BOLD_STROKE_EM` 0.03. We only checked that it is heavier; the visual critic judges the look.

## Not done, and why

- **Foxit and Acrobat were not run.** Everything about how they show replies and popups is from the standard and their documents. The hand check decides it.
- **`FileReaderSync` timing** for the custom-load path (see above).
- **Hybrid-reference files** (an xref table that also points at an xref stream) and files with XFA forms: no sample, not tried.
- **`/P`** is not written, and PDFium has no call to set it.
- **A rotated page's quad order** in Acrobat: the order is derived (displayed top-left first), and no reader here can tell a wrong one from a right one, because they draw from the appearance.
- **Signed files**: warn. The alternative writer is not built.
