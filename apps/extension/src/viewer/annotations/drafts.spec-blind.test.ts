// Spec-blind tests for the draft keeper (slice S8, "no lost text").
//
// Sources:
//   plan Phase 2, S8: "A draft is saved within 300 ms of the last key, and at once on blur, Esc, `visibilitychange` (hidden)
//     and `pagehide`. Live tabs answer a roll call on `sop-tabs` within 200 ms. A tab adopts the drafts of tabs that are gone.
//     On a memory-only PDF, drafts stay in memory." Consumes S2's draft methods (mocked here, like the plan says).
//   plan Phase 2, done-when 5: "Kill the tab 100 ms after typing stops, then reopen: the draft is back in its card, with the
//     caret at the end. Esc and clicking away never lose text."
//   contracts section 3 (the "no lost text" gate): "A draft disappears only when it is sent, when an empty new note is
//     cancelled, or when the owner discards it"; "A tab adopts drafts whose owner tab is gone."; "On a memory-only PDF
//     (Task 30 `memory-only`), drafts stay in memory and nothing is written."
//   spec, the Ctrl+Alt+M flow: "on a PDF judged not learning it stays in memory until you choose Save"; "a draft belongs to
//     the tab where it was started."
// Interface: createDraftKeeper({ store, presence, memoryOnly }): DraftKeeper { change(row, thread?), flush(), drop(id), restore(documentId) }.
// The page-lifecycle events (visibilitychange, pagehide) are in drafts-lifecycle.spec-blind.browser.test.ts, with a real DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabId } from '../../../../../packages/core/src/ids';
import { DOC, DOC2, T_A, T_B, T_C, cid, draftRow, textAnchor, threadRow } from '../../store/rows.spec-blind';
import { createDraftKeeper } from './drafts';
import { FakeStore, PresenceHub } from './fakes.spec-blind';

const THREAD = threadRow({ id: 'dt1', draftOfTab: T_A, anchor: textAnchor(0, 4, 30) });
const row = (body: string, o: { id?: string; tab?: TabId; threadId?: string } = {}) => draftRow({ id: o.id ?? 'd1', threadId: o.threadId ?? 'dt1', body, draftOfTab: o.tab ?? T_A });
const stored = (store: FakeStore, id = 'd1') => store.comments.get(id)?.body;

function setup(o: { tab?: TabId; hub?: PresenceHub; store?: FakeStore | null } = {}) {
  const store = o.store === undefined ? new FakeStore() : o.store;
  const hub = o.hub ?? new PresenceHub();
  const presence = hub.join(o.tab ?? T_A);
  const memory = { on: false };
  const keeper = createDraftKeeper({ store: store as never, presence, memoryOnly: () => memory.on });
  return { store: store!, hub, presence, keeper, memory };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  // The keeper may listen for page events when it is made; Node has no page. These do nothing (real ones: the browser test).
  const target = new EventTarget();
  vi.stubGlobal('window', target);
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('addEventListener', target.addEventListener.bind(target));
  vi.stubGlobal('removeEventListener', target.removeEventListener.bind(target));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('saving what is typed', () => {
  it('within 300 ms of the last key the latest text is stored, owned by this tab', async () => {
    const { store, keeper } = setup();
    const keys = ['T', 'Th', 'The', 'The p', 'The pa', 'The par'];
    for (const body of keys) {
      keeper.change(row(body), THREAD);
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(300);

    expect(stored(store)).toBe('The par');
    const saves = store.calls.filter((c) => c.method === 'saveDraft');
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.every((c) => (c.args[0] as { draftOfTab: TabId }).draftOfTab === T_A)).toBe(true);
    expect(store.draftThread('dt1' as never)).toMatchObject({ draftOfTab: T_A });
  });

  it('phase gate: text typed 100 ms ago is already on disk (the tab may be killed right then)', async () => {
    // Done-when 5 says the draft must be back after a kill 100 ms after typing stops, and S8 allows 300 ms. Both can only
    // hold if the write does not wait for the whole 300 ms. If this fails, the 300 ms is read as a delay, not a limit.
    const { store, keeper } = setup();
    keeper.change(row('half a thought'), THREAD);
    await vi.advanceTimersByTimeAsync(100);
    expect(stored(store)).toBe('half a thought');
  });

  it.each([
    { name: 'plain text', keys: ['Why does this hold?'] },
    { name: 'leading and trailing spaces, tabs, blank lines', keys: ['  indented\n\n\tline two  '] },
    { name: 'Polish and German letters, an emoji and Markdown', keys: ['Zażółć gęślą jaźń, Größe ß, 🙂 **bold** `code`'] },
    { name: 'a very long note', keys: ['x'.repeat(200_000)] },
    { name: 'text that was then deleted down to nothing (the old text must not come back)', keys: ['something', ''] },
    { name: 'text that was cut and replaced', keys: ['first idea', 'second idea'] },
  ])('stores $name exactly as typed', async ({ keys }) => {
    const { store, keeper } = setup();
    for (const body of keys) {
      keeper.change(row(body), THREAD);
      await vi.advanceTimersByTimeAsync(400);
    }
    expect(stored(store)).toBe(keys[keys.length - 1]);
  });

  it('flush() writes at once, and only resolves when the store has it', async () => {
    const { store, keeper } = setup();
    store.hold();
    keeper.change(row('unsaved words'), THREAD);

    let done = false;
    const flushed = keeper.flush().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0); // no 300 ms wait: the call to the store is made now
    expect(store.count('saveDraft')).toBe(1);
    expect(done, 'flush() resolved before the store finished writing').toBe(false);

    store.unhold();
    await flushed;
    expect(stored(store)).toBe('unsaved words');
  });

  it('flush() with nothing waiting is fine, and a second flush does not lose or change the text', async () => {
    const { store, keeper } = setup();
    await keeper.flush();
    keeper.change(row('kept'), THREAD);
    await keeper.flush();
    await keeper.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(stored(store)).toBe('kept');
  });

  it('the thread of a new note reaches the store even when the first keystroke and the next one are saved together', async () => {
    // startThread hands over the thread with the first change; later keystrokes only send the comment. The first write
    // needs the thread, or the comment has nothing to hang on.
    const { store, keeper } = setup();
    keeper.change(row('a'), THREAD);
    await vi.advanceTimersByTimeAsync(20);
    keeper.change(row('ab'));
    await vi.advanceTimersByTimeAsync(400);
    expect(stored(store)).toBe('ab');
    expect(store.draftThread('dt1' as never)).toMatchObject({ id: 'dt1', draftOfTab: T_A });
  });

  it('drafts of different notes are kept apart', async () => {
    const { store, keeper } = setup();
    keeper.change(row('root text'), THREAD);
    keeper.change(row('reply text', { id: 'd2', threadId: 'sent-thread' }));
    await vi.advanceTimersByTimeAsync(400);
    expect([stored(store, 'd1'), stored(store, 'd2')]).toEqual(['root text', 'reply text']);
  });
});

describe('discarding', () => {
  it('drop() stops a write that was waiting: a cancelled note is not saved afterwards', async () => {
    const { store, keeper } = setup();
    keeper.change(row('never mind'), THREAD);
    keeper.drop(cid('d1'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.count('saveDraft')).toBe(0);
    expect(stored(store)).toBeUndefined();
  });

  it('drop() of a draft that was already saved removes it, so it is not brought back by the next open', async () => {
    // "A draft disappears only when it is sent, when an empty new note is cancelled, or when the owner discards it."
    // The StoreApi has no method that deletes a draft, so the keeper has to find a way (for example a soft delete).
    const { store, keeper, hub } = setup();
    keeper.change(row('discard me'), THREAD);
    await keeper.flush();
    expect(stored(store)).toBe('discard me');
    keeper.drop(cid('d1'));
    await vi.advanceTimersByTimeAsync(2000);

    hub.crash(T_A);
    const next = setup({ tab: T_B, hub, store });
    expect((await next.keeper.restore(DOC)).map((c) => c.body)).toEqual([]);
  });
});

describe('what stays in memory', () => {
  it('memory-only: nothing is written however long the writer waits or flushes', async () => {
    const { store, keeper, memory } = setup();
    memory.on = true;
    keeper.change(row('private thoughts'), THREAD);
    await vi.advanceTimersByTimeAsync(5000);
    await keeper.flush();
    expect(store.writeCalls()).toEqual([]);
    expect(store.comments.size + store.threads.size).toBe(0);
  });

  it('memory-only: the text is still there when the same tab asks for its drafts', async () => {
    const { keeper, memory } = setup();
    memory.on = true;
    keeper.change(row('private thoughts'), THREAD);
    await keeper.flush();
    expect((await keeper.restore(DOC)).map((c) => c.body)).toEqual(['private thoughts']);
  });

  it('once the owner chooses Save, the text that was only in memory is written on the next flush', async () => {
    const { store, keeper, memory } = setup();
    memory.on = true;
    keeper.change(row('typed before I chose Save'), THREAD);
    await keeper.flush();
    expect(store.writeCalls()).toEqual([]);

    memory.on = false;
    await keeper.flush();
    expect(stored(store)).toBe('typed before I chose Save');
  });

  it('with no store at all (Incognito) typing works and nothing throws', async () => {
    const { keeper } = setup({ store: null });
    expect(() => keeper.change(row('hello'), THREAD)).not.toThrow();
    await expect(keeper.flush()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await keeper.restore(DOC)).map((c) => c.body)).toEqual(['hello']);
  });
});

describe('coming back after a crash, a closed tab or a reload', () => {
  it('a new tab gets the text of a tab that is gone, in its own name, whole', async () => {
    const hub = new PresenceHub();
    const store = new FakeStore();
    const a = setup({ tab: T_A, hub, store });
    a.keeper.change(row('root note, written to the end'), THREAD);
    a.keeper.change(row('a reply in the same paper', { id: 'd2', threadId: 'sent-thread' }));
    await a.keeper.flush();
    hub.crash(T_A); // the renderer died: no goodbye

    const b = setup({ tab: T_B, hub, store });
    const back = await b.keeper.restore(DOC);

    expect(back.map((c) => [c.id, c.body]).sort()).toEqual([['d1', 'root note, written to the end'], ['d2', 'a reply in the same paper']]);
    expect(back.every((c) => c.draftOfTab === T_B)).toBe(true);
    expect(store.draftThread('dt1' as never)?.draftOfTab).toBe(T_B);
  });

  it('a tab that is still open keeps its draft: the other tab neither shows nor takes it', async () => {
    const hub = new PresenceHub();
    const store = new FakeStore();
    const a = setup({ tab: T_A, hub, store });
    a.keeper.change(row('A is still typing'), THREAD);
    await a.keeper.flush();

    const b = setup({ tab: T_B, hub, store });
    expect(await b.keeper.restore(DOC)).toEqual([]);
    expect(store.comments.get('d1')?.draftOfTab).toBe(T_A);
    expect((await a.keeper.restore(DOC)).map((c) => c.body)).toEqual(['A is still typing']);
  });

  it('when tab A closes later, tab B adopts the draft from then on', async () => {
    const hub = new PresenceHub();
    const store = new FakeStore();
    const a = setup({ tab: T_A, hub, store });
    a.keeper.change(row('left for later'), THREAD);
    await a.keeper.flush();
    const b = setup({ tab: T_B, hub, store });
    expect(await b.keeper.restore(DOC)).toEqual([]);

    a.presence.close();
    expect((await b.keeper.restore(DOC)).map((c) => c.body)).toEqual(['left for later']);
  });

  it('only drafts of the paper being opened are adopted; other papers keep theirs for when they are opened', async () => {
    const hub = new PresenceHub();
    const store = new FakeStore();
    const a = setup({ tab: T_A, hub, store });
    a.keeper.change(row('paper one note'), THREAD);
    a.keeper.change(draftRow({ id: 'x1', threadId: 'xt', documentId: DOC2, body: 'paper two note', draftOfTab: T_A }), threadRow({ id: 'xt', documentId: DOC2, draftOfTab: T_A }));
    await a.keeper.flush();
    hub.crash(T_A);

    const b = setup({ tab: T_B, hub, store });
    expect((await b.keeper.restore(DOC)).map((c) => c.body)).toEqual(['paper one note']);
    expect(store.comments.get('x1')?.draftOfTab).toBe(T_A);
    const c = setup({ tab: T_C, hub, store });
    expect((await c.keeper.restore(DOC2)).map((x) => x.body)).toEqual(['paper two note']);
  });
});
