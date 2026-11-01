// Throwaway: import side on cropped and rotated pages. Reads geometry-annotated.pdf and checks that every highlight and bold
// maps back to the same char range, and every pin to the same point.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO } from '../src/engine.ts';
import { makeEnv, OUT } from './make-samples.ts';
import { readGeometry } from '../src/geometry.ts';
const core = (p: string) => resolve(REPO, 'packages/core/src', p);
const { userToPoint } = (await import(core('export/pdf-mapping.ts'))) as typeof import('../../../packages/core/src/export/pdf-mapping');
const meant = (JSON.parse(readFileSync(resolve(OUT, 'geometry-annotated.json'), 'utf8')) as { meant: { page: number; phrase: string; kind: string }[] }).meant;
const { mod, native, env, orig } = await makeEnv(resolve(OUT, 'inputs/geometry-crop-rotate.pdf'), [0, 1, 2, 3]);
native.openDocument('v', orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength) as ArrayBuffer);
const annotated = readFileSync(resolve(OUT, 'geometry-annotated.pdf'));
const raw = native.openRaw(annotated);
const read = native.readAll(raw.doc, 4).filter((a) => a.nm?.startsWith('sop:') && a.subtype !== 'Popup');
const geos = [0, 1, 2, 3].map((p) => { const pg = mod.FPDF_LoadPage(raw.doc, p); const g = readGeometry(mod, pg, env.pages[p]!.rotation); mod.FPDF_ClosePage(pg); return g; });
raw.close();
let bad = 0;
for (const a of read) {
  const g = geos[a.pageIndex]!;
  if (a.subtype === 'Text') {
    const pt = userToPoint(g as never, { x: a.rect.x, y: a.rect.y + a.rect.height });
    const ok = Math.abs(pt[0] - 0.8) < 0.04 && Math.abs(pt[1] - 0.15) < 0.04;
    if (!ok) bad++;
    console.log(`page ${a.pageIndex} pin -> point ${pt.map((v) => v.toFixed(3))} ${ok ? 'OK' : 'BAD'}`);
    continue;
  }
  const quads = (a.subtype === 'Square' ? [a.rect] : a.quads).map((q) => ({ x: q.x - g.crop[0], y: g.crop[3] - (q.y + q.height), width: q.width, height: q.height }));
  const glyphs = (native as unknown as { getGlyphs(id: string, p: number): { glyphs: { index: number; box: { x: number; y: number; width: number; height: number }; generated: boolean }[] } }).getGlyphs('v', a.pageIndex).glyphs;
  let lo = Infinity, hi = -1;
  for (const gl of glyphs) {
    if (gl.generated || gl.box.width === 0) continue;
    const cx = gl.box.x + gl.box.width / 2, cy = gl.box.y + gl.box.height / 2;
    if (quads.some((r) => cx >= r.x - 0.5 && cx <= r.x + r.width + 0.5 && cy >= r.y - 0.5 && cy <= r.y + r.height + 0.5)) { lo = Math.min(lo, gl.index); hi = Math.max(hi, gl.index); }
  }
  const m = meant.find((x) => x.page === a.pageIndex && x.kind === (a.subtype === 'Square' ? 'bold' : 'highlight'))!;
  const i = native.getPageChars('v', a.pageIndex).indexOf(m.phrase);
  const ok = lo === i && hi + 1 === i + m.phrase.length;
  if (!ok) bad++;
  console.log(`page ${a.pageIndex} ${m.kind} '${m.phrase}': chars ${lo}-${hi + 1} vs ${i}-${i + m.phrase.length} ${ok ? 'OK' : 'BAD'}`);
}
console.log(bad === 0 ? 'ALL IMPORT MAPPINGS OK' : `${bad} BAD`);
