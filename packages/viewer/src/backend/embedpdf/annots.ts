// Annotation I/O through PDFium (slice 8.2): writing a plan of PDF annotations into a copy of a file, and reading a page's
// annotations back. The call order is spike 8.0's recipes (docs/spikes/phase8-export-report.md, "Recipes"); every rect
// here is PDF USER SPACE (y up), as /Rect and /QuadPoints are in the file.
//
// The write handle (openSource) is our own, apart from the viewer's open document, and loads ONLY the pages that get
// notes: PDFium's incremental save rewrites every object a handle has loaded (spike, PDFium fault 2), so reading any
// other page on it would put that page into the update too.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { quadPoints, type PdfUserRect } from '@sop/core';
import { PdfFormatError, PdfPasswordError } from '../errors';
import type { ApFill, PdfAnnotation, PdfAnnotationPlan, Rotation, WriteAnnotationsOptions } from '../types';
import { dottedUnderlineStream, EMPTY_STREAM, fillBounds, fillStream } from './ap-streams';
import { fixXrefStreamTail, runtimeOf, SAVE_FLAGS, saveCopy } from './save-tail';

/** FPDF_ANNOT_* subtype numbers (fpdf_annot.h). */
const SUBTYPE = { Text: 1, Square: 5, Highlight: 9, Underline: 10, StrikeOut: 12, Popup: 16 } as const;
const SUBTYPE_NAMES: Record<number, string> = {
  0: 'Unknown', 1: 'Text', 2: 'Link', 3: 'FreeText', 4: 'Line', 5: 'Square', 6: 'Circle', 7: 'Polygon', 8: 'PolyLine', 9: 'Highlight', 10: 'Underline',
  11: 'Squiggly', 12: 'StrikeOut', 13: 'Stamp', 14: 'Caret', 15: 'Ink', 16: 'Popup', 17: 'FileAttachment', 18: 'Sound', 19: 'Movie', 20: 'Widget',
  21: 'Screen', 22: 'PrinterMark', 23: 'TrapNet', 24: 'Watermark', 25: '3D', 26: 'RichMedia', 27: 'XFAWidget', 28: 'Redact',
};
/** EPDFAnnot_SetName's icons: /Comment and /Note. */
const ICON = { comment: 0, note: 2 } as const;
/** An area or figure outline's width, points (spike recipe "Area, figure outline"). */
const BOX_BORDER = 1.5;
/** Room kept round a bold mark's glyphs, so its /Rect (= the appearance's /BBox) never clips them. */
const BOLD_MARGIN = 0.5;
/** Files bigger than this are read through FPDF_LoadCustomDocument in blocks, not copied whole into the heap (spike: 183 MB RSS, not 482 MB, on 170 MB). */
export const CUSTOM_LOAD_ABOVE = 64 * 2 ** 20;
/** The custom loader reads the Blob this many bytes at a time and keeps the last block (PDFium asks for 4 KB at a time). */
const READ_BLOCK = 2 ** 20;

type Exports = { memory: WebAssembly.Memory; malloc(n: number): number; free(p: number): void };

/** A source the writer can open: bytes in hand, or a Blob (read whole, or in blocks when large and FileReaderSync exists). */
export type WriteSource = Blob | ArrayBuffer | Uint8Array;

/** PDF date (ISO 32000-1 7.9.4), UTC, one-second resolution: D:YYYYMMDDHHmmSSZ (spike rule R6). */
export function pdfDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** A PDF date to Unix ms. Accepts D:YYYY[MM[DD[HH[mm[SS[O[HH['[mm]]]]]]]]] and the same without "D:". */
export function parsePdfDate(s: string | null): number | null {
  if (!s) return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(?:(\d{2})'?(?:(\d{2})'?)?)?)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', o, oh = '00', om = '00'] = m;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  if (o === '+' || o === '-') t -= (o === '+' ? 1 : -1) * (Number(oh) * 60 + Number(om)) * 60_000;
  return Number.isFinite(t) ? t : null;
}

/** The helpers every call here needs: the heap, UTF-16 strings, rects. */
class Io {
  readonly x: Exports;
  constructor(readonly m: WrappedPdfiumModule) {
    this.x = m.pdfium.wasmExports as unknown as Exports;
  }
  private get f32(): Float32Array {
    return new Float32Array(this.x.memory.buffer);
  }
  /** `s` as UTF-16LE with a terminating NUL in the heap (FPDF_WIDESTRING), for the length of `fn`. */
  withWide<T>(s: string, fn: (p: number) => T): T {
    const p = this.x.malloc(2 * (s.length + 1));
    try {
      const u16 = new Uint16Array(this.x.memory.buffer, p, s.length + 1);
      for (let i = 0; i < s.length; i++) u16[i] = s.charCodeAt(i);
      u16[s.length] = 0;
      return fn(p);
    } finally {
      this.x.free(p);
    }
  }
  setString(annot: number, key: string, value: string): boolean {
    return this.withWide(value, (p) => this.m.FPDFAnnot_SetStringValue(annot, key, p));
  }
  getString(annot: number, key: string): string | null {
    if (!this.m.FPDFAnnot_HasKey(annot, key)) return null;
    const need = this.m.FPDFAnnot_GetStringValue(annot, key, 0, 0);
    if (need <= 2) return '';
    const p = this.x.malloc(need);
    try {
      this.m.FPDFAnnot_GetStringValue(annot, key, p, need);
      const units = new Uint16Array(this.x.memory.buffer, p, Math.floor(need / 2) - 1); // without the NUL
      let out = '';
      for (let i = 0; i < units.length; i += 4096) out += String.fromCharCode(...units.subarray(i, i + 4096));
      return out;
    } finally {
      this.x.free(p);
    }
  }
  /** /Rect from a user-space rect (FS_RECTF's memory order is left, top, right, bottom). */
  setRect(annot: number, r: PdfUserRect): boolean {
    const p = this.x.malloc(16);
    try {
      this.f32.set([r.x, r.y + r.height, r.x + r.width, r.y], p >> 2);
      return this.m.FPDFAnnot_SetRect(annot, p);
    } finally {
      this.x.free(p);
    }
  }
  getRect(annot: number): PdfUserRect {
    const p = this.x.malloc(16);
    try {
      this.m.FPDFAnnot_GetRect(annot, p);
      const [l, t, r, b] = this.f32.subarray(p >> 2, (p >> 2) + 4);
      return { x: Math.min(l, r), y: Math.min(t, b), width: Math.abs(r - l), height: Math.abs(t - b) };
    } finally {
      this.x.free(p);
    }
  }
  appendQuad(annot: number, q: readonly number[]): boolean {
    const p = this.x.malloc(32);
    try {
      this.f32.set(q, p >> 2);
      return this.m.FPDFAnnot_AppendAttachmentPoints(annot, p);
    } finally {
      this.x.free(p);
    }
  }
  quads(annot: number): PdfUserRect[] {
    const out: PdfUserRect[] = [];
    if (!this.m.FPDFAnnot_HasAttachmentPoints(annot)) return out;
    const n = this.m.FPDFAnnot_CountAttachmentPoints(annot);
    const p = this.x.malloc(32);
    try {
      for (let i = 0; i < n; i++) {
        if (!this.m.FPDFAnnot_GetAttachmentPoints(annot, i, p)) continue;
        const f = Array.from(this.f32.subarray(p >> 2, (p >> 2) + 8));
        const xs = [f[0], f[2], f[4], f[6]];
        const ys = [f[1], f[3], f[5], f[7]];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        out.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
      }
    } finally {
      this.x.free(p);
    }
    return out;
  }
  /** /C as written (FPDFAnnot_GetColor answers false for a markup annotation that has an appearance: use EPDFAnnot_GetColor). */
  colour(annot: number): [number, number, number] | null {
    const p = this.x.malloc(12);
    try {
      if (!this.m.EPDFAnnot_GetColor(annot, 0, p, p + 4, p + 8)) return null;
      const u = new Uint32Array(this.x.memory.buffer, p, 3);
      return [u[0], u[1], u[2]];
    } finally {
      this.x.free(p);
    }
  }
  opacity(annot: number): number | null {
    const p = this.x.malloc(4);
    try {
      return this.m.EPDFAnnot_GetOpacity(annot, p) ? new Uint32Array(this.x.memory.buffer, p, 1)[0] / 255 : null;
    } finally {
      this.x.free(p);
    }
  }
}

/** An open write handle on a source, and how to free it (the handle first, then the bytes or the loader it reads). */
interface Opened {
  doc: number;
  length: number;
  close(): void;
}

/** A Blob read synchronously in blocks, for FPDF_LoadCustomDocument (the engine worker has FileReaderSync). */
type SyncReader = { readAsArrayBuffer(b: Blob): ArrayBuffer };
const syncReaderCtor = (): (new () => SyncReader) | undefined => (globalThis as { FileReaderSync?: new () => SyncReader }).FileReaderSync;

/** Opens `source` on a handle of our own. Wrong or missing password → PdfPasswordError; not a PDF → PdfFormatError. */
async function openSource(io: Io, source: WriteSource, password: string): Promise<Opened> {
  const { m, x } = io;
  const fail = (): never => {
    const code = m.FPDF_GetLastError();
    if (code === 4) throw new PdfPasswordError(password !== '');
    throw new PdfFormatError();
  };
  const Reader = syncReaderCtor();
  if (source instanceof Blob && source.size > CUSTOM_LOAD_ABOVE && Reader) {
    const blob = source;
    const reader = new Reader();
    let block: { start: number; bytes: Uint8Array } | null = null;
    const getBlock = (_param: number, position: number, buf: number, size: number): number => {
      let done = 0;
      while (done < size) {
        const at = position + done;
        if (block === null || at < block.start || at >= block.start + block.bytes.length) {
          const start = Math.floor(at / READ_BLOCK) * READ_BLOCK;
          block = { start, bytes: new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, Math.min(blob.size, start + READ_BLOCK)))) };
          if (block.bytes.length === 0) return 0;
        }
        const from = at - block.start;
        const n = Math.min(size - done, block.bytes.length - from);
        new Uint8Array(x.memory.buffer, buf + done, n).set(block.bytes.subarray(from, from + n));
        done += n;
      }
      return 1;
    };
    const runtime = runtimeOf(m);
    const fn = runtime.addFunction(getBlock, 'iiiii');
    // FPDF_FILEACCESS: { unsigned long m_FileLen; m_GetBlock; void* m_Param } (wasm32: three 32-bit words)
    const access = x.malloc(12);
    new Uint32Array(x.memory.buffer, access, 3).set([blob.size, fn, 0]);
    const doc = m.FPDF_LoadCustomDocument(access, password);
    const free = () => {
      x.free(access);
      runtime.removeFunction(fn);
    };
    if (!doc) {
      free();
      return fail();
    }
    return { doc, length: blob.size, close: () => (m.FPDF_CloseDocument(doc), free()) };
  }
  const bytes = source instanceof Blob ? new Uint8Array(await source.arrayBuffer()) : source instanceof Uint8Array ? source : new Uint8Array(source);
  const buf = x.malloc(Math.max(1, bytes.length));
  new Uint8Array(x.memory.buffer, buf, bytes.length).set(bytes);
  const doc = m.FPDF_LoadMemDocument(buf, bytes.length, password);
  if (!doc) {
    x.free(buf);
    return fail();
  }
  return { doc, length: bytes.length, close: () => (m.FPDF_CloseDocument(doc), x.free(buf)) };
}

/**
 * Writes `plan` into a copy of `source` and returns the copy's bytes: with `save: 'tail'` only what PDFium appends (the
 * caller puts it after the original's own bytes), otherwise the whole file. Throws, and returns nothing, when any note
 * could not be written: a copy that silently lacks a note would lose it.
 */
export async function writeAnnotationsCopy(m: WrappedPdfiumModule, source: WriteSource, plan: readonly PdfAnnotationPlan[], o: WriteAnnotationsOptions): Promise<Uint8Array> {
  const io = new Io(m);
  const opened = await openSource(io, source, o.password ?? '');
  try {
    const errors = writePlan(io, opened.doc, plan, o.boldFills ?? {});
    if (o.info) writeInfo(io, opened.doc, o.info, errors);
    if (o.pageOrder) movePagesTo(io, opened.doc, o.pageOrder, errors);
    if (errors.length > 0) throw new Error(`${errors.length} note${errors.length === 1 ? '' : 's'} could not be written (${errors.slice(0, 3).join('; ')})`);
    if (o.save === 'full') return saveCopy(m, opened.doc, SAVE_FLAGS.noIncremental, 0).bytes;
    const skip = o.save === 'tail' ? opened.length : 0;
    const saved = saveCopy(m, opened.doc, SAVE_FLAGS.incremental, skip);
    if (saved.total <= opened.length) throw new Error('PDFium saved no update');
    if (o.save === 'tail') return fixXrefStreamTail(saved.bytes, opened.length).bytes;
    const tail = fixXrefStreamTail(saved.bytes.subarray(opened.length), opened.length).bytes;
    const whole = new Uint8Array(opened.length + tail.length);
    whole.set(saved.bytes.subarray(0, opened.length));
    whole.set(tail, opened.length);
    return whole;
  } finally {
    opened.close();
  }
}

/**
 * The document information dictionary entries (EPDF_SetMetaText). Only into a file that has an information dictionary:
 * for one that has none, PDFium makes a new one but leaves it out of the update's cross-reference stream (/Info is
 * missing from its dictionary), so no reader would find it. Seen on paper-50 (a LaTeX file without /Info), 7 Nov 2026.
 */
function writeInfo(io: Io, doc: number, info: NonNullable<WriteAnnotationsOptions['info']>, errors: string[]): void {
  if (io.m.EPDF_GetMetaKeyCount(doc, false) <= 0) return;
  for (const [key, value] of [['Keywords', info.keywords], ['Subject', info.subject]] as const) {
    if (value === undefined) continue;
    if (!io.withWide(value, (p) => io.m.EPDF_SetMetaText(doc, key, p))) errors.push(`document ${key} not set`);
  }
}

/**
 * R108: puts the copy's pages in `order` (the original index at each position). FPDF_MovePages with every page, in the
 * new order, to index 0 leaves exactly that order. A copy in the wrong order would put notes on the wrong pages for the
 * reader, so anything odd is an error and no copy is made.
 */
function movePagesTo(io: Io, doc: number, order: readonly number[], errors: string[]): void {
  const n = io.m.FPDF_GetPageCount(doc);
  const seen = new Set(order);
  if (order.length !== n || seen.size !== n || order.some((p) => !Number.isInteger(p) || p < 0 || p >= n)) {
    errors.push(`the page order does not fit this file's ${n} pages`);
    return;
  }
  if (order.every((p, k) => p === k)) return;
  const p = io.x.malloc(4 * n);
  try {
    new Int32Array(io.x.memory.buffer, p, n).set(order);
    if (!io.m.FPDF_MovePages(doc, p, n, 0)) errors.push('the pages could not be put in the new order');
  } finally {
    io.x.free(p);
  }
}

const rotationOf = (m: WrappedPdfiumModule, page: number): Rotation => ((((m.FPDFPage_GetRotation(page) % 4) + 4) % 4) * 90) as Rotation;

/** Creates every planned annotation, in plan order (a root and its popup come before their replies). Returns what failed. */
function writePlan(io: Io, doc: number, plan: readonly PdfAnnotationPlan[], boldFills: Record<string, ApFill[]>): string[] {
  const { m } = io;
  const errors: string[] = [];
  const pages = new Map<number, number>();
  const byNm = new Map<string, number>();
  const open: number[] = [];
  try {
    for (const p of plan) {
      let page = pages.get(p.pageIndex);
      if (page === undefined) {
        page = m.FPDF_LoadPage(doc, p.pageIndex);
        if (!page) {
          errors.push(`${p.nm}: page ${p.pageIndex + 1} did not load`);
          continue;
        }
        pages.set(p.pageIndex, page);
      }
      const a = m.EPDFPage_CreateAnnot(page, SUBTYPE[p.subtype]);
      if (!a) {
        errors.push(`${p.nm}: not created`);
        continue;
      }
      open.push(a);
      byNm.set(p.nm, a);
      const ok = (what: string, done: boolean) => {
        if (!done) errors.push(`${p.nm}: ${what}`);
      };
      const fills = p.ap.kind === 'bold-outlines' ? (boldFills[p.nm] ?? []) : [];
      const rect = p.ap.kind === 'bold-outlines' ? boldRect(p.rect, fills) : p.rect;
      ok('NM', io.setString(a, 'NM', p.nm));
      ok('Rect', io.setRect(a, rect));
      if (p.author !== null) ok('T', io.setString(a, 'T', p.author));
      if (p.contents !== null) ok('Contents', io.setString(a, 'Contents', p.contents));
      if (p.subject !== null) ok('Subj', io.setString(a, 'Subj', p.subject));
      ok('M', io.setString(a, 'M', pdfDate(p.modifiedAt)));
      ok('CreationDate', io.setString(a, 'CreationDate', pdfDate(p.createdAt)));
      ok('F', m.FPDFAnnot_SetFlags(a, p.flags));
      const rotation = p.quads.length > 0 ? rotationOf(m, page) : 0;
      const quads = p.quads.map((q) => quadPoints(q, rotation));
      for (const q of quads) ok('QuadPoints', io.appendQuad(a, q));
      if (p.rgb) ok('C', m.EPDFAnnot_SetColor(a, 0, p.rgb[0], p.rgb[1], p.rgb[2]));
      if (p.subtype === 'Square') {
        // a bold mark is its glyphs only; an area or figure outline is a solid line in its colour, with no fill
        if (p.ap.kind === 'bold-outlines') ok('Border', m.FPDFAnnot_SetBorder(a, 0, 0, 0));
        else ok('BS', m.EPDFAnnot_SetBorderStyle(a, 1, BOX_BORDER));
      }
      if (p.subtype === 'Text') ok('Name', m.EPDFAnnot_SetName(a, p.subject === null ? ICON.comment : ICON.note));
      if (p.irt !== null) {
        const root = byNm.get(p.irt);
        if (root === undefined) errors.push(`${p.nm}: its comment ${p.irt} is not written yet`);
        else {
          ok('IRT', m.EPDFAnnot_SetLinkedAnnot(a, 'IRT', root));
          ok('RT', m.EPDFAnnot_SetReplyType(a, 1)); // /RT /R
        }
      }
      if (p.popupOf !== null) {
        const parent = byNm.get(p.popupOf);
        if (parent === undefined) errors.push(`${p.nm}: its note ${p.popupOf} is not written yet`);
        else {
          ok('Popup', m.EPDFAnnot_SetLinkedAnnot(parent, 'Popup', a));
          ok('Parent', m.EPDFAnnot_SetLinkedAnnot(a, 'Parent', parent));
        }
      }
      // the appearance (a /Popup has none at all: ISO 32000-1 12.5.6.14)
      switch (p.ap.kind) {
        case 'text-markup':
          ok('AP', p.subtype === 'Highlight' ? m.EPDFAnnot_GenerateAppearanceWithBlend(a, 1) /* Multiply */ : m.EPDFAnnot_GenerateAppearance(a));
          break;
        case 'dotted-underline':
          ok('AP', setAp(io, a, dottedUnderlineStream(quads, p.rgb ?? [0, 0, 0])));
          break;
        case 'bold-outlines':
          // text whose glyphs have no outline (a Type3 font) keeps its "Bold" annotation, drawn as nothing
          ok('AP', setAp(io, a, fills.length > 0 ? fillStream(fills) : EMPTY_STREAM));
          break;
        case 'box':
        case 'note-icon':
          ok('AP', m.EPDFAnnot_GenerateAppearance(a));
          break;
        case 'empty':
          if (p.subtype !== 'Popup') ok('AP', setAp(io, a, EMPTY_STREAM));
          break;
      }
    }
  } finally {
    for (const a of open) m.FPDFPage_CloseAnnot(a);
    for (const page of pages.values()) m.FPDF_ClosePage(page);
  }
  return errors;
}

const setAp = (io: Io, annot: number, stream: string): boolean => io.withWide(stream, (p) => io.m.FPDFAnnot_SetAP(annot, 0 /* normal */, p));

/** A bold mark's /Rect: its line rects and its emboldened glyphs, with a little room, so the appearance is never clipped. */
function boldRect(r: PdfUserRect, fills: readonly ApFill[]): PdfUserRect {
  const g = fillBounds(fills);
  const x0 = Math.min(r.x, g?.x ?? r.x) - BOLD_MARGIN;
  const y0 = Math.min(r.y, g?.y ?? r.y) - BOLD_MARGIN;
  const x1 = Math.max(r.x + r.width, g ? g.x + g.width : r.x + r.width) + BOLD_MARGIN;
  const y1 = Math.max(r.y + r.height, g ? g.y + g.height : r.y + r.height) + BOLD_MARGIN;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Every annotation of a loaded page, in /Annots order (contracts §9's PdfAnnotation). */
export function readPageAnnotations(m: WrappedPdfiumModule, page: number, pageIndex: number): PdfAnnotation[] {
  const io = new Io(m);
  const out: PdfAnnotation[] = [];
  const n = m.FPDFPage_GetAnnotCount(page);
  for (let i = 0; i < n; i++) {
    const a = m.FPDFPage_GetAnnot(page, i);
    if (!a) continue;
    try {
      const irt = m.FPDFAnnot_GetLinkedAnnot(a, 'IRT');
      const irtObjectNumber = irt ? m.EPDFAnnot_GetObjectNumber(irt) : null;
      if (irt) m.FPDFPage_CloseAnnot(irt);
      out.push({
        objectNumber: m.EPDFAnnot_GetObjectNumber(a),
        nm: io.getString(a, 'NM'),
        subtype: SUBTYPE_NAMES[m.FPDFAnnot_GetSubtype(a)] ?? 'Unknown',
        pageIndex,
        rect: io.getRect(a),
        quads: io.quads(a),
        rgb: io.colour(a),
        opacity: io.opacity(a),
        contents: io.getString(a, 'Contents'),
        author: io.getString(a, 'T'),
        subject: io.getString(a, 'Subj'),
        createdAt: parsePdfDate(io.getString(a, 'CreationDate')),
        modifiedAt: parsePdfDate(io.getString(a, 'M')),
        irtObjectNumber,
        replyType: irtObjectNumber === null ? null : m.EPDFAnnot_GetReplyType(a) === 2 ? 'Group' : 'R',
        flags: m.FPDFAnnot_GetFlags(a),
        hasAppearance: !!m.EPDFAnnot_HasAppearanceStream(a, 0),
      });
    } finally {
      m.FPDFPage_CloseAnnot(a);
    }
  }
  return out;
}
