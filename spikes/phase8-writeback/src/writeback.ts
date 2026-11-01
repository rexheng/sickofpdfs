// Write-back recipes: create PDF annotations in an open document through PDFium's own exports (the ones in our
// pdfium.wasm: EPDFPage_CreateAnnot, FPDFAnnot_*, EPDFAnnot_*), then save only the new bytes.
//
// This is the spike's code. The product's version is slice 8.2 (annots.ts, ap-streams.ts, save-tail.ts); the recipes
// that worked are written down in docs/spikes/phase8-export-report.md.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';
import { loadEngine } from './engine.ts';
import { makeReader, type PdfAnnotation } from './readback.ts';

/** FPDF_ANNOT_* subtype numbers (fpdf_annot.h). */
export const SUBTYPE = { Text: 1, Square: 5, Highlight: 9, Underline: 10, StrikeOut: 12, Popup: 16 } as const;
/** Annotation flags, ISO 32000-1 Table 165: bit position n is the value 2^(n-1). */
export const FLAG = { Invisible: 1, Hidden: 2, Print: 4, NoZoom: 8, NoRotate: 16, NoView: 32, ReadOnly: 64, Locked: 128, LockedContents: 512 } as const;
/** FPDF_SaveAsCopy flags. */
export const SAVE = { incremental: 1, noIncremental: 2, removeSecurity: 3 } as const;

export interface Pt { x: number; y: number }
/** A quadrilateral, written in Acrobat's order: top-left, top-right, bottom-left, bottom-right (user space, y up). */
export type Quad = [Pt, Pt, Pt, Pt];

export interface AnnotSpec {
  subtype: keyof typeof SUBTYPE;
  pageIndex: number;
  /** [left, bottom, right, top] in user space. */
  rect: [number, number, number, number];
  quads?: Quad[];
  /** Or the eight numbers of each quad, already in the order to write (core's quadPoints). */
  quadNumbers?: number[][];
  rgb?: [number, number, number] | null;
  /** Interior colour, Square only. */
  ic?: [number, number, number] | null;
  opacity?: number;
  nm: string;
  author?: string;
  contents?: string;
  subject?: string;
  created?: Date;
  modified?: Date;
  flags?: number;
  /** NM of the annotation this one replies to; the target must have been created earlier in the same run. */
  irtNm?: string;
  rt?: 'R' | 'Group';
  /** NM of the annotation this Popup belongs to. */
  popupOfNm?: string;
  /** Border width in points for Square, dash pattern in points (empty = solid). */
  borderWidth?: number;
  dash?: number[];
  /** Text note icon: /Name /Comment (default) or /Note. */
  iconName?: 'Comment' | 'Note';
  /** Border width in points for a Square whose appearance is drawn from page objects: 0 = no border at all. */
  noBorder?: boolean;
  /** How the appearance is made. */
  ap: 'pdfium' | 'pdfium-multiply' | 'none' | { stream: string };
}

export function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export async function makeWritebackEngine() {
  const { mod, SopPdfiumNative } = await loadEngine();

  class WritebackNative extends SopPdfiumNative {
    // `pdfiumModule` and `cache` are protected in the patched PdfiumNative typings; read them without a type dependency.
    private get wasm(): WrappedPdfiumModule {
      return (this as unknown as { pdfiumModule: WrappedPdfiumModule }).pdfiumModule;
    }
    private get cacheRef() {
      return (this as unknown as { cache: { getContext(id: string): { docPtr: number; acquirePage(i: number): { pagePtr: number; release(): void } } | undefined } }).cache;
    }
    docPointer(docId: string): number {
      const ctx = this.cacheRef.getContext(docId);
      if (!ctx) throw new Error(`document ${docId} is not open`);
      return ctx.docPtr;
    }

    private wbMemory() { return (mod.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory }).memory; }
    private wbMalloc(n: number): number { return mod.pdfium.wasmExports.malloc(n); }
    private wbFree(p: number): void { mod.pdfium.wasmExports.free(p); }

    /** Allocates a UTF-16LE, NUL-terminated copy of `s` in the wasm heap. The caller frees it. */
    private wbWstr(s: string): number {
      const bytes = 2 * (s.length + 1);
      const ptr = this.wbMalloc(bytes);
      mod.pdfium.stringToUTF16(s, ptr, bytes);
      return ptr;
    }
    private wbWithW<T>(s: string, f: (p: number) => T): T {
      const p = this.wbWstr(s);
      try { return f(p); } finally { this.wbFree(p); }
    }
    setStr(annot: number, key: string, value: string): boolean {
      return this.wbWithW(value, (p) => this.wasm.FPDFAnnot_SetStringValue(annot, key, p));
    }
    getStr(annot: number, key: string): string | null {
      const m = this.wasm;
      if (!m.FPDFAnnot_HasKey(annot, key)) return null;
      const need = m.FPDFAnnot_GetStringValue(annot, key, 0, 0);
      const p = this.wbMalloc(need + 2);
      try {
        m.FPDFAnnot_GetStringValue(annot, key, p, need + 2);
        return mod.pdfium.UTF16ToString(p);
      } finally { this.wbFree(p); }
    }
    private setRect(annot: number, r: [number, number, number, number]): boolean {
      const p = this.wbMalloc(16);
      try {
        const f = new Float32Array(this.wbMemory().buffer, p, 4);
        f[0] = r[0]; f[1] = r[3]; f[2] = r[2]; f[3] = r[1]; // FS_RECTF: left, top, right, bottom
        return this.wasm.FPDFAnnot_SetRect(annot, p);
      } finally { this.wbFree(p); }
    }
    private appendQuad(annot: number, q: Quad | number[]): boolean {
      const p = this.wbMalloc(32);
      try {
        const f = new Float32Array(this.wbMemory().buffer, p, 8);
        if (typeof q[0] === 'number') (q as number[]).forEach((v, i) => { f[i] = v; });
        else (q as Quad).forEach((pt, i) => { f[2 * i] = pt.x; f[2 * i + 1] = pt.y; });
        return this.wasm.FPDFAnnot_AppendAttachmentPoints(annot, p);
      } finally { this.wbFree(p); }
    }

    /** Every annotation of every page of `doc`, read back through PDFium (the product's readAnnotations, spike version). */
    readAll(doc: number, pageCount: number): PdfAnnotation[] {
      const read = makeReader(this.wasm, { get: (a, k) => this.getStr(a, k) });
      const out: PdfAnnotation[] = [];
      for (let i = 0; i < pageCount; i++) {
        const page = this.wasm.FPDF_LoadPage(doc, i);
        if (!page) continue;
        out.push(...read(page, i));
        this.wasm.FPDF_ClosePage(page);
      }
      return out;
    }

    pageCountOf(doc: number): number { return this.wasm.FPDF_GetPageCount(doc); }

    /**
     * Opens `bytes` on a handle of our own (FPDF_LoadMemDocument), apart from the viewer's. Nothing but the pages the
     * write touches is ever loaded, which keeps an incremental save's tail small (see the report, "tail size").
     */
    openRaw(bytes: Uint8Array, password?: string): { doc: number; close(): void; error: number } {
      const buf = this.wbMalloc(bytes.length);
      new Uint8Array(this.wbMemory().buffer, buf, bytes.length).set(bytes);
      const doc = this.wasm.FPDF_LoadMemDocument(buf, bytes.length, password ?? '');
      if (!doc) { const error = this.wasm.FPDF_GetLastError(); this.wbFree(buf); return { doc: 0, close() {}, error }; }
      return { doc, error: 0, close: () => { this.wasm.FPDF_CloseDocument(doc); this.wbFree(buf); } };
    }

    /**
     * Creates the annotations of `specs` on their pages. Order matters: a reply's parent and a Popup's parent must
     * already exist. Returns the NM → annotation pointers it left open, which closeAnnots frees.
     */
    writeAnnots(doc: number, specs: AnnotSpec[]): { errors: string[] } {
      const m = this.wasm;
      const errors: string[] = [];
      const byNm = new Map<string, number>();
      const pages = new Map<number, { pagePtr: number; release(): void }>();
      const open: number[] = [];
      try {
        for (const s of specs) {
          let pg = pages.get(s.pageIndex);
          if (!pg) {
            const pagePtr = m.FPDF_LoadPage(doc, s.pageIndex);
            if (!pagePtr) { errors.push(`${s.nm}: page ${s.pageIndex} did not load`); continue; }
            pg = { pagePtr, release: () => m.FPDF_ClosePage(pagePtr) };
            pages.set(s.pageIndex, pg);
          }
          const a = m.EPDFPage_CreateAnnot(pg.pagePtr, SUBTYPE[s.subtype]);
          if (!a) { errors.push(`${s.nm}: create failed`); continue; }
          open.push(a);
          byNm.set(s.nm, a);
          const ok = (name: string, r: boolean) => { if (!r) errors.push(`${s.nm}: ${name} failed`); };
          ok('NM', this.setStr(a, 'NM', s.nm));
          ok('Rect', this.setRect(a, s.rect));
          if (s.author !== undefined) ok('T', this.setStr(a, 'T', s.author));
          if (s.contents !== undefined) ok('Contents', this.setStr(a, 'Contents', s.contents));
          if (s.subject !== undefined) ok('Subj', this.setStr(a, 'Subj', s.subject));
          if (s.modified) ok('M', this.setStr(a, 'M', pdfDate(s.modified)));
          if (s.created) ok('CreationDate', this.setStr(a, 'CreationDate', pdfDate(s.created)));
          ok('F', m.FPDFAnnot_SetFlags(a, s.flags ?? FLAG.Print));
          if (s.quads) for (const q of s.quads) ok('QuadPoints', this.appendQuad(a, q));
          if (s.quadNumbers) for (const q of s.quadNumbers) ok('QuadPoints', this.appendQuad(a, q));
          if (s.rgb) ok('C', m.EPDFAnnot_SetColor(a, 0, s.rgb[0], s.rgb[1], s.rgb[2]));
          if (s.ic) ok('IC', m.EPDFAnnot_SetColor(a, 1, s.ic[0], s.ic[1], s.ic[2]));
          if (s.opacity !== undefined) ok('CA', m.EPDFAnnot_SetOpacity(a, Math.round(s.opacity * 255)));
          if (s.subtype === 'Square' && s.noBorder) ok('Border', m.FPDFAnnot_SetBorder(a, 0, 0, 0));
          else if (s.subtype === 'Square') {
            ok('BS', m.EPDFAnnot_SetBorderStyle(a, s.dash?.length ? 2 : 1, s.borderWidth ?? 1));
            if (s.dash?.length) {
              const dp = this.wbMalloc(4 * s.dash.length);
              try {
                new Float32Array(this.wbMemory().buffer, dp, s.dash.length).set(s.dash);
                ok('dash', m.EPDFAnnot_SetBorderDashPattern(a, dp, s.dash.length));
              } finally { this.wbFree(dp); }
            }
          }
          if (s.subtype === 'Text') ok('Name', m.EPDFAnnot_SetName(a, s.iconName === 'Note' ? 2 : 0)); // /Name /Comment (0) or /Note (2)
          if (s.irtNm) {
            const parent = byNm.get(s.irtNm);
            if (!parent) errors.push(`${s.nm}: IRT target ${s.irtNm} is not created yet`);
            else {
              ok('IRT', m.EPDFAnnot_SetLinkedAnnot(a, 'IRT', parent));
              ok('RT', m.EPDFAnnot_SetReplyType(a, s.rt === 'Group' ? 2 : 1));
            }
          }
          if (s.popupOfNm) {
            const parent = byNm.get(s.popupOfNm);
            if (!parent) errors.push(`${s.nm}: Popup parent ${s.popupOfNm} is not created yet`);
            else {
              ok('Popup', m.EPDFAnnot_SetLinkedAnnot(parent, 'Popup', a));
              ok('Parent', m.EPDFAnnot_SetLinkedAnnot(a, 'Parent', parent));
            }
          }
          // appearance
          if (s.ap === 'pdfium') ok('AP', m.EPDFAnnot_GenerateAppearance(a));
          else if (s.ap === 'pdfium-multiply') ok('AP', m.EPDFAnnot_GenerateAppearanceWithBlend(a, 1));
          else if (s.ap !== 'none' && 'stream' in s.ap) ok('AP', this.wbWithW(s.ap.stream, (p) => m.FPDFAnnot_SetAP(a, 0, p)));
        }
        for (const [i, pg] of pages) { m.FPDFPage_GenerateContent(pg.pagePtr); void i; }
      } finally {
        for (const a of open) m.FPDFPage_CloseAnnot(a);
        for (const pg of pages.values()) pg.release();
      }
      return { errors };
    }

    /**
     * FPDF_SaveAsCopy through a JavaScript WriteBlock. `skip` bytes at the start of the stream are dropped, which is how
     * a tail-only save works: with FPDF_INCREMENTAL PDFium first copies the original bytes, then writes the new objects.
     */
    saveWith(doc: number, flags: number, skip: number, keep = true): { bytes: Uint8Array | null; total: number; chunks: number; firstChunks: number[] } {
      const m = this.wasm;
      const parts: Uint8Array[] = [];
      let total = 0, chunks = 0;
      const firstChunks: number[] = [];
      const memory = this.wbMemory();
      const write = (_self: number, data: number, size: number): number => {
        chunks++;
        if (firstChunks.length < 5) firstChunks.push(size);
        const from = total;
        total += size;
        if (!keep) return 1;
        const end = from + size;
        if (end > skip) {
          const cut = Math.max(0, skip - from);
          parts.push(new Uint8Array(memory.buffer, data + cut, size - cut).slice());
        }
        return 1;
      };
      const fn = mod.pdfium.addFunction(write, 'iiii');
      const writer = this.wbMalloc(8);
      new Int32Array(memory.buffer, writer, 2).set([1, fn]);
      try {
        const ok = m.FPDF_SaveAsCopy(doc, writer, flags);
        if (!ok) throw new Error('FPDF_SaveAsCopy failed');
      } finally {
        this.wbFree(writer);
        mod.pdfium.removeFunction(fn);
      }
      let bytes: Uint8Array | null = null;
      if (keep) {
        bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) { bytes.set(p, o); o += p.length; }
      }
      return { bytes, total, chunks, firstChunks };
    }
  }

  return { mod, WritebackNative };
}
