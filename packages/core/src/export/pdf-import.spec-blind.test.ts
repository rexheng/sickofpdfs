// Spec-blind table tests for planPdfImport (Phase 8, slice 8.1): reading PDF annotations back into editable notes without ever
// doubling a note.
//
// Sources: spec "Export and import" ("Existing annotations then import as editable notes, de-duplicated by their PDF ids, so
// re-opening an exported copy never doubles notes"); contracts section 9 ("Import. Existing PDF annotations import as editable
// notes, de-duplicated by /NM (or the object number) through pdf_import_refs") and section 4 (the v6 table pdf_import_refs); the
// Phase 7-8 plan's contract additions (the planPdfImport signature, the /NM rule `sop:<rowId>` and `sop:<rowId>~<pageIndex>`,
// ImportedMeta, "Imported rows keep author 'me'"), its risk row ("Import draws notes twice: originals hidden in the open handle
// only") and its carried requirements ("Imported Claude comments come back as author 'me' with a from-Claude label"); Gate 1
// walkthrough 10 ("editable notes, replies in order"); CLAUDE.md ("no lost notes").
//
// How the tests read the result: ids and counts, never the order of rows in an array. A "round trip" exports real rows with
// planPdfExport, passes what the engine would read back through planPdfImport, and compares. Foreign annotations (Foxit, Acrobat)
// are written out by hand. The caller's anchorFor is a lookup the test controls; what the importer does with its answer is checked.
import { describe, expect, it } from 'vitest';
import type { Anchor } from '../model/anchor';
import {
  AREA_RGB,
  DOC,
  MARK_RGB,
  OWNER,
  THREAD_RGB,
  UUID_V4,
  areaAnchor,
  claudeMeta,
  comment,
  deepFreeze,
  foreign,
  generatedGeometry,
  identityPlace,
  lineRects,
  mark,
  pointAnchor,
  readBack,
  rowIdOfNm,
  textAnchor,
  textAnchorAcross,
  thread,
  type ExportOptions,
  type ImportResultLike,
  type PlanPdfExport,
  type PlanPdfImport,
  type ReadAnnotationLike,
} from '../../test/spec-blind/pdf-export-kit';
import * as importer from './pdf-import';
import * as mapping from './pdf-mapping';

const planPdfExport = (mapping as unknown as { planPdfExport: PlanPdfExport }).planPdfExport;
// The contract puts both functions in pdf-mapping.ts; the plan's file list gives the import its own file. Either will do.
const planPdfImport = ((importer as unknown as Record<string, unknown>).planPdfImport ?? (mapping as unknown as Record<string, unknown>).planPdfImport) as PlanPdfImport;

const GEN = deepFreeze(await generatedGeometry());
const OPTS: ExportOptions = { replies: 'threaded', markRgb: MARK_RGB, ownerName: OWNER, areaRgb: AREA_RGB, threadRgb: THREAD_RGB };

type Known = { pdfRef: string; rowId: string }[];
async function importing(read: ReadAnnotationLike[], known: Known, anchors: (a: ReadAnnotationLike) => Anchor | null): Promise<ImportResultLike> {
  return planPdfImport(deepFreeze(read), deepFreeze({ refs: known, documentId: DOC }), anchors);
}
/** anchorFor from a table of object number -> anchor. */
const byObject = (m: Record<number, Anchor>) => (a: ReadAnnotationLike): Anchor | null => m[a.objectNumber] ?? null;
const hideKey = (a: { pageIndex: number; objectNumber: number }) => `${a.pageIndex}:${a.objectNumber}`;
const isHidden = (res: ImportResultLike, a: ReadAnnotationLike) => res.hide.some((h) => hideKey(h) === hideKey(a));
const sortedIds = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
const nothingNew = (res: ImportResultLike) => {
  expect(res.marks).toEqual([]);
  expect(res.threads).toEqual([]);
  expect(res.comments).toEqual([]);
  expect(res.refs).toEqual([]);
  expect(res.skipped).toEqual([]);
};
const asKnown = (res: ImportResultLike): Known => res.refs.map((r) => ({ pdfRef: r.pdfRef, rowId: r.rowId }));

// ---------------------------------------------------------------------------------------------------------------
// Our own notes, as the owner makes them

function ours() {
  const mH = mark({ n: 1, style: 'highlight', color: 2, anchor: textAnchor({ page: 0, start: 10, end: 60, quote: 'one', rects: lineRects(0.1, 2) }), author: 'claude' });
  const mU = mark({ n: 2, style: 'underline', color: 4, anchor: textAnchor({ page: 0, start: 100, end: 130, quote: 'two', rects: lineRects(0.3, 1) }) });
  const mS = mark({ n: 3, style: 'strike', color: 5, anchor: textAnchor({ page: 1, start: 5, end: 25, quote: 'three', rects: lineRects(0.2, 1) }) });
  const mB = mark({ n: 4, style: 'bold', anchor: textAnchor({ page: 1, start: 200, end: 215, quote: 'four', rects: lineRects(0.5, 1) }) });
  const mA = mark({ n: 5, style: 'area', anchor: areaAnchor(2, [0.1, 0.2, 0.5, 0.4]) });
  const tD = thread({ n: 1, anchor: textAnchor({ page: 0, start: 300, end: 340, quote: 'five', rects: lineRects(0.6, 1) }) });
  const tP = thread({ n: 2, anchor: pointAnchor(1, [0.4, 0.3]) });
  const comments = [
    comment({ n: 1, thread: 1, body: 'Is this right?', createdAt: 1_700_000_100_000 }),
    comment({ n: 2, thread: 1, author: 'claude', body: 'Yes, see the proof.', createdAt: 1_700_000_200_000, meta: claudeMeta() }),
    comment({ n: 3, thread: 1, body: 'Thanks', createdAt: 1_700_000_300_000 }),
    comment({ n: 4, thread: 2, body: 'Pin note', createdAt: 1_700_000_400_000 }),
  ];
  return { marks: [mH, mU, mS, mB, mA], threads: [tD, tP], comments };
}
type Ours = ReturnType<typeof ours>;

async function exportOurs(s: Ours) {
  const plan = await planPdfExport(deepFreeze({ marks: s.marks, threads: s.threads, comments: s.comments, geometry: GEN, place: identityPlace }), OPTS);
  const read = readBack(plan.annotations);
  // the caller's job in the product: turn an annotation back into an anchor. Here it simply looks the row up by the id in /NM.
  const threadAnchor = new Map<string, Anchor>(s.threads.map((t) => [t.id, t.anchor]));
  const anchorOfRow = new Map<string, Anchor>([
    ...s.marks.map((m) => [m.id, m.anchor] as const),
    ...s.threads.map((t) => [t.id, t.anchor] as const),
    ...s.comments.flatMap((c) => (threadAnchor.has(c.threadId) ? [[c.id, threadAnchor.get(c.threadId)!] as const] : [])), // a reply sits on its thread's anchor
  ]);
  const anchorFor = (a: ReadAnnotationLike): Anchor | null => (a.nm ? (anchorOfRow.get(rowIdOfNm(a.nm)) ?? null) : null);
  return { plan, read, anchorFor };
}

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfImport · the file we exported comes back as the same notes', () => {
  it('marks and replies return under their own ids; threads, root comments and replies keep their anchors, order and a from-Claude label', async () => {
    const s = ours();
    const { read, anchorFor } = await exportOurs(s);
    const res = await importing(read, [], anchorFor);

    // marks: same ids (so a store that already holds them gets no second copy), same style, same anchor; imported rows are the owner's.
    // No extra mark appears for a note that was only a thread (the dotted underline is not a real underline).
    expect(sortedIds(res.marks)).toEqual(sortedIds(s.marks));
    for (const orig of s.marks) {
      const got = res.marks.find((m) => m.id === orig.id)!;
      expect(got.style).toBe(orig.style);
      expect(got.anchor).toEqual(orig.anchor);
      expect(got.pageIndex).toBe(orig.pageIndex);
      expect(got.author).toBe('me'); // even the highlight Claude made: "Imported rows keep author 'me'"
      expect(got.deletedAt).toBeNull();
      if (orig.style === 'bold' || orig.style === 'area') expect(got.color).toBeNull();
      else expect([1, 2, 3, 4, 5]).toContain(got.color);
    }

    // threads: the two we made, each on its own anchor
    expect(res.threads).toHaveLength(2);
    for (const orig of s.threads) expect(res.threads.some((t) => JSON.stringify(t.anchor) === JSON.stringify(orig.anchor))).toBe(true);
    for (const t of res.threads) {
      expect(t.draftOfTab).toBeNull();
      expect(t.deletedAt).toBeNull();
    }

    // comments: one per comment we wrote (bodies are all different, so a body finds its comment)
    expect(res.comments).toHaveLength(s.comments.length);
    const byBody = new Map(res.comments.map((c) => [c.body, c]));
    for (const orig of s.comments) {
      const got = byBody.get(orig.body)!;
      expect(got, orig.body).toBeDefined();
      expect(got.author).toBe('me'); // Claude's words come back as the owner's rows, never as 'claude' rows
      expect(got.draftOfTab).toBeNull();
      expect(got.deletedAt).toBeNull();
      expect(got.meta).toMatchObject({ kind: 'pdf-import', v: 1 });
      // the label: the PDF's /T survives as the imported comment's author, so the card can say "from Claude"
      expect((got.meta as unknown as { author: string | null }).author).toBe(orig.author === 'claude' ? 'Claude' : OWNER);
    }
    // a reply is a row of its own with its own /NM: it keeps its id
    expect(byBody.get('Yes, see the proof.')!.id).toBe(s.comments[1].id);
    expect(byBody.get('Thanks')!.id).toBe(s.comments[2].id);
    // the three comments of one thread share one imported thread, in order, oldest first; the pin note is in the other
    const q = byBody.get('Is this right?')!;
    expect([byBody.get('Yes, see the proof.')!.threadId, byBody.get('Thanks')!.threadId]).toEqual([q.threadId, q.threadId]);
    expect(byBody.get('Pin note')!.threadId).not.toBe(q.threadId);
    const inThread = res.comments.filter((c) => c.threadId === q.threadId).sort((a, b) => a.createdAt - b.createdAt);
    expect(inThread.map((c) => c.body)).toEqual(['Is this right?', 'Yes, see the proof.', 'Thanks']);
    expect(new Set(inThread.map((c) => c.createdAt)).size).toBe(3);

    // every annotation that became a note is hidden in the open handle, so the overlay does not draw it twice
    for (const a of read.filter((x) => x.subtype !== 'Popup')) expect(isHidden(res, a), `${a.subtype} ${a.nm}`).toBe(true);
    // every ref names a row that was made
    const made = new Set<string>([...res.marks, ...res.threads, ...res.comments].map((r) => r.id));
    expect(res.refs.length).toBeGreaterThan(0);
    for (const ref of res.refs) {
      expect(ref.pdfRef.length).toBeGreaterThan(0);
      expect(made.has(ref.rowId)).toBe(true);
    }
  });

  it('a highlight that carried a thread comes back as one highlight and one thread with every comment, not two copies', async () => {
    const anchor = textAnchor({ page: 0, start: 40, end: 110, quote: 'a passage with a question on it', rects: lineRects(0.2, 2) });
    const h = mark({ n: 11, style: 'highlight', color: 1, anchor });
    const t = thread({ n: 11, anchor });
    const comments = [comment({ n: 11, thread: 11, body: 'Why?', createdAt: 10 }), comment({ n: 12, thread: 11, body: 'Because.', createdAt: 20 })];
    const s: Ours = { marks: [h], threads: [t], comments };
    const { read, anchorFor } = await exportOurs(s);
    const res = await importing(read, [], anchorFor);

    expect(res.marks).toHaveLength(1);
    expect(res.marks[0].style).toBe('highlight');
    expect(res.threads).toHaveLength(1);
    expect(res.comments).toHaveLength(2);
    expect(res.comments.every((c) => c.threadId === res.threads[0].id)).toBe(true);
    expect(res.comments.find((c) => c.body === 'Because.')!.id).toBe(comments[1].id); // the reply keeps its id
    expect(res.comments.find((c) => c.body === 'Why?')).toBeDefined();
  });

  it('opening the exported copy again, with the refs recorded for the annotations we wrote, makes nothing new', async () => {
    const s = ours();
    const { plan, read, anchorFor } = await exportOurs(s);
    // pdf_import_refs holds one row per annotation, keyed by its /NM
    const refs: Known = plan.annotations.map((a) => ({ pdfRef: a.nm, rowId: rowIdOfNm(a.nm) }));
    const res = await importing(read, refs, anchorFor);

    nothingNew(res);
    for (const a of read.filter((x) => x.subtype !== 'Popup')) expect(isHidden(res, a)).toBe(true); // still hidden: our own overlay draws them
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfImport · importing twice never doubles a note', () => {
  const guid = 'a3f0c1e2-5b7d-4a8e-9c21-0d4e6f7a8b9c';
  const anchors = (): Record<number, Anchor> => {
    const passage = textAnchor({ page: 0, start: 50, end: 90, quote: 'a foreign highlight', rects: lineRects(0.25, 1) });
    return { 5: passage, 6: passage, 7: pointAnchor(1, [0.5, 0.5]) };
  };
  const foreignFile = (named: boolean): ReadAnnotationLike[] => [
    foreign({ objectNumber: 5, subtype: 'Highlight', pageIndex: 0, nm: named ? guid : null, contents: 'Note one', author: 'Alex', createdAt: 1000, rgb: [255, 255, 0] }),
    foreign({ objectNumber: 6, subtype: 'Text', pageIndex: 0, nm: named ? 'b1' : null, irtObjectNumber: 5, replyType: 'R', contents: 'Reply one', author: 'Alex', createdAt: 2000 }),
    foreign({ objectNumber: 7, subtype: 'Text', pageIndex: 1, nm: named ? 'c2' : null, contents: 'A sticky note', author: 'Alex', createdAt: 3000 }),
  ];

  const scenarios = [
    { name: 'the file we exported (/NM = sop:<id>)', make: () => exportOurs(ours()).then((e) => ({ read: e.read, anchorFor: e.anchorFor })) },
    { name: 'a Foxit/Acrobat file whose annotations have an /NM', make: () => Promise.resolve({ read: foreignFile(true), anchorFor: byObject(anchors()) }) },
    { name: 'a file whose annotations have no /NM (matched by object number)', make: () => Promise.resolve({ read: foreignFile(false), anchorFor: byObject(anchors()) }) },
  ];
  it.each(scenarios)('$name', async ({ make }) => {
    const { read, anchorFor } = await make();
    const first = await importing(read, [], anchorFor);
    expect(first.marks.length + first.threads.length).toBeGreaterThan(0);

    const second = await importing(read, asKnown(first), anchorFor);
    nothingNew(second);
    for (const a of read.filter((x) => x.subtype !== 'Popup')) expect(isHidden(second, a)).toBe(true);
  });

  it('a multi-page part is recognised by its /NM prefix: one known ref covers every part', async () => {
    const id = '00000000-0000-4000-8000-000000001040';
    const parts = [
      foreign({ objectNumber: 31, subtype: 'Square', pageIndex: 3, nm: `sop:${id}`, subject: 'Bold', author: OWNER }),
      foreign({ objectNumber: 32, subtype: 'Square', pageIndex: 4, nm: `sop:${id}~4`, subject: 'Bold', author: OWNER }),
    ];
    const anchorFor = byObject({
      31: textAnchorAcross({ start: { page: 3, index: 900 }, end: { page: 3, index: 1000 }, quote: 'x', rects: [{ page: 3, rects: lineRects(0.9, 1) }] }),
      32: textAnchorAcross({ start: { page: 4, index: 0 }, end: { page: 4, index: 12 }, quote: 'y', rects: [{ page: 4, rects: lineRects(0.05, 1) }] }),
    });

    // first time: the two parts merge back into ONE bold mark under the id in the /NM
    const first = await importing(parts, [], anchorFor);
    expect(first.marks).toHaveLength(1);
    const m = first.marks[0];
    expect(m.id).toBe(id);
    expect(m.style).toBe('bold');
    expect(m.color).toBeNull();
    expect(m.pageIndex).toBe(3);
    expect(m.anchor.kind).toBe('text');
    if (m.anchor.kind === 'text') {
      expect(m.anchor.start).toEqual({ page: 3, index: 900 });
      expect(m.anchor.end).toEqual({ page: 4, index: 12 });
    }
    for (const p of parts) expect(isHidden(first, p)).toBe(true);

    // a store that knows only the first part's /NM still recognises the second
    nothingNew(await importing(parts, [{ pdfRef: `sop:${id}`, rowId: id }], anchorFor));
    // and the refs this import returned cover both parts
    nothingNew(await importing(parts, asKnown(first), anchorFor));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('planPdfImport · annotations from other tools become editable notes', () => {
  const passage = textAnchor({ page: 2, start: 70, end: 120, quote: 'the passage Alex marked', rects: lineRects(0.4, 2) });
  const box = areaAnchor(2, [0.2, 0.2, 0.6, 0.4]);
  const pin = pointAnchor(2, [0.7, 0.1]);

  const rows = [
    {
      name: 'Highlight, no comment  ->  one highlight',
      a: { subtype: 'Highlight', nm: 'e6a3f1c2-5b7d-4a8e-9c21-0d4e6f7a8b01', rgb: [255, 255, 0] as [number, number, number] },
      anchor: passage,
      want: { marks: 'highlight', threads: 0, comments: 0 },
    },
    { name: 'Underline, no comment  ->  one underline', a: { subtype: 'Underline', nm: null, rgb: [0, 128, 0] as [number, number, number] }, anchor: passage, want: { marks: 'underline', threads: 0, comments: 0 } },
    { name: 'StrikeOut, no comment  ->  one strikethrough', a: { subtype: 'StrikeOut', nm: null, rgb: null }, anchor: passage, want: { marks: 'strike', threads: 0, comments: 0 } },
    { name: 'Square, no comment  ->  one area mark', a: { subtype: 'Square', nm: null, rgb: [255, 0, 0] as [number, number, number] }, anchor: box, want: { marks: 'area', threads: 0, comments: 0 } },
    { name: 'Highlight with a comment  ->  the highlight and a thread with that comment', a: { subtype: 'Highlight', nm: null, rgb: [255, 255, 0] as [number, number, number], contents: 'check this', author: 'Alex' }, anchor: passage, want: { marks: 'highlight', threads: 1, comments: 1 } },
    { name: 'sticky note (Text)  ->  a thread on a pin', a: { subtype: 'Text', nm: null, rgb: null, contents: 'check this', author: 'Alex' }, anchor: pin, want: { marks: null, threads: 1, comments: 1 } },
    { name: 'Square with a comment  ->  a thread on the rectangle', a: { subtype: 'Square', nm: null, rgb: null, contents: 'check this', author: 'Alex' }, anchor: box, want: { marks: undefined, threads: 1, comments: 1 } },
  ];

  it.each(rows)('$name', async ({ a, anchor, want }) => {
    const ann = foreign({ objectNumber: 9, pageIndex: 2, createdAt: 5000, modifiedAt: 6000, ...a });
    const res = await importing([ann], [], byObject({ 9: anchor }));

    if (want.marks === null) expect(res.marks).toHaveLength(0);
    else if (want.marks !== undefined) {
      expect(res.marks).toHaveLength(1);
      expect(res.marks[0].style).toBe(want.marks);
      expect(res.marks[0].author).toBe('me');
      expect(res.marks[0].anchor).toEqual(anchor);
      if (want.marks === 'area') expect(res.marks[0].color).toBeNull();
      else expect([1, 2, 3, 4, 5]).toContain(res.marks[0].color);
    }
    expect(res.threads).toHaveLength(want.threads);
    expect(res.comments).toHaveLength(want.comments);
    if (want.threads) {
      expect(res.threads[0].anchor).toEqual(anchor);
      expect(res.comments[0].body).toBe('check this');
      expect(res.comments[0].author).toBe('me');
      expect(res.comments[0].threadId).toBe(res.threads[0].id);
      expect(res.comments[0].meta).toMatchObject({ kind: 'pdf-import', v: 1, author: 'Alex' });
    }
    // new rows get fresh random version-4 UUIDs, all different
    const ids = [...res.marks, ...res.threads, ...res.comments].map((r) => r.id);
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
    expect(isHidden(res, ann)).toBe(true); // the original is hidden in the open handle: no double drawing
    expect(res.refs.length).toBeGreaterThan(0);
    expect(res.skipped).toEqual([]);
  });

  it('replies are kept in order under their root, including a reply to a reply, whatever order the file lists them in', async () => {
    const read = [
      foreign({ objectNumber: 10, subtype: 'Text', pageIndex: 2, contents: 'Root', author: 'Alex', createdAt: 1000 }),
      foreign({ objectNumber: 11, subtype: 'Text', pageIndex: 2, contents: 'Third', author: 'Claude', createdAt: 3000, irtObjectNumber: 10, replyType: 'R' }),
      foreign({ objectNumber: 12, subtype: 'Text', pageIndex: 2, contents: 'Second', author: 'Alex', createdAt: 2000, irtObjectNumber: 10, replyType: 'R' }),
      foreign({ objectNumber: 13, subtype: 'Text', pageIndex: 2, contents: 'Fourth', author: 'Sam', createdAt: 4000, irtObjectNumber: 12, replyType: 'R' }), // Acrobat nests replies; we do not
    ];
    const res = await importing(read, [], byObject({ 10: pin, 11: pin, 12: pin, 13: pin }));

    expect(res.threads).toHaveLength(1);
    expect(res.comments).toHaveLength(4);
    expect(res.comments.every((c) => c.threadId === res.threads[0].id)).toBe(true);
    const inOrder = [...res.comments].sort((a, b) => a.createdAt - b.createdAt);
    expect(inOrder.map((c) => c.body)).toEqual(['Root', 'Second', 'Third', 'Fourth']);
    expect(new Set(res.comments.map((c) => c.createdAt)).size).toBe(4);
    // a comment signed "Claude" by another tool is still the owner's row: the name is kept as a label, never as a Claude row
    const third = res.comments.find((c) => c.body === 'Third')!;
    expect(third.author).toBe('me');
    expect(third.meta).toMatchObject({ kind: 'pdf-import', v: 1, author: 'Claude' });
    expect(res.comments.every((c) => c.author === 'me')).toBe(true);
  });

  it('things that are not notes are left alone; shapes we cannot hold are listed as skipped and stay visible in the file', async () => {
    const read = [
      foreign({ objectNumber: 1, subtype: 'Link', pageIndex: 2 }),
      foreign({ objectNumber: 2, subtype: 'Widget', pageIndex: 2 }),
      foreign({ objectNumber: 3, subtype: 'Popup', pageIndex: 2 }),
      foreign({ objectNumber: 4, subtype: 'Ink', pageIndex: 2, contents: 'a scribble' }),
      foreign({ objectNumber: 5, subtype: 'Line', pageIndex: 2 }),
      foreign({ objectNumber: 6, subtype: 'Stamp', pageIndex: 2 }),
      foreign({ objectNumber: 7, subtype: 'FreeText', pageIndex: 2, contents: 'typed on the page' }),
      foreign({ objectNumber: 8, subtype: 'Squiggly', pageIndex: 2 }),
      foreign({ objectNumber: 9, subtype: 'Highlight', pageIndex: 2, contents: 'a real note', author: 'Alex' }),
    ];
    const res = await importing(read, [], byObject({ 4: box, 5: box, 6: box, 7: box, 8: passage, 9: passage }));

    // links and form fields are not notes: they are not turned into notes, and they are not hidden (they must keep working)
    for (const n of [1, 2, 3]) expect(isHidden(res, read[n - 1]), `object ${n}`).toBe(false);
    // the ordinary highlight is imported
    expect(isHidden(res, read[8])).toBe(true);
    expect(res.marks.some((m) => m.style === 'highlight')).toBe(true);
    // every markup shape is either imported (hidden, because a note now draws it) or skipped (visible, because nothing else does): never lost
    const skipped = new Map(res.skipped.map((s) => [s.objectNumber, s.subtype]));
    for (const n of [4, 5, 6, 7, 8]) {
      const a = read[n - 1];
      const imported = isHidden(res, a);
      const listed = skipped.has(n);
      expect(imported !== listed, `object ${n} (${a.subtype}): imported=${imported}, skipped=${listed}`).toBe(true);
      if (listed) expect(skipped.get(n)).toBe(a.subtype);
    }
  });
});
