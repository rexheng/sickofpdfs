// getPageGeometry (slice 8.2) in the spike: a page's crop box, media box and /Rotate in PDF user space (y up).
import type { WrappedPdfiumModule } from '@embedpdf/pdfium';

export interface PageGeometry { crop: [number, number, number, number]; media: [number, number, number, number]; rotation: 0 | 90 | 180 | 270 }
/** A rectangle as the engine gives it: points, unrotated page space, origin at the crop box's top-left, y down. */
export interface TopLeftRect { x: number; y: number; width: number; height: number }

export function readGeometry(mod: WrappedPdfiumModule, page: number, pageRotation: number): PageGeometry {
  const w = mod.pdfium.wasmExports;
  const buf = w.malloc(16);
  const mem = () => (mod.pdfium.wasmExports as unknown as { memory: WebAssembly.Memory }).memory.buffer;
  const read = (fn: (p: number, l: number, b: number, r: number, t: number) => boolean): [number, number, number, number] | null => {
    const ok = fn(page, buf, buf + 4, buf + 8, buf + 12);
    if (!ok) return null;
    const f = new Float32Array(mem(), buf, 4);
    return [f[0]!, f[1]!, f[2]!, f[3]!];
  };
  const media = read(mod.FPDFPage_GetMediaBox) ?? [0, 0, 612, 792];
  const crop = read(mod.FPDFPage_GetCropBox) ?? media;
  w.free(buf);
  return { crop, media, rotation: pageRotation as PageGeometry['rotation'] };
}

/** Engine rectangle (top-left, y down) to user space [left, bottom, right, top]. */
export function rectToUser(g: PageGeometry, r: TopLeftRect): [number, number, number, number] {
  const [cl, , , ct] = g.crop;
  return [cl + r.x, ct - (r.y + r.height), cl + r.x + r.width, ct - r.y];
}

/** Acrobat's quad order (top-left, top-right, bottom-left, bottom-right) as the page is DISPLAYED, mapped back to user space. */
export function quadFor(g: PageGeometry, r: [number, number, number, number]) {
  const [l, b, rr, t] = r;
  const P = (x: number, y: number) => ({ x, y });
  switch (g.rotation) {
    case 90: return [P(l, b), P(l, t), P(rr, b), P(rr, t)] as const;
    case 180: return [P(rr, b), P(l, b), P(rr, t), P(l, t)] as const;
    case 270: return [P(rr, t), P(rr, b), P(l, t), P(l, b)] as const;
    default: return [P(l, t), P(rr, t), P(l, b), P(rr, b)] as const;
  }
}

export const unionUser = (rs: [number, number, number, number][]): [number, number, number, number] =>
  [Math.min(...rs.map((r) => r[0])), Math.min(...rs.map((r) => r[1])), Math.max(...rs.map((r) => r[2])), Math.max(...rs.map((r) => r[3]))];
