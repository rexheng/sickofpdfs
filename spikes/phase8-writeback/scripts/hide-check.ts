// Q3 of the plan: does an annotation flagged Hidden on the OPEN handle vanish from a render of that handle, and does
// the flag stay out of a file saved from a different (fresh) handle? Slice 8.4 relies on both.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeWritebackEngine } from '../src/writeback.ts';
import { OUT } from './make-samples.ts';

const { mod, WritebackNative } = await makeWritebackEngine();
const native = new WritebackNative(mod, {});
const bytes = readFileSync(resolve(OUT, 'sample-A-threaded-empty-appearance.pdf'));
const h = native.openRaw(bytes);
const mem = () => (mod.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory }).memory.buffer;
const W = 612, H = 792;
function render(page: number): Uint8Array {
  const bmp = mod.FPDFBitmap_Create(W, H, 0);
  mod.FPDFBitmap_FillRect(bmp, 0, 0, W, H, 0xffffffff);
  mod.FPDF_RenderPageBitmap(bmp, page, 0, 0, W, H, 0, 0x01 /* FPDF_ANNOT */);
  const ptr = mod.FPDFBitmap_GetBuffer(bmp);
  const out = new Uint8Array(mem(), ptr, W * H * 4).slice();
  mod.FPDFBitmap_Destroy(bmp);
  return out;
}
const page = mod.FPDF_LoadPage(h.doc, 0);
const before = render(page);
let hidden = 0;
for (let i = 0; i < mod.FPDF_GetPageCount(h.doc) && i < 1; i++) {
  const n = mod.FPDFPage_GetAnnotCount(page);
  for (let k = 0; k < n; k++) {
    const a = mod.FPDFPage_GetAnnot(page, k);
    const nm = native.getStr(a, 'NM');
    if (nm?.startsWith('sop:')) { mod.FPDFAnnot_SetFlags(a, mod.FPDFAnnot_GetFlags(a) | 2); hidden++; }
    mod.FPDFPage_CloseAnnot(a);
  }
}
const after = render(page);
let changed = 0;
for (let i = 0; i < before.length; i += 4) if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changed++;
// the original (no annotations of ours) for comparison
const origBytes = readFileSync('/home/user/sickofpdfs/test-assets/paper-50.pdf');
const h2 = native.openRaw(origBytes);
const p2 = mod.FPDF_LoadPage(h2.doc, 0);
const plain = render(p2);
let diffToOriginal = 0;
for (let i = 0; i < plain.length; i += 4) if (plain[i] !== after[i] || plain[i + 1] !== after[i + 1] || plain[i + 2] !== after[i + 2]) diffToOriginal++;
console.log(JSON.stringify({ hiddenFlagsSet: hidden, pixelsChangedByHiding: changed, pixelsDifferentFromTheUnannotatedOriginalAfterHiding: diffToOriginal }));
mod.FPDF_ClosePage(page); mod.FPDF_ClosePage(p2); h.close(); h2.close();
// a handle that was never hidden saves without the flag: the written copy comes from a fresh handle on the original bytes
const fresh = native.openRaw(bytes);
const all = native.readAll(fresh.doc, 1).filter((a) => a.nm?.startsWith('sop:'));
console.log(JSON.stringify({ freshHandleAnnotsHidden: all.filter((a) => a.flags & 2).length, of: all.length, note: 'sample A has its replies visible (flags 28), so 0 hidden here means hiding on another handle did not leak' }));
fresh.close();
