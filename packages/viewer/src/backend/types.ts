// The PdfBackend interface: every engine call in the product goes through it (global constraints). The EmbedPDF
// implementation is createEmbedPdfBackend (./embedpdf/backend.ts). Field names of Glyph, PageGlyphs, PageObjectInfo,
// StructElement and TextRun are the Phase 0 spike's, unchanged (rulings R1, R5).
//
// Coordinates. Unless a comment says otherwise, every rectangle and point is in points, in UNROTATED page space, with
// the origin at the top-left corner of the page's crop box and y growing downwards. "Unrotated" means the page's
// /Rotate is not applied: a page with /Rotate 90 still has its glyph boxes where they are in the file. PageSize gives
// the size of that space and the rotation to display it with.
import type { PageGeometry, PdfAnnotation, PdfAnnotationPlan, Sha256 } from '@sop/core';

// Phase 8 (contracts §9): the shapes of a page's boxes, an annotation read from a file and one to write are declared once,
// in the pure mapping (packages/core/src/export), and used here as they are. Their rects are PDF USER SPACE (y up), never
// PdfRect.
export type { PageGeometry, PdfAnnotation, PdfAnnotationPlan, PdfUserRect } from '@sop/core';

/** An open document. Made by PdfBackend.open; valid until close, or until the engine stops (PdfEngineCrashedError). */
export type DocHandle = string & { readonly __doc: unique symbol };

/** Points, unrotated page space, origin at the crop box's top-left, y down. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Clockwise degrees. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * A page's size and /Rotate.
 * - `width` × `height`: the UNROTATED crop box in points, the space every PdfRect is in.
 * - `rotation`: the page's /Rotate, clockwise.
 * The page is displayed `width` wide and `height` tall when (rotation + viewRotation) % 180 is 0, and the other way
 * round when it is 90. For example, a Letter page with /Rotate 90 is { width: 612, height: 792, rotation: 90 } and
 * shows 792 pt wide.
 */
export interface PageSize {
  width: number;
  height: number;
  rotation: Rotation;
}

/** The document information dictionary. An entry that is missing or empty is null. */
export interface PdfMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
  /** The first (permanent) /ID string of the trailer, as lower-case hex; null when the file has no /ID. */
  pdfId: string | null;
}

export interface OpenResult {
  doc: DocHandle;
  pageCount: number;
  /** One entry per page, in page order. */
  pages: PageSize[];
  metadata: PdfMetadata;
  /** The file is encrypted (it needed a password, or has an owner password only). */
  encrypted: boolean;
}

export interface TileRequest {
  pageIndex: number;
  /** Device pixels per point. 4/3 draws a page at 100% on a DPR-1 screen. */
  scale: number;
  /** The part of the page to draw (unrotated page space). Omitted: the whole page. */
  rect?: PdfRect;
  /** The viewer's own rotation, clockwise, added to the page's /Rotate. */
  viewRotation: Rotation;
  /** Draw annotation appearances (highlights, notes, stamps, form widgets) as well as the page content. */
  withAnnotations: boolean;
}

/** One PDFium text-page char (FPDFText_*). Field names are fixed by ruling R5. */
export interface Glyph {
  /** PDFium char index on the page. glyphs[i].index === i. */
  index: number;
  /**
   * The char as FPDFText_GetText gives it: one UTF-16 code unit (an astral char is two Glyphs that share a box),
   * U+FFFE for a line-end hyphen PDFium joins across the line break, '\r' and '\n' for its generated line breaks.
   */
  text: string;
  /** FPDFText_GetLooseCharBox: the advance × the font's ascent–descent. Zero-size for generated chars. */
  box: PdfRect;
  /** FPDFText_GetCharBox: the glyph's ink. */
  tight: PdfRect;
  /** Effective size in points: FPDFText_GetFontSize × the char matrix's vertical scale (R30). */
  fontSize: number;
  /** Degrees in [0, 360), clockwise as displayed (y down), in unrotated page space: FPDFText_GetCharAngle. */
  angle: number;
  /** FPDFText_IsGenerated: a space or line break PDFium inserted; it has no glyph. */
  generated: boolean;
}

export interface PageGlyphs {
  pageIndex: number;
  /** Every char of the page, in PDFium char-index order. */
  glyphs: Glyph[];
  /** Consecutive chars of one PDFium text object; `end` is exclusive. */
  runs: { start: number; end: number }[];
}

export interface SearchHit {
  pageIndex: number;
  /** First char index of the match. */
  start: number;
  /** Number of chars matched. */
  count: number;
  /** The match's selection rectangles, as getTextRangeRects gives them. */
  rects: PdfRect[];
}

/**
 * Where a link or outline entry goes.
 * - `page`: a page of this document. `top` and `left` are the destination's point in points, in the TARGET page's
 *   unrotated space (top-left origin); each is null when the destination leaves it open (/Fit, or /XYZ with null).
 * - `url`: a URI action, as written in the file.
 */
export type LinkTarget = { kind: 'page'; pageIndex: number; top: number | null; left: number | null } | { kind: 'url'; url: string };

/** A link annotation that goes to a page of this document or to a URL. Other actions (launch, other files) are left out. */
export interface PdfLink {
  rect: PdfRect;
  target: LinkTarget;
}

export interface OutlineItem {
  title: string;
  /** null when the entry has no destination this viewer can follow. */
  target: LinkTarget | null;
  children: OutlineItem[];
}

/** FPDF_GetFormType: no /AcroForm, an AcroForm, a full XFA form (/NeedsRendering), or XFA over an AcroForm. */
export type FormType = 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground';

/**
 * What getFormInfo found. A PDF is a form for the viewer when hasFillableFields(info) is true (forms.ts).
 * - `firstFillablePage`: index of the first page with a widget a person can fill in (a check box, radio button, combo
 *   box, list box or text field that is neither read-only nor hidden). null when there is none, and always null for
 *   XFA documents, which are not walked.
 * - `pagesWalked`: how many pages were read. The walk stops at the first fillable page, so it is pageCount for an
 *   `acroform` document without fillable widgets, firstFillablePage + 1 when it finds one, and 0 for the other types.
 */
export interface FormInfo {
  formType: FormType;
  firstFillablePage: number | null;
  pagesWalked: number;
}

/** FPDF_PAGEOBJ_* by name. */
export type PageObjectType = 'text' | 'path' | 'image' | 'shading' | 'form' | 'unknown';

export interface PageObjectInfo {
  type: PageObjectType;
  /** FPDFPageObj_GetBounds; an object inside a form XObject is mapped to the page through the forms' matrices. */
  bounds: PdfRect;
  /** 0 for an object on the page itself, 1 for one inside a form XObject on the page, and so on. */
  formDepth: number;
  /** FPDFPageObj_GetMarkedContentID: the MCID of the marked content holding the object; -1 for none. */
  markedContentId: number;
  /** Image objects: FPDFImageObj_GetImagePixelSize and the stream's filters, e.g. DCTDecode. */
  image?: { pixelWidth: number; pixelHeight: number; filters: string[] };
  /** Path objects: FPDFPath_CountSegments and FPDFPath_GetDrawMode (`filled`: any fill mode). */
  path?: { segmentCount: number; filled: boolean; stroked: boolean };
}

export interface PageObjectList {
  /** Depth first, in content order: a form XObject comes before the objects inside it. */
  objects: PageObjectInfo[];
  /** The walk stopped at maxObjects or budgetMs; `objects` is then a prefix of the page's objects. */
  truncated: boolean;
}

/** One element of the page's structure tree (tagged PDF), read to depth 32. */
export interface StructElement {
  /** /S, e.g. Document, P, Figure, Table. */
  type: string;
  /** /Alt; null when missing or empty. */
  altText: string | null;
  /** /ActualText; null when missing or empty. */
  actualText: string | null;
  /** The marked-content ids this element holds on the page. */
  markedContentIds: number[];
  children: StructElement[];
}

/**
 * One PDFium text object's chars on one line. A run ends where the text object changes, where the baseline moves by
 * more than half the font size, and at PDFium's generated line breaks (which belong to no run).
 */
export interface TextRun {
  /** FPDFText_GetText over [charStart, charStart + charCount): one UTF-16 code unit per char. */
  text: string;
  /** The union of the run's loose char boxes. */
  rect: PdfRect;
  /** Effective size in points, as Glyph.fontSize (R30). */
  fontSize: number;
  charStart: number;
  charCount: number;
}

/** getTextRuns with a time budget: like PageObjectList, `runs` is a prefix of the page's runs when `truncated`. */
export interface TextRunList {
  runs: TextRun[];
  /** The walk stopped at budgetMs before the page's last char. */
  truncated: boolean;
}

/** A colour as PDFium gives it: red, green, blue and alpha, 0–255 each. */
export type PdfColor = [r: number, g: number, b: number, a: number];

/**
 * One glyph's outline, for drawing bold over the page (P0-5; contracts §2's `{ charIndex, d }` plus how the page paints
 * the glyph, so that bold keeps the text's own colour, ruling R29).
 */
export interface GlyphOutline {
  /** PDFium char index. A glyph PDFium expands into several chars (a ligature such as "fi") is one outline, at the first of them in the range. */
  charIndex: number;
  /** SVG path data in points, unrotated page space, origin at the crop box's top-left (the space of Glyph boxes). */
  d: string;
  /** FPDFText_GetFillColor; null when the text is stroked but not filled (render modes 1 and 5). */
  fill: PdfColor | null;
  /** FPDFText_GetStrokeColor; null when the text is filled but not stroked (render modes 0 and 4). */
  stroke: PdfColor | null;
  /** The glyph's effective font size in points, as Glyph.fontSize (R30), so a caller needs no getPageGlyphs to size a stroke. */
  fontSize?: number;
  /**
   * The font's weight as PDFium reads it (FPDFFont_GetWeight: the descriptor's stem width scaled to CSS weights, so a
   * regular face reads about 350 to 540 and a bold one 570 and up), and at least 700 for a font flagged ForceBold.
   * Missing when PDFium has no weight for the font (a standard font without a descriptor). Bold word starts (R90) draw
   * text that is already bold lighter, so it does not smudge.
   */
  fontWeight?: number;
}

/**
 * One glyph for synthetic bold (getGlyphShapes, R90b): which outline it is, where it goes on the page, how it is painted
 * and how much bold its face gets.
 */
export interface GlyphPlacement {
  /** PDFium char index; a ligature is one glyph, at the first of its chars in the range (as GlyphOutline). */
  charIndex: number;
  /** Its outline: an index into GlyphShapes.shapes. */
  shape: number;
  /**
   * Ems (y up) → unrotated page points (y down) about the origin: x = m[0]·ex + m[2]·ey + x, y = m[1]·ex + m[3]·ey + y.
   * The font size and the char matrix (skew, rotation, scale) are in it.
   */
  m: [number, number, number, number];
  /** The glyph's origin, unrotated page points from the crop box's top-left, y down. */
  x: number;
  y: number;
  fill: PdfColor | null;
  stroke: PdfColor | null;
  /** Effective size in points, as Glyph.fontSize. */
  fontSize: number;
  /**
   * The bold its face gets, in ems: `x` how much wider its stems get (both sides together), `top` how far the tops of
   * its letters rise, `bottom` how far their bottoms drop, `stem` the face's own stem width. `from`: matched to the
   * document's own bold face of the family, a typical regular-to-bold gain, or the small gain of a face already bold.
   */
  bold: { x: number; top: number; bottom: number; stem: number; from: 'matched' | 'typical' | 'already-bold' };
  /** Set when its face is italic (by its name). */
  italic?: true;
  /** Set when its face is a maths face (CMMI, CMSY, Symbol, STIX, "…Math…"): bold word starts leave it alone (R90c). */
  maths?: true;
  /**
   * With getGlyphShapes' `ink` option: how much of the glyph the page's own picture shows, from 0 (nothing: the glyph is
   * covered, or drawn in the colour behind it) to 1 (all of it, in its fill colour). Missing for a glyph with no fill, or
   * too small to measure. Bold word starts draw only words the page shows (R90).
   */
  ink?: number;
}

/** getGlyphShapes' options. */
export interface GlyphShapeOptions {
  /** Measure each glyph's `ink` against a picture of the page (one render per page, kept for the next calls). */
  ink?: boolean;
}

/** getGlyphShapes: each distinct outline once, and the glyphs that use them. */
export interface GlyphShapes {
  /** PDFium's glyph paths (FPDFFont_GetGlyphPath), in ems, y up: [type, x, y, close] per segment (2 move, 0 line, 1 cubic point). */
  shapes: Float32Array[];
  glyphs: GlyphPlacement[];
}

/**
 * A filled shape in an annotation's appearance, in PDF USER SPACE (y up, origin at the page's lower left, before /Rotate):
 * PDFium's path layout, four numbers a segment, [type, x, y, close], type 2 a move, 0 a line, 1 a cubic Bézier point
 * (three in a row: two controls and the end). Bold marks carry their emboldened glyphs this way (synthetic bold, R90b).
 */
export interface ApFill {
  /** 0–255 each. */
  rgb: [number, number, number];
  path: number[];
}

/** writeAnnotations' options (contracts §9, plus what the exporter hands in). */
export interface WriteAnnotationsOptions {
  /** The password that opens the file; the copy keeps the same encryption. */
  password?: string;
  /**
   * 'tail' (the default, spike 8.0's EXPORT_SAVE): PDFium's incremental save, keeping only the bytes it adds, so the
   * result is the original's own bytes followed by a short update; 'incremental': the same save, every byte from PDFium;
   * 'full': a full rewrite.
   */
  save: 'tail' | 'incremental' | 'full';
  /** The appearance of each bold mark ('bold-outlines' plan items), by the item's /NM: its glyphs, emboldened. */
  boldFills?: Record<string, ApFill[]>;
  /** The document information to set in the copy (spec: tags in Keywords, the reading's context in Subject). */
  info?: { keywords?: string; subject?: string };
}

/**
 * The PDF engine. It runs in a worker (or two: ENGINE_WORKERS); each worker runs its calls one at a time, in the
 * order they are made.
 *
 * Errors:
 * - open rejects with PdfPasswordError (a password is needed, or the one given is wrong) or PdfFormatError (not a PDF,
 *   or damaged beyond repair).
 * - Any call rejects with PdfEngineCrashedError when the engine stops: it crashed, hung (no answer for the watchdog
 *   time), or ran out of memory. Every call waiting at that moment is rejected. Documents open in it are lost, and
 *   later calls on their handles reject the same way; the next `open` starts a fresh engine.
 * - A call whose AbortSignal fires rejects with a DOMException named AbortError.
 */
export interface PdfBackend {
  /** Opens a PDF. The bytes are transferred to the engine, so `bytes` is detached afterwards. */
  open(bytes: ArrayBuffer, opts?: { password?: string }): Promise<OpenResult>;
  /** Frees the document. Closing a closed or lost document does nothing. */
  close(doc: DocHandle): Promise<void>;
  /**
   * Draws the page (or `req.rect`) as displayed: turned by the page's /Rotate plus viewRotation, at `scale` device px
   * per point, on white. The bitmap is round(width × scale) by round(height × scale) of the rect, swapped when the
   * total rotation is 90 or 270. Aborting drops a render that has not started, and the result of one that has.
   * Rejects with a RangeError above 16384 px a side or 2^26 px in all.
   */
  renderTile(doc: DocHandle, req: TileRequest, signal?: AbortSignal): Promise<ImageBitmap>;
  getPageGlyphs(doc: DocHandle, pageIndex: number): Promise<PageGlyphs>;
  /**
   * The page's text: FPDFText_GetText over every char, without U+FFFE (PDFium's mark for a line-end hyphen it joins),
   * U+FFFF, soft hyphens, zero-width spaces, word joiners and BOMs. Select-all must copy exactly this (R26).
   */
  getPageText(doc: DocHandle, pageIndex: number): Promise<string>;
  /**
   * The page's chars exactly as PDFium has them: FPDFText_GetText over every char, nothing removed (U+FFFE where PDFium
   * joins a line-end hyphen, soft hyphens, zero-width chars and PDFium's generated '\r', '\n' and spaces all stay), so
   * `raw.length` is the page's char count and `raw[i]` is char `i` (getPageGlyphs' `glyphs[i].text`). One engine call;
   * anchoring reads its char positions from this (getPageText's offsets drift from char indices after the first
   * removed char).
   */
  getPageChars(doc: DocHandle, pageIndex: number): Promise<string>;
  /**
   * The whole page's text as Copy writes it (R26): the text layer's text model (PDFium's text with its joined line
   * breaks, text-layer/items.ts), trimmed of white space at both ends, and the page's char count. One engine call of
   * about getPageChars' cost; Copy reads it for the pages a selection covers whole (Ctrl+A on a long book).
   */
  getPageCopyText(doc: DocHandle, pageIndex: number): Promise<{ text: string; charCount: number }>;
  /** The text of chars [start, start + count), cleaned as getPageText. */
  getTextRange(doc: DocHandle, pageIndex: number, start: number, count: number): Promise<string>;
  /**
   * Selection rectangles for chars [start, start + count), for painting a selection or a mark (R44): PDFium's own
   * rectangles (FPDFText_CountRects / FPDFText_GetRect, the ones Chrome's viewer paints), with neighbours on the same
   * line joined into one. So a run of text gives one rectangle per line, and per column where a line crosses a column
   * gap; rectangles of different lines do not overlap unless the text itself does. In reading order.
   */
  getTextRangeRects(doc: DocHandle, pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
  /** Every match of `query` on the page, in text order. An empty query finds nothing. */
  searchPage(doc: DocHandle, pageIndex: number, query: string, opts: { matchCase: boolean; wholeWord: boolean }): Promise<SearchHit[]>;
  /** The page's links in /Annots order. */
  getLinks(doc: DocHandle, pageIndex: number): Promise<PdfLink[]>;
  /** The document outline (bookmarks); [] when there is none. */
  getOutline(doc: DocHandle): Promise<OutlineItem[]>;
  /**
   * Whether the document is a form (see FormInfo and hasFillableFields).
   *
   * Call it once per document fingerprint and cache the answer: it depends only on the file's bytes, and each walk
   * leaks about 240 bytes an annotation inside PDFium (ruling R38). The backend itself remembers the answer for an open
   * handle, so a second call on the same handle is free; a cache by fingerprint also covers reopening the file.
   * It is synchronous in the engine, so run it after the first page is drawn.
   */
  getFormInfo(doc: DocHandle): Promise<FormInfo>;
  /**
   * The page's objects. Defaults: recurseForms true, maxObjects 20000, budgetMs 15. The budget clock starts once the
   * page is loaded (R31) and is checked every 64 objects.
   */
  listPageObjects(doc: DocHandle, pageIndex: number, opts?: { recurseForms?: boolean; maxObjects?: number; budgetMs?: number }): Promise<PageObjectList>;
  /** The page's structure tree; [] for an untagged page. */
  getStructTree(doc: DocHandle, pageIndex: number): Promise<StructElement[]>;
  /** The page's text runs (the figure detector's lines, Phase 2). */
  getTextRuns(doc: DocHandle, pageIndex: number): Promise<TextRun[]>;
  /**
   * The page's text runs, stopping once the walk has run `budgetMs` (checked every 256 chars; the clock starts once the
   * page and its text page are loaded, as listPageObjects' does, R31). The figure detector uses this form.
   */
  getTextRuns(doc: DocHandle, pageIndex: number, opts: { budgetMs: number }): Promise<TextRunList>;
  /**
   * The glyph outlines of chars [charStart, charStart + charCount), for bold (P0-5, R29). Left out: chars with no glyph
   * (PDFium's generated spaces and line breaks, whitespace) and text the page never shows: invisible text (render modes
   * 3 and 7, such as a scan's OCR layer, or a fill with alpha 0), and glyphs mostly outside their clip path or the page
   * box. So a visible char in the range with no outline is one bold cannot redraw (the caller draws the "strong" style
   * there). A ligature, a surrogate pair and PDFium's joined line-end hyphen each give one outline. A Type3 glyph has no
   * outline. In char order.
   */
  getGlyphOutlines(doc: DocHandle, pageIndex: number, charStart: number, charCount: number): Promise<GlyphOutline[]>;
  /**
   * The glyphs of chars [charStart, charStart + charCount) for synthetic bold (R90b): getGlyphOutlines' glyphs as em
   * outlines (each distinct one once) and placements, with each face's bold matched to the document's own bold face
   * where it has one. Bold word starts, bold marks and print with marks draw from this. With `opts.ink`, each glyph's
   * `ink` says how much of it the page's picture shows.
   */
  getGlyphShapes(doc: DocHandle, pageIndex: number, charStart: number, charCount: number, opts?: GlyphShapeOptions): Promise<GlyphShapes>;
  /**
   * SHA-256 of an image object's stream data as stored in the file (FPDFImageObj_GetImageDataRaw), computed in the
   * engine. `objectIndex` counts as listPageObjects(doc, pageIndex, { recurseForms: true }) does (depth first, a form
   * before its objects). null when the index is out of range, the object is not an image, or it has no data.
   */
  hashImageObject(doc: DocHandle, pageIndex: number, objectIndex: number): Promise<Sha256 | null>;
  /**
   * Phase 8. The page's crop box (as the engine's coordinates start from it: the crop box within the media box), its
   * media box and its /Rotate, in PDF user space.
   */
  getPageGeometry(doc: DocHandle, pageIndex: number): Promise<PageGeometry>;
  /** Phase 8. The page's annotations as they are in the file, in /Annots order (rects in PDF user space). */
  readAnnotations(doc: DocHandle, pageIndex: number): Promise<PdfAnnotation[]>;
  /**
   * Phase 8, slice 8.4. Hides (or shows again) annotations of the open document by object number (`readAnnotations`'
   * `objectNumber`), so a note the library already shows is not drawn twice. Only the open copy changes, in memory; the file
   * and what "Download with notes" writes do not. Pages already drawn keep their picture until they are drawn again.
   */
  setAnnotationsHidden(doc: DocHandle, items: readonly { pageIndex: number; objectNumber: number }[], hidden: boolean): Promise<void>;
  /** Phase 8. How many digital signatures the file has (FPDF_GetSignatureCount): adding notes shows a signature as changed. */
  getSignatureCount(doc: DocHandle): Promise<number>;
  /**
   * Phase 8, "Download with notes": a COPY of `source` with `plan` written into it as PDF annotations, in plan order. It
   * opens a handle of its own on `source` that loads only the pages that get notes, so nothing of the viewer's open
   * document (and no flag set on it) reaches the file, and `source` itself is never changed. With `save: 'tail'` the
   * result is `source`'s bytes, unchanged, followed by PDFium's incremental update. Rejects when the file does not
   * open (PdfPasswordError, PdfFormatError) or a note could not be written (nothing is half written: no Blob comes back).
   */
  writeAnnotations(source: Blob, plan: readonly PdfAnnotationPlan[], o: WriteAnnotationsOptions): Promise<Blob>;
}
