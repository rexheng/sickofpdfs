// The three files for the Foxit and Acrobat hand check (W-F1, decision D8.1), made by the product's own planPdfExport:
//   A  replies threaded, each reply a /Text with an empty appearance (the proposed default)
//   B  replies threaded, each reply hidden by its /F flag (the contract's wording)
//   C  replies folded into the root's comment text
// Same notes in all three. They go on a copy of the NBER paper (test-assets/paper-50.pdf), saved by PDFium's incremental save,
// tail only.
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSETS, REPO } from '../src/engine.ts';
import { makeEnv, writeCopy, OUT } from './make-samples.ts';
import { readGeometry } from '../src/geometry.ts';
import { readTokenColours } from '../src/samples.ts';
import { planToSpecs } from '../src/plan-writer.ts';

const core = (p: string) => resolve(REPO, 'packages/core/src', p);
const { planPdfExport, quadPoints } = (await import(core('export/pdf-mapping.ts'))) as typeof import('../../../packages/core/src/export/pdf-mapping');
const { buildTextAnchor } = (await import(core('anchoring/quote.ts'))) as typeof import('../../../packages/core/src/anchoring/quote');
type MarkRow = import('../../../packages/core/src/model/rows').MarkRow;
type ThreadRow = import('../../../packages/core/src/model/rows').ThreadRow;
type CommentRow = import('../../../packages/core/src/model/rows').CommentRow;
type Anchor = import('../../../packages/core/src/model/anchor').Anchor;
type NormRect = import('../../../packages/core/src/model/anchor').NormRect;
type PageGeometry = import('../../../packages/core/src/export/pdf-mapping').PageGeometry;

const { mod, native, env, orig } = await makeEnv(`${ASSETS}/paper-50.pdf`, [0, 1]);
native.openDocument('v', orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength) as ArrayBuffer);
const geometry: PageGeometry[] = [];
{ const raw = native.openRaw(orig); for (let p = 0; p < 2; p++) { const pg = mod.FPDF_LoadPage(raw.doc, p); geometry.push(readGeometry(mod, pg, env.pages[p]!.rotation) as PageGeometry); mod.FPDF_ClosePage(pg); } raw.close(); }

const sync = { rev: 1, hlc: 'x', deletedAt: null };
const text = (p: number) => native.getPageChars('v', p);
const sz = (p: number) => env.pages[p]!;
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const at = (m: number) => T0 + m * 60_000;
function span(p: number, from: string, to = from): Extract<Anchor, { kind: 'text' }> {
  const t = text(p);
  const s = t.indexOf(from), e = t.indexOf(to, s) + to.length;
  if (s < 0 || e < to.length) throw new Error(`"${from}" … "${to}" not on page ${p}`);
  const rects = native.getTextRangeRects('v', p, s, e - s).map((r): NormRect => [r.x / sz(p).width, r.y / sz(p).height, (r.x + r.width) / sz(p).width, (r.y + r.height) / sz(p).height]);
  return buildTextAnchor({ text, start: { page: p, index: s }, end: { page: p, index: e }, rects: [{ page: p, rects }] });
}
let n = 1;
const id = () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`;
const marks: MarkRow[] = [], threads: ThreadRow[] = [], comments: CommentRow[] = [];
const mark = (style: MarkRow['style'], color: MarkRow['color'], anchor: Anchor, m: number): MarkRow => {
  const row = { ...sync, id: id() as MarkRow['id'], documentId: 'd' as MarkRow['documentId'], style, color, anchor, pageIndex: anchor.kind === 'text' ? anchor.start.page : 'page' in anchor ? anchor.page : 0, sortKey: anchor.kind === 'text' ? (anchor.rects[0]?.rects[0]?.[1] ?? 0) : 'rect' in anchor ? anchor.rect[1] : 0, author: 'me' as const, createdAt: at(m), updatedAt: at(m) };
  marks.push(row);
  return row;
};
const thread = (anchor: Anchor, m: number, c: { by: 'me' | 'claude'; body: string; meta?: object }[]): ThreadRow => {
  const t: ThreadRow = { ...sync, id: id() as ThreadRow['id'], documentId: 'd' as ThreadRow['documentId'], anchor, pageIndex: anchor.kind === 'text' ? anchor.start.page : anchor.kind === 'document' ? null : anchor.page,
    sortKey: anchor.kind === 'text' ? (anchor.rects[0]?.rects[0]?.[1] ?? 0) : anchor.kind === 'area' ? anchor.rect[1] : anchor.kind === 'point' ? anchor.point[1] : 0, placement: 'placed', draftOfTab: null, createdAt: at(m), updatedAt: at(m) };
  threads.push(t);
  c.forEach((x, i) => comments.push({ ...sync, id: id() as CommentRow['id'], threadId: t.id, documentId: 'd' as CommentRow['documentId'], author: x.by, body: x.body, draftOfTab: null, meta: (x.meta ?? {}) as never, createdAt: at(m + i), editedAt: null }));
  return t;
};
const cite = { kind: 'claude-reply', v: 1, status: 'done', citations: [{ n: 1, pageIndex: 1 }], webSources: [] };
const dh = '0000000000000000';

// page 1
mark('highlight', 1, span(0, 'This work is a component of a', 'larger project on income risk'), 1);
mark('underline', 2, span(0, 'Stefanie', 'Stantcheva'), 2);
mark('strike', 4, span(0, 'Working Paper 29000'), 3);
const ta = span(0, 'NBER working papers are circulated for discussion');
mark('highlight', 5, ta, 4);
thread(ta, 4, [{ by: 'me', body: 'TA root: a comment on the orange highlight.' }, { by: 'claude', body: 'TA reply 1, from Claude. See [p. 2](cite:1).', meta: cite }, { by: 'me', body: 'TA reply 2, from you. Zażółć gęślą jaźń.' }]);
thread(span(0, 'peer-reviewed or been subject to the review'), 7, [{ by: 'me', body: 'TB root: a comment on plain text (a dotted underline, no highlight).' }, { by: 'me', body: 'TB reply 1. Привет, мир.' }]);
thread({ kind: 'area', page: 0, rect: [0.11, 0.3, 0.5, 0.38], dHash: dh }, 9, [{ by: 'me', body: 'TC root: a comment on an outlined area. 你好，世界' }, { by: 'claude', body: 'TC reply 1, from Claude. 日本語のテスト。' }]);
thread({ kind: 'point', page: 0, point: [0.7, 0.55] }, 11, [{ by: 'me', body: 'A pin on the page (no replies).' }]);
thread({ kind: 'page', page: 0 }, 12, [{ by: 'me', body: 'A note on the whole page.' }]);
thread({ kind: 'document' }, 13, [{ by: 'me', body: 'A note on the whole document.' }]);
// page 2
mark('bold', null, span(1, 'idiosyncratic and exogenous changes'), 14);
mark('area', null, { kind: 'area', page: 1, rect: [0.54, 0.58, 0.88, 0.62], dHash: dh }, 15);
const td = span(1, 'event-study design');
mark('highlight', 3, td, 16);
thread(td, 16, [{ by: 'me', body: 'TD root: a comment on a blue highlight.' }, { by: 'me', body: 'TD reply 1 (you).' }, { by: 'claude', body: 'TD reply 2 (Claude).' }, { by: 'me', body: 'TD reply 3 (you). The replies should read in this order.' }]);

const col = readTokenColours();
const k = (s: string) => col[s]!;
const markRgb = { 1: k('sop-mark-1'), 2: k('sop-mark-2'), 3: k('sop-mark-3'), 4: k('sop-mark-4'), 5: k('sop-mark-5') } as never;
const lineRgb = { 1: k('sop-mark-1-line'), 2: k('sop-mark-2-line'), 3: k('sop-mark-3-line'), 4: k('sop-mark-4-line'), 5: k('sop-mark-5-line') } as never;
const place = (a: Anchor) => (a.kind === 'text' ? a.rects : a.kind === 'area' ? [{ page: a.page, rects: [a.rect] }] : null);
mkdirSync(OUT, { recursive: true });
const variants = [
  ['A', 'sample-A-threaded-empty-appearance.pdf', 'threaded', 'empty'],
  ['B', 'sample-B-threaded-hidden.pdf', 'threaded', 'hidden'],
  ['C', 'sample-C-folded.pdf', 'folded', 'hidden'],
] as const;
for (const [v, name, replies, appearance] of variants) {
  const plan = planPdfExport({ marks, threads, comments, geometry, place }, { replies, markRgb, lineRgb, areaRgb: k('sop-area-outline') as never, threadRgb: k('sop-thread-underline') as never, ownerName: 'Rex Heng', replyAppearance: appearance });
  const specs = planToSpecs(plan.annotations, geometry, native as never, quadPoints);
  const r = writeCopy(native, orig, specs);
  writeFileSync(resolve(OUT, name), r.out);
  const user = (q: { x: number; y: number; width: number; height: number }) => [q.x, q.y, q.x + q.width, q.y + q.height];
  const pixel = (p: (typeof plan.annotations)[number]) => (p.ap.kind === 'text-markup' ? (p.subtype === 'Highlight' ? 'fill' : p.subtype === 'Underline' ? 'underline' : 'strike') : p.ap.kind === 'dotted-underline' ? 'underline' : p.ap.kind === 'bold-outlines' ? 'bold' : p.ap.kind === 'box' ? 'box' : p.ap.kind === 'note-icon' ? 'icon' : 'none');
  writeFileSync(resolve(OUT, name.replace('.pdf', '.expect.json')), JSON.stringify(plan.annotations.map((p) => ({ nm: p.nm, subtype: p.subtype, pageIndex: p.pageIndex, rect: user(p.rect), quads: p.quads.length ? p.quads.map(user) : undefined, rgb: p.rgb ?? undefined, contents: p.subtype === 'Popup' ? undefined : (p.contents ?? ''), author: p.author ?? undefined, subject: p.subject ?? undefined, irt: p.irt ?? undefined, popupOf: p.popupOf ?? undefined, flags: p.flags, pixel: pixel(p) })), null, 1));
  console.log(`${v}: ${name}  ${plan.annotations.length} annotations (${plan.annotations.filter((a) => a.irt).length} replies), tail ${r.tailBytes} bytes, writer errors ${r.errors.length}`);
}
