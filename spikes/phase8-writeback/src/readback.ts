// readAnnotations (slice 8.2) in the spike: the PdfAnnotation shape of contracts §9, read through PDFium on a handle.
// Rectangles are PDF USER SPACE (origin bottom-left, y up), as they are in the file: {x, y} is the lower-left corner.
// Nothing is converted here; the caller maps to engine or normalised space with the page's geometry.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

export interface UserRect { x: number; y: number; width: number; height: number }
export interface PdfAnnotation {
  objectNumber: number; nm: string | null; subtype: string; pageIndex: number; rect: UserRect; quads: UserRect[];
  rgb: [number, number, number] | null; opacity: number | null; contents: string | null; author: string | null; subject: string | null;
  createdAt: number | null; modifiedAt: number | null; irtObjectNumber: number | null; replyType: 'R' | 'Group' | null; flags: number; hasAppearance: boolean;
  /** Extra, spike only: NM of the IRT target and of the Popup, to check linkage without object numbers. */
  irtNm?: string | null; popupNm?: string | null; apBBox?: [number, number, number, number] | null;
}

const SUBTYPES: Record<number, string> = { 0: 'Unknown', 1: 'Text', 2: 'Link', 3: 'FreeText', 4: 'Line', 5: 'Square', 6: 'Circle', 7: 'Polygon', 8: 'PolyLine', 9: 'Highlight', 10: 'Underline', 11: 'Squiggly', 12: 'StrikeOut', 13: 'Stamp', 14: 'Caret', 15: 'Ink', 16: 'Popup', 17: 'FileAttachment', 18: 'Sound', 19: 'Movie', 20: 'Widget', 21: 'Screen', 22: 'PrinterMark', 23: 'TrapNet', 24: 'Watermark', 25: '3D', 26: 'RichMedia', 27: 'XFAWidget', 28: 'Redact' };

/** PDF date string (ISO 32000-1 7.9.4) to Unix ms. Accepts D:YYYY[MM[DD[HH[mm[SS[O[HH['[mm]]]]]]]]] and the same without "D:". */
export function parsePdfDate(s: string | null): number | null {
  if (!s) return null;
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(?:(\d{2})'?(?:(\d{2})'?)?)?)?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', o, oh = '00', om = '00'] = m;
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se));
  if (o === '+' || o === '-') t -= (o === '+' ? 1 : -1) * (Number(oh) * 60 + Number(om)) * 60_000;
  return Number.isFinite(t) ? t : null;
}

export function makeReader(mod: WrappedPdfiumModule, strings: { get(annot: number, key: string): string | null }) {
  const mem = () => (mod.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory }).memory.buffer;
  const malloc = (n: number) => mod.pdfium.wasmExports.malloc(n);
  const free = (p: number) => mod.pdfium.wasmExports.free(p);

  const rectOf = (annot: number): UserRect => {
    const p = malloc(16);
    mod.FPDFAnnot_GetRect(annot, p);
    const f = new Float32Array(mem(), p, 4); // left, top, right, bottom
    const r = { x: f[0]!, y: f[3]!, width: f[2]! - f[0]!, height: f[1]! - f[3]! };
    free(p);
    return r;
  };
  const quadsOf = (annot: number): UserRect[] => {
    const out: UserRect[] = [];
    if (!mod.FPDFAnnot_HasAttachmentPoints(annot)) return out;
    const n = mod.FPDFAnnot_CountAttachmentPoints(annot);
    const p = malloc(32);
    for (let i = 0; i < n; i++) {
      mod.FPDFAnnot_GetAttachmentPoints(annot, i, p);
      const f = Array.from(new Float32Array(mem(), p, 8));
      const xs = [f[0]!, f[2]!, f[4]!, f[6]!], ys = [f[1]!, f[3]!, f[5]!, f[7]!];
      const x = Math.min(...xs), y = Math.min(...ys);
      out.push({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y });
    }
    free(p);
    return out;
  };
  const colorOf = (annot: number): [number, number, number] | null => {
    // EPDFAnnot_GetColor reads /C as written; FPDFAnnot_GetColor answers false for a markup annotation that has an appearance.
    const p = malloc(16);
    const ok = mod.EPDFAnnot_GetColor(annot, 0, p, p + 4, p + 8);
    const u = new Uint32Array(mem(), p, 3);
    const out: [number, number, number] | null = ok ? [u[0]!, u[1]!, u[2]!] : null;
    free(p);
    return out;
  };
  const nmOfLinked = (annot: number, key: string): { nm: string | null; obj: number } | null => {
    const l = mod.FPDFAnnot_GetLinkedAnnot(annot, key);
    if (!l) return null;
    const r = { nm: strings.get(l, 'NM'), obj: mod.EPDFAnnot_GetObjectNumber(l) };
    mod.FPDFPage_CloseAnnot(l);
    return r;
  };

  return function readAnnotations(page: number, pageIndex: number): PdfAnnotation[] {
    const out: PdfAnnotation[] = [];
    const n = mod.FPDFPage_GetAnnotCount(page);
    for (let i = 0; i < n; i++) {
      const a = mod.FPDFPage_GetAnnot(page, i);
      if (!a) continue;
      const subtype = SUBTYPES[mod.FPDFAnnot_GetSubtype(a)] ?? 'Unknown';
      const irt = nmOfLinked(a, 'IRT');
      const popup = nmOfLinked(a, 'Popup');
      const rt = mod.EPDFAnnot_GetReplyType(a);
      const op = malloc(4);
      const hasOp = mod.EPDFAnnot_GetOpacity(a, op);
      const opacity = hasOp ? new Uint32Array(mem(), op, 1)[0]! / 255 : null;
      free(op);
      out.push({
        objectNumber: mod.EPDFAnnot_GetObjectNumber(a), nm: strings.get(a, 'NM'), subtype, pageIndex, rect: rectOf(a), quads: quadsOf(a), rgb: colorOf(a), opacity,
        contents: strings.get(a, 'Contents'), author: strings.get(a, 'T'), subject: strings.get(a, 'Subj'),
        createdAt: parsePdfDate(strings.get(a, 'CreationDate')), modifiedAt: parsePdfDate(strings.get(a, 'M')),
        irtObjectNumber: irt?.obj ?? null, replyType: irt ? (rt === 2 ? 'Group' : 'R') : null, flags: mod.FPDFAnnot_GetFlags(a), hasAppearance: !!mod.EPDFAnnot_HasAppearanceStream(a, 0),
        irtNm: irt?.nm ?? null, popupNm: popup?.nm ?? null,
      });
      mod.FPDFPage_CloseAnnot(a);
    }
    return out;
  };
}
