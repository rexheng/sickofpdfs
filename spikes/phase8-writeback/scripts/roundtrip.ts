// Slice 8.1's proof (no committed tests): our model -> PDF annotations -> our model, unchanged.
//
//   1. build a model of every kind of note on a real paper (real text, real line rects, anchors from core's buildTextAnchor)
//   2. planPdfExport (the code under test) -> PdfAnnotationPlan[]
//   3. write the plan into the paper (spike writer, tail-only incremental save), save it as test-assets/export-samples/roundtrip.pdf
//   4. read every annotation back through PDFium (fresh handle)
//   5. planPdfImport (the code under test), with an anchorFor built the way slice 8.4 will build it
//   6. compare the imported model with the exported one, then import again with the refs (nothing may double)
//
// usage: node --experimental-transform-types --import ./loader/register.mjs scripts/roundtrip.ts [replies=threaded|folded] [appearance=empty|hidden]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSETS, REPO } from '../src/engine.ts';
import { makeEnv, writeCopy, OUT } from './make-samples.ts';
import { readGeometry } from '../src/geometry.ts';
import { readTokenColours } from '../src/samples.ts';
import { contentStream, parseOutline } from '../src/svgpath.ts';
import { planToSpecs } from '../src/plan-writer.ts';

const core = (p: string) => resolve(REPO, 'packages/core/src', p);
const { planPdfExport, quadPoints, userToNorm, userToPoint, ANNOT_FLAG } = (await import(core('export/pdf-mapping.ts'))) as typeof import('../../../packages/core/src/export/pdf-mapping');
const { planPdfImport } = (await import(core('export/pdf-import.ts'))) as typeof import('../../../packages/core/src/export/pdf-import');
const { noteText, commentPlainText } = (await import(core('export/note-text.ts'))) as typeof import('../../../packages/core/src/export/note-text');
const { parseNm } = (await import(core('export/nm.ts'))) as typeof import('../../../packages/core/src/export/nm');
const { buildTextAnchor } = (await import(core('anchoring/quote.ts'))) as typeof import('../../../packages/core/src/anchoring/quote');
type Core = typeof import('../../../packages/core/src/index');
type MarkRow = import('../../../packages/core/src/model/rows').MarkRow;
type ThreadRow = import('../../../packages/core/src/model/rows').ThreadRow;
type CommentRow = import('../../../packages/core/src/model/rows').CommentRow;
type Anchor = import('../../../packages/core/src/model/anchor').Anchor;
type NormRect = import('../../../packages/core/src/model/anchor').NormRect;
type PdfAnnotation = import('../../../packages/core/src/export/pdf-import').PdfAnnotation;
type PdfAnnotationPlan = import('../../../packages/core/src/export/pdf-mapping').PdfAnnotationPlan;
type PageGeometry = import('../../../packages/core/src/export/pdf-mapping').PageGeometry;
void (undefined as unknown as Core);

const replies = (process.argv.find((a) => a.startsWith('replies='))?.slice(8) ?? 'threaded') as 'threaded' | 'folded';
const appearance = (process.argv.find((a) => a.startsWith('appearance='))?.slice(11) ?? 'empty') as 'hidden' | 'empty';

// ---------- 1. the model ----------
const source = `${ASSETS}/paper-50.pdf`;
const { mod, native, env, orig } = await makeEnv(source, [0, 1, 2]);
const DOC = 'a'.repeat(64);
const pageSize = (p: number) => env.pages[p]!;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T0 = Date.UTC(2026, 10, 1, 9, 0, 0);
const at = (minutes: number) => T0 + minutes * 60_000;
const sync = { rev: 1, hlc: 'x', deletedAt: null };

const text = (p: number) => native.getPageChars('v', p);
native.openDocument('v', orig.buffer.slice(orig.byteOffset, orig.byteOffset + orig.byteLength) as ArrayBuffer);
const norm = (p: number, r: { x: number; y: number; width: number; height: number }): NormRect => [r.x / pageSize(p).width, r.y / pageSize(p).height, (r.x + r.width) / pageSize(p).width, (r.y + r.height) / pageSize(p).height];
const idx = (p: number, phrase: string) => {
  const i = text(p).indexOf(phrase);
  if (i < 0) throw new Error(`"${phrase}" not on page ${p}`);
  return i;
};
/** A text anchor from `from` to the end of `to`, on one page or across pages (as buildTextAnchor makes one). */
function span(pa: number, from: string, pb: number, to: string): Extract<Anchor, { kind: 'text' }> {
  const start = { page: pa, index: idx(pa, from) };
  const end = { page: pb, index: idx(pb, to) + to.length };
  const rects: { page: number; rects: NormRect[] }[] = [];
  for (let p = pa; p <= pb; p++) {
    const s = p === pa ? start.index : 0;
    const e = p === pb ? end.index : text(p).length;
    rects.push({ page: p, rects: native.getTextRangeRects('v', p, s, e - s).map((r) => norm(p, r)) });
  }
  return buildTextAnchor({ text, start, end, rects });
}
const one = (p: number, from: string, to = from) => span(p, from, p, to);

const mark = (n: number, style: MarkRow['style'], color: MarkRow['color'], anchor: Anchor, minutes: number): MarkRow => ({
  ...sync, id: uuid(n) as MarkRow['id'], documentId: DOC as MarkRow['documentId'], style, color, anchor,
  pageIndex: anchor.kind === 'text' ? anchor.start.page : 'page' in anchor ? anchor.page : 0, sortKey: anchor.kind === 'text' ? (anchor.rects[0]?.rects[0]?.[1] ?? 0) : 'rect' in anchor ? anchor.rect[1] : 0,
  author: 'me', createdAt: at(minutes), updatedAt: at(minutes),
});
const thread = (n: number, anchor: Anchor, minutes: number, extra: Partial<ThreadRow> = {}): ThreadRow => ({
  ...sync, id: uuid(n) as ThreadRow['id'], documentId: DOC as ThreadRow['documentId'], anchor,
  pageIndex: anchor.kind === 'text' ? anchor.start.page : anchor.kind === 'document' ? null : anchor.page,
  sortKey: anchor.kind === 'text' ? (anchor.rects[0]?.rects[0]?.[1] ?? 0) : anchor.kind === 'area' || anchor.kind === 'figure' ? anchor.rect[1] : anchor.kind === 'point' ? anchor.point[1] : 0,
  placement: 'placed', draftOfTab: null, createdAt: at(minutes), updatedAt: at(minutes), ...extra,
});
let cn = 1000;
const comment = (threadId: string, author: 'me' | 'claude', body: string, minutes: number, extra: Partial<CommentRow> = {}): CommentRow => ({
  ...sync, id: uuid(cn++) as CommentRow['id'], threadId: threadId as CommentRow['threadId'], documentId: DOC as CommentRow['documentId'], author, body, draftOfTab: null, meta: {}, createdAt: at(minutes), editedAt: null, ...extra,
});
const dh = '0000000000000000';

const marks: MarkRow[] = [];
const threads: ThreadRow[] = [];
const comments: CommentRow[] = [];

marks.push(mark(1, 'highlight', 1, one(0, 'This work is a component of a', 'larger project on income risk'), 1));
marks.push(mark(2, 'underline', 2, one(0, 'Stefanie', 'Stantcheva'), 2));
marks.push(mark(3, 'strike', 4, one(0, 'Working Paper 29000'), 3));
marks.push(mark(4, 'bold', null, one(1, 'idiosyncratic and exogenous changes'), 4));
const areaRect: NormRect = [0.54, 0.58, 0.88, 0.62];
marks.push(mark(5, 'area', null, { kind: 'area', page: 1, rect: areaRect, dHash: dh }, 5));
marks.push(mark(6, 'highlight', 3, span(0, 'is given to the source.', 1, 'How Americans Respond'), 6));
marks.push(mark(7, 'underline', 5, span(1, 'entrepreneurship, and job-to-job mobility.', 2, '1 Introduction'), 7));
const m8 = mark(8, 'highlight', 5, one(1, 'We study how Americans respond to idiosyncratic and exogenous changes in household wealth'), 8);
marks.push(m8);
const m9 = mark(9, 'highlight', 1, one(1, 'and unearned income. Our analyses combine administrative data'), 9);
marks.push(m9);
marks.push({ ...mark(10, 'highlight', 1, one(1, 'estimate the earnings responses'), 10), deletedAt: 123 });            // deleted: never exported
const m12 = mark(12, 'highlight', 3, one(1, 'heterogeneous households face non-linear taxes and make earnings choices'), 12);
marks.push(m12);
marks.push(mark(11, 'highlight', 2, one(2, 'Economists and policymakers'), 11));                                      // place() answers null: skipped
const unplaceableMarkId = uuid(11);

// T1: a thread on part of highlight 8, with a Claude reply (citation, web link) and a Polish reply
const t1 = thread(101, m8.anchor, 12);
threads.push(t1);
comments.push(comment(t1.id, 'me', 'What does "idiosyncratic" mean here?', 12));
comments.push(comment(t1.id, 'claude', 'It means specific to one household, here a lottery win. See [p. 4](cite:1) and [the paper](web:2).', 13, {
  meta: { kind: 'claude-reply', v: 1, role: 'default', status: 'done', error: null, questionId: null, citations: [{ n: 1, pageIndex: 3, start: 0, end: 5, textSource: 'pdfium', quote: 'x' }], webSources: [{ n: 2, url: 'https://example.org/lottery', title: 't', citedText: null }], usage: null, scope: 'passages', figureLabels: [], via: 'viewer' } as never,
}));
comments.push(comment(t1.id, 'me', 'Zażółć gęślą jaźń: **that** helps, thanks.', 14));
// T2: a thread on plain text (no highlight): dotted underline root. Cyrillic reply
const t2 = thread(102, one(1, 'event-study design'), 15);
threads.push(t2);
comments.push(comment(t2.id, 'me', 'What is an event-study design?', 15));
comments.push(comment(t2.id, 'me', 'Привет: это определение мне нужно позже.', 16));
// T3: area thread (CJK), T4: figure thread with a pin, T4b: figure thread on a rect
const t3 = thread(103, { kind: 'area', page: 0, rect: [0.11, 0.42, 0.49, 0.5], dHash: dh }, 17);
threads.push(t3);
comments.push(comment(t3.id, 'me', 'Figure outline. 你好，世界', 17));
comments.push(comment(t3.id, 'claude', '日本語のテスト: 図の説明です。', 18));
const figFp = { label: 'Figure 1', captionQuote: null, imageSha256: null, dHash: dh, detector: 'manual' as const, detectorVersion: '1' };
const t4 = thread(104, { kind: 'figure', page: 0, rect: [0.1, 0.55, 0.5, 0.65], figure: figFp, sub: { point: [0.3, 0.6] } }, 19);
threads.push(t4);
comments.push(comment(t4.id, 'me', 'A pin on the figure.', 19));
const t4b = thread(105, { kind: 'figure', page: 1, rect: [0.1, 0.8, 0.5, 0.9], figure: figFp }, 20);
threads.push(t4b);
comments.push(comment(t4b.id, 'me', 'A comment on the whole figure.', 20));
// T5: pin, page notes (two, stacked), document note
const t5 = thread(106, { kind: 'point', page: 0, point: [0.69, 0.53] }, 21);
threads.push(t5);
comments.push(comment(t5.id, 'me', 'A pin on the page.', 21));
const t5b = thread(107, { kind: 'page', page: 1 }, 22);
threads.push(t5b);
comments.push(comment(t5b.id, 'me', 'A note on the whole page.', 22));
const t5c = thread(108, { kind: 'document' }, 23);
threads.push(t5c);
comments.push(comment(t5c.id, 'me', 'A note on the whole document.', 23));
const t5d = thread(109, { kind: 'page', page: 1 }, 24);
threads.push(t5d);
comments.push(comment(t5d.id, 'me', 'A second note on the page.', 24));
// T6 and T7: two threads on highlight 9. The first (older) takes the highlight, the second gets a dotted underline
const t6 = thread(110, m9.anchor, 25);
threads.push(t6);
comments.push(comment(t6.id, 'me', 'Who collects the administrative data?', 25));
const t7 = thread(111, m9.anchor, 26);
threads.push(t7);
comments.push(comment(t7.id, 'me', 'Which analyses?', 26));
// T8: cannot be placed: becomes a margin note that starts with the quote
const t8 = thread(112, one(2, 'income? Economists and policymakers are keenly interested'), 27);
threads.push(t8);
comments.push(comment(t8.id, 'me', 'This thread lost its place.', 27));
const unplaceableThreadId = t8.id;
// T12: a thread on part of a longer highlight (12): it keeps its own range, as a dotted underline beside the highlight
const t12 = thread(116, one(1, 'non-linear taxes'), 29);
threads.push(t12);
comments.push(comment(t12.id, 'me', 'Why non-linear?', 29));
// T9: Claude is the root (a comment made through the connector) with three replies, out of order in the array
const t9 = thread(113, one(0, 'NBER working papers are circulated'), 28);
threads.push(t9);
const c9d = comment(t9.id, 'me', 'Fourth, last.', 33);
const c9b = comment(t9.id, 'me', 'Second.', 31);
const c9a = comment(t9.id, 'claude', 'First: the root, by Claude.', 30);
const c9c = comment(t9.id, 'claude', 'Third, with a list:\n\n- one\n- two', 32);
comments.push(c9d, c9b, c9a, c9c);
// excluded rows: a draft thread, a deleted thread, a reply still being written
const t10 = thread(114, one(2, 'earnings'), 34, { draftOfTab: 'tab1' as ThreadRow['draftOfTab'] });
threads.push(t10);
comments.push(comment(t10.id, 'me', 'Draft, never exported.', 34, { draftOfTab: 'tab1' as CommentRow['draftOfTab'] }));
const t11 = thread(115, one(2, 'earnings'), 35, { deletedAt: 5 });
threads.push(t11);
comments.push(comment(t11.id, 'me', 'Deleted, never exported.', 35));
comments.push(comment(t1.id, 'claude', 'still streaming', 36, { meta: { kind: 'claude-reply', v: 1, status: 'streaming', citations: [], webSources: [] } as never }));

// ---------- 2. plan the export ----------
const geometry: PageGeometry[] = [];
{
  const raw = native.openRaw(orig);
  for (let p = 0; p < 3; p++) {
    const page = mod.FPDF_LoadPage(raw.doc, p);
    geometry.push(readGeometry(mod, page, env.pages[p]!.rotation) as PageGeometry);
    mod.FPDF_ClosePage(page);
  }
  raw.close();
}
const col = readTokenColours();
const rgb = (k: string) => col[k]!;
const markRgb = { 1: rgb('sop-mark-1'), 2: rgb('sop-mark-2'), 3: rgb('sop-mark-3'), 4: rgb('sop-mark-4'), 5: rgb('sop-mark-5') };
const lineRgb = { 1: rgb('sop-mark-1-line'), 2: rgb('sop-mark-2-line'), 3: rgb('sop-mark-3-line'), 4: rgb('sop-mark-4-line'), 5: rgb('sop-mark-5-line') };
const place = (a: Anchor) => {
  if (a === t8.anchor) return null;
  if (marks.some((m) => m.id === unplaceableMarkId && m.anchor === a)) return null;
  if (a.kind === 'text') return a.rects;
  if (a.kind === 'area' || a.kind === 'figure') return [{ page: a.page, rects: [a.rect] }];
  return null;
};
const plan = planPdfExport({ marks, threads, comments, geometry, place }, { replies, markRgb, lineRgb, areaRgb: rgb('sop-area-outline'), threadRgb: rgb('sop-thread-underline'), ownerName: 'Rex Heng', replyAppearance: appearance });
console.log(`plan: ${plan.annotations.length} annotations, notPlaced ${plan.notPlaced.length}, skippedMarks ${plan.skippedMarks.length}`);

// ---------- 3. write ----------
const user = (r: { x: number; y: number; width: number; height: number }): [number, number, number, number] => [r.x, r.y, r.x + r.width, r.y + r.height];
const specs = planToSpecs(plan.annotations, geometry, native, quadPoints);
const written = writeCopy(native, orig, specs);
mkdirSync(OUT, { recursive: true });
const outName = `roundtrip-${replies}${replies === 'threaded' ? '-' + appearance : ''}.pdf`;
writeFileSync(resolve(OUT, outName), written.out);
console.log(`wrote ${outName}: tail ${written.tailBytes} bytes, xref ${written.fix}, writer errors ${written.errors.length}`, written.errors.slice(0, 3));
// the expectations for check_file.py (the multi-reader checker)
const pixelOf = (p: PdfAnnotationPlan): string => (p.ap.kind === 'text-markup' ? (p.subtype === 'Highlight' ? 'fill' : p.subtype === 'Underline' ? 'underline' : 'strike') : p.ap.kind === 'dotted-underline' ? 'underline' : p.ap.kind === 'bold-outlines' ? 'bold' : p.ap.kind === 'box' ? 'box' : p.ap.kind === 'note-icon' ? 'icon' : 'none');
writeFileSync(resolve(OUT, outName.replace('.pdf', '.expect.json')), JSON.stringify(plan.annotations.map((p) => ({
  nm: p.nm, subtype: p.subtype, pageIndex: p.pageIndex, rect: user(p.rect), quads: p.quads.length ? p.quads.map(user) : undefined, rgb: p.rgb ?? undefined, contents: p.subtype === 'Popup' ? undefined : (p.contents ?? ''),
  author: p.author ?? undefined, subject: p.subject ?? undefined, irt: p.irt ?? undefined, popupOf: p.popupOf ?? undefined, flags: p.flags, pixel: pixelOf(p),
})), null, 1));

// ---------- 4. read back ----------
const raw = native.openRaw(written.out);
const read = native.readAll(raw.doc, native.pageCountOf(raw.doc)) as unknown as PdfAnnotation[];
raw.close();
const ours = read.filter((a) => a.nm?.startsWith('sop:'));
console.log(`read back ${read.length} annotations (${ours.length} of ours)`);

// ---------- 5. import, with an anchorFor built the way slice 8.4 will ----------
const toEngine = (p: number, r: { x: number; y: number; width: number; height: number }) => {
  const g = geometry[p]!;
  return { x: r.x - g.crop[0], y: g.crop[3] - (r.y + r.height), width: r.width, height: r.height };
};
function charsIn(p: number, rects: { x: number; y: number; width: number; height: number }[]): { start: number; end: number } | null {
  const glyphs = (native as unknown as { getGlyphs(id: string, p: number): { glyphs: { index: number; box: { x: number; y: number; width: number; height: number }; generated: boolean }[] } }).getGlyphs('v', p).glyphs;
  let lo = Infinity, hi = -1;
  for (const gl of glyphs) {
    if (gl.generated || gl.box.width === 0) continue;
    const cx = gl.box.x + gl.box.width / 2, cy = gl.box.y + gl.box.height / 2;
    if (rects.some((r) => cx >= r.x - 0.5 && cx <= r.x + r.width + 0.5 && cy >= r.y - 0.5 && cy <= r.y + r.height + 0.5)) { lo = Math.min(lo, gl.index); hi = Math.max(hi, gl.index); }
  }
  return hi < 0 ? null : { start: lo, end: hi + 1 };
}
const anchorFor = (a: PdfAnnotation): Anchor | null => {
  const g = geometry[a.pageIndex]!;
  if (a.subtype === 'Square' && a.subject !== 'Bold') return { kind: 'area', page: a.pageIndex, rect: userToNorm(g, a.rect), dHash: dh };
  if (a.subtype === 'Text') return { kind: 'point', page: a.pageIndex, point: userToPoint(g, { x: a.rect.x, y: a.rect.y + a.rect.height }) };
  const quads = (a.subtype === 'Square' ? [a.rect] : a.quads).map((q) => toEngine(a.pageIndex, q));
  const chars = charsIn(a.pageIndex, quads);
  if (!chars) return null;
  const rects = native.getTextRangeRects('v', a.pageIndex, chars.start, chars.end - chars.start).map((r) => norm(a.pageIndex, r));
  return buildTextAnchor({ text, start: { page: a.pageIndex, index: chars.start }, end: { page: a.pageIndex, index: chars.end }, rects: [{ page: a.pageIndex, rects }] });
};
const imported = planPdfImport(read, { refs: [] }, anchorFor, { documentId: DOC as never, markRgb, now: T0 });
console.log(`import: ${imported.marks.length} marks, ${imported.threads.length} threads, ${imported.comments.length} comments, ${imported.refs.length} refs, hide ${imported.hide.length}, skipped ${imported.skipped.length} (${[...new Set(imported.skipped.map((s) => s.subtype))].join(', ')})`);

// ---------- 6. compare ----------
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
const near = (a: NormRect, b: NormRect, t = 2e-4) => a.every((v, i) => Math.abs(v - b[i]!) <= t);
const rectsClose = (a: { page: number; rects: NormRect[] }[], b: { page: number; rects: NormRect[] }[]) =>
  a.length === b.length && a.every((pa, i) => pa.page === b[i]!.page && pa.rects.length === b[i]!.rects.length && pa.rects.every((r, k) => near(r, b[i]!.rects[k]!)));
const refText = (c: CommentRow) => commentPlainText(c);

const exportedMarks = marks.filter((m) => m.deletedAt === null && m.id !== unplaceableMarkId);
check('skippedMarks is exactly the unplaceable mark', plan.skippedMarks.length === 1 && plan.skippedMarks[0] === unplaceableMarkId);
check('notPlaced is exactly the unplaceable thread', plan.notPlaced.length === 1 && plan.notPlaced[0] === unplaceableThreadId);
check('deleted, draft and still-streaming rows are not in the file', !plan.annotations.some((p) => /Draft, never|Deleted, never|still streaming/.test(p.contents ?? '')) && !plan.annotations.some((p) => p.nm === `sop:${uuid(10)}`));
check('every /NM is unique per page', new Set(plan.annotations.map((p) => `${p.pageIndex}|${p.nm}`)).size === plan.annotations.length);
check('every /NM is one of ours', plan.annotations.every((p) => parseNm(p.nm) !== null));
check('a root and its popup come before its replies; every IRT target comes earlier on the same page', plan.annotations.every((p, i) => !p.irt || plan.annotations.slice(0, i).some((q) => q.nm === p.irt && q.pageIndex === p.pageIndex)));
check('every annotation the plan lists was written and read back', plan.annotations.every((p) => ours.some((a) => a.nm === p.nm && a.subtype === p.subtype)), `${plan.annotations.length} vs ${ours.length}`);

// marks: id, style, colour, anchor
for (const m of exportedMarks) {
  const got = imported.marks.find((x) => x.id === m.id);
  const tag = `mark ${m.style} #${Number(m.id.slice(-12))}`;
  check(`${tag}: comes back with its own id`, !!got);
  if (!got) continue;
  check(`${tag}: style and colour`, got.style === m.style && got.color === m.color, `${got.style}/${got.color} vs ${m.style}/${m.color}`);
  const hostOf = threads.find((t) => t.anchor === m.anchor && t.deletedAt === null && t.draftOfTab === null && m.style === 'highlight' && !(t === t7));
  check(`${tag}: created and updated times (to the second)${hostOf ? ', which are the hosted comment\'s' : ''}`, hostOf ? got.createdAt === sec(hostOf.createdAt) : got.createdAt === sec(m.createdAt) && got.updatedAt === sec(m.updatedAt));
  check(`${tag}: author stays 'me', page and order`, got.author === 'me' && got.pageIndex === m.pageIndex);
  if (m.anchor.kind === 'text' && got.anchor.kind === 'text') {
    check(`${tag}: range start and end (chars)`, got.anchor.start.page === m.anchor.start.page && got.anchor.start.index === m.anchor.start.index && got.anchor.end.page === m.anchor.end.page && got.anchor.end.index === m.anchor.end.index,
      `${JSON.stringify(got.anchor.start)}-${JSON.stringify(got.anchor.end)} vs ${JSON.stringify(m.anchor.start)}-${JSON.stringify(m.anchor.end)}`);
    check(`${tag}: quote and context`, got.anchor.quote.quote === m.anchor.quote.quote && got.anchor.quote.prefix === m.anchor.quote.prefix && got.anchor.quote.suffix === m.anchor.quote.suffix, JSON.stringify(got.anchor.quote.quote.slice(0, 40)));
    check(`${tag}: line rects`, rectsClose(got.anchor.rects, m.anchor.rects));
  } else if (m.anchor.kind === 'area' && got.anchor.kind === 'area') {
    check(`${tag}: area page and rect`, got.anchor.page === m.anchor.page && near(got.anchor.rect, m.anchor.rect));
  } else check(`${tag}: anchor kind`, false, `${got.anchor.kind} vs ${m.anchor.kind}`);
}
check('the unplaceable and the deleted mark are not imported', !imported.marks.some((x) => x.id === unplaceableMarkId || x.id === uuid(10)));
check('no more marks than exported', imported.marks.length === exportedMarks.length, `${imported.marks.length} vs ${exportedMarks.length}`);

// threads: match by first-comment text (ids of a highlight-hosted thread are not in the file)
const liveThreads = threads.filter((t) => t.deletedAt === null && t.draftOfTab === null);
const rootTextOf = (t: ThreadRow) => refText(comments.filter((c) => c.threadId === t.id && c.deletedAt === null && c.draftOfTab === null && (c.meta as { status?: string }).status !== 'streaming').sort((a, b) => a.createdAt - b.createdAt)[0]!);
for (const t of liveThreads) {
  if (t.id === t8.id) continue; // checked below: its note starts with the quote
  const orig_cs = comments.filter((c) => c.threadId === t.id && c.deletedAt === null && c.draftOfTab === null && (c.meta as { status?: string }).status !== 'streaming').sort((a, b) => a.createdAt - b.createdAt);
  const tag = `thread #${Number(t.id.slice(-12))} (${t.anchor.kind}${t.anchor.kind === 'figure' && t.anchor.sub?.point ? ' pin' : ''})`;
  const want = rootTextOf(t);
  const got = imported.threads.find((x) => imported.comments.find((c) => c.threadId === x.id && noteText(c.body) === want && c === imported.comments.filter((cc) => cc.threadId === x.id)[0]));
  if (replies === 'folded') {
    // folded replies are text in the root: the thread comes back as one comment holding all of it
    const gotF = imported.threads.find((x) => noteText(imported.comments.find((c) => c.threadId === x.id)!.body).startsWith(want));
    check(`${tag}: comes back (folded, one comment)`, !!gotF);
    continue;
  }
  check(`${tag}: comes back`, !!got);
  if (!got) continue;
  const gcs = imported.comments.filter((c) => c.threadId === got.id).sort((a, b) => a.createdAt - b.createdAt);
  check(`${tag}: same comments in the same order (plain text)`, gcs.length === orig_cs.length && gcs.every((c, i) => noteText(c.body) === refText(orig_cs[i]!)), `${gcs.length} vs ${orig_cs.length}`);
  check(`${tag}: authors: all 'me', the PDF's name kept as a label`, gcs.every((c) => c.author === 'me') && gcs.every((c, i) => (c.meta as { author?: string }).author === (orig_cs[i]!.author === 'claude' ? 'Claude' : 'Rex Heng')));
  check(`${tag}: created times (to the second)`, gcs.every((c, i) => c.createdAt === sec(orig_cs[i]!.createdAt)));
  const dedicated = ['area', 'figure', 'point', 'page', 'document'].includes(t.anchor.kind) || t === t2 || t === t7 || t === t12;
  if (dedicated && t.id !== t8.id) check(`${tag}: keeps its thread id`, got.id === t.id, `${got.id} vs ${t.id}`);
  const a = got.anchor, b = t.anchor;
  if (b.kind === 'text' && a.kind === 'text') check(`${tag}: anchor range`, a.start.index === b.start.index && a.end.index === b.end.index && a.quote.quote === b.quote.quote, `${a.start.index}-${a.end.index} vs ${b.start.index}-${b.end.index}`);
  else if ((b.kind === 'area' || b.kind === 'figure') && !(b.kind === 'figure' && b.sub?.point)) check(`${tag}: anchor is an area at the same place`, a.kind === 'area' && near(a.rect, (b as { rect: NormRect }).rect), JSON.stringify(a));
  else if (b.kind === 'figure' && b.sub?.point) check(`${tag}: the pin is at the same point (within the icon's size)`, a.kind === 'point' && Math.abs(a.point[0] - b.sub.point[0]) < 0.04 && Math.abs(a.point[1] - b.sub.point[1]) < 0.04, JSON.stringify(a));
  else if (b.kind === 'point') check(`${tag}: the pin is at the same point`, a.kind === 'point' && Math.abs(a.point[0] - b.point[0]) < 1e-3 && Math.abs(a.point[1] - b.point[1]) < 1e-3, JSON.stringify(a));
  else if (b.kind === 'page') check(`${tag}: a page note on the same page`, a.kind === 'page' && a.page === b.page);
  else if (b.kind === 'document') check(`${tag}: a document note`, a.kind === 'document');
}
// the margin note of the unplaceable thread starts with its quote
const lost = imported.comments.find((c) => /This thread lost its place/.test(c.body));
check('unplaceable thread: the note starts with the quote and keeps the comment', !!lost && noteText(lost.body).startsWith('"income? Economists and policymakers are keenly interested"') && /This thread lost its place/.test(lost.body), lost ? noteText(lost.body).slice(0, 80) : 'none');
check('no thread for the draft or the deleted thread', !imported.comments.some((c) => /never exported/.test(c.body)));
check('two threads on one highlight: the first takes it (host highlight has contents), the second has its own dotted underline', ours.filter((a) => a.subtype === 'Underline' && a.subject === 'Comment').length >= 2 && imported.marks.filter((m) => m.id === m9.id).length === 1);

// hiding, refs, no doubling
const hideSet = new Set(imported.hide.map((h) => h.objectNumber));
const imp = ours.filter((a) => a.subtype !== 'Popup');
check('every imported annotation is hidden (nothing draws twice)', imp.every((a) => hideSet.has(a.objectNumber)), `${imp.filter((a) => !hideSet.has(a.objectNumber)).length} not hidden`);
check('popups are not hidden or skipped', !ours.filter((a) => a.subtype === 'Popup').some((a) => hideSet.has(a.objectNumber) || imported.skipped.some((s) => s.objectNumber === a.objectNumber)));
check('refs are unique and cover every imported annotation', new Set(imported.refs.map((r) => r.pdfRef)).size === imported.refs.length && imp.every((a) => imported.refs.some((r) => r.pdfRef === a.nm)));
const second = planPdfImport(read, { refs: imported.refs.map((r) => ({ pdfRef: r.pdfRef, rowId: r.rowId })) }, anchorFor, { documentId: DOC as never, markRgb, now: T0 });
check('importing again with the refs makes no rows', second.marks.length + second.threads.length + second.comments.length === 0, `${second.marks.length}/${second.threads.length}/${second.comments.length}`);
check('importing again still hides the same annotations', second.hide.length === imported.hide.length);
const third = planPdfImport(read, { refs: [] }, anchorFor, { documentId: DOC as never, markRgb, now: T0 });
check('importing the same file twice from scratch gives the same ids', JSON.stringify(third.marks.map((m) => m.id)) === JSON.stringify(imported.marks.map((m) => m.id)) && JSON.stringify(third.threads.map((m) => m.id)) === JSON.stringify(imported.threads.map((m) => m.id)) && JSON.stringify(third.comments.map((m) => m.id)) === JSON.stringify(imported.comments.map((m) => m.id)));
// a foreign file: MuPDF annotations (no /NM), FreeText stays
{
  const foreign = readFileSync(resolve(OUT, 'inputs/paper-50.mupdf-annots.pdf'));
  const raw2 = native.openRaw(foreign);
  const fread = native.readAll(raw2.doc, native.pageCountOf(raw2.doc)).filter((a) => a.pageIndex === 1 && a.subtype !== 'Link') as unknown as PdfAnnotation[];
  raw2.close();
  const fplan = planPdfImport(fread, { refs: [] }, (a) => (a.subtype === 'Text' ? { kind: 'point', page: a.pageIndex, point: [0.1, 0.1] } : a.subtype === 'Square' ? { kind: 'area', page: a.pageIndex, rect: [0.1, 0.1, 0.2, 0.2], dHash: dh } : buildTextAnchor({ text, start: { page: 1, index: 0 }, end: { page: 1, index: 5 }, rects: [{ page: 1, rects: [[0.1, 0.1, 0.2, 0.12]] }] })), { documentId: DOC as never, markRgb });
  check('foreign (MuPDF) file: highlight, underline and square become marks; the sticky note a thread', fplan.marks.map((m) => m.style).sort().join() === 'area,highlight,underline' && fplan.threads.length === 3 /* highlight text, square text, sticky note */, `${fplan.marks.map((m) => m.style)} / ${fplan.threads.length} threads`);
  check('foreign file: FreeText is skipped, and kept as it is', fplan.skipped.some((s) => s.subtype === 'FreeText') && !fplan.hide.some((h) => fread.find((a) => a.objectNumber === h.objectNumber)?.subtype === 'FreeText'));
  check('foreign file: the author is a label, rows are the owner\'s; yellow is slot 1, green slot 2', fplan.comments.every((c) => c.author === 'me') && fplan.comments.some((c) => (c.meta as { author?: string }).author === 'Alice') && fplan.marks.find((m) => m.style === 'highlight')!.color === 1 && fplan.marks.find((m) => m.style === 'underline')!.color === 2, JSON.stringify(fplan.marks.map((m) => m.color)));
  check('foreign file: refs fall back to the object number', fplan.refs.some((r) => /^obj:\d+$/.test(r.pdfRef)));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} round-trip checks pass${replies === 'folded' ? ' (folded replies)' : ''}`);
for (const r of failed) console.log(`  FAIL ${r.name} :: ${r.detail}`);
writeFileSync(resolve(OUT, outName.replace('.pdf', '.roundtrip.json')), JSON.stringify({ results, plan: { count: plan.annotations.length, notPlaced: plan.notPlaced, skippedMarks: plan.skippedMarks }, imported: { marks: imported.marks.length, threads: imported.threads.length, comments: imported.comments.length, refs: imported.refs.length, hide: imported.hide.length, skipped: imported.skipped.length } }, null, 1));
process.exit(failed.length ? 1 : 0);
void ANNOT_FLAG;
