// Spec-blind tests for the drafts journal that need a real browser: the real localStorage, the viewer's own journal
// (`localDraftJournal()`), `forgetDraftJournal(documentId)`, Incognito, and the real per-document Web Lock.
// The table-driven cases with an in-memory storage are in journal-restore.spec-blind.test.ts (same sources).
//
// Sources:
//   contracts section 3, "The journal (R56 corrected, 1 Nov)": "`journal` in the deps (`localDraftJournal()` in the viewer)
//     ... in the extension's localStorage. There is one key per draft: `sop-draft:c:<commentId>` or `sop-draft:e:<commentId>`.
//     It follows the store's rules: nothing for a PDF that is not saved, nothing in Incognito ... `restore` takes a journal text
//     the store has not confirmed (`pending`) over the store's, under a per-document Web Lock. ... `forgetDraftJournal(documentId)`
//     runs wherever a document is forgotten."
//   contracts section 3, tab ownership: "A tab adopts drafts whose owner tab is gone", and a draft belongs to one tab.
//   spec: "Incognito ... the extension never saves"; "a PDF that isn't saved leaves no ... log line" (no trace in storage).
//   The declaration of localDraftJournal() says: "Null in Incognito and where localStorage cannot be used." Incognito is
//   told by `chrome.extension.inIncognitoContext`, the way the viewer's own incognito check reads it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabId } from '../../../../../packages/core/src/ids';
import { DOC, DOC2, T_A, T_B, T_C, commentRow, draftRow, textAnchor, threadRow } from '../../store/rows.spec-blind';
import { JOURNAL_PREFIX, forgetDraftJournal, localDraftJournal } from './draft-journal';
import { createDraftKeeper, type DraftKeeper } from './drafts';
import { FakeStore, PresenceHub } from './fakes.spec-blind';

const THREAD = threadRow({ id: 'dt1', draftOfTab: T_A, anchor: textAnchor(0, 4, 30) });
const row = (body: string, o: { id?: string; doc?: typeof DOC; threadId?: string } = {}) =>
  draftRow({ id: o.id ?? 'd1', threadId: o.threadId ?? 'dt1', body, draftOfTab: T_A, documentId: o.doc ?? DOC });
const ours = () => Object.keys(localStorage).filter((k) => k.startsWith(JOURNAL_PREFIX)).sort();
const FOREIGN = { 'sop-tab-id': 'tab-zzzz', 'sop-drafts:c:d1': 'look-alike', theme: 'light' };

/** A store whose reads take a few milliseconds, so two tabs that restore together really do interleave. */
class SlowStore extends FakeStore {
  private nap = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 4)));
  override async listDrafts(...a: Parameters<FakeStore['listDrafts']>) {
    await this.nap();
    return super.listDrafts(...a);
  }
  override async claimDrafts(...a: Parameters<FakeStore['claimDrafts']>) {
    await this.nap();
    return super.claimDrafts(...a);
  }
  override async listDraftThreads(...a: Parameters<FakeStore['listDraftThreads']>) {
    await this.nap();
    return super.listDraftThreads(...a);
  }
  override async listEditDrafts(...a: Parameters<FakeStore['listEditDrafts']>) {
    await this.nap();
    return super.listEditDrafts(...a);
  }
  override async claimEditDrafts(...a: Parameters<FakeStore['claimEditDrafts']>) {
    await this.nap();
    return super.claimEditDrafts(...a);
  }
}

const keepers: DraftKeeper[] = [];
function openTab(hub: PresenceHub, store: FakeStore | null, tab: TabId, journal = localDraftJournal()) {
  const keeper = createDraftKeeper({ store, presence: hub.join(tab), memoryOnly: () => false, journal });
  keepers.push(keeper);
  return keeper;
}
function crash(hub: PresenceHub, keeper: DraftKeeper, tab: TabId): void {
  keeper.dispose();
  hub.crash(tab);
}
function clean(): void {
  for (const k of [...Object.keys(localStorage)]) if (k.startsWith('sop-') || k === 'theme') localStorage.removeItem(k);
}

beforeEach(() => {
  clean();
  for (const [k, v] of Object.entries(FOREIGN)) localStorage.setItem(k, v);
});
afterEach(() => {
  for (const k of keepers.splice(0)) k.dispose();
  vi.unstubAllGlobals();
  clean();
});

describe('the extension localStorage', () => {
  it('a saved PDF: every draft and edit draft is in localStorage under its own key, in the same call as the change', () => {
    const hub = new PresenceHub();
    const store = new FakeStore();
    store.threads.set('t1', threadRow({ id: 't1' }));
    const sent = commentRow({ id: 'c1', threadId: 't1', body: 'original wording' });
    store.comments.set('c1', sent);
    const keeper = openTab(hub, store, T_A);
    expect(localDraftJournal()).not.toBeNull();

    keeper.change(row('typed just now'), THREAD);
    keeper.changeEdit(sent, 'edited just now');

    expect(ours()).toEqual([`${JOURNAL_PREFIX}c:d1`, `${JOURNAL_PREFIX}e:c1`]);
  });

  it('forgetDraftJournal(documentId) removes only that document\'s entries, drafts and edits, and no other key', async () => {
    const hub = new PresenceHub();
    const store = new FakeStore();
    store.threads.set('t1', threadRow({ id: 't1' }));
    store.threads.set('t2', threadRow({ id: 't2', documentId: DOC2 }));
    const c1 = commentRow({ id: 'c1', threadId: 't1', body: 'one' });
    const c2 = commentRow({ id: 'c2', threadId: 't2', documentId: DOC2, body: 'two' });
    store.comments.set('c1', c1);
    store.comments.set('c2', c2);
    const a = openTab(hub, store, T_A);
    a.change(row('paper one note'), THREAD);
    a.changeEdit(c1, 'paper one edit');
    a.change(row('paper two note', { id: 'x1', doc: DOC2, threadId: 'xt' }), threadRow({ id: 'xt', documentId: DOC2, draftOfTab: T_A }));
    a.changeEdit(c2, 'paper two edit');
    expect(ours()).toHaveLength(4);
    const paperTwo = [`${JOURNAL_PREFIX}c:x1`, `${JOURNAL_PREFIX}e:c2`].map((k) => [k, localStorage.getItem(k)]);

    forgetDraftJournal(DOC);

    expect(ours()).toEqual([`${JOURNAL_PREFIX}c:x1`, `${JOURNAL_PREFIX}e:c2`].sort());
    expect(paperTwo.map(([k]) => localStorage.getItem(k as string))).toEqual(paperTwo.map(([, v]) => v));
    for (const [k, v] of Object.entries(FOREIGN)) expect(localStorage.getItem(k), k).toBe(v);

    crash(hub, a, T_A);
    const b = openTab(hub, new FakeStore(), T_B);
    expect(await b.restore(DOC)).toEqual([]);
    expect(b.editDrafts(DOC)).toEqual([]);
    expect((await b.restore(DOC2)).map((r) => r.body)).toEqual(['paper two note']);
    expect(b.editDrafts(DOC2).map((e) => e.body)).toEqual(['paper two edit']);
  });

  it('forgetting a document with no entries, or with unreadable entries around, does not throw and leaves foreign keys alone', () => {
    localStorage.setItem(`${JOURNAL_PREFIX}c:unreadable`, 'not json {{{');
    expect(() => forgetDraftJournal(DOC)).not.toThrow();
    expect(() => forgetDraftJournal(DOC2)).not.toThrow();
    for (const [k, v] of Object.entries(FOREIGN)) expect(localStorage.getItem(k), k).toBe(v);
  });
});

describe('Incognito', () => {
  it.each([
    { name: 'a normal window journals the draft', incognito: false, expected: 1 },
    { name: 'an Incognito window has no journal and writes nothing', incognito: true, expected: 0 },
  ])('$name', ({ incognito, expected }) => {
    if (incognito) vi.stubGlobal('chrome', { extension: { inIncognitoContext: true } });
    const journal = localDraftJournal();
    expect(journal === null).toBe(incognito);

    // In Incognito the viewer has no store either.
    const keeper = openTab(new PresenceHub(), incognito ? null : new FakeStore(), T_A, journal);
    expect(() => keeper.change(row('typed in a window that never saves'), THREAD)).not.toThrow();
    expect(ours()).toHaveLength(expected);
  });
});

describe('two tabs restoring at the same moment (per-document Web Lock)', () => {
  it('a draft and an unsent edit left by a gone tab are adopted by exactly one of two tabs, every time', async () => {
    for (let i = 0; i < 20; i++) {
      // A fresh set of ids each round, and every keeper of the round is stopped at its end: the rounds share one localStorage.
      const hub = new PresenceHub();
      const store = new SlowStore();
      store.threads.set(`t${i}`, threadRow({ id: `t${i}` }));
      const sent = commentRow({ id: `c${i}`, threadId: `t${i}`, body: 'original wording' });
      store.comments.set(sent.id, sent);
      const a = openTab(hub, store, T_A);
      a.change(row(`the only copy of this note, round ${i}`, { id: `d${i}`, threadId: `dt${i}` }), threadRow({ id: `dt${i}`, draftOfTab: T_A }));
      a.changeEdit(sent, `the only copy of this edit, round ${i}`);
      crash(hub, a, T_A);

      const b = openTab(hub, store, T_B);
      const c = openTab(hub, store, T_C);
      const [fromB, fromC] = await Promise.all([b.restore(DOC), c.restore(DOC)]);
      const adopted = [...fromB, ...fromC];
      const edits = [...b.editDrafts(DOC), ...c.editDrafts(DOC)];
      b.dispose();
      c.dispose();

      expect(adopted.map((r) => r.body), `round ${i}: new-note drafts adopted`).toEqual([`the only copy of this note, round ${i}`]);
      expect(edits.map((e) => e.body), `round ${i}: edits adopted`).toEqual([`the only copy of this edit, round ${i}`]);
      clean();
    }
  });

  it('restoring a document does not wait for, or take anything from, the entries of another document', async () => {
    const hub = new PresenceHub();
    const a = openTab(hub, new FakeStore(), T_A);
    a.change(row('paper two note', { id: 'x1', doc: DOC2, threadId: 'xt' }), threadRow({ id: 'xt', documentId: DOC2, draftOfTab: T_A }));
    crash(hub, a, T_A);
    const before = localStorage.getItem(`${JOURNAL_PREFIX}c:x1`);

    const b = openTab(hub, new FakeStore(), T_B);
    expect(await b.restore(DOC)).toEqual([]);
    expect(localStorage.getItem(`${JOURNAL_PREFIX}c:x1`)).toBe(before);
  });
});
