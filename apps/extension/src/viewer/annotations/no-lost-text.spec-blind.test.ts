// Spec-blind tests for the "no lost text" gate across the three slices at once (S2 store, S8 drafts, S9 session).
// Nothing is faked except the three things outside the slices: the clock, the tab roll call (PresenceHub answers at once, so
// timers can be fake) and the save decision. The store is the real one over real SQLite (in memory); a "killed tab" is a
// copy of the database file as it was at that moment, so only what was committed can come back.
//
// Sources:
//   plan Phase 2, done-when 5: "No lost text. Kill the tab 100 ms after typing stops, then reopen: the draft is back in its
//     card, with the caret at the end. Esc and clicking away never lose text."
//   plan Phase 2, Gate 1 item 5: "Kill the renderer 100 ms after the last key, and reopen: the draft is back ... Closing the
//     tab mid-draft gives the same result. With two tabs, the draft stays with tab A until A is gone; then tab B adopts it."
//   contracts section 3: draft rules (300 ms, own tab, adoption, memory-only writes nothing); "A draft disappears only when
//     it is sent, when an empty new note is cancelled, or when the owner discards it."
//   spec: "Note drafts stay local; only saved notes sync."; "The same document open in two tabs stays in step; a draft belongs
//     to the tab where it was started."; CLAUDE.md: "no lost notes"; "nothing saved from non-learning PDFs".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabId } from '../../../../../packages/core/src/ids';
import { count, ftsHits, outboxRows, reopen } from '../../store/db.spec-blind';
import { freshStore, wrapStore, type StoreEnv } from '../../store/env.spec-blind';
import { migrate } from '../../store/migrate';
import { T_A, T_B, T_C } from '../../store/rows.spec-blind';
import type { StoreChange } from '../../store/change-bus';
import { createDraftKeeper } from './drafts';
import { DOC, FakeSave, PresenceHub, anchorContext, makeTextAnchor, range, type SaveStateLike } from './fakes.spec-blind';
import { createAnnotationSession } from './session';

const SENTENCE = range(0, 4, 29);
const WORD = range(0, 30, 39);

/** A change bus like BroadcastChannel: every listener gets every event, a moment later. */
class Bus {
  private listeners = new Set<(c: StoreChange) => void>();
  emit = (c: StoreChange) => void Promise.resolve().then(() => this.listeners.forEach((cb) => cb(c)));
  on = (cb: (c: StoreChange) => void) => (this.listeners.add(cb), () => this.listeners.delete(cb));
}

function connect(env: StoreEnv, bus: Bus) {
  env.publish.mockImplementation(bus.emit);
  return new Proxy(env.api, {
    get(target, key) {
      if (key === 'onChange') return bus.on;
      if (key === 'close') return () => undefined;
      const v = Reflect.get(target, key) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

let hub: PresenceHub;
let bus: Bus;
let clock: { t: number };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
  vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
  hub = new PresenceHub();
  bus = new Bus();
  clock = { t: 1_700_000_000_000 };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const pump = async (ms = 0) => {
  for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(ms / 3);
  await vi.advanceTimersByTimeAsync(0);
};

/** One viewer tab on the real store. */
function openTab(env: StoreEnv, tab: TabId, saveState: SaveStateLike = { kind: 'saved', documentId: DOC, undoable: false }) {
  const store = connect(env, bus);
  const presence = hub.join(tab);
  const save = new FakeSave(saveState);
  const keeper = createDraftKeeper({ store: store as never, presence, memoryOnly: () => save.state.kind !== 'saved' });
  const session = createAnnotationSession({
    store: store as never, save: save as never, anchors: anchorContext(), drafts: keeper, presence,
    makeTextAnchor, documentId: () => save.documentId(), incognito: false, now: () => ++clock.t,
  });
  return { tab, session, keeper, save, presence };
}
type Tab = ReturnType<typeof openTab>;

async function startNote(t: Tab, body: string, at = SENTENCE) {
  const { threadId, commentId } = t.session.startThread(await makeTextAnchor([at]), { highlight: 1 });
  if (body) t.session.typeDraft(commentId, body);
  return { threadId, commentId };
}
const notDraftRows = (env: StoreEnv) => outboxRows(env.db).filter((r) => r.table === 'comments' || r.table === 'threads');

describe('Enter right after the last key', () => {
  it('the sent note stays a sent note: the draft timer that was still waiting cannot turn it back into a draft', async () => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const { commentId, threadId } = await startNote(a, 'Why does this hold?');
    a.session.typeDraft(commentId, 'Why does this hold? Check the placebo test.');
    await a.session.send(commentId); // Enter, 0 ms after the last key
    await pump(5000);

    const stored = await env.api.listAnnotations(DOC);
    expect(stored.comments).toEqual([expect.objectContaining({ id: commentId, threadId, body: 'Why does this hold? Check the placebo test.', draftOfTab: null })]);
    expect(stored.threads.map((t) => t.id)).toEqual([threadId]);
    expect(stored.marks).toHaveLength(1);
    expect(await env.api.listDrafts(DOC, T_A)).toEqual([]);
    expect(ftsHits(env.db, 'placebo')).toEqual([commentId]);
    expect(a.session.state().comments).toHaveLength(1);
  });
});

describe('the tab is killed while typing', () => {
  // A copy of the database at the moment of the kill: what a new tab can find.
  it.each([
    { name: '300 ms after the last key (the saving rule)', silence: 300 },
    { name: '100 ms after the last key (the phase gate)', silence: 100 },
  ])('$name: reopen, and the whole text is back in a new tab, ready to send', async ({ silence }) => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const { commentId, threadId } = await startNote(a, '');
    const typed = 'Does the placebo test rule out anticipation effects? 🙂';
    for (let i = 1; i <= typed.length; i += 7) {
      a.session.typeDraft(commentId, typed.slice(0, i));
      await pump(30);
    }
    a.session.typeDraft(commentId, typed);
    await pump(silence);

    const diskAtKill = await reopen(env.db); // the renderer dies here
    hub.crash(T_A);

    migrate(diskAtKill as never);
    const env2 = wrapStore(diskAtKill, 'devA2');
    const b = openTab(env2, T_B);
    await pump(50);

    expect(b.session.state().drafts).toEqual([expect.objectContaining({ id: commentId, threadId, body: typed, draftOfTab: T_B })]);
    expect(notDraftRows(env2), 'reopening queued the draft for sync').toEqual([]);

    await b.session.send(commentId);
    await pump(1000);
    expect((await env2.api.listAnnotations(DOC)).comments.map((c) => c.body)).toEqual([typed]);
  });

  it('...and the draft is back in its card: the new tab knows the note\'s thread and where it sits', async () => {
    // restore() gives back comments only and listAnnotations hides draft threads: the card needs the thread's anchor from somewhere.
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const anchor = await makeTextAnchor([SENTENCE]);
    const { threadId, commentId } = a.session.startThread(anchor, { highlight: 1 });
    a.session.typeDraft(commentId, 'my draft');
    await pump(300);
    hub.crash(T_A);

    const b = openTab(env, T_B);
    await pump(50);
    expect(b.session.state().drafts.map((d) => d.body)).toEqual(['my draft']);
    expect(b.session.state().threads.find((t) => t.id === threadId)?.anchor).toEqual(anchor);
  });

  it('closing the tab (a normal close, with goodbye) gives the same result', async () => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const { commentId } = await startNote(a, 'closing the tab mid-sentence');
    await a.keeper.flush(); // pagehide / visibilitychange
    a.session.dispose();
    a.presence.close();

    const b = openTab(env, T_B);
    await pump(50);
    expect(b.session.state().drafts.map((d) => [d.id, d.body])).toEqual([[commentId, 'closing the tab mid-sentence']]);
  });
});

describe('two tabs on one paper', () => {
  it('the draft stays with tab A while A is open; tab B sees notes A posted, not the draft; when A is gone, B adopts it', async () => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const posted = await startNote(a, 'a note A has posted', SENTENCE);
    await a.session.send(posted.commentId);
    const draft = await startNote(a, 'a note A is still writing', WORD);
    await pump(400);

    const b = openTab(env, T_B);
    await pump(50);
    expect(b.session.state().comments.map((c) => c.body), 'B sees what A posted').toEqual(['a note A has posted']);
    expect(b.session.state().drafts, "B must not see A's draft").toEqual([]);
    expect(b.session.state().threads.map((t) => t.id)).not.toContain(draft.threadId);
    expect(a.session.state().drafts.map((d) => d.body)).toEqual(['a note A is still writing']);
    expect((await env.api.listDrafts(DOC, T_A)).map((c) => c.body)).toEqual(['a note A is still writing']);

    // A posts a second note: B sees it without a reload
    const second = await startNote(a, 'second posted note', range(1, 0, 20));
    await a.session.send(second.commentId);
    await pump(50);
    expect(b.session.state().comments.map((c) => c.body).sort()).toEqual(['a note A has posted', 'second posted note']);

    // A goes: the next tab to open the paper gets the draft
    hub.crash(T_A);
    const c = openTab(env, T_C);
    await pump(50);
    expect(c.session.state().drafts.map((d) => [d.id, d.body, d.draftOfTab])).toEqual([[draft.commentId, 'a note A is still writing', T_C]]);
  });
});

describe('what typing leaves behind', () => {
  it('a draft is never queued for sync and never searchable, however much is typed', async () => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const { commentId } = await startNote(a, '');
    for (let i = 1; i <= 40; i++) {
      a.session.typeDraft(commentId, `walrus ${'x'.repeat(i)}`);
      await pump(25);
    }
    await a.keeper.flush();
    await pump(1000);
    expect((await env.api.listDrafts(DOC, T_A))[0]?.body).toBe(`walrus ${'x'.repeat(40)}`);
    expect(notDraftRows(env)).toEqual([]);
    expect(ftsHits(env.db, 'walrus')).toEqual([]);
    expect(env.changes().filter((c) => c.table === 'comments' || c.table === 'threads'), 'draft writes must publish nothing').toEqual([]);
  });

  it('a cancelled note leaves no draft to come back and no mark behind', async () => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    const { commentId } = await startNote(a, 'changed my mind');
    await pump(400);
    expect(await env.api.listDrafts(DOC, T_A)).toHaveLength(1);
    await a.session.cancel(commentId);
    await pump(2000);
    expect(await env.api.listDrafts(DOC, T_A)).toEqual([]);
    expect(await env.api.listAnnotations(DOC)).toEqual({ marks: [], threads: [], comments: [] });

    hub.crash(T_A);
    const b = openTab(env, T_B);
    await pump(50);
    expect(b.session.state().drafts).toEqual([]);
  });
});

describe('nothing is stored for a paper that is not saved', () => {
  it.each([
    { name: 'the owner said "no"', state: { kind: 'memory-only' } as SaveStateLike },
    { name: 'the save question is still open', state: { kind: 'asking' } as SaveStateLike },
  ])('$name: marks, notes, replies and drafts leave no row in any table', async ({ state }) => {
    const env = await freshStore();
    const a = openTab(env, T_A, state);
    await pump();
    void a.session.applyStyle([WORD], 'highlight', 1); // not awaited: with the question open a call may wait for the answer
    const n = await startNote(a, 'typed on a paper I did not save');
    await a.keeper.flush();
    await pump(1000);
    void a.session.send(n.commentId);
    await pump(1000);
    a.session.dispose();

    for (const table of ['marks', 'threads', 'comments', 'outbox', 'comments_fts']) expect(count(env.db, table), `rows in ${table}`).toBe(0);
    expect(a.session.state().marks.length).toBeGreaterThan(0);
  });
});

describe('after a reload', () => {
  it('marks, a sent note with its replies and an undone mark are exactly as they were left', async () => {
    const env = await freshStore();
    const a = openTab(env, T_A);
    await pump();
    await a.session.applyStyle([WORD], 'underline', 3);
    await a.session.applyStyle([range(1, 0, 20)], 'strike', 5);
    await a.session.undo(); // the strike goes
    const n = await startNote(a, 'root');
    await a.session.send(n.commentId);
    for (const body of ['reply one', 'reply two']) {
      const id = a.session.startReply(n.threadId);
      a.session.typeDraft(id, body);
      await a.session.send(id);
    }
    await pump(500);

    hub.crash(T_A);
    const b = openTab(env, T_B);
    await pump(50);
    const s = b.session.state();
    expect(s.marks.map((m) => m.style).sort()).toEqual(['highlight', 'underline']);
    expect(s.comments.map((c) => c.body)).toEqual(['root', 'reply one', 'reply two']);
    expect(s.drafts).toEqual([]);
  });
});
