// Our PdfiumNative: EmbedPDF 2.15.1's PDFium engine plus the calls PdfBackend needs. It runs inside the engine worker
// (engine.worker.ts), which calls only the EngineApi methods (rpc.ts). Each takes a document id, not a
// PdfDocumentObject.
//
// Ported from the Phase 0 spike (spikes/phase0/src/engine/spike-native.ts): getGlyphs and getTextRange (P0-4),
// getFormInfo (P0-7), listPageObjects, getStructTree and getTextRuns (P0-10; the spike's getPageObjects and
// getPageTextRuns), getGlyphOutlines (P0-5, Phase 2 S11, ruling R29), hashImageObject and getPageChars (Phase 2 S11).
// The patch patches/@embedpdf__engines@2.15.1.patch makes PdfiumNative's `pdfiumModule` and `cache`
// protected, so these methods can reach PDFium.
//
// Coordinates: every rect is in points, unrotated page space, with the origin at the top-left of the page's bounding
// box (FPDF_GetPageBoundingBox: the crop box within the media box), as in types.ts.
import { PdfiumNative, type PdfiumEngineOptions } from '@embedpdf/engines/pdfium';
import { sha256Hex, type Sha256 } from '@sop/core';
import { stripPdfUnwantedMarkers, type PdfDocumentObject, type PdfTask } from '@embedpdf/models';
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { PdfFormatError, PdfPasswordError } from '../errors';
import { pageCopyText } from '../../text-layer/items';
import type {
  FormInfo,
  FormType,
  Glyph,
  GlyphOutline,
  LinkTarget,
  OutlineItem,
  PageGlyphs,
  PageObjectInfo,
  PageObjectList,
  PageObjectType,
  PageSize,
  PdfColor,
  PdfLink,
  PdfMetadata,
  PdfRect,
  Rotation,
  SearchHit,
  StructElement,
  TextRun,
  TextRunList,
  TileRequest,
} from '../types';
import type { EngineApi, OpenedDocument } from './rpc';

/** FPDF_GetFormType's result (fpdf_formfill.h FORMTYPE_*), by value. */
const FORM_TYPES: FormType[] = ['none', 'acroform', 'xfa-full', 'xfa-foreground'];
/** The FPDF_FORMFIELD_* types a person fills in: CHECKBOX 2, RADIOBUTTON 3, COMBOBOX 4, LISTBOX 5, TEXTFIELD 6. */
const FILLABLE_FIELD_TYPES: ReadonlySet<number> = new Set([2, 3, 4, 5, 6]);
/** FPDF_ANNOT_WIDGET (fpdf_annot.h). */
const FPDF_ANNOT_WIDGET = 20;
/** FPDF_ANNOT_LINK (fpdf_annot.h). */
const FPDF_ANNOT_LINK = 2;
/** FPDF_ANNOT_FLAG_HIDDEN (fpdf_annot.h). */
const FPDF_ANNOT_FLAG_HIDDEN = 2;
/** FPDFAnnot_GetFormFieldType's answer for a widget that is not (yet) linked to a form field. */
const NO_FIELD = -1;
/** Annotation flags (PDF 32000 12.5.3) that make a widget unusable: Hidden 2, NoView 32, ReadOnly 64. */
const ANNOT_FLAGS_NOT_FILLABLE = 2 | 32 | 64;
/** Field flag ReadOnly (bit 1, FPDF_FORMFLAG_READONLY). */
const FIELD_FLAG_READONLY = 1;

/** listPageObjects' defaults: the figure detector's production limits (research 06 §3.2). */
const OBJECT_LIMITS = { recurseForms: true, maxObjects: 20_000, budgetMs: 15 } as const;
/** How deep getStructTree and getOutline read. */
const MAX_TREE_DEPTH = 32;
/** getOutline stops after this many entries (a guard against malformed outlines). */
const MAX_OUTLINE_ITEMS = 100_000;
/** FPDF_PAGEOBJ_* in fpdf_edit.h, by value. */
const PAGE_OBJECT_TYPES: PageObjectType[] = ['unknown', 'text', 'path', 'image', 'shading', 'form'];
/** FPDFText_FindStart flags (fpdf_text.h). */
const FPDF_MATCHCASE = 1;
const FPDF_MATCHWHOLEWORD = 2;
/** FPDFAction_GetType (fpdf_doc.h). */
const PDFACTION_GOTO = 1;
const PDFACTION_URI = 3;
/** FPDFDest_GetView (fpdf_doc.h). */
const VIEW_FITH = 3;
const VIEW_FITV = 4;
const VIEW_FITR = 5;
const VIEW_FITBH = 7;
const VIEW_FITBV = 8;
/** getTextRuns with a budget checks the clock every this many chars. */
const RUNS_CLOCK_EVERY = 256;
/** fpdf_edit.h path segment types. */
const FPDF_SEGMENT_LINETO = 0;
const FPDF_SEGMENT_BEZIERTO = 1;
const FPDF_SEGMENT_MOVETO = 2;
/**
 * FPDFTextObj_GetTextRenderMode (FPDF_TEXTRENDERMODE_*): 0 fill, 1 stroke, 2 fill and stroke, 3 invisible, 4–6 the
 * same three adding the text to the clip, 7 clip only. -1 (unknown) is read as 0.
 */
const FILLS_BY_MODE = [true, false, true, false, true, false, true, false];
const STROKES_BY_MODE = [false, true, true, false, false, true, true, false];
/** The ligatures Unicode encodes, by the chars PDFium expands them into (P0-5). */
const LIGATURES: Record<string, number> = { ff: 0xfb00, fi: 0xfb01, fl: 0xfb02, ffi: 0xfb03, ffl: 0xfb04, ſt: 0xfb05, st: 0xfb06 };
/** getGlyphOutlines reads chars this far either side of the range, to find a ligature the range starts or ends inside. */
const GLYPH_GROUP_REACH = 8;
/** Outline coordinates are written to 1/100 pt (0.05 px at 400% on a DPR-2 screen). */
const OUTLINE_PRECISION = 100;

/** renderBitmap refuses bitmaps larger than this (a side, and in all): beyond it the wasm heap would run out. */
export const MAX_TILE_SIDE = 16_384;
export const MAX_TILE_PIXELS = 2 ** 26;

/** Every PDFium function called through the wasm exports (no cwrap): every argument and result is a number. */
type ExportName =
  | 'FPDF_GetPageBoundingBox'
  | 'FPDFPage_CountObjects'
  | 'FPDFPage_GetObject'
  | 'FPDFPageObj_GetType'
  | 'FPDFPageObj_GetBounds'
  | 'FPDFPageObj_GetMarkedContentID'
  | 'FPDFPageObj_GetMatrix'
  | 'FPDFFormObj_CountObjects'
  | 'FPDFFormObj_GetObject'
  | 'FPDFImageObj_GetImagePixelSize'
  | 'FPDFImageObj_GetImageFilterCount'
  | 'FPDFImageObj_GetImageFilter'
  | 'FPDFPath_CountSegments'
  | 'FPDFPath_GetDrawMode'
  | 'FPDF_StructTree_GetForPage'
  | 'FPDF_StructTree_CountChildren'
  | 'FPDF_StructTree_GetChildAtIndex'
  | 'FPDF_StructTree_Close'
  | 'FPDF_StructElement_CountChildren'
  | 'FPDF_StructElement_GetChildAtIndex'
  | 'FPDF_StructElement_GetType'
  | 'FPDF_StructElement_GetAltText'
  | 'FPDF_StructElement_GetActualText'
  | 'FPDF_StructElement_GetMarkedContentIdCount'
  | 'FPDF_StructElement_GetMarkedContentIdAtIndex'
  | 'FPDFText_CountChars'
  | 'FPDFText_GetText'
  | 'FPDFText_IsGenerated'
  | 'FPDFText_GetTextObject'
  | 'FPDFText_GetCharOrigin'
  | 'FPDFText_GetLooseCharBox'
  | 'FPDFText_GetMatrix'
  | 'FPDFText_CountRects'
  | 'FPDFText_GetRect'
  | 'FPDFText_FindStart'
  | 'FPDFText_FindNext'
  | 'FPDFText_GetSchResultIndex'
  | 'FPDFText_GetSchCount'
  | 'FPDFText_FindClose'
  | 'FPDFTextObj_GetFontSize'
  | 'FPDFTextObj_GetFont'
  | 'FPDFTextObj_GetTextRenderMode'
  | 'FPDFText_GetUnicode'
  | 'FPDFText_HasUnicodeMapError'
  | 'FPDFText_IsHyphen'
  | 'FPDFText_GetFillColor'
  | 'FPDFText_GetStrokeColor'
  | 'FPDFFont_GetGlyphPath'
  | 'FPDFGlyphPath_CountGlyphSegments'
  | 'FPDFGlyphPath_GetGlyphPathSegment'
  | 'FPDFPathSegment_GetPoint'
  | 'FPDFPathSegment_GetType'
  | 'FPDFPathSegment_GetClose'
  | 'FPDFImageObj_GetImageDataRaw'
  | 'FPDF_GetFormType'
  | 'PDFiumExt_OpenFormFillInfo'
  | 'PDFiumExt_InitFormFillEnvironment'
  | 'PDFiumExt_ExitFormFillEnvironment'
  | 'PDFiumExt_CloseFormFillInfo'
  | 'EPDFPage_GetAnnotCountRaw'
  | 'EPDFPage_GetAnnotRaw'
  | 'FPDFPage_GetAnnotCount'
  | 'FPDFPage_GetAnnot'
  | 'FPDFPage_CloseAnnot'
  | 'FPDFAnnot_GetSubtype'
  | 'FPDFAnnot_GetFlags'
  | 'FPDFAnnot_SetFlags'
  | 'EPDFAnnot_HasAppearanceStream'
  | 'FPDFAnnot_GetFormFieldType'
  | 'FPDFAnnot_GetFormFieldFlags'
  | 'FORM_OnAfterLoadPage'
  | 'FORM_OnBeforeClosePage'
  | 'FPDFLink_Enumerate'
  | 'FPDFLink_GetAnnotRect'
  | 'FPDFLink_GetDest'
  | 'FPDFLink_GetAction'
  | 'FPDFAction_GetType'
  | 'FPDFAction_GetDest'
  | 'FPDFAction_GetURIPath'
  | 'FPDFDest_GetDestPageIndex'
  | 'FPDFDest_GetLocationInPage'
  | 'FPDFDest_GetView'
  | 'FPDFBookmark_GetFirstChild'
  | 'FPDFBookmark_GetNextSibling'
  | 'FPDFBookmark_GetTitle'
  | 'FPDFBookmark_GetDest'
  | 'FPDFBookmark_GetAction'
  | 'FPDF_GetFileIdentifier';
type Exports = Record<ExportName, (...args: number[]) => number> & {
  memory: WebAssembly.Memory;
  malloc(bytes: number): number;
  free(ptr: number): void;
};
type Matrix = [number, number, number, number, number, number];
/** PDF space (y up): left, top, right, bottom. */
interface PdfBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Typed views of the wasm memory, made again whenever the memory has grown (which detaches the old buffer). */
class Heap {
  private buffer: ArrayBuffer | null = null;
  private f32 = new Float32Array(0);
  private f64 = new Float64Array(0);
  private i32 = new Int32Array(0);
  private u8 = new Uint8Array(0);
  private u16 = new Uint16Array(0);

  constructor(private readonly memory: WebAssembly.Memory) {}

  private sync(): void {
    if (this.buffer === this.memory.buffer) return;
    this.buffer = this.memory.buffer;
    this.f32 = new Float32Array(this.buffer);
    this.f64 = new Float64Array(this.buffer);
    this.i32 = new Int32Array(this.buffer);
    this.u8 = new Uint8Array(this.buffer);
    this.u16 = new Uint16Array(this.buffer);
  }

  float(ptr: number): number {
    this.sync();
    return this.f32[ptr >> 2];
  }
  double(ptr: number): number {
    this.sync();
    return this.f64[ptr >> 3];
  }
  int(ptr: number): number {
    this.sync();
    return this.i32[ptr >> 2];
  }
  setInt(ptr: number, value: number): void {
    this.sync();
    this.i32[ptr >> 2] = value;
  }
  /** `count` UTF-16 code units at ptr, as they are (no decoding: lone surrogates, U+0000 and U+FFFE stay). */
  utf16(ptr: number, count: number): string {
    this.sync();
    let out = '';
    for (let i = 0; i < count; i += 4096) out += String.fromCharCode(...this.u16.subarray((ptr >> 1) + i, (ptr >> 1) + Math.min(count, i + 4096)));
    return out;
  }
  /** Writes `text` as UTF-16 with a terminating NUL; the buffer needs 2 × (text.length + 1) bytes. */
  writeUtf16(ptr: number, text: string): void {
    this.sync();
    const base = ptr >> 1;
    for (let i = 0; i < text.length; i++) this.u16[base + i] = text.charCodeAt(i);
    this.u16[base + text.length] = 0;
  }
  /** `count` bytes at ptr. */
  bytes(ptr: number, count: number): Uint8Array {
    this.sync();
    return this.u8.slice(ptr, ptr + count);
  }
}

/** The parts of EmbedPDF's page cache used here (dist/lib/pdfium/cache.d.ts, which the package does not export). */
interface PageContext {
  readonly pagePtr: number;
  /** The page's text page, loaded once and kept with the page. */
  getTextPage(): number;
  release(): void;
}
interface DocumentContext {
  readonly docPtr: number;
  /** Loads the page (or takes it from the cache, 10 pages a document, 5 s); pair with release(). */
  acquirePage(pageIndex: number): PageContext;
}
interface PdfCache {
  getContext(docId: string): DocumentContext | undefined;
}

interface DocState {
  doc: PdfDocumentObject;
  /** Per page, unrotated. */
  sizes: PageSize[];
  /** The pages whose borderless-link annotations are already hidden (hideLinkBorders), so that is done once per page. */
  linksHidden: Set<number>;
}

export class SopPdfiumNative extends PdfiumNative implements EngineApi {
  private readonly docs = new Map<string, DocState>();
  /** The cwrap wrappers (the spike's getGlyphs uses them). */
  private readonly m: WrappedPdfiumModule;
  /** The wasm exports, called directly: about 3× cheaper than the wrappers (P0-5). */
  private readonly x: Exports;
  private readonly h: Heap;

  constructor(module: WrappedPdfiumModule, options: PdfiumEngineOptions = {}) {
    super(module, options);
    this.m = module;
    this.x = module.pdfium.wasmExports as unknown as Exports;
    this.h = new Heap(this.x.memory);
  }

  /** The wasm heap's size in bytes (it only grows). */
  heapBytes(): number {
    return this.x.memory.buffer.byteLength;
  }

  // ---- documents ----

  /** Opens `bytes` (EmbedPDF copies them into the wasm heap). PDFium error 4 → PdfPasswordError, 2 and 3 → PdfFormatError. */
  openDocument(docId: string, bytes: ArrayBuffer, password?: string): OpenedDocument {
    if (this.docs.has(docId)) throw new Error(`document ${docId} is already open`);
    let doc: PdfDocumentObject;
    try {
      doc = settled(this.openDocumentBuffer({ id: docId, content: bytes }, { password: password ?? '' }));
    } catch (err) {
      const code = err instanceof EngineTaskError ? err.code : null;
      if (code === 4) throw new PdfPasswordError(password !== undefined);
      if (code === 2 || code === 3) throw new PdfFormatError();
      throw err;
    }
    const sizes = doc.pages.map((p): PageSize => {
      const rotation = (((p.rotation % 4) + 4) % 4) * 90 as Rotation;
      // EmbedPDF's size is PDFium's page size, which is turned by /Rotate; PageSize is the unrotated one.
      return rotation % 180 === 0 ? { width: p.size.width, height: p.size.height, rotation } : { width: p.size.height, height: p.size.width, rotation };
    });
    this.docs.set(docId, { doc, sizes, linksHidden: new Set() });
    try {
      return { pageCount: doc.pageCount, pages: sizes, metadata: this.metadata(doc), encrypted: doc.isEncrypted };
    } catch (err) {
      this.closeDoc(docId); // the page never gets a handle for it
      throw err;
    }
  }

  closeDoc(docId: string): void {
    const state = this.docs.get(docId);
    if (!state) return;
    this.docs.delete(docId);
    settled(this.closeDocument(state.doc));
  }

  private metadata(doc: PdfDocumentObject): PdfMetadata {
    const m = settled(this.getMetadata(doc));
    const text = (v: string | null) => (v ? v : null);
    return {
      title: text(m.title),
      author: text(m.author),
      subject: text(m.subject),
      keywords: text(m.keywords),
      creator: text(m.creator),
      producer: text(m.producer),
      pdfId: this.fileId(doc),
    };
  }

  /** FPDF_GetFileIdentifier(FILEIDTYPE_PERMANENT) as hex: the byte count it returns includes a NUL. */
  private fileId(doc: PdfDocumentObject): string | null {
    const docPtr = this.docPtr(doc);
    const bytes = this.x.FPDF_GetFileIdentifier(docPtr, 0, 0, 0);
    if (bytes <= 1) return null;
    const buf = this.x.malloc(bytes);
    try {
      this.x.FPDF_GetFileIdentifier(docPtr, 0, buf, bytes);
      return Array.from(this.h.bytes(buf, bytes - 1), (b) => b.toString(16).padStart(2, '0')).join('');
    } finally {
      this.x.free(buf);
    }
  }

  // ---- drawing ----

  /**
   * The page (or req.rect) as displayed, as an ImageBitmap. EmbedPDF's renderPageRect takes its rect in /Rotate-turned
   * space and adds its `rotation` on top; req.rect is unrotated, so it is turned by the page's /Rotate first.
   */
  async renderBitmap(docId: string, req: TileRequest): Promise<ImageBitmap> {
    const state = this.state(docId);
    const { doc, sizes } = state;
    const page = this.page(doc, req.pageIndex);
    const size = sizes[req.pageIndex];
    const rect = req.rect ?? { x: 0, y: 0, width: size.width, height: size.height };
    if (![rect.x, rect.y, rect.width, rect.height, req.scale].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || req.scale <= 0) {
      throw new RangeError(`renderTile: bad rect or scale ${JSON.stringify({ rect, scale: req.scale })}`);
    }
    const turned = rotateRect(rect, size.width, size.height, size.rotation);
    const swap = req.viewRotation % 180 !== 0;
    // The same sums as EmbedPDF's renderRectEncoded, so the check matches the bitmap it would allocate.
    const w = Math.max(1, Math.round((swap ? turned.height : turned.width) * req.scale));
    const h = Math.max(1, Math.round((swap ? turned.width : turned.height) * req.scale));
    if (w > MAX_TILE_SIDE || h > MAX_TILE_SIDE || w * h > MAX_TILE_PIXELS) {
      throw new RangeError(`renderTile: a ${w} × ${h} px bitmap is too large (at most ${MAX_TILE_SIDE} px a side and ${MAX_TILE_PIXELS} px)`);
    }
    if (req.withAnnotations && !state.linksHidden.has(req.pageIndex)) {
      this.hideLinkBorders(doc, req.pageIndex);
      state.linksHidden.add(req.pageIndex);
    }
    const image = settled(
      this.renderPageRect(doc, page, { origin: { x: turned.x, y: turned.y }, size: { width: turned.width, height: turned.height } }, {
        scaleFactor: req.scale,
        rotation: req.viewRotation / 90, // EmbedPDF's Rotation: quarter turns
        withAnnotations: req.withAnnotations,
      }),
    );
    return createImageBitmap(new ImageData(image.data, image.width, image.height));
  }

  /**
   * Hides every Link annotation of the page that has no appearance stream, so drawing annotations does not box it.
   * EmbedPDF's PDFium makes an appearance stream for such a link when it draws annotations: a box in the link's /C colour
   * and /Border width, which hyperref sets (green for citations, red for links, cyan for URLs). Chrome's PDFium draws
   * nothing for a link without an appearance stream, and a coloured box round every citation looks like the owner's own
   * marks. The flag is set on the open copy in memory only (this engine never saves a document), and it does not touch
   * the link itself: FPDFLink_Enumerate (getLinks) ignores annotation flags. A link that has its own appearance stream is
   * left alone and drawn, as Chrome does, and so is every other kind of annotation. This must run before the page's first
   * drawing with annotations, which is what makes the stream.
   */
  private hideLinkBorders(doc: PdfDocumentObject, pageIndex: number): void {
    const x = this.x;
    const page = this.ctx(doc).acquirePage(pageIndex);
    try {
      const count = x.FPDFPage_GetAnnotCount(page.pagePtr);
      for (let i = 0; i < count; i++) {
        const annot = x.FPDFPage_GetAnnot(page.pagePtr, i);
        if (!annot) continue;
        try {
          if (x.FPDFAnnot_GetSubtype(annot) !== FPDF_ANNOT_LINK || x.EPDFAnnot_HasAppearanceStream(annot, 0)) continue;
          x.FPDFAnnot_SetFlags(annot, x.FPDFAnnot_GetFlags(annot) | FPDF_ANNOT_FLAG_HIDDEN);
        } finally {
          x.FPDFPage_CloseAnnot(annot);
        }
      }
    } finally {
      page.release();
    }
  }

  // ---- text ----

  /**
   * Every char on the page with its PDFium geometry (P0-4). Runs come from getPageGeometry. Its boxes do not: it rounds
   * them to whole device pixels at 1 px per point (FPDF_PageToDevice), up to 0.5 pt off. So the boxes are read here,
   * unrounded, from the same FPDFText_GetLooseCharBox, with FPDFText_GetCharBox, GetCharAngle, IsGenerated,
   * GetFontSize and GetMatrix.
   */
  getGlyphs(docId: string, pageIndex: number): PageGlyphs {
    const { doc } = this.state(docId);
    const page = this.page(doc, pageIndex);
    const geometry = settled(this.getPageGeometry(doc, page));
    const runs = geometry.runs.map((r) => ({ start: r.charStart, end: r.charStart + r.glyphs.length }));

    const m = this.m;
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const mem = this.x.malloc(64);
    try {
      const textPage = pageCtx.getTextPage();
      const count = m.FPDFText_CountChars(textPage);
      const text = this.rawText(textPage, 0, count);
      const read = this.glyphReader(textPage, pageCtx.pagePtr, mem, text);
      const glyphs: Glyph[] = [];
      for (let i = 0; i < count; i++) glyphs.push(read(i));
      return { pageIndex, glyphs, runs };
    } finally {
      this.x.free(mem);
      pageCtx.release();
    }
  }

  /**
   * Reads char `i` of a text page as a Glyph: FPDFText_GetLooseCharBox, GetCharBox, GetMatrix, GetFontSize, GetCharAngle
   * and IsGenerated. `mem` is 64 bytes of scratch; `text` is rawText of the page.
   */
  private glyphReader(textPage: number, pagePtr: number, mem: number, text: string): (i: number) => Glyph {
    const m = this.m;
    const f32 = (offset: number) => this.h.float(mem + offset);
    const f64 = (offset: number) => this.h.double(mem + offset);
    const crop = this.cropBox(pagePtr, mem);
    const rect = (l: number, t: number, r: number, b: number): PdfRect => ({ x: l - crop.left, y: crop.top - t, width: r - l, height: t - b });
    return (i) => {
      m.FPDFText_GetLooseCharBox(textPage, i, mem); // FS_RECTF: left, top, right, bottom
      const box = rect(f32(0), f32(4), f32(8), f32(12));
      m.FPDFText_GetCharBox(textPage, i, mem, mem + 8, mem + 16, mem + 24); // doubles: left, right, bottom, top
      const tight = rect(f64(0), f64(24), f64(8), f64(16));
      m.FPDFText_GetMatrix(textPage, i, mem); // FS_MATRIX: a b c d e f (floats)
      const fontSize = m.FPDFText_GetFontSize(textPage, i) * Math.hypot(f32(8), f32(12));
      const angle = Math.round(((m.FPDFText_GetCharAngle(textPage, i) * 180) / Math.PI) * 1000) / 1000;
      return { index: i, text: text[i] ?? '', box, tight, fontSize, angle: angle % 360, generated: m.FPDFText_IsGenerated(textPage, i) === 1 };
    };
  }

  /**
   * The whole page's text as Copy writes it (PdfBackend.getPageCopyText): the text layer's text model (items.ts
   * pageCopyText) built from rawText, reading glyphs only at PDFium's generated line breaks and the chars either side,
   * so a page costs about as much as getPageChars instead of getGlyphs.
   */
  getPageCopyText(docId: string, pageIndex: number): { text: string; charCount: number } {
    return this.withTextPage(docId, pageIndex, (textPage, pagePtr) => {
      const count = this.x.FPDFText_CountChars(textPage);
      const text = this.rawText(textPage, 0, count);
      const mem = this.x.malloc(64);
      try {
        const read = this.glyphReader(textPage, pagePtr, mem, text);
        const read1 = new Map<number, Glyph>();
        const glyph = (i: number): Glyph => {
          let g = read1.get(i);
          if (!g) read1.set(i, (g = read(i)));
          return g;
        };
        return { text: pageCopyText(count, (i) => text[i] ?? '', glyph), charCount: count };
      } finally {
        this.x.free(mem);
      }
    });
  }

  getPageText(docId: string, pageIndex: number): string {
    return this.withTextPage(docId, pageIndex, (textPage) => stripPdfUnwantedMarkers(this.rawText(textPage, 0, this.x.FPDFText_CountChars(textPage))));
  }

  /** FPDFText_GetText over every char of the page, as it is: raw[i] is char i (PdfBackend.getPageChars). */
  getPageChars(docId: string, pageIndex: number): string {
    return this.withTextPage(docId, pageIndex, (textPage) => this.rawText(textPage, 0, this.x.FPDFText_CountChars(textPage)));
  }

  getTextRange(docId: string, pageIndex: number, start: number, count: number): string {
    return this.withTextPage(docId, pageIndex, (textPage) => {
      const [from, n] = clampRange(start, count, this.x.FPDFText_CountChars(textPage));
      return stripPdfUnwantedMarkers(this.rawText(textPage, from, n));
    });
  }

  /**
   * PDFium's rectangles for chars [start, start + count) (FPDFText_CountRects/GetRect: one per run of chars of one text
   * object, the union of their char boxes), joined where they continue a line: the next one overlaps the current one by
   * at least half the lower height vertically and starts no further than one line height away. A column gap is wider
   * than that, so the columns of a two-column page stay apart.
   */
  getTextRangeRects(docId: string, pageIndex: number, start: number, count: number): PdfRect[] {
    return this.withTextPage(docId, pageIndex, (textPage, pagePtr) => this.rangeRects(textPage, pagePtr, start, count));
  }

  searchPage(docId: string, pageIndex: number, query: string, opts: { matchCase: boolean; wholeWord: boolean }): SearchHit[] {
    if (query.length === 0) return [];
    return this.withTextPage(docId, pageIndex, (textPage, pagePtr) => {
      const flags = (opts.matchCase ? FPDF_MATCHCASE : 0) | (opts.wholeWord ? FPDF_MATCHWHOLEWORD : 0);
      const buf = this.x.malloc(2 * (query.length + 1));
      const found: { start: number; count: number }[] = [];
      try {
        this.h.writeUtf16(buf, query);
        const search = this.x.FPDFText_FindStart(textPage, buf, flags, 0);
        if (!search) return [];
        try {
          while (this.x.FPDFText_FindNext(search)) found.push({ start: this.x.FPDFText_GetSchResultIndex(search), count: this.x.FPDFText_GetSchCount(search) });
        } finally {
          this.x.FPDFText_FindClose(search);
        }
      } finally {
        this.x.free(buf);
      }
      return found.map((f) => ({ pageIndex, ...f, rects: this.rangeRects(textPage, pagePtr, f.start, f.count) }));
    });
  }

  private rangeRects(textPage: number, pagePtr: number, start: number, count: number): PdfRect[] {
    const [from, n] = clampRange(start, count, this.x.FPDFText_CountChars(textPage));
    if (n === 0) return [];
    const mem = this.x.malloc(32);
    try {
      const crop = this.cropBox(pagePtr, mem);
      const total = this.x.FPDFText_CountRects(textPage, from, n);
      const rects: PdfRect[] = [];
      for (let i = 0; i < total; i++) {
        if (!this.x.FPDFText_GetRect(textPage, i, mem, mem + 8, mem + 16, mem + 24)) continue; // doubles: left, top, right, bottom
        const [l, t, r, b] = [this.h.double(mem), this.h.double(mem + 8), this.h.double(mem + 16), this.h.double(mem + 24)];
        const rect = { x: Math.min(l, r) - crop.left, y: crop.top - Math.max(t, b), width: Math.abs(r - l), height: Math.abs(t - b) };
        if (rect.width > 0 && rect.height > 0) rects.push(rect);
      }
      return mergeLineRects(rects);
    } finally {
      this.x.free(mem);
    }
  }

  // ---- links and outline ----

  getLinks(docId: string, pageIndex: number): PdfLink[] {
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const mem = this.x.malloc(32);
    try {
      const crop = this.cropBox(pageCtx.pagePtr, mem);
      const links: PdfLink[] = [];
      this.h.setInt(mem, 0); // start_pos
      while (this.x.FPDFLink_Enumerate(pageCtx.pagePtr, mem, mem + 4)) {
        const link = this.h.int(mem + 4);
        if (!link || !this.x.FPDFLink_GetAnnotRect(link, mem + 8)) continue; // FS_RECTF: left, top, right, bottom
        const [l, t, r, b] = [this.h.float(mem + 8), this.h.float(mem + 12), this.h.float(mem + 16), this.h.float(mem + 20)];
        const target = this.linkTarget(doc, this.x.FPDFLink_GetDest(this.docPtr(doc), link), this.x.FPDFLink_GetAction(link));
        if (!target) continue;
        links.push({ rect: { x: Math.min(l, r) - crop.left, y: crop.top - Math.max(t, b), width: Math.abs(r - l), height: Math.abs(t - b) }, target });
      }
      return links;
    } finally {
      this.x.free(mem);
      pageCtx.release();
    }
  }

  getOutline(docId: string): OutlineItem[] {
    const { doc } = this.state(docId);
    const docPtr = this.docPtr(doc);
    const seen = new Set<number>();
    const walk = (parent: number, depth: number): OutlineItem[] => {
      const items: OutlineItem[] = [];
      for (let mark = this.x.FPDFBookmark_GetFirstChild(docPtr, parent); mark && !seen.has(mark) && seen.size < MAX_OUTLINE_ITEMS; mark = this.x.FPDFBookmark_GetNextSibling(docPtr, mark)) {
        seen.add(mark);
        items.push({
          title: this.utf16Call((buf, len) => this.x.FPDFBookmark_GetTitle(mark, buf, len)),
          target: this.linkTarget(doc, this.x.FPDFBookmark_GetDest(docPtr, mark), this.x.FPDFBookmark_GetAction(mark)),
          children: depth < MAX_TREE_DEPTH ? walk(mark, depth + 1) : [],
        });
      }
      return items;
    };
    return walk(0, 1);
  }

  /** A destination (dest) or else an action: GoTo goes to a page, URI to a URL; anything else gives null. */
  private linkTarget(doc: PdfDocumentObject, dest: number, action: number): LinkTarget | null {
    if (dest) return this.pageTarget(doc, dest);
    if (!action) return null;
    const type = this.x.FPDFAction_GetType(action);
    if (type === PDFACTION_GOTO) {
      const goTo = this.x.FPDFAction_GetDest(this.docPtr(doc), action);
      return goTo ? this.pageTarget(doc, goTo) : null;
    }
    if (type !== PDFACTION_URI) return null;
    const docPtr = this.docPtr(doc);
    const bytes = this.x.FPDFAction_GetURIPath(docPtr, action, 0, 0); // 7-bit ASCII with a NUL
    if (bytes <= 1) return null;
    const buf = this.x.malloc(bytes);
    try {
      this.x.FPDFAction_GetURIPath(docPtr, action, buf, bytes);
      return { kind: 'url', url: String.fromCharCode(...this.h.bytes(buf, bytes - 1)) };
    } finally {
      this.x.free(buf);
    }
  }

  /** FPDFDest_*: the page, and the point /XYZ (or /FitH, /FitV, /FitR …) names, in the target page's top-left space. */
  private pageTarget(doc: PdfDocumentObject, dest: number): LinkTarget | null {
    const pageIndex = this.x.FPDFDest_GetDestPageIndex(this.docPtr(doc), dest);
    if (pageIndex < 0 || pageIndex >= doc.pageCount) return null;
    const origin = pageOrigin(doc, pageIndex);
    const mem = this.x.malloc(64);
    try {
      let x: number | null = null;
      let y: number | null = null;
      // hasX, hasY, hasZoom (FPDF_BOOL), then x, y, zoom (FS_FLOAT)
      if (this.x.FPDFDest_GetLocationInPage(dest, mem, mem + 4, mem + 8, mem + 12, mem + 16, mem + 20)) {
        if (this.h.int(mem)) x = this.h.float(mem + 12);
        if (this.h.int(mem + 4)) y = this.h.float(mem + 16);
      } else {
        this.h.setInt(mem, 4); // in: room for 4 params
        const view = this.x.FPDFDest_GetView(dest, mem, mem + 8);
        const params = this.h.int(mem);
        const p = (i: number) => (i < params ? this.h.float(mem + 8 + 4 * i) : null);
        if (view === VIEW_FITH || view === VIEW_FITBH) y = p(0);
        else if (view === VIEW_FITV || view === VIEW_FITBV) x = p(0);
        else if (view === VIEW_FITR) [x, y] = [p(0), p(3)];
      }
      const finite = (v: number | null) => (v !== null && Number.isFinite(v) ? v : null);
      const left = finite(x);
      const top = finite(y);
      return { kind: 'page', pageIndex, top: top === null ? null : origin.top - top, left: left === null ? null : left - origin.left };
    } finally {
      this.x.free(mem);
    }
  }

  // ---- forms (P0-7) ----

  /**
   * The document's form type (FPDF_GetFormType) and, for an `acroform`, the first page with a fillable widget. XFA
   * documents are forms whatever their pages hold, so only `acroform` is walked.
   *
   * The walk loads no page. It reads each page's /Annots raw (EPDFPage_GetAnnotCountRaw/GetAnnotRaw) and asks every
   * Widget its field type, field flags and annotation flags, through one form-fill environment made for the call. Walks
   * that load the pages were too slow for the 200 ms bar on the 133-page NBER paper (P0-7): 25–50 ms for this walk,
   * 183–232 ms for FPDF_LoadPage + FPDFPage_GetAnnot on every page.
   *
   * A widget counts (see forms.ts) when its field is a check box, radio button, combo box, list box or text field; the
   * field is not read-only (field flag ReadOnly); and the widget is not Hidden, NoView or ReadOnly (annotation flags).
   *
   * Two things to know about the raw read:
   * - EPDFPage_GetAnnotRaw leaks 130–240 bytes an annotation in this wasm, though every annotation is closed with
   *   FPDFPage_CloseAnnot, and the memory is not given back when the document closes (R38). So call this once per
   *   document: PdfBackend memoizes it per handle and asks callers to cache it by fingerprint.
   * - A Widget that the /AcroForm /Fields tree leaves out is linked to its field only when its page is loaded
   *   (FORM_OnAfterLoadPage; PDFium's FixPageFields), so FPDFAnnot_GetFormFieldType gives -1 for it. A page with such a
   *   widget is read again loaded (FPDFPage_GetAnnot), as PDFium shows it.
   *
   * The widgets, the page and the form-fill environment are closed when the call ends, whatever happens.
   */
  getFormInfo(docId: string): FormInfo {
    const { doc } = this.state(docId);
    const x = this.x;
    const docPtr = this.docPtr(doc);
    const formType = FORM_TYPES[x.FPDF_GetFormType(docPtr)] ?? 'none';
    let firstFillablePage: number | null = null;
    let pagesWalked = 0;
    if (formType === 'acroform') {
      const formInfo = x.PDFiumExt_OpenFormFillInfo();
      const form = x.PDFiumExt_InitFormFillEnvironment(docPtr, formInfo);
      try {
        for (let pageIndex = 0; pageIndex < doc.pageCount && firstFillablePage === null; pageIndex++) {
          pagesWalked++;
          let widgets = this.widgets(form, x.EPDFPage_GetAnnotCountRaw(docPtr, pageIndex), (i) => x.EPDFPage_GetAnnotRaw(docPtr, pageIndex, i));
          if (widgets.some((w) => w.type === NO_FIELD)) {
            const page = this.ctx(doc).acquirePage(pageIndex);
            x.FORM_OnAfterLoadPage(page.pagePtr, form);
            try {
              widgets = this.widgets(form, x.FPDFPage_GetAnnotCount(page.pagePtr), (i) => x.FPDFPage_GetAnnot(page.pagePtr, i));
            } finally {
              x.FORM_OnBeforeClosePage(page.pagePtr, form);
              page.release();
            }
          }
          if (widgets.some((w) => w.fillable)) firstFillablePage = pageIndex;
        }
      } finally {
        x.PDFiumExt_ExitFormFillEnvironment(form);
        x.PDFiumExt_CloseFormFillInfo(formInfo);
      }
    }
    return { formType, firstFillablePage, pagesWalked };
  }

  /** The Widgets among `count` annotations (`annotAt(i)` opens one), each with its field type; every annotation is closed again. */
  private widgets(form: number, count: number, annotAt: (i: number) => number): { type: number; fillable: boolean }[] {
    const x = this.x;
    const out: { type: number; fillable: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      const annot = annotAt(i);
      if (!annot) continue;
      try {
        if (x.FPDFAnnot_GetSubtype(annot) !== FPDF_ANNOT_WIDGET) continue;
        const type = x.FPDFAnnot_GetFormFieldType(form, annot);
        const usable = (x.FPDFAnnot_GetFlags(annot) & ANNOT_FLAGS_NOT_FILLABLE) === 0 && (x.FPDFAnnot_GetFormFieldFlags(form, annot) & FIELD_FLAG_READONLY) === 0;
        out.push({ type, fillable: FILLABLE_FIELD_TYPES.has(type) && usable });
      } finally {
        x.FPDFPage_CloseAnnot(annot);
      }
    }
    return out;
  }

  // ---- page objects, structure, runs (P0-10) ----

  /**
   * The page's objects, depth first in content order. For each: FPDFPageObj_GetType, GetBounds and
   * GetMarkedContentID; for an image, FPDFImageObj_GetImagePixelSize and GetImageFilter(Count); for a path,
   * FPDFPath_CountSegments and GetDrawMode. With recurseForms, each form XObject is followed by its own objects, whose
   * bounds are mapped to the page through the forms' matrices (FPDFPageObj_GetMatrix). The walk stops once it holds
   * maxObjects objects or has run budgetMs (checked every 64 objects; the clock starts once the page is loaded, R31).
   */
  listPageObjects(docId: string, pageIndex: number, opts: { recurseForms?: boolean; maxObjects?: number; budgetMs?: number } = {}): PageObjectList {
    const limits = { ...OBJECT_LIMITS, ...opts };
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    const x = this.x;
    const h = this.h;
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const walkStart = performance.now();
    const mem = x.malloc(64);
    const objects: PageObjectInfo[] = [];
    let truncated = false;
    try {
      const crop = this.cropBox(pageCtx.pagePtr, mem);
      const visit = (obj: number, depth: number, matrix: Matrix | null): boolean => {
        if (objects.length >= limits.maxObjects || ((objects.length & 63) === 0 && performance.now() - walkStart > limits.budgetMs)) {
          truncated = true;
          return false;
        }
        const type = PAGE_OBJECT_TYPES[x.FPDFPageObj_GetType(obj)] ?? 'unknown';
        let [l, b, r, t] = [0, 0, 0, 0];
        if (x.FPDFPageObj_GetBounds(obj, mem, mem + 4, mem + 8, mem + 12)) {
          [l, b, r, t] = [h.float(mem), h.float(mem + 4), h.float(mem + 8), h.float(mem + 12)];
          if (matrix) [l, b, r, t] = transformBox(matrix, l, b, r, t);
        }
        const info: PageObjectInfo = {
          type,
          bounds: { x: l - crop.left, y: crop.top - t, width: r - l, height: t - b },
          formDepth: depth,
          markedContentId: x.FPDFPageObj_GetMarkedContentID(obj),
        };
        if (type === 'image') {
          x.FPDFImageObj_GetImagePixelSize(obj, mem, mem + 4);
          info.image = { pixelWidth: h.int(mem), pixelHeight: h.int(mem + 4), filters: this.imageFilters(obj) };
        } else if (type === 'path') {
          x.FPDFPath_GetDrawMode(obj, mem, mem + 4); // int fill mode (0 = none), FPDF_BOOL stroke
          info.path = { segmentCount: x.FPDFPath_CountSegments(obj), filled: h.int(mem) !== 0, stroked: h.int(mem + 4) !== 0 };
        }
        objects.push(info);
        if (type === 'form' && limits.recurseForms) {
          x.FPDFPageObj_GetMatrix(obj, mem); // FS_MATRIX: the form matrix, form space → its parent's space
          const own: Matrix = [h.float(mem), h.float(mem + 4), h.float(mem + 8), h.float(mem + 12), h.float(mem + 16), h.float(mem + 20)];
          const toPage = matrix ? concat(own, matrix) : own;
          const count = x.FPDFFormObj_CountObjects(obj);
          for (let k = 0; k < count; k++) if (!visit(x.FPDFFormObj_GetObject(obj, k), depth + 1, toPage)) return false;
        }
        return true;
      };
      const count = x.FPDFPage_CountObjects(pageCtx.pagePtr);
      for (let i = 0; i < count; i++) if (!visit(x.FPDFPage_GetObject(pageCtx.pagePtr, i), 0, null)) break;
    } finally {
      x.free(mem);
      pageCtx.release();
    }
    return { objects, truncated };
  }

  /**
   * The page's structure tree: FPDF_StructTree_GetForPage, then each element's type, alt text, actual text and
   * marked-content ids, and its element children (marked-content kids are not elements and are skipped), to depth 32.
   * PDFium returns an empty string for a missing /Alt or /ActualText, so both read null when empty.
   */
  getStructTree(docId: string, pageIndex: number): StructElement[] {
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    const x = this.x;
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const tree = x.FPDF_StructTree_GetForPage(pageCtx.pagePtr);
    try {
      if (!tree) return [];
      const element = (el: number, depth: number): StructElement => {
        const markedContentIds: number[] = [];
        const ids = x.FPDF_StructElement_GetMarkedContentIdCount(el);
        for (let k = 0; k < ids; k++) {
          const id = x.FPDF_StructElement_GetMarkedContentIdAtIndex(el, k);
          if (id >= 0) markedContentIds.push(id);
        }
        const children: StructElement[] = [];
        if (depth < MAX_TREE_DEPTH) {
          const kids = x.FPDF_StructElement_CountChildren(el);
          for (let k = 0; k < kids; k++) {
            const child = x.FPDF_StructElement_GetChildAtIndex(el, k);
            if (child) children.push(element(child, depth + 1));
          }
        }
        return {
          type: this.utf16Call((buf, len) => x.FPDF_StructElement_GetType(el, buf, len)),
          altText: this.utf16Call((buf, len) => x.FPDF_StructElement_GetAltText(el, buf, len)) || null,
          actualText: this.utf16Call((buf, len) => x.FPDF_StructElement_GetActualText(el, buf, len)) || null,
          markedContentIds,
          children,
        };
      };
      const out: StructElement[] = [];
      const count = x.FPDF_StructTree_CountChildren(tree);
      for (let k = 0; k < count; k++) {
        const el = x.FPDF_StructTree_GetChildAtIndex(tree, k);
        if (el) out.push(element(el, 1));
      }
      return out;
    } finally {
      if (tree) x.FPDF_StructTree_Close(tree);
      pageCtx.release();
    }
  }

  /**
   * The page's text as runs: its chars in index order, a new run whenever FPDFText_GetTextObject changes or the
   * baseline (FPDFText_GetCharOrigin's y) moves by more than half the run's font size. PDFium's generated line breaks
   * end a run and belong to none; a generated space belongs to a run only when the run goes on after it. `fontSize` is
   * FPDFTextObj_GetFontSize × the vertical scale of the first char's matrix (R30).
   *
   * Named getTextRuns, not getPageTextRuns: PdfiumNative's own getPageTextRuns (runs by font and colour) stays as it is.
   *
   * With opts.budgetMs it answers a TextRunList: the walk stops once it has run that long (checked every 256 chars,
   * the clock started once the page and its text page are loaded, as listPageObjects', R31), and the runs so far are
   * kept. Without, it reads every char and answers the runs alone.
   */
  getTextRuns(docId: string, pageIndex: number, opts?: { budgetMs?: number }): TextRun[] | TextRunList {
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    const x = this.x;
    const h = this.h;
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const mem = x.malloc(64);
    const budgetMs = opts?.budgetMs;
    try {
      const crop = this.cropBox(pageCtx.pagePtr, mem);
      const textPage = pageCtx.getTextPage();
      const walkStart = performance.now();
      const count = x.FPDFText_CountChars(textPage);
      const text = this.rawText(textPage, 0, count);
      let truncated = false;

      const runs: TextRun[] = [];
      let run: { start: number; end: number; obj: number; baseline: number; size: number; l: number; t: number; r: number; b: number } | null = null;
      const close = () => {
        if (!run) return;
        runs.push({
          text: text.slice(run.start, run.end),
          rect: { x: run.l - crop.left, y: crop.top - run.t, width: run.r - run.l, height: run.t - run.b },
          fontSize: run.size,
          charStart: run.start,
          charCount: run.end - run.start,
        });
        run = null;
      };
      for (let i = 0; i < count; i++) {
        if (budgetMs !== undefined && i > 0 && i % RUNS_CLOCK_EVERY === 0 && performance.now() - walkStart > budgetMs) {
          truncated = true;
          break;
        }
        const ch = text.charCodeAt(i);
        if (ch === 0x0d || ch === 0x0a) {
          close();
          continue;
        }
        if (x.FPDFText_IsGenerated(textPage, i) === 1) continue; // inside the run only if a later char extends it
        const obj = x.FPDFText_GetTextObject(textPage, i);
        x.FPDFText_GetCharOrigin(textPage, i, mem, mem + 8);
        const baseline = h.double(mem + 8);
        if (run && (obj !== run.obj || Math.abs(baseline - run.baseline) > run.size / 2)) close();
        x.FPDFText_GetLooseCharBox(textPage, i, mem); // FS_RECTF: left, top, right, bottom
        const [l, t, r, b] = [h.float(mem), h.float(mem + 4), h.float(mem + 8), h.float(mem + 12)];
        if (run) {
          run.end = i + 1;
          run.l = Math.min(run.l, l);
          run.t = Math.max(run.t, t);
          run.r = Math.max(run.r, r);
          run.b = Math.min(run.b, b);
          continue;
        }
        let size = 0;
        if (obj && x.FPDFTextObj_GetFontSize(obj, mem)) {
          const tf = h.float(mem);
          x.FPDFText_GetMatrix(textPage, i, mem); // FS_MATRIX: a b c d e f
          size = tf * Math.hypot(h.float(mem + 8), h.float(mem + 12));
        }
        run = { start: i, end: i + 1, obj, baseline, size: size > 0 ? size : t - b, l, t, r, b };
      }
      close();
      return budgetMs === undefined ? runs : { runs, truncated };
    } finally {
      x.free(mem);
      pageCtx.release();
    }
  }

  // ---- bold (P0-5, Phase 2 S11) ----

  /**
   * The glyph outlines of chars [charStart, charStart + charCount) (PdfBackend.getGlyphOutlines). Per glyph:
   *   1. its text object (FPDFText_GetTextObject) gives the font (FPDFTextObj_GetFont), the size (GetFontSize), the
   *      render mode (GetTextRenderMode) and, with the char, its fill and stroke colours (FPDFText_GetFillColor and
   *      GetStrokeColor). Invisible text is skipped: modes 3 and 7, or nothing painted with alpha above 0;
   *   2. the outline, in ems: FPDFFont_GetGlyphPath(font, argument, size), the argument being the char's Unicode value
   *      (GLYPH_ARG = unicode), or the forms in glyphArguments for ligatures and joined hyphens. Outlines are cached by
   *      font and argument for as long as the page stays loaded (see outlineCache);
   *   3. scaled by size × the char matrix's linear part (FPDFText_GetMatrix, whose translation is the text object's),
   *      moved to the char's origin (FPDFText_GetCharOrigin), flipped to a top-left origin and written as SVG path data.
   * Every PDFium call goes to the wasm exports directly (P0-5: about 3× cheaper than the wrappers).
   */
  getGlyphOutlines(docId: string, pageIndex: number, charStart: number, charCount: number): GlyphOutline[] {
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    const x = this.x;
    const h = this.h;
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const mem = x.malloc(64);
    try {
      const textPage = pageCtx.getTextPage();
      const total = x.FPDFText_CountChars(textPage);
      const [start, count] = clampRange(charStart, charCount, total);
      if (count === 0) return [];
      const end = start + count;
      const crop = this.cropBox(pageCtx.pagePtr, mem);
      let byFont = this.outlineCache.get(pageCtx);
      if (!byFont) this.outlineCache.set(pageCtx, (byFont = new Map<number, Map<number, CachedGlyph | null>>()));

      // Per char, over the range and a few chars either side: its text object (0 for a generated char) and origin.
      // PDFium expands a char code with several Unicode chars (a ligature, a surrogate pair) into that many chars,
      // which share the text object and the origin: they are one glyph.
      const lo = Math.max(0, start - GLYPH_GROUP_REACH);
      const hi = Math.min(total, end + GLYPH_GROUP_REACH);
      const objs = new Float64Array(hi - lo);
      const ox = new Float64Array(hi - lo);
      const oy = new Float64Array(hi - lo);
      for (let i = lo; i < hi; i++) {
        const obj = x.FPDFText_IsGenerated(textPage, i) === 1 ? 0 : x.FPDFText_GetTextObject(textPage, i);
        objs[i - lo] = obj;
        if (!obj) continue;
        x.FPDFText_GetCharOrigin(textPage, i, mem, mem + 8);
        ox[i - lo] = h.double(mem);
        oy[i - lo] = h.double(mem + 8);
      }
      const sameGlyph = (a: number, b: number) => objs[a - lo] !== 0 && objs[a - lo] === objs[b - lo] && ox[a - lo] === ox[b - lo] && oy[a - lo] === oy[b - lo];

      const objects = new Map<number, TextObjectPaint | null>(); // null: invisible text
      const paintOf = (obj: number, charIndex: number): TextObjectPaint | null => {
        const known = objects.get(obj);
        if (known !== undefined) return known;
        const paint = this.textObjectPaint(textPage, obj, charIndex, mem);
        objects.set(obj, paint);
        return paint;
      };

      const out: GlyphOutline[] = [];
      const units: number[] = [];
      let i = start;
      while (i < end) {
        const obj = objs[i - lo];
        if (!obj) {
          i++;
          continue;
        }
        let first = i;
        while (first > lo && sameGlyph(first - 1, first)) first--; // the range starts inside a ligature
        let next = i + 1;
        while (next < hi && sameGlyph(next - 1, next)) next++;
        const paint = paintOf(obj, first);
        if (!paint) {
          i = next;
          continue;
        }
        units.length = 0;
        for (let k = first; k < next; k++) units.push(x.FPDFText_GetUnicode(textPage, k));
        let glyph: CachedGlyph | null = null;
        for (const arg of this.glyphArguments(textPage, first, units)) {
          glyph = this.cachedGlyph(byFont, paint.font, arg, paint.size, mem);
          if (glyph) break;
        }
        if (glyph) {
          let placed = glyph.placed.get(paint.matrixKey);
          if (!placed) glyph.placed.set(paint.matrixKey, (placed = placeOutline(glyph.em, paint.matrix)));
          // The origin on the 1/100 pt grid, then the glyph's own points relative to it (see placeOutline).
          const x0 = Math.round(((ox[first - lo] ?? 0) - crop.left) * OUTLINE_PRECISION) + placed.x0;
          const y0 = Math.round((crop.top - (oy[first - lo] ?? 0)) * OUTLINE_PRECISION) + placed.y0;
          out.push({ charIndex: i, d: `M${x0 / OUTLINE_PRECISION} ${y0 / OUTLINE_PRECISION}${placed.tail}`, fill: paint.fill, stroke: paint.stroke });
        }
        i = next;
      }
      return out;
    } finally {
      x.free(mem);
      pageCtx.release();
    }
  }

  /**
   * Glyph outlines by font and FPDFFont_GetGlyphPath argument, per loaded page: the em-space outline, and its path data
   * for each char matrix it has been drawn with. A font pointer is valid only while a loaded page uses the font, and
   * PDFium may free it and reuse its address once the pages using it close, so the cache hangs off EmbedPDF's
   * PageContext, which lives exactly as long as the page stays loaded: a reloaded page gets a new PageContext and an
   * empty cache. null: the glyph has no outline (a space, a Type3 glyph).
   */
  private readonly outlineCache = new WeakMap<PageContext, Map<number, Map<number, CachedGlyph | null>>>();

  /** The glyph's outline in ems, as [segment type, x, y, close] per segment, from the cache or from PDFium. */
  private cachedGlyph(byFont: Map<number, Map<number, CachedGlyph | null>>, font: number, arg: number, size: number, mem: number): CachedGlyph | null {
    let byArg = byFont.get(font);
    if (!byArg) byFont.set(font, (byArg = new Map<number, CachedGlyph | null>()));
    const known = byArg.get(arg);
    if (known !== undefined) return known;
    const x = this.x;
    const path = font ? x.FPDFFont_GetGlyphPath(font, arg, size) : 0;
    const segments = path ? x.FPDFGlyphPath_CountGlyphSegments(path) : 0;
    let em: Float32Array | null = null;
    if (segments > 0) {
      em = new Float32Array(4 * segments);
      for (let s = 0; s < segments; s++) {
        const segment = x.FPDFGlyphPath_GetGlyphPathSegment(path, s);
        x.FPDFPathSegment_GetPoint(segment, mem, mem + 4);
        em[4 * s] = x.FPDFPathSegment_GetType(segment);
        em[4 * s + 1] = this.h.float(mem);
        em[4 * s + 2] = this.h.float(mem + 4);
        em[4 * s + 3] = x.FPDFPathSegment_GetClose(segment);
      }
    }
    const glyph = em ? { em, placed: new Map<string, PlacedOutline>() } : null;
    byArg.set(arg, glyph);
    return glyph;
  }

  /**
   * How the text object paints its glyphs: font, size, the linear part of the char matrix (size included), and the
   * fill and stroke colours its render mode uses. null for invisible text: render mode 3 or 7, or nothing painted
   * with an alpha above 0. `charIndex` is any char of the object (colours and matrix are the object's).
   */
  private textObjectPaint(textPage: number, obj: number, charIndex: number, mem: number): TextObjectPaint | null {
    const x = this.x;
    const h = this.h;
    const raw = x.FPDFTextObj_GetTextRenderMode(obj);
    const mode = raw >= 0 && raw <= 7 ? raw : 0;
    const colour = (get: (...a: number[]) => number): PdfColor | null =>
      get(textPage, charIndex, mem, mem + 4, mem + 8, mem + 12) ? [h.int(mem), h.int(mem + 4), h.int(mem + 8), h.int(mem + 12)] : null;
    const fillColour = FILLS_BY_MODE[mode] ? (colour(x.FPDFText_GetFillColor) ?? [0, 0, 0, 255]) : null;
    const strokeColour = STROKES_BY_MODE[mode] ? (colour(x.FPDFText_GetStrokeColor) ?? [0, 0, 0, 255]) : null;
    const fill = fillColour && fillColour[3] > 0 ? fillColour : null;
    const stroke = strokeColour && strokeColour[3] > 0 ? strokeColour : null;
    if (!fill && !stroke) return null;
    const size = x.FPDFTextObj_GetFontSize(obj, mem) ? h.float(mem) : 0;
    x.FPDFText_GetMatrix(textPage, charIndex, mem); // FS_MATRIX: a b c d e f (floats)
    const matrix: [number, number, number, number] = [size * h.float(mem), size * h.float(mem + 4), size * h.float(mem + 8), size * h.float(mem + 12)];
    return { font: x.FPDFTextObj_GetFont(obj), size, matrix, matrixKey: matrix.join(' '), fill, stroke };
  }

  /**
   * FPDFFont_GetGlyphPath arguments to try, in order, for the glyph of chars [first, first + units.length) (P0-5). The
   * call maps its argument through the font's CharCodeFromUnicode, so every form is a Unicode value. PDFium has no call
   * that returns a char's code: for a char without Unicode, FPDFText_GetUnicode already returns the code, so retrying
   * "with the char code" is the same call.
   * - One char: its Unicode value; for PDFium's joined line-end hyphen (FPDFText_IsHyphen; its Unicode reads 0x2),
   *   U+002D, then U+2010.
   * - Several chars (one glyph): the code point they compose to (a surrogate pair, a decomposed accent), the ligature
   *   they spell (U+FB01 for "fi"), and last the first char's own glyph.
   */
  private glyphArguments(textPage: number, first: number, units: number[]): number[] {
    const x = this.x;
    const [own = 0] = units;
    if (units.length === 1 && x.FPDFText_IsHyphen(textPage, first) === 1) return [0x2d, 0x2010, own];
    if (units.length === 1) return [own];
    const text = String.fromCharCode(...units);
    const composed = [...text.normalize('NFC')];
    const out: number[] = [];
    const single = composed.length === 1 ? composed[0]?.codePointAt(0) : undefined;
    if (single !== undefined) out.push(single);
    const ligature = LIGATURES[text];
    if (ligature !== undefined) out.push(ligature);
    out.push(own);
    return out;
  }

  // ---- image fingerprints (research 06 §5) ----

  /**
   * SHA-256 of the image object's raw stream data (FPDFImageObj_GetImageDataRaw), the object found by counting as
   * listPageObjects with recurseForms does. null when there is no such object, it is not an image, or it has no data.
   */
  async hashImageObject(docId: string, pageIndex: number, objectIndex: number): Promise<Sha256 | null> {
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    if (!Number.isInteger(objectIndex) || objectIndex < 0) return null;
    const x = this.x;
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    const bytes = ((): Uint8Array | null => {
      try {
        const obj = this.objectAt(pageCtx.pagePtr, objectIndex);
        if (!obj || PAGE_OBJECT_TYPES[x.FPDFPageObj_GetType(obj)] !== 'image') return null;
        const length = x.FPDFImageObj_GetImageDataRaw(obj, 0, 0);
        if (length <= 0) return null;
        const buf = x.malloc(length);
        try {
          x.FPDFImageObj_GetImageDataRaw(obj, buf, length);
          return this.h.bytes(buf, length);
        } finally {
          x.free(buf);
        }
      } finally {
        pageCtx.release();
      }
    })();
    return bytes ? sha256Hex(bytes) : null;
  }

  /** The page object at `index` in listPageObjects' recurseForms order (depth first, a form before its objects), or 0. */
  private objectAt(pagePtr: number, index: number): number {
    const x = this.x;
    let seen = 0;
    const visit = (obj: number): number => {
      if (seen++ === index) return obj;
      if (PAGE_OBJECT_TYPES[x.FPDFPageObj_GetType(obj)] === 'form') {
        const count = x.FPDFFormObj_CountObjects(obj);
        for (let k = 0; k < count && seen <= index; k++) {
          const found = visit(x.FPDFFormObj_GetObject(obj, k));
          if (found) return found;
        }
      }
      return 0;
    };
    const count = x.FPDFPage_CountObjects(pagePtr);
    for (let i = 0; i < count && seen <= index; i++) {
      const found = visit(x.FPDFPage_GetObject(pagePtr, i));
      if (found) return found;
    }
    return 0;
  }

  // ---- helpers ----

  private state(docId: string): DocState {
    const state = this.docs.get(docId);
    if (!state) throw new Error(`document ${docId} is not open`);
    return state;
  }

  private page(doc: PdfDocumentObject, pageIndex: number) {
    const page = Number.isInteger(pageIndex) ? doc.pages[pageIndex] : undefined;
    if (!page) throw new RangeError(`page ${pageIndex} is out of range (0–${doc.pageCount - 1})`);
    return page;
  }

  private ctx(doc: PdfDocumentObject): DocumentContext {
    const ctx = (this.cache as PdfCache).getContext(doc.id);
    if (!ctx) throw new Error(`document ${doc.id} is not open`);
    return ctx;
  }

  private docPtr(doc: PdfDocumentObject): number {
    return this.ctx(doc).docPtr;
  }

  private withTextPage<T>(docId: string, pageIndex: number, fn: (textPage: number, pagePtr: number) => T): T {
    const { doc } = this.state(docId);
    this.page(doc, pageIndex);
    const pageCtx = this.ctx(doc).acquirePage(pageIndex);
    try {
      return fn(pageCtx.getTextPage(), pageCtx.pagePtr);
    } finally {
      pageCtx.release();
    }
  }

  /** FPDF_GetPageBoundingBox (the crop box within the media box), in PDF space. */
  private cropBox(pagePtr: number, mem: number): PdfBox {
    this.x.FPDF_GetPageBoundingBox(pagePtr, mem);
    return { left: this.h.float(mem), top: this.h.float(mem + 4), right: this.h.float(mem + 8), bottom: this.h.float(mem + 12) };
  }

  /**
   * The text of chars [start, start + count): exactly one UTF-16 code unit per char, so text[k] is char start + k.
   *
   * FPDFText_GetText does not keep to that. It leaves out the chars whose Unicode value is 0, 2 or 3 (the codes of glyphs
   * a font has no mapping for, such as the tick labels of a plot) and the chars beyond the BMP (the italic letters of
   * maths), so on those pages everything after the first one sits too early and the tail of the buffer stays empty. It
   * returns the number of units it wrote, terminator included: when that is count + 1 nothing was left out and its text is
   * used as it is. Otherwise each char is read with FPDFText_GetUnicode, and a char that has no single unit of text gets
   * U+FFFF, which getPageText strips and anchoring folds away, as it does U+FFFE.
   */
  private rawText(textPage: number, start: number, count: number): string {
    if (count <= 0) return '';
    const buf = this.x.malloc(2 * (count + 1));
    try {
      if (this.x.FPDFText_GetText(textPage, start, count, buf) === count + 1) return this.h.utf16(buf, count);
    } finally {
      this.x.free(buf);
    }
    let text = '';
    for (let from = 0; from < count; from += 4096) {
      const units: number[] = [];
      for (let k = from; k < Math.min(count, from + 4096); k++) {
        const unicode = this.x.FPDFText_GetUnicode(textPage, start + k);
        const left = unicode === 0 || unicode === 2 || unicode === 3 || unicode > 0xffff; // the chars GetText leaves out
        units.push(left ? 0xffff : unicode);
      }
      text += String.fromCharCode(...units);
    }
    return text;
  }

  /** A PDFium call that writes UTF-16LE with a NUL and returns the byte count, NUL included, whatever the buffer. */
  private utf16Call(fn: (buf: number, len: number) => number): string {
    const bytes = fn(0, 0);
    if (bytes <= 2) return '';
    const buf = this.x.malloc(bytes);
    try {
      fn(buf, bytes);
      return this.h.utf16(buf, bytes / 2 - 1);
    } finally {
      this.x.free(buf);
    }
  }

  /** FPDFImageObj_GetImageFilter for each of the image's filters (ASCII names such as DCTDecode). */
  private imageFilters(obj: number): string[] {
    const x = this.x;
    const filters: string[] = [];
    const count = x.FPDFImageObj_GetImageFilterCount(obj);
    for (let k = 0; k < count; k++) {
      const bytes = x.FPDFImageObj_GetImageFilter(obj, k, 0, 0);
      if (bytes <= 1) continue;
      const buf = x.malloc(bytes);
      try {
        x.FPDFImageObj_GetImageFilter(obj, k, buf, bytes);
        filters.push(String.fromCharCode(...this.h.bytes(buf, bytes - 1)));
      } finally {
        x.free(buf);
      }
    }
    return filters;
  }
}

/** What getGlyphOutlines needs of a visible text object (textObjectPaint). */
interface TextObjectPaint {
  font: number;
  size: number;
  /** The char matrix's a, b, c, d, times the font size: em space → page space, without the translation. */
  matrix: [number, number, number, number];
  /** `matrix` as a cache key. */
  matrixKey: string;
  fill: PdfColor | null;
  stroke: PdfColor | null;
}

/** A glyph in the outline cache: its em-space outline, and its placed path data by char matrix (placeOutline). */
interface CachedGlyph {
  em: Float32Array;
  placed: Map<string, PlacedOutline>;
}

/**
 * A glyph's outline under one char matrix, ready to place at any origin: its first point (x0, y0) from the origin, in
 * 1/100 pt with y down, and the rest of its path data in relative commands. A glyph drawn many times on a page at one
 * size and angle is formatted once; each char then costs one absolute move. Every point is rounded on the 1/100 pt grid
 * relative to the origin, and the relative steps are differences of those rounded points, so nothing drifts.
 */
interface PlacedOutline {
  x0: number;
  y0: number;
  tail: string;
}

/**
 * placeOutline: SVG path data for an em-space outline ([type, x, y, close] per segment) under `m` (em → points, without
 * the translation), flipped to y down. A cubic is three BEZIERTO points: two controls, then the end, all three relative
 * to the point the curve starts from. After a close, the current point is the start of the closed contour.
 */
function placeOutline(em: Float32Array, m: [number, number, number, number]): PlacedOutline {
  const [a, b, c, d] = m;
  const P = OUTLINE_PRECISION;
  let x0 = 0;
  let y0 = 0;
  let [cx, cy] = [0, 0]; // the current point
  let [sx, sy] = [0, 0]; // the current contour's start
  let tail = '';
  let curve: number[] = [];
  let closeAfterCurve = false;
  const step = (x: number, y: number) => `${(x - cx) / P} ${(y - cy) / P}`;
  for (let s = 0; s < em.length; s += 4) {
    const gx = em[s + 1] ?? 0;
    const gy = em[s + 2] ?? 0;
    const x = Math.round((a * gx + c * gy) * P);
    const y = Math.round(-(b * gx + d * gy) * P);
    const type = em[s];
    const close = em[s + 3] !== 0;
    if (s === 0) {
      [x0, y0, cx, cy, sx, sy] = [x, y, x, y, x, y];
    } else if (type === FPDF_SEGMENT_MOVETO) {
      tail += `m${step(x, y)}`;
      [cx, cy, sx, sy] = [x, y, x, y];
    } else if (type === FPDF_SEGMENT_LINETO) {
      tail += `l${step(x, y)}`;
      [cx, cy] = [x, y];
    } else if (type === FPDF_SEGMENT_BEZIERTO) {
      curve.push(x, y);
      if (curve.length === 6) {
        const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = curve;
        tail += `c${step(x1, y1)} ${step(x2, y2)} ${step(x3, y3)}`;
        [cx, cy] = [x3, y3];
        curve = [];
      } else if (close) {
        closeAfterCurve = true;
        continue;
      }
    }
    if ((close || closeAfterCurve) && curve.length === 0) {
      tail += 'z';
      [cx, cy] = [sx, sy];
      closeAfterCurve = false;
    }
  }
  return { x0, y0, tail };
}

/** A PdfTask that failed: PDFium's error code (FPDF_ERR_*) when it gave one. */
class EngineTaskError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** The value of a PdfTask that has settled (PDFium calls are synchronous; the task only wraps the result). */
function settled<T>(task: PdfTask<T>): T {
  let out: { value: T } | undefined;
  let failure: unknown;
  task.wait(
    (value) => (out = { value }),
    (error) => (failure = error),
  );
  if (out) return out.value;
  const reason = (failure as { reason?: { code?: unknown; message?: unknown } } | undefined)?.reason;
  const code = typeof reason?.code === 'number' ? reason.code : null;
  throw new EngineTaskError(code, typeof reason?.message === 'string' ? reason.message : `PDFium task failed: ${JSON.stringify(failure ?? 'still pending')}`);
}

/** [start, count] cut to the page's `total` chars. */
function clampRange(start: number, count: number, total: number): [number, number] {
  const from = Math.max(0, Math.min(total, Math.floor(start)));
  const to = Math.max(from, Math.min(total, Math.floor(start + count)));
  return [from, to - from];
}

/**
 * Joins rectangles that continue a line (see getTextRangeRects): `next` joins `current` when they overlap vertically by
 * at least half the lower of the two heights and the horizontal gap between them is at most the taller height.
 */
export function mergeLineRects(rects: PdfRect[]): PdfRect[] {
  const out: PdfRect[] = [];
  let cur: PdfRect | null = null;
  for (const r of rects) {
    if (cur) {
      const overlap = Math.min(cur.y + cur.height, r.y + r.height) - Math.max(cur.y, r.y);
      const gap = Math.max(r.x - (cur.x + cur.width), cur.x - (r.x + r.width));
      if (overlap >= 0.5 * Math.min(cur.height, r.height) && gap <= Math.max(cur.height, r.height)) {
        const x = Math.min(cur.x, r.x);
        const y = Math.min(cur.y, r.y);
        cur = { x, y, width: Math.max(cur.x + cur.width, r.x + r.width) - x, height: Math.max(cur.y + cur.height, r.y + r.height) - y };
        continue;
      }
      out.push(cur);
    }
    cur = { ...r };
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * `rect` (unrotated page space of a `width` × `height` page) in the space the page is displayed in when turned
 * clockwise by `rotation`: what EmbedPDF's renderPageRect takes.
 */
export function rotateRect(rect: PdfRect, width: number, height: number, rotation: Rotation): PdfRect {
  const { x, y, width: w, height: h } = rect;
  switch (rotation) {
    case 90:
      return { x: height - y - h, y: x, width: h, height: w };
    case 180:
      return { x: width - x - w, y: height - y - h, width: w, height: h };
    case 270:
      return { x: y, y: width - x - w, width: h, height: w };
    default:
      return { x, y, width: w, height: h };
  }
}

/** The top-left corner (PDF space) of a page's crop box within its media box, without loading the page. */
function pageOrigin(doc: PdfDocumentObject, pageIndex: number): { left: number; top: number } {
  const boxes = doc.pages[pageIndex]?.boxes;
  if (!boxes) return { left: 0, top: doc.pages[pageIndex]?.size.height ?? 0 };
  const norm = (b: PdfBox): PdfBox => ({ left: Math.min(b.left, b.right), right: Math.max(b.left, b.right), bottom: Math.min(b.top, b.bottom), top: Math.max(b.top, b.bottom) });
  const media = norm(boxes.media);
  const crop = norm(boxes.crop);
  const left = Math.max(media.left, crop.left);
  const top = Math.min(media.top, crop.top);
  // PDFium uses the media box when the crop box does not meet it.
  return left < Math.min(media.right, crop.right) && top > Math.max(media.bottom, crop.bottom) ? { left, top } : { left: media.left, top: media.top };
}

/** Matrix product in PDF's row-vector order: `first`, then `then`. */
function concat(first: Matrix, then: Matrix): Matrix {
  const [a, b, c, d, e, f] = first;
  const [A, B, C, D, E, F] = then;
  return [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D, e * A + f * C + E, e * B + f * D + F];
}

/** The bounding box (PDF space: left, bottom, right, top) of a box mapped through `m`. */
function transformBox(m: Matrix, l: number, b: number, r: number, t: number): [number, number, number, number] {
  const [a, bb, c, d, e, f] = m;
  const xs = [a * l + c * b + e, a * r + c * b + e, a * l + c * t + e, a * r + c * t + e];
  const ys = [bb * l + d * b + f, bb * r + d * b + f, bb * l + d * t + f, bb * r + d * t + f];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
