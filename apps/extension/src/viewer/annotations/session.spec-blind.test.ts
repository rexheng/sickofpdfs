// Spec-blind tests for the annotation session (slice S9): one in-memory model of a document's notes.
//
// Sources:
//   plan Phase 2, S9: "one in-memory model of a document's notes. It draws first, then writes. It undoes cleanly, keeps tabs
//     in step and obeys the save decision." Threads: "startThread writes the thread, its root comment and a highlight ... An
//     empty new note cancels its highlight; emptying an existing note keeps it. A selection over existing comments returns the
//     most recent thread." "Undo and redo apply inverse batches." Saving: "The first mark calls firstMark(), and writes wait
//     while the save question is open. memory-only writes nothing. Undoing a first-mark save also removes that mark."
//     "Tabs in step: change events for the document reload the rows; events carrying this tab's own tabId are ignored."
//     "Placement results are kept in memory and never written."
//   plan Phase 2, Gate 1 items 2-5, 8 and 10 (the keys, comments, replies, no lost text, tabs in step, save rules).
//   contracts section 2: "Marks and threads are independent rows ... Removing or splitting a style never touches a thread";
//     "The owner may delete a Claude row but not rewrite it"; "Resolution is a view, not data ... it never writes the stored anchor".
//   spec, Marks: "Applying a style that already covers the whole selection removes it ... Comments are separate from styles";
//     the Ctrl+Alt+M flow (1-6); "Undo / redo ... (the note box keeps its own undo)".
//   Task 23/30 (SaveController): unsure + first mark saves (with Undo), not-learning + first mark asks, memory-only does nothing.
// Interface: createAnnotationSession(d): AnnotationSession and AnnotationState (plan section 7). Everything at the boundary is
// a fake that follows the contracts (fakes.spec-blind.ts). Real planStyle and resolveAnchor (S3) are used, because the
// session's job is to call them correctly.
// GUESSES, written down: session.tabId is presence.tabId; state() returns the same object until something changes; a new
// thread is in state().threads (with draftOfTab) and its root comment in state().drafts; applyStyle() resolves once the
// mark is drawn and written.
import { describe, expect, it } from 'vitest';
import type { CommentRow, ThreadRow } from '../../../../../packages/core/src/index';
import { DOC, DOC2, PAGES, T_A, T_B, makeTextAnchor, marksOf, range, rig, settle, storeMarks, textOf, until, type Rig } from './harness.spec-blind';
import { commentRow, markRow, threadRow } from '../../store/rows.spec-blind';

const SENTENCE = range(0, 4, 29); // "difference-in-differences"
const MIDDLE = range(0, 10, 20);
const WORD = range(0, 30, 39); // "estimator"
const PAGE1 = range(1, 0, 20);

/** A note the way the owner makes it: select, Ctrl+Alt+M, type. Not yet sent. */
async function newNote(r: Rig, rg = SENTENCE, body = 'Why does this hold?', highlight: 1 | 2 | 3 | 4 | 5 | null = 1) {
  const anchor = await makeTextAnchor([rg]);
  const { threadId, commentId } = r.session.startThread(anchor, { highlight });
  if (body) r.session.typeDraft(commentId, body);
  return { threadId, commentId, anchor };
}
async function sentNote(r: Rig, rg = SENTENCE, body = 'Why does this hold?') {
  const n = await newNote(r, rg, body);
  await r.session.send(n.commentId);
  return n;
}
const live = (r: Rig) => r.store.listAnnotations(DOC);

describe('the page text the tests use', () => {
  it('has the words the offsets point at', () => {
    expect([textOf(SENTENCE), textOf(WORD), textOf(PAGE1)]).toEqual(['difference-in-differences', 'estimator', PAGES[1]!.slice(0, 20)]);
  });
});

describe('select: which thread a selection lands on', () => {
  // A = 4..29 (older), B = 10..35 (newer, overlaps A), C is on page 1.
  const cases: { name: string; at: ReturnType<typeof range>; want: 'A' | 'B' | 'C' | null }[] = [
    { name: 'inside the older thread only', at: range(0, 5, 8), want: 'A' },
    { name: 'inside two threads: the most recent one', at: range(0, 12, 20), want: 'B' },
    { name: 'inside the newer thread only', at: range(0, 30, 34), want: 'B' },
    { name: 'across both: the most recent one', at: range(0, 0, 100), want: 'B' },
    { name: 'just after the end of a thread (end is exclusive)', at: range(0, 35, 40), want: null },
    { name: 'just before the start of a thread', at: range(0, 0, 4), want: null },
    { name: 'on another page', at: range(1, 0, 5), want: 'C' },
    { name: 'on a page with no thread', at: range(2, 0, 5), want: null },
  ];
  it.each(cases)('$name', async ({ at, want }) => {
    const r = rig();
    const ids = { A: (await sentNote(r, range(0, 4, 29), 'older')).threadId, B: (await sentNote(r, range(0, 10, 35), 'newer')).threadId, C: (await sentNote(r, range(1, 0, 20), 'page one')).threadId };
    expect(r.session.threadAt(at)).toBe(want ? ids[want] : null);
  });

  it('a removed thread no longer catches a selection, and the older one shows through', async () => {
    const r = rig();
    const a = await sentNote(r, range(0, 4, 29), 'older');
    const b = await sentNote(r, range(0, 10, 35), 'newer');
    await r.session.removeThread(b.threadId);
    expect(r.session.threadAt(range(0, 12, 20))).toBe(a.threadId);
  });

  it('setActive and setFocusedMark change what the state says, and tell subscribers', async () => {
    const r = rig();
    const n = await sentNote(r);
    const seen: (string | null)[] = [];
    const off = r.session.subscribe(() => seen.push(r.session.state().active));
    r.session.setActive(n.threadId);
    expect(r.session.state().active).toBe(n.threadId);
    r.session.setActive(null);
    expect(r.session.state().active).toBeNull();
    expect(seen).toEqual([n.threadId, null]);
    off();
    r.session.setActive(n.threadId);
    expect(seen).toHaveLength(2);
    const mark = r.session.state().marks[0]!;
    r.session.setFocusedMark(mark.id);
    expect(r.session.state().focusedMark).toBe(mark.id);
    r.session.setFocusedMark(null);
    expect(r.session.state().focusedMark).toBeNull();
  });

  it('state() is the same object until something changes (a view library can rely on it)', async () => {
    const r = rig();
    const before = r.session.state();
    expect(r.session.state()).toBe(before);
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    const after = r.session.state();
    expect(after).not.toBe(before);
    expect(r.session.state()).toBe(after);
  });
});

describe('mark: it draws first, then writes', () => {
  it('the mark is on screen while the write is still on its way, and the same mark is what gets written', async () => {
    const r = rig();
    r.store.hold();
    const done = r.session.applyStyle([SENTENCE], 'highlight', 2);
    await until(() => r.session.state().marks.length === 1);
    expect(r.store.marks.size, 'the write has not finished, yet the mark is drawn').toBe(0);
    expect(r.session.state().marks[0]).toMatchObject({ style: 'highlight', color: 2, author: 'me', documentId: DOC, pageIndex: 0, deletedAt: null });

    r.store.unhold();
    await done;
    await settle();
    const stored = (await live(r)).marks;
    expect(stored.map((m) => m.id)).toEqual(r.session.state().marks.map((m) => m.id));
    expect(await storeMarks(r.store)).toEqual(marksOf(r.session.state()));
  });

  it.each([
    { style: 'highlight', color: 1 },
    { style: 'underline', color: 3 },
    { style: 'strike', color: 5 },
    { style: 'bold', color: null },
  ] as const)('a $style mark keeps its colour slot ($color) and the place it covers', async ({ style, color }) => {
    const r = rig();
    await r.session.applyStyle([WORD], style, color);
    await settle();
    const [m] = r.session.state().marks;
    expect(m).toMatchObject({ style, color, pageIndex: 0, author: 'me' });
    expect(m!.anchor).toMatchObject({ kind: 'text', start: { page: 0, index: 30 }, end: { page: 0, index: 39 }, quote: { quote: 'estimator' } });
    expect(m!.sortKey).toBe((m!.anchor as { rects: { rects: number[][] }[] }).rects[0]!.rects[0]![1]); // the top of the first rect (0-1)
    expect((await live(r)).marks).toHaveLength(1);
  });

  it('a selection that runs over a page break is one mark that starts on the first page', async () => {
    const r = rig();
    await r.session.applyStyle([range(0, 100, PAGES[0]!.length), range(1, 0, 12)], 'highlight', 1);
    const marks = r.session.state().marks;
    expect(marks).toHaveLength(1);
    expect(marks[0]!.pageIndex).toBe(0);
    expect(marks[0]!.anchor).toMatchObject({ start: { page: 0, index: 100 }, end: { page: 1, index: 12 } });
  });

  it('the same style again on the same words takes the mark off; pressing H twice quickly does the same', async () => {
    const r = rig();
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect(await storeMarks(r.store)).toEqual([]);

    const first = r.session.applyStyle([WORD], 'highlight', 1);
    const second = r.session.applyStyle([WORD], 'highlight', 1); // no waiting in between
    await Promise.all([first, second]);
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect(await storeMarks(r.store)).toEqual([]);
  });

  it('taking a style off the middle splits the mark, and another style on the same words stays', async () => {
    const r = rig();
    await r.session.applyStyle([range(0, 4, 39)], 'highlight', 1);
    await r.session.applyStyle([range(0, 4, 39)], 'underline', 3);
    await r.session.applyStyle([MIDDLE], 'highlight', 1);
    await settle();
    expect(marksOf(r.session.state())).toEqual(
      marksOf({
        marks: [
          { style: 'highlight', color: 1, anchor: { kind: 'text', start: { page: 0, index: 4 }, end: { page: 0, index: 10 } } },
          { style: 'highlight', color: 1, anchor: { kind: 'text', start: { page: 0, index: 20 }, end: { page: 0, index: 39 } } },
          { style: 'underline', color: 3, anchor: { kind: 'text', start: { page: 0, index: 4 }, end: { page: 0, index: 39 } } },
        ],
      } as never),
    );
    expect(await storeMarks(r.store)).toEqual(marksOf(r.session.state()));
  });

  it.each([
    { name: 'taking the style off the whole selection (H again)', act: (s: Rig['session']) => s.applyStyle([SENTENCE], 'highlight', 1) },
    { name: 'splitting the mark', act: (s: Rig['session']) => s.applyStyle([MIDDLE], 'highlight', 1) },
    { name: 'removing the mark', act: (s: Rig['session']) => s.removeMark(s.state().marks[0]!.id) },
    { name: 'recolouring the mark', act: (s: Rig['session']) => s.recolor(s.state().marks[0]!.id, 4) },
    { name: 'putting another style on the same words', act: (s: Rig['session']) => s.applyStyle([SENTENCE], 'underline', 2) },
  ])('$name never touches the comment on the same words', async ({ act }) => {
    const r = rig();
    const n = await sentNote(r);
    await act(r.session);
    await settle();
    expect(r.session.state().threads.map((t) => t.id)).toEqual([n.threadId]);
    expect(r.session.state().comments.map((c) => c.body)).toEqual(['Why does this hold?']);
    const stored = await live(r);
    expect(stored.threads.map((t) => t.id)).toEqual([n.threadId]);
    expect(stored.comments.map((c) => c.body)).toEqual(['Why does this hold?']);
  });

  it('recolour changes the colour and nothing else', async () => {
    const r = rig();
    await r.session.applyStyle([SENTENCE], 'underline', 2);
    const before = r.session.state().marks[0]!;
    await r.session.recolor(before.id, 5);
    await settle();
    expect(r.session.state().marks[0]).toMatchObject({ id: before.id, style: 'underline', color: 5, anchor: before.anchor });
    expect((await live(r)).marks[0]).toMatchObject({ id: before.id, color: 5 });
  });

  it('an area mark keeps no colour and sits on its page', async () => {
    const r = rig();
    const id = await r.session.addAreaMark({ kind: 'area', page: 2, rect: [0.1, 0.2, 0.5, 0.6], dHash: '00ff00ff00ff00ff' });
    await settle();
    expect(r.session.state().marks).toEqual([expect.objectContaining({ id, style: 'area', color: null, pageIndex: 2, sortKey: 0.2 })]);
    expect((await live(r)).marks.map((m) => m.id)).toEqual([id]);
  });
});

describe('undo and redo', () => {
  it('walk back and forward through a run of marks; the store always agrees with the screen', async () => {
    const r = rig();
    const s = r.session;
    const snaps: ReturnType<typeof marksOf>[] = [marksOf(s.state())];
    const step = async (fn: () => Promise<unknown>) => {
      await fn();
      await settle();
      snaps.push(marksOf(s.state()));
    };
    await step(() => s.applyStyle([range(0, 4, 39)], 'highlight', 1));
    await step(() => s.applyStyle([MIDDLE], 'underline', 3));
    await step(() => s.applyStyle([range(0, 12, 15)], 'highlight', 1)); // splits the highlight
    await step(() => s.recolor(s.state().marks.find((m) => m.style === 'underline')!.id, 4));
    await step(() => s.removeMark(s.state().marks.find((m) => m.style === 'highlight')!.id));
    expect(new Set(snaps.map((x) => JSON.stringify(x))).size, 'every step changed something').toBe(snaps.length);

    for (let i = snaps.length - 2; i >= 0; i--) {
      await s.undo();
      await settle();
      expect(marksOf(s.state()), `after undoing to step ${i}`).toEqual(snaps[i]);
      expect(await storeMarks(r.store), `store after undoing to step ${i}`).toEqual(snaps[i]);
    }
    for (let i = 1; i < snaps.length; i++) {
      await s.redo();
      await settle();
      expect(marksOf(s.state()), `after redoing to step ${i}`).toEqual(snaps[i]);
      expect(await storeMarks(r.store), `store after redoing to step ${i}`).toEqual(snaps[i]);
    }
  });

  it('undoing a removal brings back the very same mark (same id), and redo removes it again', async () => {
    const r = rig();
    await r.session.applyStyle([SENTENCE], 'highlight', 2);
    const original = r.session.state().marks[0]!;
    await r.session.removeMark(original.id);
    expect(r.session.state().marks).toEqual([]);

    await r.session.undo();
    await settle();
    expect(r.session.state().marks.map((m) => m.id)).toEqual([original.id]);
    expect((await live(r)).marks).toEqual([expect.objectContaining({ id: original.id, color: 2, deletedAt: null })]);

    await r.session.redo();
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect((await live(r)).marks).toEqual([]);
  });

  it('with nothing to undo or redo, nothing happens and nothing is written', async () => {
    const r = rig();
    await r.session.undo();
    await r.session.redo();
    expect(r.session.state().marks).toEqual([]);
    expect(r.store.writeCalls()).toEqual([]);
  });

  it('a new action after an undo ends the redo path', async () => {
    const r = rig();
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await r.session.undo();
    await r.session.applyStyle([WORD], 'underline', 3);
    await r.session.redo();
    await settle();
    expect(marksOf(r.session.state())).toEqual([expect.objectContaining({ style: 'underline' })]);
  });

  it('a removed thread comes back with its comments and replies, and the marks are as they were', async () => {
    const r = rig();
    const n = await sentNote(r);
    const reply = r.session.startReply(n.threadId);
    r.session.typeDraft(reply, 'a second thought');
    await r.session.send(reply);
    const marksBefore = marksOf(r.session.state());

    await r.session.removeThread(n.threadId);
    await settle();
    expect(r.session.state().threads).toEqual([]);
    expect(r.session.state().comments).toEqual([]);
    expect(marksOf(r.session.state()), 'removing a thread leaves its highlight').toEqual(marksBefore);

    await r.session.undo();
    await settle();
    expect(r.session.state().threads.map((t) => t.id)).toEqual([n.threadId]);
    expect(r.session.state().comments.map((c) => c.body)).toEqual(['Why does this hold?', 'a second thought']);
    const stored = await live(r);
    expect(stored.comments.map((c) => c.body)).toEqual(['Why does this hold?', 'a second thought']);
  });
});

describe('fast actions keep their order', () => {
  it('actions fired without waiting end exactly like the same actions made one by one', async () => {
    const script = (s: Rig['session']) => [
      () => s.applyStyle([range(0, 4, 39)], 'highlight', 1),
      () => s.applyStyle([range(0, 4, 39)], 'underline', 2),
      () => s.applyStyle([range(1, 0, 20)], 'strike', 5),
      () => s.applyStyle([MIDDLE], 'highlight', 1), // only makes sense after the first one exists: it splits it
      () => s.applyStyle([range(2, 0, 10)], 'bold', null),
      () => s.applyStyle([range(1, 0, 20)], 'strike', 5), // takes the strike off again
    ];
    const slow = rig();
    for (const act of script(slow.session)) await act();
    await settle();

    const fast = rig();
    await Promise.all(script(fast.session).map((act) => act()));
    await settle();

    expect(marksOf(fast.session.state())).toEqual(marksOf(slow.session.state()));
    expect(await storeMarks(fast.store)).toEqual(await storeMarks(slow.store));
    expect(await storeMarks(fast.store)).toEqual(marksOf(fast.session.state()));
  });

  it('a mark removed while its own write is still in flight ends removed, and the store sees the write before the removal', async () => {
    const r = rig();
    r.store.hold();
    const made = r.session.applyStyle([SENTENCE], 'highlight', 1);
    await until(() => r.session.state().marks.length === 1);
    const id = r.session.state().marks[0]!.id;
    const removed = r.session.removeMark(id);
    await settle(); // the write is still held; the removal is drawn all the same
    expect(r.session.state().marks).toEqual([]);
    expect(r.store.marks.size).toBe(0);

    r.store.unhold();
    await Promise.all([made, removed]);
    await settle();
    expect((await live(r)).marks).toEqual([]);
    const order = r.store.log.filter((l) => l.endsWith(`:${id}`));
    expect(order[0]).toMatch(/^marks:upsert:/);
    expect(order.at(-1)).toMatch(/^marks:soft-delete:/);
  });

  it('an undo asked for during a slow write waits its turn and still undoes that write', async () => {
    const r = rig();
    r.store.hold();
    const made = r.session.applyStyle([SENTENCE], 'highlight', 1);
    await until(() => r.session.state().marks.length === 1);
    const undone = r.session.undo();
    r.store.unhold();
    await Promise.all([made, undone]);
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect(await storeMarks(r.store)).toEqual([]);
  });
});

describe('the save decision', () => {
  it('an already saved paper: marks are written at once, and the session says so', async () => {
    const r = rig();
    expect(r.session.state().mode).toBe('stored');
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await settle();
    expect(await storeMarks(r.store)).toHaveLength(1);
    expect(r.session.state().mode).toBe('stored');
  });

  it('a not-sure paper: the first mark asks the save controller first, then writes, in that order', async () => {
    const r = rig({ save: { kind: 'unsure', reasons: [] } });
    const order: string[] = [];
    const write = r.store.writeAnnotations.bind(r.store);
    r.store.writeAnnotations = async (...a) => (order.push('write'), write(...a));
    const first = r.save.firstMark.bind(r.save);
    r.save.firstMark = async () => (order.push('firstMark'), first());

    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await settle();
    expect(order[0]).toBe('firstMark');
    expect(order).toContain('write');
    expect(r.save.state).toMatchObject({ kind: 'saved', undoable: true });
    expect(await storeMarks(r.store)).toEqual(marksOf(r.session.state()));
    expect((await live(r)).marks[0]).toMatchObject({ documentId: DOC }); // the paper only got its id when it was saved
    expect(r.session.state().mode).toBe('stored');
  });

  it('a paper judged not learning: marks show at once, nothing is written while the question is open, and "Yes" writes them in order', async () => {
    const r = rig({ save: { kind: 'not-learning', reasons: [] } });
    // not awaited: a call may well wait for the answer before it finishes
    const first = r.session.applyStyle([SENTENCE], 'highlight', 1);
    const second = r.session.applyStyle([WORD], 'underline', 3);
    await until(() => r.session.state().marks.length === 2);
    await settle();
    expect(r.save.state.kind).toBe('asking');
    expect(r.session.state().mode).toBe('pending-save');
    expect(r.store.writeCalls(), 'written while the save question was open').toEqual([]);

    await r.save.answerAsk(true);
    await Promise.all([first, second]);
    await until(() => r.store.marks.size === 2);
    expect(r.session.state().mode).toBe('stored');
    expect(r.store.log.map((l) => l.split(':')[1])).toEqual(['upsert', 'upsert']);
    expect(await storeMarks(r.store)).toEqual(marksOf(r.session.state()));
  });

  it('a paper judged not learning, answered "No": the marks stay on screen and nothing is ever stored', async () => {
    const r = rig({ save: { kind: 'not-learning', reasons: [] } });
    const first = r.session.applyStyle([SENTENCE], 'highlight', 1);
    await until(() => r.session.state().marks.length === 1);
    await r.save.answerAsk(false);
    await first;
    await settle();
    expect(r.session.state().mode).toBe('memory-only');
    await r.session.applyStyle([WORD], 'underline', 3);
    await sentNote(r, range(1, 0, 20), 'a note I only want for now');
    await r.session.undo();
    await r.session.redo();
    await settle();
    expect(r.session.state().marks.length).toBeGreaterThan(0);
    expect(r.session.state().comments.map((c) => c.body)).toContain('a note I only want for now');
    expect(r.store.writeCalls(), 'something reached the store').toEqual([]);
    expect([r.store.marks.size, r.store.threads.size, r.store.comments.size]).toEqual([0, 0, 0]);
  });

  it.each([
    { name: 'memory-only from the start', opts: { save: { kind: 'memory-only' } as const } },
    { name: 'no store and no save controller', opts: { noStore: true, saveNull: true } },
  ])('$name: the work is drawn and kept in memory, and nothing is written', async ({ opts }) => {
    const r = rig(opts);
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await sentNote(r, WORD, 'in memory only');
    await settle();
    expect(r.session.state().mode).toBe('memory-only');
    expect(r.session.state().marks.length).toBeGreaterThan(0);
    expect(r.session.state().comments.map((c) => c.body)).toEqual(['in memory only']);
    expect(r.store.writeCalls()).toEqual([]);
    expect(r.store.marks.size + r.store.comments.size + r.store.threads.size).toBe(0);
  });

  it('Incognito is view-only: no marks, no notes, no questions to the save controller, nothing stored', async () => {
    const r = rig({ incognito: true, save: { kind: 'incognito' } });
    expect(r.session.state().mode).toBe('view-only');
    await r.session.applyStyle([SENTENCE], 'highlight', 1).catch(() => undefined);
    await r.session.addAreaMark({ kind: 'area', page: 0, rect: [0, 0, 1, 1], dHash: '0' }).catch(() => undefined);
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect(r.session.state().threads).toEqual([]);
    expect(r.save.calls).not.toContain('firstMark');
    expect(r.store.writeCalls()).toEqual([]);
  });

  it('Undo on the "saved, with Undo" chip takes the first mark away with the save, and the mark is not written again', async () => {
    const r = rig({ save: { kind: 'unsure', reasons: [] } });
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await until(() => r.store.marks.size === 1);
    expect(r.save.state).toMatchObject({ kind: 'saved', undoable: true });

    await r.save.undo(); // the chip: the PDF is forgotten
    await settle();
    expect(r.session.state().marks, 'the mark is still on a PDF that is no longer saved').toEqual([]);
    expect(r.store.marks.size).toBe(0);
    expect(r.store.writeCalls().length).toBeGreaterThan(0);
    const writes = r.store.writeCalls().length;
    await settle();
    expect(r.store.writeCalls().length, 'the session wrote again after the save was undone').toBe(writes);
  });

  it('Ctrl+Z right after the first mark removes the mark', async () => {
    const r = rig({ save: { kind: 'unsure', reasons: [] } });
    await r.session.applyStyle([SENTENCE], 'highlight', 1);
    await settle();
    await r.session.undo();
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect((await live(r)).marks).toEqual([]);
  });
});

describe('comments: type, send, reply, cancel', () => {
  it('starting a note draws its highlight at once, and the empty note is a draft owned by this tab', async () => {
    const r = rig();
    const anchor = await makeTextAnchor([SENTENCE]);
    const { threadId, commentId } = r.session.startThread(anchor, { highlight: 2 });
    const st = r.session.state(); // no waiting: "draws at once"

    expect(st.marks).toEqual([expect.objectContaining({ style: 'highlight', color: 2, anchor })]);
    expect(st.threads).toEqual([expect.objectContaining({ id: threadId, anchor, draftOfTab: r.tab, placement: 'placed' })]);
    expect(st.drafts).toEqual([expect.objectContaining({ id: commentId, threadId, body: '', author: 'me', draftOfTab: r.tab, deletedAt: null })]);
    expect(st.comments).toEqual([]);
    expect(r.session.tabId).toBe(r.presence.tabId);
  });

  it('every key goes to the draft keeper with the thread, in this tab\'s name, and shows on screen', async () => {
    const r = rig();
    const { threadId, commentId } = await newNote(r, SENTENCE, '');
    for (const body of ['W', 'Wh', 'Why']) r.session.typeDraft(commentId, body);
    expect(r.session.state().drafts[0]).toMatchObject({ id: commentId, body: 'Why' });
    const last = r.keeper.calls.filter((c) => c.method === 'change').at(-1)!;
    expect(last.args[0]).toMatchObject({ id: commentId, body: 'Why', draftOfTab: r.tab, threadId });
    expect(last.args[1] ?? r.keeper.pending.get(commentId)?.thread).toMatchObject({ id: threadId, draftOfTab: r.tab });
  });

  it('Enter: the note is sent with the last text typed, as one card; nothing of the draft is left to come back', async () => {
    const r = rig();
    const n = await newNote(r, SENTENCE, 'Why does this hold?');
    r.session.typeDraft(n.commentId, 'Why does this hold? Check the placebo test.'); // typed a moment before Enter, never flushed
    await r.session.send(n.commentId);
    await settle();

    const st = r.session.state();
    expect(st.drafts).toEqual([]);
    expect(st.comments).toEqual([expect.objectContaining({ id: n.commentId, body: 'Why does this hold? Check the placebo test.', author: 'me', draftOfTab: null })]);
    expect(st.threads).toEqual([expect.objectContaining({ id: n.threadId, draftOfTab: null })]);
    expect(st.marks).toHaveLength(1);

    const stored = await live(r);
    expect(stored.comments).toEqual([expect.objectContaining({ id: n.commentId, body: 'Why does this hold? Check the placebo test.', draftOfTab: null })]);
    expect(stored.threads.map((t) => t.id)).toEqual([n.threadId]);
    expect(stored.marks).toHaveLength(1);
    expect(await r.store.listDrafts(DOC, r.tab)).toEqual([]);
    expect(r.keeper.pending.size, 'a write is still waiting that could turn the sent note back into a draft').toBe(0);
  });

  it('a note on a point or a page has no highlight to draw', async () => {
    const r = rig();
    const { threadId, commentId } = r.session.startThread({ kind: 'point', page: 1, point: [0.3, 0.4] }, { highlight: null });
    r.session.typeDraft(commentId, 'look here');
    await r.session.send(commentId);
    await settle();
    expect(r.session.state().marks).toEqual([]);
    expect((await live(r)).threads.map((t) => t.id)).toEqual([threadId]);
  });

  it('replies stack under the note in the order they were sent, and still do after a reload', async () => {
    const r = rig();
    const n = await sentNote(r);
    for (const body of ['first reply', 'second reply']) {
      const id = r.session.startReply(n.threadId);
      expect(r.session.state().drafts).toEqual([expect.objectContaining({ id, threadId: n.threadId, body: '', draftOfTab: r.tab })]);
      r.session.typeDraft(id, body);
      await r.session.send(id);
    }
    await settle();
    const bodies = (s: Rig['session']) => s.state().comments.filter((c) => c.threadId === n.threadId).map((c) => c.body);
    expect(bodies(r.session)).toEqual(['Why does this hold?', 'first reply', 'second reply']);

    const reopened = rig({ shared: r, tab: T_B });
    await until(() => reopened.session.state().comments.length === 3);
    expect(bodies(reopened.session)).toEqual(['Why does this hold?', 'first reply', 'second reply']);
  });

  it('cancelling an empty new note takes its highlight away too, and leaves nothing in the store', async () => {
    const r = rig();
    const n = await newNote(r, SENTENCE, '', 3);
    expect(r.session.state().marks).toHaveLength(1);
    await r.session.cancel(n.commentId);
    await settle();

    const st = r.session.state();
    expect([st.marks, st.threads, st.drafts, st.comments]).toEqual([[], [], [], []]);
    expect(r.keeper.called('drop')).toBeGreaterThan(0);
    expect(await live(r)).toEqual({ marks: [], threads: [], comments: [] });
    expect(await r.store.listDrafts(DOC, r.tab)).toEqual([]);
  });

  it('cancelling a new note that had already been saved as a draft still leaves nothing behind', async () => {
    const r = rig();
    const n = await newNote(r, SENTENCE, 'started, then changed my mind');
    await r.keeper.flush();
    expect((await r.store.listDrafts(DOC, r.tab)).map((c) => c.id)).toEqual([n.commentId]);
    await r.session.cancel(n.commentId);
    await settle();
    expect(await r.store.listDrafts(DOC, r.tab)).toEqual([]);
    expect(await live(r)).toEqual({ marks: [], threads: [], comments: [] });
  });

  it('cancelling a reply draft keeps the note, its replies and its highlight', async () => {
    const r = rig();
    const n = await sentNote(r);
    const reply = r.session.startReply(n.threadId);
    r.session.typeDraft(reply, 'never mind');
    await r.session.cancel(reply);
    await settle();
    expect(r.session.state().drafts).toEqual([]);
    expect(r.session.state().threads.map((t) => t.id)).toEqual([n.threadId]);
    expect(r.session.state().comments).toHaveLength(1);
    expect(r.session.state().marks).toHaveLength(1);
  });

  it('a note on something with no highlight: cancelling it removes the empty note and nothing else', async () => {
    const r = rig();
    await r.session.applyStyle([WORD], 'highlight', 1);
    const { commentId } = r.session.startThread({ kind: 'page', page: 2 }, { highlight: null });
    await r.session.cancel(commentId);
    await settle();
    expect(r.session.state().threads).toEqual([]);
    expect(r.session.state().marks).toHaveLength(1);
  });

  it('Esc keeps the text: after a flush the draft is still a draft, on screen and in the store, and nothing was sent', async () => {
    const r = rig();
    const n = await newNote(r, SENTENCE, 'half a thought');
    await r.keeper.flush(); // what the note box does on Esc, blur or click-away
    expect(r.session.state().drafts).toEqual([expect.objectContaining({ id: n.commentId, body: 'half a thought' })]);
    expect((await r.store.listDrafts(DOC, r.tab)).map((c) => c.body)).toEqual(['half a thought']);
    expect((await live(r)).comments).toEqual([]);
    expect((await live(r)).threads).toEqual([]);
  });

  it('closing the session never throws a draft away', async () => {
    const r = rig();
    const n = await newNote(r, SENTENCE, 'still typing when the tab closed');
    r.session.dispose();
    await settle();
    expect(r.keeper.called('drop')).toBe(0);
    expect(r.keeper.pending.get(n.commentId)?.row.body ?? r.store.comments.get(n.commentId)?.body).toBe('still typing when the tab closed');
  });

  it('the text comes back in the next tab after this one is killed', async () => {
    const r = rig();
    const n = await newNote(r, SENTENCE, 'the whole note, to the last word');
    await r.keeper.flush();
    r.hub.crash(r.tab); // killed: no dispose, no goodbye

    const next = rig({ shared: r, tab: T_B });
    await until(() => next.session.state().drafts.length === 1);
    expect(next.session.state().drafts[0]).toMatchObject({ id: n.commentId, body: 'the whole note, to the last word', draftOfTab: T_B });
  });

  it('...and it comes back in its card: the thread and the place it sits on are there too', async () => {
    // restore() returns comments only, and listAnnotations hides draft threads. The card needs the thread's anchor.
    const r = rig();
    const n = await newNote(r, SENTENCE, 'the whole note');
    await r.keeper.flush();
    r.hub.crash(r.tab);

    const next = rig({ shared: r, tab: T_B });
    await until(() => next.session.state().drafts.length === 1);
    expect(next.session.state().threads.map((t) => t.id)).toContain(n.threadId);
    expect(next.session.state().threads.find((t) => t.id === n.threadId)?.anchor).toEqual(n.anchor);
    // and it can be sent from there
    await next.session.send(n.commentId);
    await settle();
    expect((await next.store.listAnnotations(DOC)).comments.map((c) => c.body)).toEqual(['the whole note']);
  });

  it('while the first tab is alive, a second tab on the same paper does not see or take its draft', async () => {
    const r = rig();
    await newNote(r, SENTENCE, 'only for tab A');
    await r.keeper.flush();
    const other = rig({ shared: r, tab: T_B });
    await settle(5);
    expect(other.session.state().drafts).toEqual([]);
    expect(other.session.state().threads).toEqual([]);
    expect(r.session.state().drafts).toHaveLength(1);
    expect((await r.store.listDrafts(DOC, T_A)).map((c) => c.body)).toEqual(['only for tab A']);
  });
});

describe('editing and deleting notes', () => {
  it('an edit shows at once, stamps the edit time, and can be undone', async () => {
    const r = rig();
    const n = await sentNote(r);
    await r.session.editComment(n.commentId, 'Why does this hold? (edited)');
    await settle();
    const edited = r.session.state().comments[0]!;
    expect(edited).toMatchObject({ body: 'Why does this hold? (edited)' });
    expect(edited.editedAt).toEqual(expect.any(Number));
    expect((await live(r)).comments[0]).toMatchObject({ body: 'Why does this hold? (edited)' });

    await r.session.undo();
    await settle();
    expect(r.session.state().comments[0]).toMatchObject({ body: 'Why does this hold?', editedAt: null });
    expect((await live(r)).comments[0]).toMatchObject({ body: 'Why does this hold?' });
  });

  it('emptying an existing note keeps its highlight', async () => {
    const r = rig();
    await sentNote(r);
    const root = r.session.state().comments[0]!;
    await r.session.editComment(root.id, '').catch(() => undefined);
    await settle();
    expect(r.session.state().marks).toHaveLength(1);
    expect((await live(r)).marks).toHaveLength(1);
  });

  it('deleting a note or a reply leaves the highlight; deleting the highlight leaves the note', async () => {
    const r = rig();
    const n = await sentNote(r);
    const reply = r.session.startReply(n.threadId);
    r.session.typeDraft(reply, 'a reply');
    await r.session.send(reply);

    await r.session.removeComment(reply);
    await settle();
    expect(r.session.state().comments.map((c) => c.id)).toEqual([n.commentId]);
    expect(r.session.state().marks).toHaveLength(1);

    await r.session.removeMark(r.session.state().marks[0]!.id);
    await settle();
    expect(r.session.state().threads.map((t) => t.id)).toEqual([n.threadId]);
    expect(r.session.state().comments.map((c) => c.id)).toEqual([n.commentId]);
    expect((await live(r)).comments.map((c) => c.id)).toEqual([n.commentId]);
  });

  describe('a reply from Claude', () => {
    const claudeThread = (): { thread: ThreadRow; question: CommentRow; answer: CommentRow } => {
      const thread = threadRow({ id: 'ct1' });
      const question = commentRow({ id: 'cq', threadId: 'ct1', body: '@Claude why?', createdAt: 1_700_000_000_100 });
      const meta = { kind: 'claude-reply', v: 1, role: 'default', status: 'done', error: null, questionId: 'cq', citations: [], webSources: [], usage: null, scope: 'passages', figureLabels: [], via: 'viewer', fromTheFuture: { keep: true } } as never;
      const answer = commentRow({ id: 'ca', threadId: 'ct1', author: 'claude', body: 'Because of the placebo test.', meta, createdAt: 1_700_000_000_200 });
      return { thread, question, answer };
    };
    const open = async () => {
      const first = rig();
      const { thread, question, answer } = claudeThread();
      for (const [map, row] of [[first.store.threads, thread], [first.store.comments, question], [first.store.comments, answer]] as const) (map as Map<string, unknown>).set(row.id, row);
      const r = rig({ shared: first, tab: T_B });
      await until(() => r.session.state().comments.length === 2);
      return { r, answer };
    };

    it('can be deleted by the owner, and undo brings it back as it was, still Claude\'s', async () => {
      const { r, answer } = await open();
      await r.session.removeComment(answer.id);
      await settle();
      expect(r.session.state().comments.map((c) => c.id)).toEqual(['cq']);
      expect((await live(r)).comments.map((c) => c.id)).toEqual(['cq']);

      await r.session.undo();
      await settle();
      const back = (await live(r)).comments.find((c) => c.id === 'ca')!;
      expect(back).toMatchObject({ author: 'claude', body: 'Because of the placebo test.' });
      expect(back.meta).toEqual(answer.meta);
    });

    it('cannot be rewritten by the owner', async () => {
      const { r } = await open();
      await r.session.editComment('ca' as never, 'Claude said something else').catch(() => undefined);
      await settle();
      expect(r.session.state().comments.find((c) => c.id === 'ca')).toMatchObject({ author: 'claude', body: 'Because of the placebo test.' });
      expect((await live(r)).comments.find((c) => c.id === 'ca')).toMatchObject({ author: 'claude', body: 'Because of the placebo test.' });
    });
  });
});

describe('tabs in step', () => {
  it('a mark and a sent note made in tab A show up in tab B without a reload', async () => {
    const a = rig();
    const b = rig({ shared: a, tab: T_B });
    await settle();
    let notified = 0;
    b.session.subscribe(() => notified++);

    await a.session.applyStyle([SENTENCE], 'highlight', 4);
    await until(() => b.session.state().marks.length === 1);
    expect(b.session.state().marks[0]).toMatchObject({ style: 'highlight', color: 4 });
    expect(notified).toBeGreaterThan(0);

    await sentNote(a, WORD, 'seen in both tabs');
    await until(() => b.session.state().comments.length === 1);
    expect(b.session.state().comments[0]).toMatchObject({ body: 'seen in both tabs' });
    expect(b.session.state().threads).toHaveLength(1);
    expect(b.session.state().drafts).toEqual([]);
  });

  it('what tab A is still typing never reaches tab B, even when B reloads for another reason', async () => {
    const a = rig();
    const b = rig({ shared: a, tab: T_B });
    await settle();
    await newNote(a, SENTENCE, 'secret draft of tab A');
    await a.keeper.flush();
    await a.session.applyStyle([WORD], 'underline', 2); // a change event: B reloads
    await until(() => b.session.state().marks.length >= 1);
    await settle();
    expect(b.session.state().drafts).toEqual([]);
    expect(b.session.state().comments).toEqual([]);
    expect(b.session.state().threads).toEqual([]);
  });

  it('a tab ignores the echo of its own writes: it does not read the rows again', async () => {
    const a = rig();
    await settle();
    const reads = a.reads.listAnnotations;
    await a.session.applyStyle([SENTENCE], 'highlight', 1);
    await settle(5);
    expect(a.reads.listAnnotations).toBe(reads);
    expect(a.session.state().marks).toHaveLength(1);
  });

  it('a change to another paper is ignored', async () => {
    const a = rig();
    await settle();
    const reads = a.reads.listAnnotations;
    a.store.announce({ table: 'marks', ids: ['x'], op: 'upsert', documentId: DOC2, origin: 'tab' });
    await settle(5);
    expect(a.reads.listAnnotations).toBe(reads);
  });

  it('a change from another tab makes this tab read the rows again, and a closed session stops listening', async () => {
    const a = rig();
    const b = rig({ shared: a, tab: T_B });
    await settle();
    const reads = b.reads.listAnnotations;
    await a.session.applyStyle([SENTENCE], 'highlight', 1);
    await until(() => b.reads.listAnnotations > reads);

    b.session.dispose();
    const stopped = b.reads.listAnnotations;
    const seen = b.session.state();
    await a.session.applyStyle([WORD], 'highlight', 1);
    await settle(5);
    expect(b.reads.listAnnotations).toBe(stopped);
    expect(b.session.state()).toBe(seen);
  });
});

describe('where a note sits is a view, not data', () => {
  it('placing notes on this copy of the PDF never writes anything, and a missing passage is "couldn\'t place", not moved onto other text', async () => {
    const first = rig();
    const text = (page: number, index: number, quote: string) =>
      ({ kind: 'text' as const, quote: { quote, prefix: '', suffix: '' }, start: { page, index }, end: { page, index: index + quote.length }, rects: [] });
    const still = text(0, 4, textOf(SENTENCE));
    const moved = text(0, 50, 'Placebo tests check the pre-period fit.'); // stored on page 0, now on page 1
    const gone = text(2, 5, 'a passage that is not in this file at all');
    for (const [id, a] of [['t-still', still], ['t-moved', moved], ['t-gone', gone]] as const) {
      first.store.threads.set(id, threadRow({ id, anchor: a, pageIndex: a.start.page, createdAt: 1_700_000_000_000 + first.store.threads.size }));
      first.store.comments.set(`c-${id}`, commentRow({ id: `c-${id}`, threadId: id, body: `note ${id}`, createdAt: 1_700_000_000_000 + first.store.comments.size }));
    }
    first.store.marks.set('m-still', markRow({ id: 'm-still', anchor: still }));
    const before = JSON.stringify([...first.store.threads.values(), ...first.store.marks.values()]);

    const r = rig({ shared: first, tab: T_B });
    await until(() => r.session.state().placement.size >= 3);
    const p = r.session.state().placement;

    expect(p.get('t-still')).toMatchObject({ placed: true, by: 'stored' });
    expect(p.get('m-still')).toMatchObject({ placed: true, by: 'stored' });
    expect(p.get('t-moved')).toMatchObject({ placed: true });
    expect((p.get('t-moved') as { by: string }).by).not.toBe('stored');
    expect(p.get('t-gone')).toMatchObject({ placed: false });

    // all three notes are still there to read, and nothing was written
    expect(r.session.state().threads.map((t) => t.id).sort()).toEqual(['t-gone', 't-moved', 't-still']);
    expect(first.store.writeCalls()).toEqual([]);
    expect(JSON.stringify([...first.store.threads.values(), ...first.store.marks.values()])).toBe(before);
    expect(first.store.threads.get('t-gone')!.placement).toBe('placed');
  });
});

describe('dispose', () => {
  it('stops telling subscribers anything', async () => {
    const r = rig();
    let n = 0;
    r.session.subscribe(() => n++);
    r.session.dispose();
    r.store.announce({ table: 'marks', ids: ['x'], op: 'upsert', documentId: DOC });
    await settle(5);
    expect(n).toBe(0);
  });
});
