// The bytes PDFium appends in an incremental save, and the one defect in them that the spike found.
//
// FPDF_SaveAsCopy(..., FPDF_INCREMENTAL) first copies the original file, then writes the objects it changed, then a new
// cross-reference section. When the original uses cross-reference STREAMS (every PDF with object streams: Word, LaTeX
// with pdfTeX 1.5+, Chrome's "Save as PDF"), the section PDFium writes is not a valid xref stream in this build:
//   - the dictionary has no /Type /XRef (ISO 32000-1 Table 17: required), and
//   - the object is not closed with `endobj`.
// qpdf says "xref not found ... file is damaged" and rebuilds the table; Acrobat would show a repair notice.
// `fixXrefStreamTail` repairs both in the tail. Nothing before the xref object moves, so every offset PDFium wrote
// (including `startxref`, which points at the start of the xref object) stays right.

export interface TailFix {
  bytes: Uint8Array;
  /** 'none' = the tail ended in a classic xref table, 'xref-stream' = repaired, 'xref-stream-ok' = already valid. */
  kind: 'none' | 'xref-stream' | 'xref-stream-ok';
  startxref: number;
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

export function fixXrefStreamTail(tail: Uint8Array, origLength: number): TailFix {
  const text = latin1(tail);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(text);
  if (!m) throw new Error('the tail does not end in startxref/%%EOF');
  const startxref = Number(m[1]);
  const rel = startxref - origLength;
  if (rel < 0 || rel >= tail.length) throw new Error(`startxref ${startxref} is outside the tail (original is ${origLength} bytes)`);
  const at = text.slice(rel, rel + 6);
  if (at.startsWith('xref')) return { bytes: tail, kind: 'none', startxref };
  const obj = /^(\d+ \d+ obj)\s*<</.exec(text.slice(rel, rel + 40));
  if (!obj) throw new Error(`the tail's startxref does not point at "xref" or an object (found ${JSON.stringify(at)})`);
  const dictStart = rel + obj[0].length; // just after "<<"
  const xrefEnd = m.index; // where "startxref" begins
  const body = text.slice(rel, xrefEnd);
  const hasType = /\/Type\s*\/XRef/.test(body.slice(0, body.indexOf('stream')));
  const hasEndobj = /endobj\s*$/.test(body);
  if (hasType && hasEndobj) return { bytes: tail, kind: 'xref-stream-ok', startxref };
  const head = tail.subarray(0, dictStart);
  const mid = tail.subarray(dictStart, xrefEnd);
  const end = tail.subarray(xrefEnd);
  const typeKey = hasType ? new Uint8Array(0) : bytesOf('/Type/XRef');
  const endobj = hasEndobj ? new Uint8Array(0) : bytesOf('endobj\r\n');
  const out = new Uint8Array(head.length + typeKey.length + mid.length + endobj.length + end.length);
  let o = 0;
  for (const part of [head, typeKey, mid, endobj, end]) { out.set(part, o); o += part.length; }
  return { bytes: out, kind: 'xref-stream', startxref };
}
