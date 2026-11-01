// Spec-blind tests for the drafts journal and how `restore` reconciles it with the store (no lost notes).
//
// Sources (the code under test was not read; only its public types):
//   contracts section 3, "The journal (R56 corrected, 1 Nov)": "A renderer crash kills the offscreen store with the tab, so
//     `journal` in the deps gets a copy of every draft and edit draft in the same call as the change, in the extension's
//     localStorage. There is one key per draft: `sop-draft:c:<commentId>` or `sop-draft:e:<commentId>`. It follows the store's
//     rules: nothing for a PDF that is not saved, nothing in Incognito, never synced or searched. `restore` takes a journal
//     text the store has not confirmed (`pending`) over the store's, under a per-document Web Lock. An entry goes when the
//     store confirms the send or the delete, and `forgetDraftJournal(documentId)` runs wherever a document is forgotten."
//   contracts section 3: `sent?(commentId)`: "the session calls it once the store has confirmed a comment as a sent row (or
//     deleted it). The keeper forgets that draft and its journal entry, and does not touch the store."
//   contracts section 3, edit drafts (R54): "never shows as the live text"; "A restored edit reopens the editor with the
//     unsent text; the live text stays until it is sent." `dropEdit` is "sent or cancelled".
//   contracts section 3, the no-lost-text gate: "A draft disappears only when it is sent, when an empty new note is cancelled,
//     or when the owner discards it"; "A tab adopts drafts whose owner tab is gone"; "On a memory-only PDF, drafts stay in
//     memory and nothing is written"; "the draft is back in its card with the caret at the end".
//   spec, "After a crash (R65)": "...every PDF tab reopens at its page, and any unsent note is restored."
//   spec, Local traces / Notes on a PDF that isn't saved: nothing stored for a PDF that is not saved; in Incognito the
//     extension never saves.
//
// Public surface used (types from drafts.ts and the declarations of draft-journal.ts): createDraftKeeper({ store, presence,
// memoryOnly, journal }), DraftKeeper, createDraftJournal(storage), DraftJournal, KeyValueStorage, JOURNAL_PREFIX.
// A "crash" here is: the keeper is disposed (dispose() does not write) and the tab stops answering the roll call. The
// journal is written in the same call as `change`, so a crash straight after a keystroke leaves the journal ahead of the store.
// The real localStorage, `forgetDraftJournal`, Incognito and the real Web Lock are in journal-restore.spec-blind.browser.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabId } from '../../../../../packages/core/src/ids';
import { DOC, DOC2, T_A, T_B, T_C, cid, commentRow, draftRow, textAnchor, threadRow } from '../../store/rows.spec-blind';
import { JOURNAL_PREFIX, createDraftJournal, type DraftJournal, type KeyValueStorage } from './draft-journal';
import { createDraftKeeper } from './drafts';
import { FakeStore, PresenceHub } from './fakes.spec-blind';

/** localStorage, in memory, with the failures a real one can have. */
class MemStorage implements KeyValueStorage {
  private m = new Map<string, string>();
  /** Every write throws, as a full or blocked localStorage does. */
  full = false;
  /** Every call throws, as a localStorage that cannot be used does. */
  broken = false;
  private check(): void {
    if (this.broken) throw new DOMException('blocked', 'SecurityError');
  }
  get length(): number {
    this.check();
    return this.m.size;
  }
  key(i: number): string | null {
    this.check();
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    this.check();
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.check();
    if (this.full) throw new DOMException('full', 'QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.check();
    this.m.delete(k);
  }
  keys(prefix = ''): string[] {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  snapshot(prefix = ''): Record<string, string> {
    return Object.fromEntries(this.keys(prefix).map((k) => [k, this.m.get(k)!]));
  }
}

const THREAD = threadRow({ id: 'dt1', draftOfTab: T_A, anchor: textAnchor(0, 4, 30) });
type RowOpts = { id?: string; tab?: TabId; threadId?: string; doc?: typeof DOC };
const row = (body: string, o: RowOpts = {}) =>
  draftRow({ id: o.id ?? 'd1', threadId: o.threadId ?? 'dt1', body, draftOfTab: o.tab ?? T_A, documentId: o.doc ?? DOC });
const draftKey = (id: string) => `${JOURNAL_PREFIX}c:${id}`;
const editKey = (id: string) => `${JOURNAL_PREFIX}e:${id}`;
const journalKeys = (s: MemStorage) => s.keys(JOURNAL_PREFIX);

interface Rig {
  hub: PresenceHub;
  store: FakeStore;
  storage: MemStorage;
}
function newRig(): Rig {
  return { hub: new PresenceHub(), store: new FakeStore(), storage: new MemStorage() };
}
/** One viewer tab: its own keeper and its own journal object over the shared extension localStorage. */
function openTab(r: Rig, tab: TabId, o: { journal?: DraftJournal | null; store?: FakeStore | null } = {}) {
  const memory = { on: false };
  const journal = o.journal === undefined ? createDraftJournal(r.storage) : o.journal;
  const presence = r.hub.join(tab);
  const store = o.store === undefined ? r.store : o.store;
  const keeper = createDraftKeeper({ store, presence, memoryOnly: () => memory.on, journal });
  return { keeper, journal, memory, tab, presence };
}
type Tab = ReturnType<typeof openTab>;
/** The renderer dies: nothing is flushed, no goodbye is said. */
function crash(r: Rig, t: Tab): void {
  t.keeper.dispose();
  r.hub.crash(t.tab);
}
/** A sent comment (and its thread) already in the store, for edits and for replies. */
function seedSent(store: FakeStore, body = 'original wording') {
  store.threads.set('t1', threadRow({ id: 't1' }));
  store.comments.set('c1', commentRow({ id: 'c1', threadId: 't1', body }));
  return store.comments.get('c1')!;
}
const bodies = (rows: { body: string }[]) => rows.map((r) => r.body);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
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

describe('a crash before the store heard of the text: the journal has it', () => {
  it.each([
    { name: 'plain text, the same tab comes back with its id (R65)', text: 'Why does parallel trends hold here?', back: 'same' as const },
    { name: 'blank lines, tabs, Polish letters and an emoji, a new tab adopts it', text: '  line one\n\n\tZażółć gęślą jaźń 🙂 **bold** `code`  ', back: 'other' as const },
    { name: 'a very long note, the same tab comes back', text: 'long thought. '.repeat(15_000), back: 'same' as const },
  ])('new note, $name: the whole text and its thread come back', async ({ text, back }) => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row(text), THREAD);
    // no timer has run: the store never got a byte
    expect(r.store.comments.size).toBe(0);
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
    crash(r, a);

    const tab = back === 'same' ? T_A : T_B;
    const b = openTab(r, tab);
    const rows = await b.keeper.restore(DOC);

    expect(rows.map((x) => [x.id, x.body])).toEqual([['d1', text]]);
    expect(rows[0].body.length).toBe(text.length); // the caret goes to the end of exactly this text
    expect(rows[0].draftOfTab).toBe(tab);
    expect(b.keeper.draftThread(THREAD.id)).toMatchObject({ id: 'dt1', anchor: THREAD.anchor });
  });

  it('a reply draft in a sent thread comes back with its thread id, and no draft thread is invented', async () => {
    const r = newRig();
    r.store.threads.set('sent-thread', threadRow({ id: 'sent-thread' }));
    const a = openTab(r, T_A);
    a.keeper.change(row('my reply, typed a moment ago', { id: 'r1', threadId: 'sent-thread' }));
    crash(r, a);

    const b = openTab(r, T_B);
    const rows = await b.keeper.restore(DOC);
    expect(rows.map((x) => [x.id, x.threadId, x.body])).toEqual([['r1', 'sent-thread', 'my reply, typed a moment ago']]);
    expect(b.keeper.draftThread('sent-thread' as never)).toBeUndefined();
  });

  it('the store has an older confirmed text, the journal has the newer: the journal text wins', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('The estimator'), THREAD);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.store.comments.get('d1')?.body).toBe('The estimator'); // confirmed
    a.keeper.change(row('The estimator compares treated and control groups, but only if trends are parallel'));
    crash(r, a); // the crash is in the middle of the commit of the second text

    const b = openTab(r, T_B);
    const rows = await b.keeper.restore(DOC);
    expect(bodies(rows)).toEqual(['The estimator compares treated and control groups, but only if trends are parallel']);
    expect(rows[0].draftOfTab).toBe(T_B);
  });

  it('restoring does not use the entry up: a second crash straight after still finds the text', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('written once, restored twice'), THREAD);
    crash(r, a);

    const b = openTab(r, T_B);
    expect(bodies(await b.keeper.restore(DOC))).toEqual(['written once, restored twice']);
    crash(r, b); // before anything else was saved

    const c = openTab(r, T_C);
    expect(bodies(await c.keeper.restore(DOC))).toEqual(['written once, restored twice']);
    expect(c.keeper.draftThread(THREAD.id)).toMatchObject({ id: 'dt1' });
  });

  it('text deleted down to nothing after an older save: the old text does not come back', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('something I regret'), THREAD);
    await vi.advanceTimersByTimeAsync(400); // the store has the long text
    a.keeper.change(row(''));
    crash(r, a);

    const b = openTab(r, T_B);
    const back = await b.keeper.restore(DOC);
    expect(back.every((x) => x.body === '')).toBe(true);
  });
});

describe('the store has the newer text: the store wins', () => {
  it('a journal entry the store had confirmed is not newer than what the store holds now', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('first version'), THREAD);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.store.comments.get('d1')?.body).toBe('first version');
    // The text moves on in the store without the journal hearing of it.
    r.store.comments.set('d1', { ...r.store.comments.get('d1')!, body: 'newer text, confirmed by the store' });
    crash(r, a);

    const b = openTab(r, T_B);
    expect(bodies(await b.keeper.restore(DOC))).toEqual(['newer text, confirmed by the store']);
  });

  it('a journal that is full cannot keep a stale copy that would beat the store: typing goes on and the store text is used', async () => {
    // The journal's put() says an older copy is removed when the new one cannot be written. Otherwise the older, still
    // "pending" text would be taken over the newer text the store confirmed.
    const r = newRig();
    r.store.hold();
    const a = openTab(r, T_A);
    a.keeper.change(row('abc'), THREAD);
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
    r.storage.full = true;
    expect(() => a.keeper.change(row('abc, then much more'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);
    r.store.unhold();
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.store.comments.get('d1')?.body).toBe('abc, then much more');
    crash(r, a);

    r.storage.full = false;
    const b = openTab(r, T_B);
    expect(bodies(await b.keeper.restore(DOC))).toEqual(['abc, then much more']);
  });
});

describe('a draft that is over leaves nothing behind', () => {
  it('sent and confirmed: the entry is gone, the sent text is not touched, the other drafts stay, and nothing comes back', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('final words'), THREAD);
    a.keeper.change(row('another note, still being typed', { id: 'd2', threadId: 'sent-thread' }));
    await vi.advanceTimersByTimeAsync(400);
    await r.store.sendDraft(cid('d1')); // the store confirms a sent row
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
    const callsBefore = r.store.calls.length;
    const savesBefore = r.store.count('saveDraft');

    expect(typeof a.keeper.sent).toBe('function');
    a.keeper.sent!(cid('d1'));
    expect(r.store.calls.length).toBe(callsBefore); // "does not touch the store"
    await vi.advanceTimersByTimeAsync(10_000);

    expect(r.storage.getItem(draftKey('d1'))).toBeNull();
    expect(r.storage.getItem(draftKey('d2'))).not.toBeNull();
    expect(r.store.count('saveDraft')).toBe(savesBefore); // no late write for a note that is sent
    expect(r.store.comments.get('d1')).toMatchObject({ body: 'final words', draftOfTab: null });
    crash(r, a);

    const b = openTab(r, T_B);
    expect(typeof b.keeper.sent).toBe('function');
    expect((await b.keeper.restore(DOC)).map((x) => x.id)).toEqual(['d2']);
  });

  it.each([
    { name: 'after the store had saved it', waitBeforeDrop: 400 },
    { name: 'before the store ever got it', waitBeforeDrop: 0 },
  ])('discarded $name: the entry is gone and restore brings back nothing', async ({ waitBeforeDrop }) => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('discard me'), THREAD);
    await vi.advanceTimersByTimeAsync(waitBeforeDrop);
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
    a.keeper.drop(cid('d1'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.storage.getItem(draftKey('d1'))).toBeNull();
    crash(r, a);

    const b = openTab(r, T_B);
    expect(await b.keeper.restore(DOC)).toEqual([]);
  });

  it.each([
    { name: 'the store never had the text', waitBeforeDrop: 0 },
    { name: 'the store had saved the text', waitBeforeDrop: 400 },
  ])('discarded while the store cannot confirm the delete ($name): the entry stays until it does, and a crash does not bring the discarded text back', async ({ waitBeforeDrop }) => {
    class StoreThatCannotDelete extends FakeStore {
      override discardDraft(): Promise<void> {
        return Promise.reject(new Error('the store went down with the tab'));
      }
    }
    const r = newRig();
    r.store = new StoreThatCannotDelete();
    const a = openTab(r, T_A);
    a.keeper.change(row('thrown away on purpose'), THREAD);
    await vi.advanceTimersByTimeAsync(waitBeforeDrop);
    a.keeper.drop(cid('d1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull(); // "An entry goes when the store confirms the delete"
    crash(r, a);

    const b = openTab(r, T_B);
    expect(await b.keeper.restore(DOC)).toEqual([]);
  });

  it('crash between the store confirming a send and the keeper being told: the sent text is never overwritten and the stale entry does not live on', async () => {
    // The contract is silent on this window: `sent()` never ran, so the journal still has the entry. The store refuses a
    // draft write for a sent comment (contracts section 3: not-a-draft), as the real one does. What must hold: the sent text
    // stays, and the entry cannot come back on every later open. R66 settles the first restore too: it shows no card.
    class StrictStore extends FakeStore {
      override async saveDraft(...args: Parameters<FakeStore['saveDraft']>): Promise<void> {
        const had = this.comments.get(args[0].id);
        if (had && !had.draftOfTab) throw new Error('not-a-draft: that comment was already sent');
        return super.saveDraft(...args);
      }
    }
    const r = newRig();
    r.store = new StrictStore();
    const a = openTab(r, T_A);
    a.keeper.change(row('what I sent'), THREAD);
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
    // The send reached the store (a sent row with the final text); the crash came before `sent()`.
    r.store.threads.set('dt1', { ...THREAD, draftOfTab: null });
    r.store.comments.set('d1', { ...row('what I sent'), draftOfTab: null });
    crash(r, a);

    const b = openTab(r, T_B);
    expect(await b.keeper.restore(DOC)).toEqual([]); // R66: sent with this very text, so the stale entry is dropped and no card is shown
    await b.keeper.flush().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.store.comments.get('d1')).toMatchObject({ body: 'what I sent', draftOfTab: null });
    crash(r, b);

    const c = openTab(r, T_C);
    expect(await c.keeper.restore(DOC)).toEqual([]); // not a zombie on every later open
    expect(r.storage.getItem(draftKey('d1'))).toBeNull();
  });
});

describe('edit drafts of sent comments (R54)', () => {
  it('the journal has the unsent edit; after a crash it is restored as the edit and the live text is unchanged', async () => {
    const r = newRig();
    const c1 = seedSent(r.store);
    const a = openTab(r, T_A);
    a.keeper.changeEdit(c1, 'original wording, now with my correction');
    expect(r.storage.getItem(editKey('c1'))).not.toBeNull();
    expect(r.storage.getItem(draftKey('c1'))).toBeNull(); // an edit is not a new-note draft
    crash(r, a);

    const b = openTab(r, T_A);
    expect(await b.keeper.restore(DOC)).toEqual([]); // not a new note
    expect(b.keeper.editDrafts(DOC).map((e) => [e.commentId, e.threadId, e.body])).toEqual([['c1', 't1', 'original wording, now with my correction']]);
    await b.keeper.flush().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(2000);

    expect(r.store.comments.get('c1')?.body).toBe('original wording');
    expect((await r.store.listAnnotations(DOC)).comments.map((c) => c.body)).toEqual(['original wording']);
    expect(r.store.log.filter((l) => l.startsWith('comments:'))).toEqual([]); // no write to the comment itself
  });

  it('the store has an older edit, the journal the newer: the journal text is the edit, owned by the tab that adopted it', async () => {
    const r = newRig();
    const c1 = seedSent(r.store);
    const a = openTab(r, T_A);
    a.keeper.changeEdit(c1, 'edit, first part');
    await vi.advanceTimersByTimeAsync(400);
    expect(r.store.edits.get('c1')?.body).toBe('edit, first part');
    a.keeper.changeEdit(c1, 'edit, first part and the rest of it');
    crash(r, a);

    const b = openTab(r, T_B);
    await b.keeper.restore(DOC);
    expect(b.keeper.editDrafts(DOC).map((e) => [e.body, e.draftOfTab])).toEqual([['edit, first part and the rest of it', T_B]]);
    expect(r.store.comments.get('c1')?.body).toBe('original wording');
  });

  it.each([
    { name: 'sent: the live text was written, then the edit is dropped', send: true },
    { name: 'cancelled: the edit is dropped and the live text stays', send: false },
  ])('$name: the entry is gone and no edit comes back', async ({ send }) => {
    const r = newRig();
    const c1 = seedSent(r.store);
    const a = openTab(r, T_A);
    a.keeper.changeEdit(c1, 'edited text');
    await vi.advanceTimersByTimeAsync(400);
    expect(r.storage.getItem(editKey('c1'))).not.toBeNull();
    if (send) r.store.comments.set('c1', { ...c1, body: 'edited text', editedAt: 1_700_000_100_000 });
    a.keeper.dropEdit(cid('c1'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.storage.getItem(editKey('c1'))).toBeNull();
    crash(r, a);

    const b = openTab(r, T_B);
    await b.keeper.restore(DOC);
    expect(b.keeper.editDrafts(DOC)).toEqual([]);
    expect(r.store.comments.get('c1')?.body).toBe(send ? 'edited text' : 'original wording');
  });
});

describe('two documents', () => {
  it("restoring one document returns only its drafts and never touches the other's entries", async () => {
    const r = newRig();
    const c1 = seedSent(r.store);
    const c2 = commentRow({ id: 'c2', threadId: 't2', documentId: DOC2, body: 'second paper, sent' });
    r.store.threads.set('t2', threadRow({ id: 't2', documentId: DOC2 }));
    r.store.comments.set('c2', c2);
    const a = openTab(r, T_A);
    a.keeper.change(row('paper one note'), THREAD);
    a.keeper.changeEdit(c1, 'paper one edit');
    const t2 = threadRow({ id: 'xt', documentId: DOC2, draftOfTab: T_A });
    a.keeper.change(row('paper two note', { id: 'x1', threadId: 'xt', doc: DOC2 }), t2);
    a.keeper.changeEdit(c2, 'paper two edit');
    const two = {
      [draftKey('x1')]: r.storage.getItem(draftKey('x1')),
      [editKey('c2')]: r.storage.getItem(editKey('c2')),
    };
    expect(Object.values(two).every((v) => v !== null)).toBe(true);
    crash(r, a);

    const b = openTab(r, T_B);
    expect(bodies(await b.keeper.restore(DOC))).toEqual(['paper one note']);
    expect(b.keeper.editDrafts(DOC).map((e) => e.body)).toEqual(['paper one edit']);
    expect(b.keeper.editDrafts(DOC2)).toEqual([]);
    expect({ [draftKey('x1')]: r.storage.getItem(draftKey('x1')), [editKey('c2')]: r.storage.getItem(editKey('c2')) }).toEqual(two);

    const c = openTab(r, T_C);
    expect(bodies(await c.keeper.restore(DOC2))).toEqual(['paper two note']);
    expect(c.keeper.editDrafts(DOC2).map((e) => e.body)).toEqual(['paper two edit']);
  });
});

describe('tab ownership: a draft another live tab owns is not taken', () => {
  it('a new-note draft stays with its live tab, untouched; it is adopted once that tab is gone, by one tab only', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('A is still typing'), THREAD);
    const before = r.storage.snapshot(JOURNAL_PREFIX);

    const b = openTab(r, T_B);
    expect(await b.keeper.restore(DOC)).toEqual([]);
    expect(r.storage.snapshot(JOURNAL_PREFIX)).toEqual(before);
    expect(bodies(await a.keeper.restore(DOC))).toEqual(['A is still typing']); // the owner still has it

    crash(r, a);
    expect(bodies(await b.keeper.restore(DOC))).toEqual(['A is still typing']);
    const c = openTab(r, T_C);
    expect(await c.keeper.restore(DOC)).toEqual([]); // B owns it now
  });

  it('an unsent edit stays with its live tab, untouched; it is adopted once that tab is gone, by one tab only', async () => {
    const r = newRig();
    const c1 = seedSent(r.store);
    const a = openTab(r, T_A);
    a.keeper.changeEdit(c1, 'A is still editing');
    const before = r.storage.snapshot(JOURNAL_PREFIX);

    const b = openTab(r, T_B);
    await b.keeper.restore(DOC);
    expect(b.keeper.editDrafts(DOC)).toEqual([]);
    expect(r.storage.snapshot(JOURNAL_PREFIX)).toEqual(before);

    crash(r, a);
    await b.keeper.restore(DOC);
    expect(b.keeper.editDrafts(DOC).map((e) => e.body)).toEqual(['A is still editing']);
    const c = openTab(r, T_C);
    await c.keeper.restore(DOC);
    expect(c.keeper.editDrafts(DOC)).toEqual([]);
  });
});

describe('a PDF that is not saved, and Undo of a save', () => {
  it('memory-only: nothing is journaled however long it waits, flushes or the page hides; once saved, typing is journaled', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    const c1 = seedSent(r.store);
    a.memory.on = true;
    a.keeper.change(row('private thoughts'), THREAD);
    a.keeper.changeEdit(c1, 'private edit');
    await vi.advanceTimersByTimeAsync(5000);
    await a.keeper.flush();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(journalKeys(r.storage)).toEqual([]);

    a.memory.on = false; // the owner chose Save
    a.keeper.change(row('private thoughts, now kept'));
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
  });

  it('Undo of a save: the entry is gone and nothing is journaled afterwards, not even by a store write that was in flight', async () => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('abc'), THREAD);
    expect(r.storage.getItem(draftKey('d1'))).not.toBeNull();
    r.store.hold();
    await vi.advanceTimersByTimeAsync(20); // the store write is on its way

    // Undo: the document is forgotten (store and journal) and the PDF goes back to "not saved".
    a.memory.on = true;
    r.store.forgetAll();
    a.journal!.clear(DOC);
    r.store.unhold();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(journalKeys(r.storage)).toEqual([]);

    expect(() => a.keeper.change(row('abc, typed after the Undo'))).not.toThrow();
    await a.keeper.flush().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(journalKeys(r.storage)).toEqual([]);
  });
});

describe('keys and values that are not ours', () => {
  const valid = JSON.stringify({ v: 1, kind: 'comment', documentId: DOC, commentId: 'bad', threadId: 'dt1', tab: T_A, body: 'x', at: 1, pending: true });
  const corrupt: { name: string; key: string; value: string }[] = [
    { name: 'text that is not JSON', key: `${JOURNAL_PREFIX}c:bad`, value: 'not json {{{' },
    { name: 'a truncated entry', key: `${JOURNAL_PREFIX}c:bad`, value: valid.slice(0, 40) },
    { name: 'JSON null', key: `${JOURNAL_PREFIX}c:bad`, value: 'null' },
    { name: 'a JSON array', key: `${JOURNAL_PREFIX}e:bad`, value: '[1,2,3]' },
    { name: 'an empty object', key: `${JOURNAL_PREFIX}c:bad`, value: '{}' },
    { name: 'a body that is not text', key: `${JOURNAL_PREFIX}c:bad`, value: valid.replace('"body":"x"', '"body":42') },
    { name: 'a kind the journal does not know', key: `${JOURNAL_PREFIX}z:bad`, value: valid.replace('"comment"', '"mystery"') },
  ];

  it.each(corrupt)('$name under a sop-draft: key: restore does not crash and the real draft still comes back', async ({ key, value }) => {
    const r = newRig();
    const a = openTab(r, T_A);
    a.keeper.change(row('the real draft'), THREAD);
    a.keeper.changeEdit(seedSent(r.store), 'the real edit');
    crash(r, a);
    r.storage.setItem(key, value);

    const b = openTab(r, T_B);
    const back = await b.keeper.restore(DOC);
    expect(bodies(back)).toEqual(['the real draft']);
    expect(b.keeper.editDrafts(DOC).map((e) => e.body)).toEqual(['the real edit']);
  });

  it('keys that do not start with sop-draft: are never read as drafts and never deleted, by restore, sent, drop or clear', async () => {
    const r = newRig();
    const foreign: Record<string, string> = {
      theme: 'light',
      'sop-tab-id': 'tab-zzzz',
      'sop-draft': 'no colon, not ours',
      'sop-drafts:c:d1': valid.replace('"x"', '"look-alike prefix"'),
      'other-app:sop-draft:c:d9': valid.replace('"x"', '"inside another key"'),
    };
    for (const [k, v] of Object.entries(foreign)) r.storage.setItem(k, v);
    const a = openTab(r, T_A);
    a.keeper.change(row('mine'), THREAD);
    a.keeper.change(row('mine too', { id: 'd2', threadId: 'sent-thread' }));
    crash(r, a);

    const b = openTab(r, T_B);
    expect(bodies(await b.keeper.restore(DOC)).sort()).toEqual(['mine', 'mine too']);
    b.keeper.sent!(cid('d1'));
    b.keeper.drop(cid('d2'));
    b.journal!.clear(DOC);
    await vi.advanceTimersByTimeAsync(2000);
    for (const [k, v] of Object.entries(foreign)) expect(r.storage.getItem(k), k).toBe(v);
  });

  it('a localStorage that throws on every call does not stop typing or restoring: the store still gives its drafts', async () => {
    const r = newRig();
    r.storage.broken = true;
    const a = openTab(r, T_A);
    expect(() => a.keeper.change(row('typed with a blocked localStorage'), THREAD)).not.toThrow();
    await vi.advanceTimersByTimeAsync(400);
    expect(r.store.comments.get('d1')?.body).toBe('typed with a blocked localStorage'); // the store path is not affected
    crash(r, a);

    const b = openTab(r, T_B);
    expect(bodies(await b.keeper.restore(DOC))).toEqual(['typed with a blocked localStorage']);
  });
});
