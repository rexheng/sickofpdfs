// Spec-blind tests for ruling R54: editing an already-sent note is crash-safe.
//
// Sources:
//   ruling R54 (progress ledger, 1 Nov): "editing an already-sent note must be crash-safe too. The edit text is stored as a
//     tab-owned edit draft, keyed to the comment, that never syncs and is restored on reload."
//   plan Phase 2, done-when 5 and contracts §3 gate: "A draft is saved within 300 ms of the last keystroke ... Kill the renderer
//     100 ms after typing stops, then reopen: the draft is back"; "A draft disappears only when it is sent, when an empty new
//     note is cancelled, or when the owner discards it"; "A tab adopts drafts whose owner tab is gone".
//   contracts §3 and spec: drafts stay local ("only saved notes sync"), are not searched, and belong to the tab that started them.
//   CLAUDE.md: "no lost notes"; nothing is stored for a PDF that is not saved.
// The stack is the real one (real store over SQLite in memory, real keeper, real session), so the store side of R54 is exercised
// through the session. The session names for an edit in progress are guesses, kept in edit-adapter.spec-blind.ts.
// "The live text" is the note as everybody else sees it: state().comments and listAnnotations.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TabId } from '../../../../../packages/core/src/ids';
import { ftsHits, outboxRows, reopen, count } from '../../store/db.spec-blind';
import { freshStore, wrapStore, type StoreEnv } from '../../store/env.spec-blind';
import { migrate } from '../../store/migrate';
import { T_A, T_B, T_C } from '../../store/rows.spec-blind';
import { edit } from './edit-adapter.spec-blind';
import { DOC, makeTextAnchor, range, type SaveStateLike } from './fakes.spec-blind';
import { Stack, pump, type Tab } from './stack.spec-blind';

const ORIGINAL = 'Why does the placebo test matter?';
const EDITED = 'Why does the placebo test matter for anticipation effects? Zażółć gęślą 🙂';
const SENTENCE = range(0, 4, 29);

let stack: Stack;
beforeEach(() => {
  stack = Stack.install();
});
afterEach(() => Stack.uninstall());
const openTab = (env: StoreEnv, tab: TabId, saveState?: SaveStateLike): Tab => stack.openTab(env, tab, saveState);

/** A note that was sent, in tab A, and settled. */
async function sentNote(env: StoreEnv, tab: TabId = T_A, saveState?: SaveStateLike) {
  const t = openTab(env, tab, saveState);
  await pump();
  const { threadId, commentId } = t.session.startThread(await makeTextAnchor([SENTENCE]), { highlight: 1 });
  t.session.typeDraft(commentId, ORIGINAL);
  await t.session.send(commentId);
  await pump(300);
  return { t, threadId, commentId };
}

/** The owner edits the note: opens the editor and types, a few characters at a time, then stops. */
async function typeEdit(t: Tab, id: Parameters<typeof edit.type>[1], text = EDITED) {
  edit.start(t.session, id);
  for (let i = 1; i < text.length; i += 9) {
    edit.type(t.session, id, text.slice(0, i));
    await pump(30);
  }
  edit.type(t.session, id, text);
}
const liveBody = async (env: StoreEnv) => (await env.api.listAnnotations(DOC)).comments.map((c) => c.body);
const syncRows = (env: StoreEnv) => outboxRows(env.db).filter((r) => r.table === 'comments' || r.table === 'threads').length;

/** The database as it is on disk at this moment, opened by a fresh store: what a new tab finds after a kill. */
async function diskNow(env: StoreEnv): Promise<StoreEnv> {
  const copy = await reopen(env.db);
  migrate(copy);
  return wrapStore(copy, 'devA2');
}

describe('editing a sent note (R54)', () => {
  it('while the edit is typed, the note itself is unchanged, nothing is queued for sync, nothing is searchable, and no second card appears', async () => {
    const env = await freshStore();
    const { t, commentId } = await sentNote(env);
    const queued = syncRows(env);
    env.publish.mockClear();

    await typeEdit(t, commentId);
    await t.keeper.flush();
    await pump(1000);

    expect(await liveBody(env)).toEqual([ORIGINAL]);
    expect(t.session.state().comments.map((c) => c.body)).toEqual([ORIGINAL]);
    expect(syncRows(env), 'typing an edit queued something for sync').toBe(queued);
    expect(ftsHits(env.db, 'anticipation'), 'an edit in progress was indexed').toEqual([]);
    expect(ftsHits(env.db, 'placebo')).toEqual([commentId]); // the old text is what search still finds
    expect(env.changes().filter((c) => c.table === 'comments' || c.table === 'threads'), 'an edit in progress was announced to other tabs').toEqual([]);
  });

  it.each([
    { name: '300 ms after the last key (the saving rule)', silence: 300 },
    { name: '100 ms after the last key (the phase gate)', silence: 100 },
  ])('$name, the tab dies: after reload the edit text is restored and the note is unchanged until sent', async ({ silence }) => {
    const env = await freshStore();
    const { t, commentId } = await sentNote(env);
    await typeEdit(t, commentId);
    await pump(silence);

    const disk = await diskNow(env); // the renderer dies here
    stack.hub.crash(T_A);

    const b = openTab(disk, T_B);
    await pump(50);
    expect(edit.restored(b.session.state()).get(commentId), 'the edit text is back').toBe(EDITED);
    expect(b.session.state().comments.map((c) => [c.id, c.body]), 'the live note is unchanged').toEqual([[commentId, ORIGINAL]]);
    expect(await liveBody(disk)).toEqual([ORIGINAL]);
    expect(b.session.state().drafts.filter((d) => d.id === commentId), 'the edit is not a second copy of the note').toEqual([]);
    expect(syncRows(disk), 'reopening queued the edit draft for sync').toBe(syncRows(env));

    // Enter in the new tab: the edit becomes the text of the note, once
    await edit.commit(b.session, commentId, EDITED);
    await pump(1000);
    expect(await liveBody(disk)).toEqual([EDITED]);
    expect(b.session.state().comments.map((c) => c.body)).toEqual([EDITED]);
    expect(ftsHits(disk.db, 'anticipation')).toEqual([commentId]);
    expect(ftsHits(disk.db, 'placebo')).toEqual([commentId]); // still in the new text, once
    expect((await disk.api.listAnnotations(DOC)).comments, 'the edit left a second note behind').toHaveLength(1);

    stack.hub.crash(T_B);
    const c = openTab(disk, T_C);
    await pump(50);
    expect(edit.restored(c.session.state()).size, 'a finished edit came back as a draft').toBe(0);
  });

  it('Enter right after the last key: the late save of the edit cannot bring the edit back, and the new text stays', async () => {
    const env = await freshStore();
    const { t, commentId } = await sentNote(env);
    edit.start(t.session, commentId);
    edit.type(t.session, commentId, 'a first thought');
    edit.type(t.session, commentId, EDITED); // still waiting to be saved
    await edit.commit(t.session, commentId, EDITED); // 0 ms later
    await pump(5000);

    expect(await liveBody(env)).toEqual([EDITED]);
    expect(t.session.state().comments.map((c) => c.body)).toEqual([EDITED]);
    stack.hub.crash(T_A);
    const b = openTab(await diskNow(env), T_B);
    await pump(50);
    expect(edit.restored(b.session.state()).size, 'the finished edit came back as a draft').toBe(0);
    expect(b.session.state().comments.map((c) => c.body)).toEqual([EDITED]);
  });

  it('a cancelled edit drops the edit draft: nothing comes back after a reload, and the note is untouched', async () => {
    const env = await freshStore();
    const { t, commentId } = await sentNote(env);
    await typeEdit(t, commentId);
    await t.keeper.flush(); // it was saved first, as it would be on blur
    await edit.cancel(t.session, commentId);
    await pump(2000);

    expect(await liveBody(env)).toEqual([ORIGINAL]);
    expect(t.session.state().comments.map((c) => c.body)).toEqual([ORIGINAL]);
    expect(edit.restored(t.session.state()).size).toBe(0);

    stack.hub.crash(T_A);
    const b = openTab(await diskNow(env), T_B);
    await pump(50);
    expect(edit.restored(b.session.state()).size, 'a cancelled edit came back').toBe(0);
    expect(b.session.state().comments.map((c) => c.body)).toEqual([ORIGINAL]);
  });

  it('the edit stays with the tab that started it: tab B neither sees nor takes it while A is open; when A is gone, B has it', async () => {
    const env = await freshStore();
    const { t, commentId } = await sentNote(env);
    await typeEdit(t, commentId);
    await pump(400);

    const b = openTab(env, T_B);
    await pump(300);
    expect(edit.restored(b.session.state()).size, "B must not show A's edit").toBe(0);
    expect(b.session.state().comments.map((c) => c.body)).toEqual([ORIGINAL]);
    expect(edit.restored(t.session.state()).size === 0 || edit.restored(t.session.state()).get(commentId) === EDITED).toBe(true);

    stack.hub.crash(T_A);
    const c = openTab(env, T_C);
    await pump(300);
    expect(edit.restored(c.session.state()).get(commentId), 'tab C adopted the edit of the tab that is gone').toBe(EDITED);
    expect(c.session.state().comments.map((x) => x.body)).toEqual([ORIGINAL]);
  });

  it('on a paper that is not stored the edit stays in memory: no row anywhere', async () => {
    const env = await freshStore();
    const { t, commentId } = await sentNote(env, T_A, { kind: 'memory-only' });
    await typeEdit(t, commentId);
    await t.keeper.flush();
    await pump(1000);
    for (const table of ['marks', 'threads', 'comments', 'outbox', 'comments_fts']) expect(count(env.db, table), `rows in ${table}`).toBe(0);
    expect(t.session.state().comments.map((c) => c.body)).toEqual([ORIGINAL]);
  });
});
