// Throwaway check for 8.1's geometry: a highlight, a bold and a pin on pages with an offset crop box and /Rotate 0, 90, 180, 270.
// Writes geometry-annotated.pdf next to the input and geometry-annotated.json (what was meant, per page).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO } from '../src/engine.ts';
import { makeEnv, writeCopy, OUT } from './make-samples.ts';
import { readGeometry } from '../src/geometry.ts';
import { contentStream, parseOutline } from '../src/svgpath.ts';
import type { AnnotSpec } from '../src/writeback.ts';

const core = (p: string) => resolve(REPO, 'packages/core/src', p);
const { planPdfExport, quadPoints } = (await import(core('export/pdf-mapping.ts'))) as typeof import('../../../packages/core/src/export/pdf-mapping');
const { buildTextAnchor } = (await import(core('anchoring/quote.ts'))) as typeof import('../../../packages/core/src/anchoring/quote');
type MarkRow = import('../../../packages/core/src/model/rows').MarkRow;
type ThreadRow = import('../../../packages/core/src/model/rows').ThreadRow;
type CommentRow = import('../../../packages/core/src/model/rows').CommentRow;
type NormRect = import('../../../packages/core/src/model/anchor').NormRect;
type PageGeometry = import('../../../packages/core/src/export/pdf-mapping').PageGeometry;

const file = resolve(OUT, 'inputs/geometry-crop-rotate.pdf');
const { mod, native, env, orig } = await makeEnv(file, [0, 1, 2, 3]);
native.openDocument('v', orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength) as ArrayBuffer);
const geometry: PageGeometry[] = [];
{ const raw = native.openRaw(orig); for (let p = 0; p < 4; p++) { const pg = mod.FPDF_LoadPage(raw.doc, p); geometry.push(readGeometry(mod, pg, env.pages[p]!.rotation) as PageGeometry); mod.FPDF_ClosePage(pg); } raw.close(); }
console.log(JSON.stringify(geometry));
const sync = { rev: 1, hlc: 'x', deletedAt: null };
const text = (p: number) => native.getPageChars('v', p);
const marks: MarkRow[] = [], threads: ThreadRow[] = [], comments: CommentRow[] = [];
const meant: { page: number; phrase: string; kind: string }[] = [];
for (let p = 0; p < 4; p++) {
  const sz = env.pages[p]!;
  const t = text(p);
  const lines = t.split('\r\n');
  const line = lines.find((l) => l.length > 40 && /^[A-Z][a-z]+ [a-z]+ [a-z]+/.test(l))!;
  const phrase = line.split(' ').slice(0, 3).join(' ');
  const bold = lines.filter((l) => l.length > 40 && l !== line && lines.indexOf(l) > lines.indexOf(line) + 2).map((l) => l.split(' ').slice(3, 6).join(' ')).find((s) => s && s !== phrase && /^[a-z]+ [a-z]+ [a-z]+$/.test(s))!;
  const anchorOf = (ph: string) => {
    const i = t.indexOf(ph);
    const rects = native.getTextRangeRects('v', p, i, ph.length).map((r): NormRect => [r.x / sz.width, r.y / sz.height, (r.x + r.width) / sz.width, (r.y + r.height) / sz.height]);
    return buildTextAnchor({ text, start: { page: p, index: i }, end: { page: p, index: i + ph.length }, rects: [{ page: p, rects }] });
  };
  const m = (n: number, style: MarkRow['style'], color: MarkRow['color'], ph: string): MarkRow => ({ ...sync, id: `00000000-0000-4000-8000-${p}${n}0000000000`.slice(0, 36) as MarkRow['id'], documentId: 'd' as MarkRow['documentId'], style, color, anchor: anchorOf(ph), pageIndex: p, sortKey: n, author: 'me', createdAt: n, updatedAt: n });
  marks.push(m(1, 'highlight', 1, phrase), m(2, 'bold', null, bold));
  meant.push({ page: p, phrase, kind: 'highlight' }, { page: p, phrase: bold, kind: 'bold' });
  const th: ThreadRow = { ...sync, id: `00000000-0000-4000-8000-${p}30000000000`.slice(0, 36) as ThreadRow['id'], documentId: 'd' as ThreadRow['documentId'], anchor: { kind: 'point', page: p, point: [0.8, 0.15] }, pageIndex: p, sortKey: 0.15, placement: 'placed', draftOfTab: null, createdAt: 5, updatedAt: 5 };
  threads.push(th);
  comments.push({ ...sync, id: `00000000-0000-4000-8000-${p}40000000000`.slice(0, 36) as CommentRow['id'], threadId: th.id, documentId: 'd' as CommentRow['documentId'], author: 'me', body: 'pin', draftOfTab: null, meta: {}, createdAt: 5, editedAt: null });
  meant.push({ page: p, phrase: 'pin@0.8,0.15', kind: 'pin' });
}
const rgb = { 1: [253, 226, 147], 2: [168, 218, 181], 3: [127, 207, 255], 4: [251, 169, 214], 5: [253, 198, 156] } as never;
const plan = planPdfExport({ marks, threads, comments, geometry, place: (a) => (a.kind === 'text' ? a.rects : null) }, { replies: 'threaded', markRgb: rgb, ownerName: 'T' });
const specs = plan.annotations.map((p): AnnotSpec => {
  const g = geometry[p.pageIndex]!;
  const s: AnnotSpec = { subtype: p.subtype, pageIndex: p.pageIndex, rect: [p.rect.x, p.rect.y, p.rect.x + p.rect.width, p.rect.y + p.rect.height], nm: p.nm, flags: p.flags, rgb: p.rgb, ap: 'none', ...(p.contents !== null ? { contents: p.contents } : {}), ...(p.popupOf ? { popupOfNm: p.popupOf } : {}) };
  if (p.quads.length) s.quadNumbers = p.quads.map((q) => quadPoints(q, g.rotation));
  if (p.ap.kind === 'text-markup') s.ap = 'pdfium-multiply';
  if (p.ap.kind === 'note-icon') s.ap = 'pdfium';
  if (p.ap.kind === 'bold-outlines') {
    const o = native.getGlyphOutlines('v', p.pageIndex, p.ap.chars!.start, p.ap.chars!.count);
    const toUser = (x: number, y: number) => ({ x: g.crop[0] + x, y: g.crop[3] - y });
    s.noBorder = true;
    s.ap = { stream: contentStream(o.map((q) => { const f = (q.fill ?? [0, 0, 0, 255]) as [number, number, number, number]; return { cmds: parseOutline(q.d, toUser), fill: f, stroke: f, width: 0.3 }; })) };
  }
  if (p.ap.kind === 'empty') s.ap = p.subtype === 'Popup' ? 'none' : { stream: 'q Q' };
  return s;
});
const res = writeCopy(native, orig, specs);
writeFileSync(resolve(OUT, 'geometry-annotated.pdf'), res.out);
writeFileSync(resolve(OUT, 'geometry-annotated.json'), JSON.stringify({ meant, errors: res.errors }));
console.log('written', specs.length, 'errors', res.errors);
