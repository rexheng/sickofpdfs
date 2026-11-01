// Spec-blind table tests for planPdfExport (Phase 8, slice 8.1): how the owner's marks and comment threads become standard
// PDF annotations.
//
// Sources: spec "Export and import" ("highlights, underlines, strikethroughs, bold marks as square annotations with their own
// appearance, labelled Bold, comments and reply threads"); contracts section 9 (the mapping table, "Bodies", "/NM = sop:<row id>",
// "/T = the owner's name or Claude") and its 1 Nov note (export geometry is PdfUserRect, PDF user space, y up, before /Rotate;
// never the engine's top-left PdfRect; options lineRgb/areaRgb/threadRgb/replyAppearance; the result's skippedMarks); the Phase 7-8
// plan's contract additions (PdfAnnotationPlan, the /NM rule for marks that span pages) and carried requirements; the 8.1 goals
// ("a thread that cannot be placed becomes a /Text note on its stored page, starting with the quote"; "a highlight carries one
// thread; a second thread on it gets its own dotted underline"; "normalised 0-1 rectangles convert to PDF user space using the
// crop box's offset"); CLAUDE.md ("no lost notes").
//
// How the tests read the result: by what an annotation IS (subtype, page, text, colour), not by array position or by which row id a
// carrier annotation borrowed its /NM from. Rectangles are PdfUserRect = { x, y, width, height } with (x, y) the lower-left corner.
// Page geometry comes out of real PDF files (see the kit). Every input is deep-frozen, so a plan that edits its input throws.
import { describe, expect, it } from 'vitest';
import type { Anchor, NormRect } from '../model/anchor';
import type { CommentRow, MarkRow, ThreadRow } from '../model/rows';
import {
  AREA_RGB,
  HIDDEN,
  MARK_RGB,
  OWNER,
  THREAD_RGB,
  areaAnchor,
  claudeMeta,
  comment,
  deepFreeze,
  documentAnchor,
  figureAnchor,
  generatedGeometry,
  geometryFromPdf,
  hasFlag,
  identityPlace,
  isExportedFor,
  lineRects,
  mark,
  pageAnchor,
  pointAnchor,
  skippedIds,
  subtypes,
  testAsset,
  textAnchor,
  textAnchorAcross,
  thread,
  topFirst,
  toX,
  userRectOf,
  TAB,
  type ExportInput,
  type ExportOptions,
  type ExportResult,
  type GeometryLike,
  type Placement,
  type PlanPdfExport,
  type UserRectLike,
} from '../../test/spec-blind/pdf-export-kit';
import * as mapping from './pdf-mapping';

const planPdfExport = (mapping as unknown as { planPdfExport: PlanPdfExport }).planPdfExport;

const GEN: GeometryLike[] = deepFreeze(await generatedGeometry());
let mixedCache: GeometryLike[] | null = null;
async function mixed(): Promise<GeometryLike[]> {
  mixedCache ??= deepFreeze(await geometryFromPdf(testAsset('mixed.pdf')));
  return mixedCache;
}

const BASE_OPTS: ExportOptions = { replies: 'threaded', markRgb: MARK_RGB, ownerName: OWNER, areaRgb: AREA_RGB, threadRgb: THREAD_RGB };

interface Rows {
  marks?: MarkRow[];
  threads?: ThreadRow[];
  comments?: CommentRow[];
}
/** Runs the plan on frozen inputs. */
async function run(rows: Rows, o: Partial<ExportOptions> = {}, place: ExportInput['place'] = identityPlace, geometry: GeometryLike[] = GEN): Promise<ExportResult> {
  const input: ExportInput = deepFreeze({ marks: rows.marks ?? [], threads: rows.threads ?? [], comments: rows.comments ?? [], geometry, place });
  return planPdfExport(input, { ...BASE_OPTS, ...o });
}

function expectRect(actual: UserRectLike, want: UserRectLike, digits = 3): void {
  expect(actual.x).toBeCloseTo(want.x, digits);
  expect(actual.y).toBeCloseTo(want.y, digits);
  expect(actual.width).toBeCloseTo(want.width, digits);
  expect(actual.height).toBeCloseTo(want.height, digits);
}
function unionOf(rs: UserRectLike[]): UserRectLike {
  const b = rs.map(toX);
  const x0 = Math.min(...b.map((r) => r.x0));
  const y0 = Math.min(...b.map((r) => r.y0));
  return { x: x0, y: y0, width: Math.max(...b.map((r) => r.x1)) - x0, height: Math.max(...b.map((r) => r.y1)) - y0 };
}
/** Plain text: none of the Markdown or link syntax is left. */
function expectPlain(s: string | null): void {
  expect(s).not.toBeNull();
  for (const bad of ['**', '](', 'cite:', 'web:', '`', '##', '__']) expect(s).not.toContain(bad);
}

const Q1 = 'Residual connections let each layer learn a correction to its input';
const Q2 = 'Ablation studies show that removing the second normalisation layer costs about two points';

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfExport · a mark becomes the right annotation, in the right colour', () => {
  const rows = [
    { style: 'highlight', subtype: 'Highlight', color: 1, author: 'me' },
    { style: 'highlight', subtype: 'Highlight', color: 4, author: 'claude' },
    { style: 'underline', subtype: 'Underline', color: 3, author: 'me' },
    { style: 'underline', subtype: 'Underline', color: 2, author: 'claude' },
    { style: 'strike', subtype: 'StrikeOut', color: 5, author: 'me' },
  ] as const;

  it.each(rows)('$style, colour slot $color, by $author  ->  /$subtype', async (row) => {
    const anchor = textAnchor({ page: 0, start: 120, end: 190, quote: Q1, rects: lineRects(0.2, 2) });
    const m = mark({ n: 1, style: row.style, color: row.color, anchor, author: row.author, createdAt: 1_700_000_001_000, updatedAt: 1_700_000_009_000 });
    const r = await run({ marks: [m] });

    expect(r.annotations).toHaveLength(1); // no popup, no reply: a bare mark is one annotation
    const a = r.annotations[0];
    expect(a.subtype).toBe(row.subtype);
    expect(a.pageIndex).toBe(0);
    expect(a.nm).toBe(`sop:${m.id}`);
    expect(a.rgb).toEqual(MARK_RGB[row.color]); // the colour handed in, unchanged (the token file is the one source)
    expect(a.ap.kind).toBe('text-markup');
    expect(a.author).toBe(row.author === 'claude' ? 'Claude' : OWNER);
    expect(a.createdAt).toBe(1_700_000_001_000);
    expect(a.modifiedAt).toBe(1_700_000_009_000);
    expect(a.contents ?? '').toBe('');
    expect(a.irt).toBeNull();
    expect(a.popupOf).toBeNull();

    // /QuadPoints come from the anchor's line rectangles, one each, in PDF user space
    const want = topFirst(anchor.rects[0].rects.map((n) => userRectOf(n, GEN[0].crop)));
    const got = topFirst(a.quads);
    expect(got).toHaveLength(2);
    got.forEach((q, i) => expectRect(q, want[i]));
    expectRect(a.rect, unionOf(a.quads));
    expect(r.notPlaced).toEqual([]);
    expect(r.skippedMarks).toEqual([]);
  });

  it('bold -> a /Square labelled Bold, with an appearance made of the glyph outlines of exactly its characters', async () => {
    const anchor = textAnchor({ page: 0, start: 300, end: 318, quote: 'a correction to its', rects: lineRects(0.4, 1) });
    const m = mark({ n: 2, style: 'bold', anchor });
    const r = await run({ marks: [m] });

    expect(r.annotations).toHaveLength(1);
    const a = r.annotations[0];
    expect(a.subtype).toBe('Square');
    expect(a.subject).toBe('Bold');
    expect(a.ap.kind).toBe('bold-outlines');
    expect(a.ap.chars).toEqual({ start: 300, count: 18 }); // char range [300, 318): the engine draws these glyphs' outlines
    expect(a.nm).toBe(`sop:${m.id}`);
    expectRect(a.rect, userRectOf(lineRects(0.4, 1)[0], GEN[0].crop));
  });

  const boxes = [
    { name: 'area mark', page: 4, anchor: areaAnchor(4, [0.2, 0.3, 0.6, 0.5]), rect: [0.2, 0.3, 0.6, 0.5] as NormRect },
    { name: 'figure outline marked as an area', page: 0, anchor: figureAnchor(0, [0.1, 0.55, 0.9, 0.85]), rect: [0.1, 0.55, 0.9, 0.85] as NormRect },
  ];
  it.each(boxes)('$name  ->  a /Square in the area colour, no fill, on its page', async (b) => {
    const m = mark({ n: 3, style: 'area', anchor: b.anchor });
    const r = await run({ marks: [m] });
    expect(r.annotations).toHaveLength(1);
    const a = r.annotations[0];
    expect(a.subtype).toBe('Square');
    expect(a.subject).not.toBe('Bold');
    expect(a.pageIndex).toBe(b.page);
    expect(a.rgb).toEqual(AREA_RGB);
    expect(a.ap.kind).toBe('box');
    expect(a.nm).toBe(`sop:${m.id}`);
    expectRect(a.rect, userRectOf(b.rect, GEN[b.page].crop));
  });

  it.each(['bold', 'highlight'] as const)('a %s that runs over two pages is one annotation per page, with the /NM rule for later pages', async (style) => {
    // pages 3 and 4 have different crop boxes (offset (20,30), then a negative origin), so each part must use its own page's box
    const rects: Placement = [
      { page: 3, rects: lineRects(0.9, 2) },
      { page: 4, rects: lineRects(0.05, 2) },
    ];
    const anchor = textAnchorAcross({ start: { page: 3, index: 3100 }, end: { page: 4, index: 40 }, quote: 'over the page break', rects });
    const m = mark({ n: 4, style, anchor });
    const r = await run({ marks: [m] });

    const parts = [...r.annotations].sort((a, b) => a.pageIndex - b.pageIndex);
    expect(parts.map((p) => p.pageIndex)).toEqual([3, 4]);
    expect(parts.map((p) => p.subtype)).toEqual(style === 'bold' ? ['Square', 'Square'] : ['Highlight', 'Highlight']);
    expect(parts[0].nm).toBe(`sop:${m.id}`);
    expect(parts[1].nm).toBe(`sop:${m.id}~4`);
    for (const p of parts) {
      const norm = rects.find((x) => x.page === p.pageIndex)!.rects;
      const want = unionOf(norm.map((n) => userRectOf(n, GEN[p.pageIndex].crop)));
      expectRect(p.rect, want);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfExport · geometry: stored NormRect -> PdfUserRect (PDF user space, y up) on real pages', () => {
  // Every row marks the same 0-1 rectangle, [0.25, 0.1, 0.5, 0.2] of the crop box, top-left origin. The expected rectangles are
  // worked out by hand from the page's crop box: x = left + 0.25 W, top = ury - 0.1 H, bottom = ury - 0.2 H.
  // /Rotate must change nothing: /Rect and /QuadPoints are in unrotated user space (contracts section 9, 1 Nov note).
  const rows = [
    { src: 'generated', label: 'crop box offset (20,30), /Rotate 0', page: 0, rotation: 0, crop: [20, 30, 632, 822], want: { x: 173, y: 663.6, width: 153, height: 79.2 } },
    { src: 'generated', label: 'crop box offset (20,30), /Rotate 90', page: 1, rotation: 90, crop: [20, 30, 632, 822], want: { x: 173, y: 663.6, width: 153, height: 79.2 } },
    { src: 'generated', label: 'crop box offset (20,30), /Rotate 180', page: 2, rotation: 180, crop: [20, 30, 632, 822], want: { x: 173, y: 663.6, width: 153, height: 79.2 } },
    { src: 'generated', label: 'crop box offset (20,30), /Rotate 270', page: 3, rotation: 270, crop: [20, 30, 632, 822], want: { x: 173, y: 663.6, width: 153, height: 79.2 } },
    { src: 'generated', label: 'negative origin, landscape 800 x 500, /Rotate 90', page: 4, rotation: 90, crop: [-10, -20, 790, 480], want: { x: 190, y: 380, width: 200, height: 50 } },
    { src: 'mixed.pdf', label: 'Letter portrait', page: 0, rotation: 0, crop: [0, 0, 612, 792], want: { x: 153, y: 633.6, width: 153, height: 79.2 } },
    { src: 'mixed.pdf', label: 'A4 landscape 842 x 595', page: 1, rotation: 0, crop: [0, 0, 842, 595], want: { x: 210.5, y: 476, width: 210.5, height: 59.5 } },
    { src: 'mixed.pdf', label: 'Letter with /Rotate 90 (612 x 792 in the file)', page: 2, rotation: 90, crop: [0, 0, 612, 792], want: { x: 153, y: 633.6, width: 153, height: 79.2 } },
    { src: 'mixed.pdf', label: '16:9 slide 960 x 540', page: 3, rotation: 0, crop: [0, 0, 960, 540], want: { x: 240, y: 432, width: 240, height: 54 } },
    { src: 'mixed.pdf', label: 'A5 portrait 420 x 595', page: 4, rotation: 0, crop: [0, 0, 420, 595], want: { x: 105, y: 476, width: 105, height: 59.5 } },
  ] as const;

  it.each(rows)('$src · page $page · $label', async (row) => {
    const geometry = row.src === 'generated' ? GEN : await mixed();
    // the fixture really is what the table says (a changed fixture must not pass quietly)
    expect(geometry[row.page].crop).toEqual(row.crop);
    expect(geometry[row.page].rotation).toBe(row.rotation);

    const anchor = textAnchor({ page: row.page, start: 10, end: 40, quote: 'geometry probe', rects: [[0.25, 0.1, 0.5, 0.2]] });
    const m = mark({ n: 5, style: 'highlight', anchor });
    const r = await run({ marks: [m] }, {}, identityPlace, geometry);

    expect(r.annotations).toHaveLength(1);
    const a = r.annotations[0];
    expect(a.pageIndex).toBe(row.page);
    expect(a.quads).toHaveLength(1);
    expectRect(a.quads[0], row.want);
    expectRect(a.rect, row.want);
  });

  it('rectangles come from the current placement (place), not the rectangles stored on the anchor', async () => {
    // A passage that moved when the bytes changed: the stored rectangles are stale, place() holds the real ones.
    const stored = textAnchor({ page: 0, start: 10, end: 60, quote: 'a passage that moved', rects: lineRects(0.2, 1) });
    const moved: Placement = [{ page: 4, rects: lineRects(0.6, 1) }];
    const place = (a: Anchor): Placement | null => (a.kind === 'text' && a.quote.quote === 'a passage that moved' ? moved : identityPlace(a));
    const r = await run({ marks: [mark({ n: 7, style: 'highlight', anchor: stored })] }, {}, place);

    expect(r.annotations).toHaveLength(1);
    expect(r.annotations[0].pageIndex).toBe(4);
    expectRect(r.annotations[0].quads[0], userRectOf(moved[0].rects[0], GEN[4].crop));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfExport · comment threads', () => {
  const passage = () => textAnchor({ page: 0, start: 40, end: 110, quote: Q1, rects: lineRects(0.2, 2) });
  /** A highlight with one thread: a question, a Claude answer with citations, and an edited reply from the owner. */
  function highlightWithThread() {
    const anchor = passage();
    const h = mark({ n: 10, style: 'highlight', color: 1, anchor });
    const t = thread({ n: 10, anchor });
    const c0 = comment({ n: 10, thread: 10, body: 'Why does this work?', createdAt: 1000 });
    const c1 = comment({
      n: 11,
      thread: 10,
      author: 'claude',
      body: 'Because **identity** is easy to learn, see [here](cite:1) and [the paper](web:2).',
      createdAt: 2000,
      meta: claudeMeta({
        citations: [{ n: 1, pageIndex: 8, start: 0, end: 10, textSource: 'pdfium', quote: 'x' }],
        webSources: [{ n: 2, url: 'https://example.org/resnet', title: 'ResNet', citedText: null }],
      }),
    });
    const c2 = comment({ n: 12, thread: 10, body: 'Thanks', createdAt: 3000, editedAt: 3500 });
    return { h, t, c0, c1, c2, comments: [c2, c0, c1] /* not in order on purpose: the root is the earliest */ };
  }

  it('threaded: the highlight is the root, with the root comment as /Contents, a closed popup, and one /Text per reply', async () => {
    const { h, t, c1, c2, comments } = highlightWithThread();
    const r = await run({ marks: [h], threads: [t], comments });

    const highlights = subtypes(r, 'Highlight');
    expect(highlights).toHaveLength(1); // the highlight carries the thread: no second highlight, no dotted underline
    expect(subtypes(r, 'Underline')).toHaveLength(0);
    const root = highlights[0];
    expect([`sop:${h.id}`, `sop:${t.id}`]).toContain(root.nm);
    expect(root.contents).toBe('Why does this work?');
    expect(root.rgb).toEqual(MARK_RGB[1]);
    expect(root.author).toBe(OWNER);
    expect(r.annotations.filter((a) => (a.contents ?? '').includes('Why does this work?'))).toHaveLength(1); // the root text once

    expect(subtypes(r, 'Popup').filter((p) => p.popupOf === root.nm)).toHaveLength(1);

    const replies = r.annotations.filter((a) => a.irt === root.nm);
    expect(replies).toHaveLength(2);
    expect(replies.every((a) => a.subtype === 'Text')).toBe(true);
    const fromClaude = replies.find((a) => a.nm === `sop:${c1.id}`)!;
    const fromMe = replies.find((a) => a.nm === `sop:${c2.id}`)!;
    expect(fromClaude.author).toBe('Claude');
    expect(fromMe.author).toBe(OWNER);
    expect(fromMe.contents).toBe('Thanks');
    expect([fromMe.createdAt, fromMe.modifiedAt]).toEqual([3000, 3500]); // /CreationDate from createdAt, /M from the edit
    expect([fromClaude.createdAt, fromClaude.modifiedAt]).toEqual([2000, 2000]);
    for (const a of replies) expect(a.ap.kind).toBe('empty'); // the default reply appearance, until the Foxit/Acrobat check

    // Markdown is flattened; cite:n is "(p. N)" with N the cited page (the citation's pageIndex 8 is page 9); web:n is the URL
    expectPlain(fromClaude.contents);
    expect(fromClaude.contents).toContain('identity');
    expect(fromClaude.contents).toContain('(p. 9)');
    expect(fromClaude.contents).toContain('https://example.org/resnet');
  });

  it('folded: no reply annotations; the replies are added to the root /Contents, in order, as plain text', async () => {
    const { h, t, comments } = highlightWithThread();
    const r = await run({ marks: [h], threads: [t], comments }, { replies: 'folded' });

    expect(r.annotations.filter((a) => a.irt !== null)).toHaveLength(0);
    expect(subtypes(r, 'Text')).toHaveLength(0);
    const root = subtypes(r, 'Highlight')[0];
    const text = root.contents ?? '';
    expect(text.startsWith('Why does this work?')).toBe(true);
    const at = ['Why does this work?', 'identity', 'Thanks'].map((s) => text.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b)); // oldest first
    expectPlain(text);
    expect(text).toContain('(p. 9)');
    expect(text).toContain('https://example.org/resnet');
  });

  const appearances = [
    { name: 'default (not given)', opt: undefined, hidden: false },
    { name: "'empty'", opt: 'empty', hidden: false },
    { name: "'hidden'", opt: 'hidden', hidden: true },
  ] as const;
  it.each(appearances)('reply appearance $name', async ({ opt, hidden }) => {
    const { h, t, comments } = highlightWithThread();
    const r = await run({ marks: [h], threads: [t], comments }, opt === undefined ? {} : { replyAppearance: opt });
    const replies = subtypes(r, 'Text');
    expect(replies).toHaveLength(2);
    for (const a of replies) {
      if (opt !== 'hidden') expect(a.ap.kind).toBe('empty');
      expect(hasFlag(a.flags, HIDDEN)).toBe(hidden);
    }
  });

  it('a thread on text with no style on it is a dotted underline, in the thread colour, and carries its replies', async () => {
    const anchor = textAnchor({ page: 1, start: 400, end: 460, quote: Q2, rects: lineRects(0.5, 1) });
    const t = thread({ n: 20, anchor });
    const root = comment({ n: 20, thread: 20, body: 'A question about this', createdAt: 100 });
    const reply = comment({ n: 21, thread: 20, body: 'An answer', createdAt: 200 });
    const r = await run({ threads: [t], comments: [root, reply] });

    expect(subtypes(r, 'Highlight')).toHaveLength(0);
    const u = subtypes(r, 'Underline');
    expect(u).toHaveLength(1);
    expect(u[0].ap.kind).toBe('dotted-underline'); // matches the viewer's dotted underline
    expect(u[0].rgb).toEqual(THREAD_RGB);
    expect(u[0].pageIndex).toBe(1);
    expect(u[0].contents).toBe('A question about this');
    expectRect(u[0].quads[0], userRectOf(lineRects(0.5, 1)[0], GEN[1].crop));
    expect(subtypes(r, 'Popup').filter((p) => p.popupOf === u[0].nm)).toHaveLength(1);
    expect(r.annotations.filter((a) => a.irt === u[0].nm).map((a) => a.contents)).toEqual(['An answer']);
  });

  it('a highlight carries one thread; a second thread on the same passage gets its own dotted underline', async () => {
    const anchor = passage();
    const h = mark({ n: 30, style: 'highlight', anchor });
    const tA = thread({ n: 30, anchor, createdAt: 1000 });
    const tB = thread({ n: 31, anchor, createdAt: 2000 });
    const comments = [
      comment({ n: 30, thread: 30, body: 'First thread root', createdAt: 1001 }),
      comment({ n: 31, thread: 30, body: 'First thread reply', createdAt: 1002 }),
      comment({ n: 32, thread: 31, body: 'Second thread root', createdAt: 2001 }),
      comment({ n: 33, thread: 31, body: 'Second thread reply', createdAt: 2002 }),
    ];
    const r = await run({ marks: [h], threads: [tA, tB], comments });

    expect(subtypes(r, 'Highlight')).toHaveLength(1);
    expect(subtypes(r, 'Underline')).toHaveLength(1);
    const carriers = [...subtypes(r, 'Highlight'), ...subtypes(r, 'Underline')];
    expect(carriers.map((a) => a.contents).sort()).toEqual(['First thread root', 'Second thread root']);
    expect(subtypes(r, 'Underline')[0].ap.kind).toBe('dotted-underline');
    for (const [root, reply] of [
      ['First thread root', 'First thread reply'],
      ['Second thread root', 'Second thread reply'],
    ]) {
      const carrier = carriers.find((a) => a.contents === root)!;
      expect(r.annotations.filter((a) => a.irt === carrier.nm).map((a) => a.contents)).toEqual([reply]); // each reply under its own root
    }
  });

  it('a highlight on other text does not carry the thread: it stays plain and the thread gets the dotted underline', async () => {
    const h = mark({ n: 34, style: 'highlight', anchor: textAnchor({ page: 0, start: 500, end: 560, quote: 'some other passage entirely', rects: lineRects(0.7, 1) }) });
    const t = thread({ n: 34, anchor: passage() });
    const r = await run({ marks: [h], threads: [t], comments: [comment({ n: 34, thread: 34, body: 'About the first passage', createdAt: 5 })] });

    const hl = subtypes(r, 'Highlight');
    expect(hl).toHaveLength(1);
    expect(hl[0].contents ?? '').toBe('');
    expect(hl[0].nm).toBe(`sop:${h.id}`);
    const u = subtypes(r, 'Underline');
    expect(u).toHaveLength(1);
    expect(u[0].contents).toBe('About the first passage');
    expect(u[0].ap.kind).toBe('dotted-underline');
  });

  const boxThreads = [
    { name: 'area thread', page: 4, anchor: areaAnchor(4, [0.2, 0.3, 0.6, 0.5]), rect: [0.2, 0.3, 0.6, 0.5] as NormRect },
    { name: 'figure thread (the figure outline)', page: 0, anchor: figureAnchor(0, [0.1, 0.55, 0.9, 0.85]), rect: [0.1, 0.55, 0.9, 0.85] as NormRect },
  ];
  it.each(boxThreads)('$name  ->  a /Square on the rectangle as the root, with a popup and its replies', async (b) => {
    const t = thread({ n: 40, anchor: b.anchor });
    const root = comment({ n: 40, thread: 40, body: 'What does this axis show?', createdAt: 10 });
    const reply = comment({ n: 41, thread: 40, author: 'claude', body: 'Training loss per epoch.', createdAt: 20, meta: claudeMeta() });
    const r = await run({ threads: [t], comments: [root, reply] });

    const squares = subtypes(r, 'Square');
    expect(squares).toHaveLength(1);
    const sq = squares[0];
    expect(sq.pageIndex).toBe(b.page);
    expect(sq.contents).toBe('What does this axis show?');
    expectRect(sq.rect, userRectOf(b.rect, GEN[b.page].crop));
    expect(subtypes(r, 'Popup').filter((p) => p.popupOf === sq.nm)).toHaveLength(1);
    const replies = r.annotations.filter((a) => a.irt === sq.nm);
    expect(replies.map((a) => [a.contents, a.author])).toEqual([['Training loss per epoch.', 'Claude']]);
  });

  const pins = [
    { name: 'a pin (point)', page: 1, anchor: pointAnchor(1, [0.4, 0.3]), subject: null },
    { name: 'a page note', page: 2, anchor: pageAnchor(2), subject: null },
    { name: 'a document note', page: 0, anchor: documentAnchor, subject: 'Document note' },
  ] as const;
  it.each(pins)('$name  ->  a /Text note on the right page, where the contract puts it', async (p) => {
    const t = thread({ n: 50, anchor: p.anchor });
    const r = await run({ threads: [t], comments: [comment({ n: 50, thread: 50, body: 'Remember to check this', createdAt: 7 })] });

    const notes = subtypes(r, 'Text');
    expect(notes).toHaveLength(1);
    const n = notes[0];
    expect(n.pageIndex).toBe(p.page);
    expect(n.contents).toBe('Remember to check this');
    expect(n.ap.kind).toBe('note-icon');
    if (p.subject) expect(n.subject).toBe(p.subject);

    const crop = GEN[p.page].crop;
    const b = toX(n.rect);
    if (p.anchor.kind === 'point') {
      // the icon touches the pin: its position in user space, 0.4 across and 0.3 down from the crop box's top-left
      const px = crop[0] + 0.4 * (crop[2] - crop[0]);
      const py = crop[3] - 0.3 * (crop[3] - crop[1]);
      const dist = Math.hypot(Math.max(b.x0 - px, 0, px - b.x1), Math.max(b.y0 - py, 0, py - b.y1));
      expect(dist).toBeLessThanOrEqual(1);
    } else if (p.anchor.kind === 'page') {
      // the top-left margin of the page (the crop box's top-left, y up: left edge, top edge)
      expect(b.x0).toBeGreaterThanOrEqual(crop[0] - 0.01);
      expect(b.x0 - crop[0]).toBeLessThanOrEqual(100);
      expect(b.y1).toBeLessThanOrEqual(crop[3] + 0.01);
      expect(crop[3] - b.y1).toBeLessThanOrEqual(100);
    }
  });

  it('a thread that cannot be placed becomes a /Text note on its stored page, starting with the quote, and is reported', async () => {
    const stored = textAnchor({ page: 3, start: 500, end: 540, quote: 'sparse transformers reduce the cost', rects: lineRects(0.3, 1) });
    const lost = thread({ n: 60, anchor: stored });
    const fine = thread({ n: 61, anchor: textAnchor({ page: 0, start: 40, end: 110, quote: Q1, rects: lineRects(0.2, 1) }) });
    const comments = [
      comment({ n: 60, thread: 60, body: 'Is this still true today?', createdAt: 1 }),
      comment({ n: 61, thread: 60, body: 'Mostly.', createdAt: 2 }),
      comment({ n: 62, thread: 61, body: 'This one is placed', createdAt: 3 }),
    ];
    const place = (a: Anchor): Placement | null => (a.kind === 'text' && a.quote.quote === 'sparse transformers reduce the cost' ? null : identityPlace(a));
    const r = await run({ threads: [lost, fine], comments }, {}, place);

    const note = r.annotations.find((a) => (a.contents ?? '').includes('Is this still true today?'))!;
    expect(note).toBeDefined();
    expect(note.subtype).toBe('Text');
    expect(note.pageIndex).toBe(3);
    expect(note.contents).toMatch(/^[\s"“”'‘’«»>]*sparse transformers reduce the cost/); // starts with the quote
    expect((note.contents ?? '').indexOf('Is this still true today?')).toBeGreaterThan((note.contents ?? '').indexOf('sparse transformers'));
    expect(r.notPlaced).toEqual([lost.id]);
    expect(r.annotations.find((a) => a.contents === 'Mostly.')?.irt).toBe(note.nm); // the reply still has a root to hang from
    expect(subtypes(r, 'Underline').map((a) => a.contents)).toEqual(['This one is placed']); // the placed thread is untouched
  });

  it('Markdown in a comment is flattened to plain text', async () => {
    const body = '## Plan\n\nThis is **very** _important_ and `code`.\n\n- first item\n- second item\n\nSee [the docs](https://example.com/docs).';
    const t = thread({ n: 70, anchor: pageAnchor(0) });
    const r = await run({ threads: [t], comments: [comment({ n: 70, thread: 70, body, createdAt: 1 })] });
    const c = subtypes(r, 'Text')[0].contents ?? '';
    for (const word of ['Plan', 'very', 'important', 'code', 'first item', 'second item', 'the docs']) expect(c).toContain(word);
    expect(c.indexOf('first item')).toBeLessThan(c.indexOf('second item'));
    expectPlain(c);
    expect(c).not.toContain('*');
    expect(c).not.toContain('_important_');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfExport · what is never exported', () => {
  const A = () => textAnchor({ page: 0, start: 40, end: 110, quote: Q1, rects: lineRects(0.2, 1) });

  it('drafts: an unsent new thread, an unsent reply and a Claude reply still being written are not in the file', async () => {
    const draftThread = thread({ n: 80, anchor: A(), draftOfTab: TAB });
    const live = thread({ n: 81, anchor: textAnchor({ page: 1, start: 400, end: 460, quote: Q2, rects: lineRects(0.5, 1) }) });
    const comments = [
      comment({ n: 80, thread: 80, body: 'SECRET-DRAFT-ROOT', createdAt: 1, draftOfTab: TAB }),
      comment({ n: 81, thread: 81, body: 'A sent note', createdAt: 2 }),
      comment({ n: 82, thread: 81, body: 'SECRET-DRAFT-REPLY', createdAt: 3, draftOfTab: TAB }),
      comment({ n: 83, thread: 81, author: 'claude', body: 'SECRET-STREAMING', createdAt: 4, draftOfTab: TAB, meta: claudeMeta({ status: 'streaming' }) }),
    ];
    for (const replies of ['threaded', 'folded'] as const) {
      const r = await run({ threads: [draftThread, live], comments }, { replies });
      const dump = JSON.stringify(r);
      for (const secret of ['SECRET-DRAFT-ROOT', 'SECRET-DRAFT-REPLY', 'SECRET-STREAMING', draftThread.id, comments[0].id, comments[2].id, comments[3].id]) expect(dump).not.toContain(secret);
      expect(r.annotations.filter((a) => (a.contents ?? '').includes('A sent note'))).toHaveLength(1); // the sent note is there
      expect(r.notPlaced).toEqual([]);
    }
  });

  it.each([
    {
      name: 'a deleted mark is neither exported nor reported as skipped',
      build: () => {
        const m = mark({ n: 90, style: 'highlight', anchor: A(), deletedAt: 5 });
        return { rows: { marks: [m] }, forbid: [m.id] };
      },
    },
    {
      name: 'a deleted thread is not exported, whether or not it could be placed',
      build: () => {
        const t = thread({ n: 91, anchor: textAnchor({ page: 3, start: 1, end: 30, quote: 'gone text', rects: [] }), deletedAt: 5 });
        const c = [comment({ n: 90, thread: 91, body: 'GONE-ROOT', createdAt: 1 }), comment({ n: 91, thread: 91, body: 'GONE-REPLY', createdAt: 2 })];
        return { rows: { threads: [t], comments: c }, forbid: [t.id, 'GONE-ROOT', 'GONE-REPLY', c[0].id, c[1].id] };
      },
    },
    {
      name: 'a deleted reply is not exported, threaded or folded',
      build: () => {
        const t = thread({ n: 92, anchor: A() });
        const keep = comment({ n: 92, thread: 92, body: 'Keep me', createdAt: 1 });
        const gone = comment({ n: 93, thread: 92, body: 'GONE-REPLY', createdAt: 2, deletedAt: 9 });
        return { rows: { threads: [t], comments: [keep, gone] }, forbid: ['GONE-REPLY', gone.id], keep: 'Keep me' };
      },
    },
    {
      name: 'a deleted highlight no longer carries its thread: the thread gets the dotted underline',
      build: () => {
        const m = mark({ n: 94, style: 'highlight', anchor: A(), deletedAt: 5 });
        const t = thread({ n: 94, anchor: A() });
        return { rows: { marks: [m], threads: [t], comments: [comment({ n: 94, thread: 94, body: 'Still here', createdAt: 1 })] }, forbid: [m.id], keep: 'Still here', dotted: true };
      },
    },
  ])('soft-deleted rows: $name', async ({ build }) => {
    const { rows, forbid, keep, dotted } = build() as { rows: Rows; forbid: string[]; keep?: string; dotted?: boolean };
    for (const replies of ['threaded', 'folded'] as const) {
      const r = await run(rows, { replies });
      const dump = JSON.stringify(r);
      for (const s of forbid) expect(dump).not.toContain(s);
      if (keep) expect(r.annotations.filter((a) => (a.contents ?? '').includes(keep))).toHaveLength(1);
      if (dotted) {
        expect(subtypes(r, 'Highlight')).toHaveLength(0);
        expect(subtypes(r, 'Underline')[0].ap.kind).toBe('dotted-underline');
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfExport · nothing is lost, nothing is doubled', () => {
  /** Marks of every kind, some of which cannot be placed, plus threads of every kind. */
  function everything() {
    const m1 = mark({ n: 101, style: 'highlight', anchor: textAnchor({ page: 0, start: 5, end: 25, quote: 'alpha one', rects: lineRects(0.1, 1) }) });
    const m2 = mark({ n: 102, style: 'underline', anchor: textAnchor({ page: 1, start: 5, end: 25, quote: 'beta two', rects: [] }) }); // made in claude.ai: no rectangles
    const m3 = mark({ n: 103, style: 'area', anchor: areaAnchor(1, [0.1, 0.1, 0.4, 0.3]) });
    const m4 = mark({ n: 104, style: 'area', anchor: figureAnchor(2, [0.1, 0.5, 0.9, 0.9]) });
    const m5 = mark({
      n: 105,
      style: 'bold',
      anchor: textAnchorAcross({ start: { page: 3, index: 900 }, end: { page: 4, index: 12 }, quote: 'across', rects: [{ page: 3, rects: lineRects(0.9, 1) }, { page: 4, rects: lineRects(0.05, 1) }] }),
    });
    const m6 = mark({ n: 106, style: 'strike', anchor: textAnchor({ page: 0, start: 50, end: 70, quote: 'gamma six', rects: lineRects(0.3, 1) }) }); // has rectangles; the resolver cannot place it
    const m7 = mark({ n: 107, style: 'highlight', color: 3, author: 'claude', anchor: textAnchor({ page: 4, start: 5, end: 25, quote: 'delta seven', rects: lineRects(0.1, 1) }) });
    const m8 = mark({ n: 108, style: 'highlight', anchor: textAnchor({ page: 0, start: 80, end: 90, quote: 'epsilon eight', rects: lineRects(0.4, 1) }), deletedAt: 3 });
    const t1 = thread({ n: 101, anchor: textAnchor({ page: 0, start: 200, end: 230, quote: 'zeta', rects: lineRects(0.5, 1) }) });
    const t2 = thread({ n: 102, anchor: pointAnchor(1, [0.3, 0.3]) });
    const t3 = thread({ n: 103, anchor: textAnchor({ page: 2, start: 7, end: 17, quote: 'eta three', rects: lineRects(0.5, 1) }) }); // cannot be placed
    const t4 = thread({ n: 104, anchor: A(), draftOfTab: TAB });
    const comments = [
      comment({ n: 101, thread: 101, body: 'About zeta', createdAt: 1 }),
      comment({ n: 102, thread: 101, author: 'claude', body: 'Zeta is the sixth letter', createdAt: 2, meta: claudeMeta() }),
      comment({ n: 103, thread: 102, body: 'A pin', createdAt: 3 }),
      comment({ n: 104, thread: 103, body: 'Lost in the new bytes', createdAt: 4 }),
      comment({ n: 105, thread: 104, body: 'Unsent', createdAt: 5, draftOfTab: TAB }),
    ];
    const place = (a: Anchor): Placement | null => (a.kind === 'text' && ['gamma six', 'eta three'].includes(a.quote.quote) ? null : identityPlace(a));
    return { marks: [m1, m2, m3, m4, m5, m6, m7, m8], threads: [t1, t2, t3, t4], comments, place, m: { m1, m2, m3, m4, m5, m6, m7, m8 }, t: { t1, t2, t3, t4 } };
  }
  function A() {
    return textAnchor({ page: 0, start: 40, end: 110, quote: Q1, rects: lineRects(0.2, 1) });
  }

  it('every mark is either exported or listed in skippedMarks (never both, never neither); deleted marks are neither', async () => {
    const s = everything();
    const r = await run({ marks: s.marks, threads: s.threads, comments: s.comments }, {}, s.place);
    const skipped = skippedIds(r);
    for (const m of s.marks.filter((x) => x.deletedAt === null)) {
      const exported = isExportedFor(r, m.id);
      const listed = skipped.includes(m.id);
      expect(exported !== listed, `mark ${m.id} (${m.style}): exported=${exported}, listed=${listed}`).toBe(true);
    }
    expect(skipped).toContain(s.m.m2.id); // no rectangles at all: it cannot be drawn, so it must be reported
    expect(isExportedFor(r, s.m.m8.id)).toBe(false);
    expect(skipped).not.toContain(s.m.m8.id);
    const claudeMark = r.annotations.find((a) => a.nm === `sop:${s.m.m7.id}`);
    expect(claudeMark?.author).toBe('Claude');
    expect(claudeMark?.rgb).toEqual(MARK_RGB[3]);
  });

  it('every thread is exported or listed in notPlaced (placed ones are not listed); the plan is pure and its /NM values are unique', async () => {
    const s = everything();
    const first = await run({ marks: s.marks, threads: s.threads, comments: s.comments }, {}, s.place); // inputs are frozen: editing one throws
    const again = await run({ marks: s.marks, threads: s.threads, comments: s.comments }, {}, s.place);
    expect(again).toEqual(first);

    expect(first.notPlaced).toEqual([s.t.t3.id]);
    for (const text of ['About zeta', 'Zeta is the sixth letter', 'A pin', 'Lost in the new bytes']) {
      expect(first.annotations.filter((a) => (a.contents ?? '').includes(text)), text).toHaveLength(1); // every sent note, once
    }
    expect(JSON.stringify(first)).not.toContain('Unsent');

    const nms = first.annotations.map((a) => a.nm);
    expect(new Set(nms).size).toBe(nms.length);
    for (const nm of nms) expect(nm.startsWith('sop:')).toBe(true);
    for (const a of first.annotations) {
      expect(a.pageIndex).toBeGreaterThanOrEqual(0);
      expect(a.pageIndex).toBeLessThan(GEN.length);
    }
  });
});
