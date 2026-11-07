// Saving a copy of a document through PDFium (slice 8.2; spike 8.0's EXPORT_SAVE = tail-only).
//
// FPDF_SaveAsCopy writes through an FPDF_FILEWRITE whose WriteBlock is a JavaScript function (addFunction). With
// FPDF_INCREMENTAL, PDFium first copies the original file, then writes the objects it changed and a new cross-reference
// section. A tail-only save drops the first `skip` bytes as they arrive, so the 170 MB scan costs 173 KB of memory, not
// another 170 MB; the copy is then the caller's original bytes followed by this tail.
//
// PDFium fault 1 (spike report, "Two PDFium faults"): when the original uses cross-reference STREAMS (every Word, LaTeX
// 1.5+ or Chrome-saved PDF), the xref stream PDFium writes has no /Type /XRef (ISO 32000-1 Table 17: required) and no
// `endobj`. qpdf calls the file damaged and Acrobat would offer to repair it. fixXrefStreamTail adds both inside the
// tail. Nothing before the xref object moves, so every offset PDFium wrote, `startxref` included, stays right.
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

/** The Emscripten runtime helpers used for callbacks (their typings, @types/emscripten, are not installed). */
export interface PdfiumRuntime {
  addFunction(fn: (...args: number[]) => number, signature: string): number;
  removeFunction(ptr: number): void;
}
export function runtimeOf(m: WrappedPdfiumModule): PdfiumRuntime {
  const runtime: unknown = m.pdfium;
  return runtime as PdfiumRuntime;
}

/** FPDF_SaveAsCopy's flags (fpdf_save.h). */
export const SAVE_FLAGS = { incremental: 1, noIncremental: 2 } as const;

export interface TailFix {
  bytes: Uint8Array;
  /** 'none': the tail ends in a classic xref table; 'xref-stream': repaired; 'xref-stream-ok': already valid. */
  kind: 'none' | 'xref-stream' | 'xref-stream-ok';
}

const latin1 = (b: Uint8Array): string => new TextDecoder('latin1').decode(b);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** Repairs the xref stream PDFium writes at the end of an incremental update (`tail` follows `originalLength` bytes). */
export function fixXrefStreamTail(tail: Uint8Array, originalLength: number): TailFix {
  const text = latin1(tail);
  const end = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!end) throw new Error('the saved update does not end in startxref and %%EOF');
  const rel = Number(end[1]) - originalLength;
  if (rel < 0 || rel >= tail.length) throw new Error('the saved update points outside itself');
  if (text.startsWith('xref', rel)) return { bytes: tail, kind: 'none' };
  const obj = /^(\d+ \d+ obj)\s*<</.exec(text.slice(rel, rel + 40));
  if (!obj) throw new Error('the saved update does not point at a cross-reference');
  const dictStart = rel + obj[0].length; // just after "<<"
  const body = text.slice(rel, end.index);
  const streamAt = body.indexOf('stream');
  const hasType = /\/Type\s*\/XRef/.test(streamAt < 0 ? body : body.slice(0, streamAt));
  const hasEndobj = /endobj\s*$/.test(body);
  const self = selfEntry(text, dictStart, Number(end[1]), Number(obj[1].split(' ')[0]));
  if (hasType && hasEndobj && self === null) return { bytes: tail, kind: 'xref-stream-ok' };
  const pieces: (Uint8Array | string)[] = [tail.subarray(0, dictStart), hasType ? '' : '/Type/XRef'];
  if (self === null) pieces.push(tail.subarray(dictStart, end.index));
  else pieces.push(self.dict, self.data, tail.subarray(self.dataEnd, end.index));
  pieces.push(hasEndobj ? '' : 'endobj\r\n', tail.subarray(end.index));
  const parts = pieces.map((p) => (typeof p === 'string' ? ascii(p) : p));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return { bytes: out, kind: 'xref-stream' };
}

/**
 * PDFium's xref stream lists every object of the update but itself, so its /Size (one more than its own number) is one
 * more than the highest object it lists, and qpdf warns. When the stream is not compressed (PDFium writes it plain), its
 * own entry is added: its number at the end of /Index, and its offset in the data. `dictStart` is just after its "<<".
 * Returns the new text from there to the end of the old stream data, the entry's bytes (which follow it), and where the old
 * stream data ended; or null to leave the stream as it is.
 */
function selfEntry(text: string, dictStart: number, offset: number, num: number): { dict: string; data: Uint8Array; dataEnd: number } | null {
  const streamKw = text.indexOf('stream', dictStart);
  if (streamKw < 0) return null;
  const dict = text.slice(dictStart, streamKw);
  if (/\/Filter|\/DecodeParms/.test(dict)) return null;
  const size = /\/Size\s+(\d+)/.exec(dict);
  const w = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dict);
  const index = /\/Index\s*\[([\d\s]*)\]/.exec(dict);
  const length = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
  if (!size || !w || !index || !length || Number(size[1]) !== num + 1) return null;
  const pairs = index[1].trim().split(/\s+/).map(Number);
  for (let i = 0; i + 1 < pairs.length; i += 2) if (num >= pairs[i] && num < pairs[i] + pairs[i + 1]) return null; // listed already
  const [wt, wo, wg] = [Number(w[1]), Number(w[2]), Number(w[3])];
  if (wo < 1 || wo > 6 || offset >= 2 ** (8 * wo)) return null;
  // the data starts after "stream" and its end of line
  const dataStart = streamKw + 6 + (text.startsWith('\r\n', streamKw + 6) ? 2 : 1);
  const dataEnd = dataStart + Number(length[1]);
  if (!text.startsWith('endstream', dataEnd + (/^\s+/.exec(text.slice(dataEnd, dataEnd + 4))?.[0].length ?? 0))) return null;
  const entry = new Uint8Array(wt + wo + wg);
  if (wt > 0) entry[wt - 1] = 1; // type 1: an object in use, at this offset
  for (let k = 0; k < wo; k++) entry[wt + k] = Math.floor(offset / 2 ** (8 * (wo - 1 - k))) % 256;
  const newDict = dict
    .replace(index[0], `/Index[${index[1].trimEnd()} ${num} 1]`)
    .replace(length[0], `/Length ${Number(length[1]) + entry.length}`);
  return { dict: newDict + text.slice(streamKw, dataEnd), data: entry, dataEnd };
}

/**
 * FPDF_SaveAsCopy of `doc` with `flags`, keeping the bytes after the first `skip`. Returns them, and how many bytes PDFium
 * wrote in all.
 */
export function saveCopy(m: WrappedPdfiumModule, doc: number, flags: number, skip: number): { bytes: Uint8Array; total: number } {
  const exports = m.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory; malloc(n: number): number; free(p: number): void };
  const parts: Uint8Array[] = [];
  let total = 0;
  const write = (_self: number, data: number, size: number): number => {
    const from = total;
    total += size;
    if (total > skip) {
      const cut = Math.max(0, skip - from);
      parts.push(new Uint8Array(exports.memory.buffer, data + cut, size - cut).slice());
    }
    return 1;
  };
  const runtime = runtimeOf(m);
  const fn = runtime.addFunction(write, 'iiii');
  const writer = exports.malloc(8);
  try {
    // FPDF_FILEWRITE: { int version = 1; WriteBlock }
    new Int32Array(exports.memory.buffer, writer, 2).set([1, fn]);
    if (!m.FPDF_SaveAsCopy(doc, writer, flags)) throw new Error('PDFium could not save the copy');
  } finally {
    exports.free(writer);
    runtime.removeFunction(fn);
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, total };
}
