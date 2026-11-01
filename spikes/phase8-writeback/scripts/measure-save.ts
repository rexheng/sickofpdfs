// Save-path measurements: full rewrite, incremental with the whole file collected, and tail-only.
// usage: measure-save.ts FILE MODE [password]   MODE = full | incremental-all | tail | tail-custom
// One mode per process, so max RSS belongs to that mode. "tail-custom" opens the file through FPDF_LoadCustomDocument.
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { makeWritebackEngine, SAVE } from '../src/writeback.ts';
import { fixXrefStreamTail } from '../src/tail.ts';

const [file, mode, password] = process.argv.slice(2) as [string, string, string | undefined];
const { mod, WritebackNative } = await makeWritebackEngine();
const native = new WritebackNative(mod, {});
const size = statSync(file).size;
const t0 = performance.now();
let h: { doc: number; close(): void; error: number };
let custom: { close(): void; reads: number; bytes: number } | null = null;
if (mode === 'tail-custom') {
  // PDFium pulls the file in blocks through a callback; nothing but the touched blocks is ever in the wasm heap.
  const fd = openSync(file, 'r');
  let reads = 0, bytes = 0;
  const memory = () => (mod.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory }).memory;
  const getBlock = (_param: number, pos: number, buf: number, len: number): number => {
    reads++; bytes += len;
    const tmp = Buffer.allocUnsafe(len);
    const n = readSync(fd, tmp, 0, len, pos);
    if (n !== len) return 0;
    new Uint8Array(memory().buffer, buf, len).set(tmp);
    return 1;
  };
  const fn = mod.pdfium.addFunction(getBlock, 'iiiii');
  const acc = mod.pdfium.wasmExports.malloc(12);
  new Uint32Array(memory().buffer, acc, 3).set([size, fn, 0]); // FPDF_FILEACCESS { m_FileLen, m_GetBlock, m_Param }
  const doc = mod.FPDF_LoadCustomDocument(acc, password ?? '');
  h = { doc, error: doc ? 0 : mod.FPDF_GetLastError(), close: () => { mod.FPDF_CloseDocument(doc); } };
  custom = { close: () => closeSync(fd), get reads() { return reads; }, get bytes() { return bytes; } };
} else {
  h = native.openRaw(readFileSync(file), password);
}
if (!h.doc) { console.log(JSON.stringify({ file, mode, error: h.error })); process.exit(0); }
const tOpen = performance.now();
const quads = [{ x: 72, y: 700 }, { x: 140, y: 700 }, { x: 72, y: 688 }, { x: 140, y: 688 }] as [never, never, never, never];
const res = native.writeAnnots(h.doc, [{ subtype: 'Highlight', pageIndex: 0, rect: [72, 688, 140, 700], quads: [quads], rgb: [253, 226, 147], nm: 'sop:measure', author: 'x', contents: 'x', ap: 'pdfium-multiply' }]);
const tWrite = performance.now();
const flags = mode === 'full' ? SAVE.noIncremental : SAVE.incremental;
const skip = mode.startsWith('tail') ? size : 0;
const r = native.saveWith(h.doc, flags, skip);
const tSave = performance.now();
let tailBytes = r.bytes!.length, fix = '-';
if (mode.startsWith('tail')) { const f = fixXrefStreamTail(r.bytes!, size); tailBytes = f.bytes.length; fix = f.kind; }
const heap = (mod.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory }).memory.buffer.byteLength;
console.log(JSON.stringify({
  file: file.split('/').pop(), mode, fileMB: +(size / 1048576).toFixed(1), errs: res.errors.length,
  openMs: Math.round(tOpen - t0), writeMs: Math.round(tWrite - tOpen), saveMs: Math.round(tSave - tWrite), totalMs: Math.round(tSave - t0),
  outMB: +(r.total / 1048576).toFixed(2), keptMB: +(r.bytes!.length / 1048576).toFixed(3), tailKB: mode.startsWith('tail') ? +(tailBytes / 1024).toFixed(1) : null, fix,
  wasmHeapMB: Math.round(heap / 1048576), maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), blocksRead: custom ? `${custom.reads} reads, ${(custom.bytes / 1048576).toFixed(1)} MB` : null,
}));
h.close(); custom?.close();
