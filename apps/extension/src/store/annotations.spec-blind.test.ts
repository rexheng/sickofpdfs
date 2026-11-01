// Spec-blind tests for the Phase 2 annotation store methods (slice S2): listAnnotations, writeAnnotations, saveDraft,
// sendDraft, listDrafts, claimDrafts, getPageFigures, putPageFigures, and the FTS and sync rules around them.
//
// Sources:
//   contracts section 3 "Phase 2 StoreApi additions":
//     listAnnotations "returns live, non-draft rows"; writeAnnotations is "One transaction. Undo and redo are inverse batches";
//     saveDraft "publishes no change event and queues nothing for sync"; sendDraft "clears draftOfTab on the comment and its
//     new thread in one transaction"; listDrafts(documentId, tabId); claimDrafts(documentId, tabId, liveTabs).
//   contracts section 3 gate: "A draft disappears only when it is sent, when an empty new note is cancelled, or when the
//     owner discards it"; "A tab adopts drafts whose owner tab is gone".
//   contracts section 2 lifecycle: "deletedAt is a soft delete ... the row stays as a tombstone, because sync needs it. Only
//     forgetDocument hard-deletes"; "JSON columns keep unknown fields on rewrite".
//   contracts section 4: comments_fts indexes only non-draft, non-deleted rows; the change event shape; "Draft writes publish nothing".
//   plan Phase 2 contract additions: "The store stamps hlc and rev on every write, ignoring the caller's values";
//     writeAnnotations(ops, { tabId }) puts tabId into the published StoreChange; getPageFigures / putPageFigures.
//   plan Phase 2, S2: "sendDraft runs as one transaction; unknown JSON fields are kept"; spec: "Note drafts stay local; only saved notes sync."
//   CLAUDE.md: "no lost notes" and, for forgetDocument, "nothing saved from non-learning PDFs".
// Real store, real SQLite (in memory). The database is also read directly where the rule is about what is on disk.
import { describe, expect, it } from 'vitest';
import { compareHlc } from '../../../../packages/core/src/hlc';
import type { CommentRow, MarkRow, PageFigure, ThreadRow } from '../../../../packages/core/src/index';
import { all, count, ftsHits, outboxRows, reopen, rowsMentioning, userVersion, value } from './db.spec-blind';
import { freshStore, saveSecondDocument, wrapStore, type StoreEnv } from './env.spec-blind';
import { migrate } from './migrate';
import { ANCHORS, DOC, DOC2, T_A, T_B, T_C, cid, commentRow, draftRow, markRow, pageOf, textAnchor, threadRow } from './rows.spec-blind';

type Op = Parameters<StoreEnv['api']['writeAnnotations']>[0][number];
const up = (table: Op['table'], row: MarkRow | ThreadRow | CommentRow): Op => ({ table, op: 'upsert', row } as Op);
const del = (table: Op['table'], row: MarkRow | ThreadRow | CommentRow): Op => ({ table, op: 'soft-delete', row } as Op);
const restore = (table: Op['table'], row: MarkRow | ThreadRow | CommentRow): Op => ({ table, op: 'restore', row } as Op);
const stamped = <T extends object>(row: T) => ({ ...row, rev: expect.any(Number), hlc: expect.any(String) });
const HLC = /^\d{13}-[0-9a-f]{4}-.+$/;

/** A sent thread with a root comment and a highlight, the shape Ctrl+Alt+M leaves behind. */
const T1 = threadRow({ id: 't1' });
const C1 = commentRow({ id: 'c1', threadId: 't1', body: 'Why does zebra crossing matter?' });
const M1 = markRow({ id: 'm1' });
async function seed(env: StoreEnv) {
  await env.api.writeAnnotations([up('threads', T1), up('comments', C1), up('marks', M1)]);
}

describe('writing and listing notes', () => {
  it.each(ANCHORS)('a $name anchor comes back exactly as it went in, on a thread, its comment and (where allowed) a mark', async ({ anchor, markable }) => {
    const env = await freshStore();
    const page = pageOf(anchor);
    const thread = threadRow({ id: 'tx', anchor, pageIndex: page, sortKey: page === null ? null : 0.3 });
    const comment = commentRow({ id: 'cx', threadId: 'tx', body: 'a note' });
    const mark = markable ? markRow({ id: 'mx', anchor, pageIndex: page ?? 0, sortKey: 0.3, style: anchor.kind === 'area' ? 'area' : 'highlight', color: anchor.kind === 'area' ? null : 3 }) : null;
    await env.api.writeAnnotations([up('threads', thread), up('comments', comment), ...(mark ? [up('marks', mark)] : [])]);

    const got = await env.api.listAnnotations(DOC);
    expect(got.threads).toEqual([stamped(thread)]);
    expect(got.comments).toEqual([stamped(comment)]);
    expect(got.marks).toEqual(mark ? [stamped(mark)] : []);
    expect(got.threads[0]!.anchor).toEqual(anchor);
  });

  it('keeps JSON fields it does not know, at any depth, through a rewrite (anchor and comment meta)', async () => {
    const env = await freshStore();
    const anchor = { ...textAnchor(2, 5, 30), quote: { quote: 'x', prefix: 'p', suffix: 's', fromTheFuture: true }, rects: [{ page: 2, rects: [[0, 0, 1, 1] as [number, number, number, number]], note: 'kept' }] };
    const meta = { kind: 'claude-reply', v: 1, status: 'done', extraFromAnotherDevice: { nested: [1, { two: 2 }] } } as never;
    await env.api.writeAnnotations([up('threads', threadRow({ id: 't1', anchor })), up('comments', commentRow({ id: 'c1', threadId: 't1', author: 'claude', meta }))]);

    const first = await env.api.listAnnotations(DOC);
    expect(first.threads[0]!.anchor).toEqual(anchor);
    expect(first.comments[0]!.meta).toEqual(meta);
    // an owner edit rewrites the row from what was read: nothing the store does may drop the unknown parts
    await env.api.writeAnnotations([up('comments', { ...first.comments[0]!, body: 'edited', editedAt: 5 })]);
    const again = await env.api.listAnnotations(DOC);
    expect(again.comments[0]).toMatchObject({ body: 'edited', editedAt: 5, author: 'claude' });
    expect(again.comments[0]!.meta).toEqual(meta);
    expect(again.threads[0]!.anchor).toEqual(anchor);
  });

  it('stamps hlc and rev itself and ignores the caller\'s values; a later write gets a later stamp', async () => {
    const env = await freshStore();
    await env.api.writeAnnotations([up('marks', { ...M1, rev: 99, hlc: 'bogus' } as MarkRow)]);
    const first = (await env.api.listAnnotations(DOC)).marks[0]!;
    expect(first.rev).not.toBe(99);
    expect(first.hlc).not.toBe('bogus');
    expect(first.hlc).toMatch(HLC);

    env.clock.t += 5;
    await env.api.writeAnnotations([up('marks', { ...first, color: 4, hlc: '9999999999999-ffff-evil', rev: 500 })]);
    const second = (await env.api.listAnnotations(DOC)).marks[0]!;
    expect(second.color).toBe(4);
    expect(second.hlc).toMatch(HLC);
    expect(second.hlc).not.toBe('9999999999999-ffff-evil');
    expect(second.rev).not.toBe(500);
    expect(compareHlc(second.hlc, first.hlc)).toBeGreaterThan(0);
  });

  it('queues one upsert per written row for sync, and updating a row never queues a delete', async () => {
    const env = await freshStore();
    await seed(env);
    expect(outboxRows(env.db).map((r) => `${r.table}:${r.id}:${r.op}`).sort()).toEqual(['comments:c1:upsert', 'marks:m1:upsert', 'threads:t1:upsert']);
    await env.api.writeAnnotations([up('marks', { ...M1, color: 2 })]);
    expect(outboxRows(env.db).filter((r) => r.id === 'm1').map((r) => r.op)).toEqual(['upsert', 'upsert']);
    expect(outboxRows(env.db).some((r) => r.op === 'delete')).toBe(false);
  });

  it('updating a thread never takes its comments with it (an upsert is not delete-and-insert)', async () => {
    const env = await freshStore();
    await seed(env);
    await env.api.writeAnnotations([up('comments', commentRow({ id: 'c2', threadId: 't1', body: 'a reply', createdAt: 1_700_000_000_500 }))]);
    await env.api.writeAnnotations([up('threads', { ...T1, placement: 'unplaced', updatedAt: 1_700_000_001_000 })]);
    await env.api.writeAnnotations([up('threads', { ...T1, placement: 'placed', updatedAt: 1_700_000_002_000 })]);
    const got = await env.api.listAnnotations(DOC);
    expect(got.comments.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(count(env.db, 'comments')).toBe(2);
    expect(got.threads[0]).toMatchObject({ placement: 'placed', updatedAt: 1_700_000_002_000 });
  });

  it('lists the comments of a thread oldest first, whatever order they were written in', async () => {
    const env = await freshStore();
    await env.api.writeAnnotations([up('threads', T1)]);
    await env.api.writeAnnotations([up('comments', commentRow({ id: 'late', threadId: 't1', createdAt: 3000 })), up('comments', commentRow({ id: 'first', threadId: 't1', createdAt: 1000 })), up('comments', commentRow({ id: 'mid', threadId: 't1', createdAt: 2000 }))]);
    expect((await env.api.listAnnotations(DOC)).comments.map((c) => c.id)).toEqual(['first', 'mid', 'late']);
  });

  it('only lists the asked document', async () => {
    const env = await freshStore();
    await saveSecondDocument(env);
    await env.api.writeAnnotations([up('marks', M1), up('marks', markRow({ id: 'other', documentId: DOC2 }))]);
    expect((await env.api.listAnnotations(DOC)).marks.map((m) => m.id)).toEqual(['m1']);
    expect((await env.api.listAnnotations(DOC2)).marks.map((m) => m.id)).toEqual(['other']);
  });
});

describe('deleting and restoring (a soft delete keeps a tombstone)', () => {
  it('soft-delete hides the row from listAnnotations but keeps it for sync; restore brings it back unchanged', async () => {
    const env = await freshStore();
    await seed(env);
    const [live] = (await env.api.listAnnotations(DOC)).marks;
    const queued = outboxRows(env.db).length;
    env.clock.t += 10;

    await env.api.writeAnnotations([del('marks', live!), del('comments', C1)]);
    const hidden = await env.api.listAnnotations(DOC);
    expect(hidden.marks).toEqual([]);
    expect(hidden.comments).toEqual([]);
    expect(hidden.threads.map((t) => t.id)).toEqual(['t1']); // a thread is its own row: deleting a mark or a comment never deletes it
    expect(count(env.db, 'marks', "id = 'm1'"), 'the tombstone must stay in the table').toBe(1);
    expect(value(env.db, "SELECT deleted_at FROM marks WHERE id = 'm1'")).toBe(env.clock.t);
    const newEntries = outboxRows(env.db).slice(queued);
    expect(newEntries.map((r) => `${r.table}:${r.op}`).sort()).toEqual(['comments:upsert', 'marks:upsert']); // sync sees an update with deletedAt, not a hard delete

    env.clock.t += 10;
    await env.api.writeAnnotations([restore('marks', live!), restore('comments', C1)]);
    const back = await env.api.listAnnotations(DOC);
    expect(back.marks).toEqual([stamped({ ...live!, deletedAt: null })]);
    expect(back.comments).toEqual([expect.objectContaining({ id: 'c1', body: C1.body, deletedAt: null })]);
    expect(compareHlc(back.marks[0]!.hlc, live!.hlc)).toBeGreaterThan(0); // delete and restore are writes: each moves the stamp on
  });

  it('a whole batch is one transaction: if one operation fails, none of them is applied', async () => {
    const env = await freshStore();
    await seed(env);
    const before = { rows: await env.api.listAnnotations(DOC), queued: outboxRows(env.db).length };
    env.publish.mockClear();

    const badMark = { ...markRow({ id: 'bad' }), style: 'glow' } as unknown as MarkRow; // violates the style CHECK
    const orphan = commentRow({ id: 'orphan', threadId: 'no-such-thread' }); // violates the thread foreign key
    for (const bad of [up('marks', badMark), up('comments', orphan)]) {
      await expect(env.api.writeAnnotations([up('marks', markRow({ id: 'ok-1' })), del('marks', M1), up('threads', threadRow({ id: 'ok-2' })), bad])).rejects.toThrow();
      expect(await env.api.listAnnotations(DOC)).toEqual(before.rows);
      expect(outboxRows(env.db).length).toBe(before.queued);
      expect(env.publish).not.toHaveBeenCalled();
    }
  });
});

describe('change events', () => {
  it('writeAnnotations tells every open tab which rows changed, for which document, and which tab did it', async () => {
    const env = await freshStore();
    await env.api.writeAnnotations([up('threads', T1), up('comments', C1), up('marks', M1)], { tabId: T_A });

    const changes = env.changes();
    expect(changes.every((c) => c.documentId === DOC && c.tabId === T_A && c.op === 'upsert')).toBe(true);
    const byTable = Object.fromEntries(changes.map((c) => [c.table, c.ids.slice().sort()]));
    expect(byTable).toEqual({ threads: ['t1'], comments: ['c1'], marks: ['m1'] });

    env.publish.mockClear();
    await env.api.writeAnnotations([up('marks', { ...M1, color: 2 })]);
    expect(env.changes()).toHaveLength(1);
    expect(env.changes()[0]).toMatchObject({ table: 'marks', ids: ['m1'], documentId: DOC });
    expect(env.changes()[0]!.tabId, 'no tabId given, none published').toBeUndefined();
  });

  it('a soft delete is announced too (the other tab must redraw)', async () => {
    const env = await freshStore();
    await seed(env);
    env.publish.mockClear();
    await env.api.writeAnnotations([del('marks', M1)], { tabId: T_B });
    expect(env.changes()).toHaveLength(1);
    expect(env.changes()[0]).toMatchObject({ table: 'marks', ids: ['m1'], documentId: DOC, tabId: T_B });
  });
});

describe('drafts: owned by one tab, never synced, never indexed', () => {
  const rootDraft = (body: string, tab = T_A) => draftRow({ id: 'd1', threadId: 'dt1', body, draftOfTab: tab });
  const draftThread = (tab = T_A) => threadRow({ id: 'dt1', draftOfTab: tab, anchor: textAnchor(0, 50, 60, 'quokka habitat') });

  it('a draft of a new thread is stored, but is invisible to listAnnotations, the outbox, the index and the other tabs', async () => {
    const env = await freshStore();
    await env.api.saveDraft(rootDraft('quokka draft text'), draftThread());

    expect((await env.api.listAnnotations(DOC)).comments).toEqual([]);
    expect((await env.api.listAnnotations(DOC)).threads).toEqual([]);
    expect(outboxRows(env.db)).toEqual([]);
    expect(ftsHits(env.db, 'quokka')).toEqual([]);
    expect(env.publish).not.toHaveBeenCalled();

    expect(await env.api.listDrafts(DOC, T_A)).toEqual([stamped({ ...rootDraft('quokka draft text') })]);
    expect(await env.api.listDrafts(DOC, T_B)).toEqual([]);
    expect(await env.api.listDrafts(DOC2, T_A)).toEqual([]);
    expect(value(env.db, "SELECT draft_of_tab FROM threads WHERE id = 'dt1'")).toBe(T_A);
  });

  it('typing more replaces the same draft (one row, latest text) and stays silent', async () => {
    const env = await freshStore();
    for (const body of ['h', 'he', 'hello', 'hello wor', 'hello world']) await env.api.saveDraft(rootDraft(body), draftThread());
    await env.api.saveDraft(rootDraft('hello world, edited'));
    const drafts = await env.api.listDrafts(DOC, T_A);
    expect(drafts.map((d) => d.body)).toEqual(['hello world, edited']);
    expect(count(env.db, 'comments')).toBe(1);
    expect(outboxRows(env.db)).toEqual([]);
    expect(env.publish).not.toHaveBeenCalled();
  });

  it('a draft reply in a sent thread works the same way and leaves the thread alone', async () => {
    const env = await freshStore();
    await seed(env);
    const queued = outboxRows(env.db).length;
    env.publish.mockClear();
    await env.api.saveDraft(draftRow({ id: 'r1', threadId: 't1', body: 'half a reply about numbat', draftOfTab: T_A, createdAt: 1_700_000_000_900 }));
    expect((await env.api.listAnnotations(DOC)).comments.map((c) => c.id)).toEqual(['c1']);
    expect((await env.api.listDrafts(DOC, T_A)).map((c) => c.id)).toEqual(['r1']);
    expect(outboxRows(env.db).length).toBe(queued);
    expect(ftsHits(env.db, 'numbat')).toEqual([]);
    expect(env.publish).not.toHaveBeenCalled();
  });

  it('sendDraft makes the comment and its new thread real in one step: listed, queued once, searchable, announced', async () => {
    const env = await freshStore();
    await env.api.saveDraft(rootDraft('quokka final words'), draftThread());
    const draftStamp = (await env.api.listDrafts(DOC, T_A))[0]!.hlc;
    env.clock.t += 20;

    await env.api.sendDraft(cid('d1'));

    const got = await env.api.listAnnotations(DOC);
    expect(got.threads).toEqual([expect.objectContaining({ id: 'dt1', draftOfTab: null })]);
    expect(got.comments).toEqual([expect.objectContaining({ id: 'd1', draftOfTab: null, body: 'quokka final words', author: 'me', deletedAt: null })]);
    expect(await env.api.listDrafts(DOC, T_A)).toEqual([]);
    expect(outboxRows(env.db).map((r) => `${r.table}:${r.id}:${r.op}`).sort()).toEqual(['comments:d1:upsert', 'threads:dt1:upsert']);
    expect(ftsHits(env.db, 'quokka')).toEqual(['d1']);
    expect(compareHlc(got.comments[0]!.hlc, draftStamp)).toBeGreaterThan(0);
    expect(env.changes().map((c) => c.table).sort()).toEqual(['comments', 'threads']);
    expect(env.changes().every((c) => c.documentId === DOC)).toBe(true);
  });

  it('sendDraft of a reply draft touches only the comment', async () => {
    const env = await freshStore();
    await seed(env);
    await env.api.saveDraft(draftRow({ id: 'r1', threadId: 't1', body: 'reply about numbat', draftOfTab: T_A, createdAt: 1_700_000_000_900 }));
    const queued = outboxRows(env.db).length;
    env.publish.mockClear();
    await env.api.sendDraft(cid('r1'));
    expect((await env.api.listAnnotations(DOC)).comments.map((c) => c.id)).toEqual(['c1', 'r1']);
    expect(outboxRows(env.db).slice(queued).map((r) => `${r.table}:${r.id}`)).toEqual(['comments:r1']);
    expect(ftsHits(env.db, 'numbat')).toEqual(['r1']);
    expect(env.changes().map((c) => c.table)).toEqual(['comments']);
  });

  it.each([
    { name: 'the thread update', table: 'threads', when: 'OLD.draft_of_tab IS NOT NULL AND NEW.draft_of_tab IS NULL' },
    { name: 'the comment update', table: 'comments', when: 'OLD.draft_of_tab IS NOT NULL AND NEW.draft_of_tab IS NULL' },
  ])('sendDraft is all or nothing: if $name fails, the draft is still a draft and nothing leaked', async ({ table, when }) => {
    const env = await freshStore();
    await env.api.saveDraft(rootDraft('quokka final words'), draftThread());
    env.db.exec(`CREATE TRIGGER zz_boom BEFORE UPDATE ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'boom'); END`);

    await expect(env.api.sendDraft(cid('d1'))).rejects.toThrow();

    expect((await env.api.listDrafts(DOC, T_A)).map((c) => [c.id, c.body, c.draftOfTab])).toEqual([['d1', 'quokka final words', T_A]]);
    expect(value(env.db, "SELECT draft_of_tab FROM threads WHERE id = 'dt1'")).toBe(T_A);
    expect(outboxRows(env.db)).toEqual([]);
    expect(ftsHits(env.db, 'quokka')).toEqual([]);
    expect(env.publish).not.toHaveBeenCalled();
  });

  it('sendDraft of something that is not a draft changes nothing and does not pretend', async () => {
    const env = await freshStore();
    await seed(env);
    const before = { queued: outboxRows(env.db).length, rows: await env.api.listAnnotations(DOC) };
    env.publish.mockClear();
    await env.api.sendDraft(cid('no-such-comment')).catch(() => undefined);
    expect(outboxRows(env.db).length).toBe(before.queued);
    expect(await env.api.listAnnotations(DOC)).toEqual(before.rows);
    expect(env.publish).not.toHaveBeenCalled();
    await env.api.sendDraft(cid('c1')).catch(() => undefined); // already sent: the note must stay as it was
    expect((await env.api.listAnnotations(DOC)).comments).toEqual([expect.objectContaining({ id: 'c1', body: C1.body, draftOfTab: null })]);
  });

  it('a late draft write cannot turn a sent note back into a draft (a stale debounce timer must not hide a note)', async () => {
    const env = await freshStore();
    await env.api.saveDraft(rootDraft('almost'), draftThread());
    await env.api.sendDraft(cid('d1'));
    // the timer that was still pending when Enter was pressed fires now, with the text from before the last key
    await env.api.saveDraft(rootDraft('almos'), draftThread()).catch(() => undefined);

    const got = await env.api.listAnnotations(DOC);
    expect(got.comments.map((c) => [c.id, c.body])).toEqual([['d1', 'almost']]);
    expect(got.threads.map((t) => t.id)).toEqual(['dt1']);
    expect(await env.api.listDrafts(DOC, T_A)).toEqual([]);
  });

  it('claimDrafts moves the drafts of tabs that are gone to the asking tab, and leaves live tabs\' and other documents\' drafts alone', async () => {
    const env = await freshStore();
    await saveSecondDocument(env);
    await seed(env);
    await env.api.saveDraft(draftRow({ id: 'a-reply', threadId: 't1', body: 'A reply', draftOfTab: T_A, createdAt: 1_700_000_000_800 }));
    await env.api.saveDraft(draftRow({ id: 'a-root', threadId: 'at', body: 'A root', draftOfTab: T_A }), threadRow({ id: 'at', draftOfTab: T_A, anchor: textAnchor(0, 80, 90) }));
    await env.api.saveDraft(draftRow({ id: 'b-reply', threadId: 't1', body: 'B reply', draftOfTab: T_B, createdAt: 1_700_000_000_850 }));
    await env.api.saveDraft(draftRow({ id: 'a-other-doc', threadId: 'ot', documentId: DOC2, body: 'A on paper 2', draftOfTab: T_A }), threadRow({ id: 'ot', documentId: DOC2, draftOfTab: T_A }));
    env.publish.mockClear();

    // tab C opens the paper; tab B is alive, tab A is not
    const claimed = await env.api.claimDrafts(DOC, T_C, [T_B, T_C]);

    expect(claimed.map((c) => c.id)).toEqual(expect.arrayContaining(['a-reply', 'a-root']));
    expect(claimed.map((c) => c.id)).not.toContain('b-reply');
    expect(claimed.map((c) => c.id)).not.toContain('a-other-doc');
    expect(claimed.filter((c) => c.id === 'a-root' || c.id === 'a-reply').every((c) => c.draftOfTab === T_C)).toBe(true);

    expect((await env.api.listDrafts(DOC, T_C)).map((c) => c.id).sort()).toEqual(['a-reply', 'a-root']);
    expect(await env.api.listDrafts(DOC, T_A)).toEqual([]);
    expect((await env.api.listDrafts(DOC, T_B)).map((c) => [c.id, c.body])).toEqual([['b-reply', 'B reply']]);
    expect((await env.api.listDrafts(DOC2, T_A)).map((c) => c.id)).toEqual(['a-other-doc']);
    // the adopted draft text is exactly what was typed, and the whole thing is still invisible to sync and search
    expect((await env.api.listDrafts(DOC, T_C)).find((c) => c.id === 'a-root')!.body).toBe('A root');
    expect(outboxRows(env.db).every((r) => ['t1', 'c1', 'm1'].includes(r.id))).toBe(true);
    expect(env.publish).not.toHaveBeenCalled();

    // and the adopted new-thread draft can be sent by its new owner
    await env.api.sendDraft(cid('a-root'));
    expect((await env.api.listAnnotations(DOC)).threads.map((t) => t.id).sort()).toEqual(['at', 't1']);
  });

  it('a tab never takes the drafts of a tab that is in the live list, even if it asks twice', async () => {
    const env = await freshStore();
    await env.api.saveDraft(rootDraft('mine, still typing'), draftThread());
    await env.api.claimDrafts(DOC, T_B, [T_A, T_B]);
    await env.api.claimDrafts(DOC, T_B, [T_A, T_B]);
    expect((await env.api.listDrafts(DOC, T_A)).map((c) => c.body)).toEqual(['mine, still typing']);
    expect(await env.api.listDrafts(DOC, T_B)).toEqual([]);
  });
});

describe('reload: only what was committed survives, and it survives whole', () => {
  it('notes, a sent reply and an unsent draft are all back after the database is reopened', async () => {
    const env = await freshStore();
    await seed(env);
    await env.api.saveDraft(draftRow({ id: 'r1', threadId: 't1', body: 'typed just before the crash', draftOfTab: T_A, createdAt: 1_700_000_000_900 }));
    await env.api.saveDraft(draftRow({ id: 'd1', threadId: 'dt1', body: 'a brand new note, half written', draftOfTab: T_A }), threadRow({ id: 'dt1', draftOfTab: T_A, anchor: textAnchor(1, 20, 30) }));

    const db2 = await reopen(env.db);
    expect(migrate(db2 as never)).toBe(2);
    expect(userVersion(db2)).toBe(2);
    const { api } = wrapStore(db2);

    const notes = await api.listAnnotations(DOC);
    expect(notes.marks.map((m) => m.id)).toEqual(['m1']);
    expect(notes.threads.map((t) => t.id)).toEqual(['t1']);
    expect(notes.comments.map((c) => c.body)).toEqual([C1.body]);
    expect((await api.listDrafts(DOC, T_A)).map((c) => [c.id, c.body]).sort()).toEqual([['d1', 'a brand new note, half written'], ['r1', 'typed just before the crash']]);
    // the tab that wrote them is gone: a new tab adopts both
    expect((await api.claimDrafts(DOC, T_B, [T_B])).map((c) => c.id).sort()).toEqual(['d1', 'r1']);
    expect(ftsHits(db2, 'crash')).toEqual([]);
  });
});

describe('search: comments_fts holds exactly the notes that are sent and not deleted', () => {
  const sendNote = (env: StoreEnv, body: string, o: Partial<CommentRow> = {}) =>
    env.api.writeAnnotations([up('threads', T1), up('comments', commentRow({ id: 'c1', threadId: 't1', body, ...o }))]);

  const scenarios: { name: string; run: (env: StoreEnv) => Promise<void>; hits: Record<string, string[]> }[] = [
    { name: 'a sent note is found', run: (env) => sendNote(env, 'the zebra crossing'), hits: { zebra: ['c1'], crossing: ['c1'], giraffe: [] } },
    {
      name: 'an edited note is found by its new words only',
      run: async (env) => {
        await sendNote(env, 'the zebra crossing');
        await env.api.writeAnnotations([up('comments', commentRow({ id: 'c1', threadId: 't1', body: 'the giraffe crossing', editedAt: 9 }))]);
      },
      hits: { zebra: [], giraffe: ['c1'], crossing: ['c1'] },
    },
    {
      name: 'a deleted note is not found',
      run: async (env) => {
        await sendNote(env, 'the zebra crossing');
        await env.api.writeAnnotations([del('comments', commentRow({ id: 'c1', threadId: 't1', body: 'the zebra crossing' }))]);
      },
      hits: { zebra: [] },
    },
    {
      name: 'a restored note is found again, once',
      run: async (env) => {
        const note = commentRow({ id: 'c1', threadId: 't1', body: 'the zebra crossing' });
        await sendNote(env, 'the zebra crossing');
        await env.api.writeAnnotations([del('comments', note)]);
        await env.api.writeAnnotations([restore('comments', note)]);
      },
      hits: { zebra: ['c1'] },
    },
    {
      name: 'a draft is not found while it is a draft',
      run: async (env) => {
        await env.api.saveDraft(draftRow({ id: 'c1', threadId: 'dt', body: 'the zebra crossing', draftOfTab: T_A }), threadRow({ id: 'dt', draftOfTab: T_A }));
      },
      hits: { zebra: [] },
    },
    {
      name: 'a draft is found once it is sent, and the text typed last is what is indexed',
      run: async (env) => {
        const draft = (body: string) => draftRow({ id: 'c1', threadId: 'dt', body, draftOfTab: T_A });
        await env.api.saveDraft(draft('the zebra'), threadRow({ id: 'dt', draftOfTab: T_A }));
        await env.api.saveDraft(draft('the zebra crossing'));
        await env.api.sendDraft(cid('c1'));
      },
      hits: { zebra: ['c1'], crossing: ['c1'] },
    },
    { name: 'a reply from Claude is found', run: (env) => sendNote(env, 'the zebra crossing', { author: 'claude', meta: { kind: 'claude-reply', v: 1 } as never }), hits: { zebra: ['c1'] } },
  ];
  it.each(scenarios)('$name', async ({ run, hits }) => {
    const env = await freshStore();
    await run(env);
    for (const [word, ids] of Object.entries(hits)) expect(ftsHits(env.db, word), `search for "${word}"`).toEqual(ids);
    expect(() => env.db.exec("INSERT INTO comments_fts(comments_fts) VALUES('integrity-check')")).not.toThrow();
  });
});

describe('figure cache', () => {
  const FIG: PageFigure = { kind: 'image', rect: { x: 10, y: 20, width: 200, height: 100 }, label: 'Figure 1', captionRect: null, confidence: 'high', index: 0, objectIndices: [2], caption: { start: 10, end: 30, text: 'Figure 1: Event study' }, imageSha256: null };

  it('returns what was put for that page and detector version, and nothing for any other', async () => {
    const env = await freshStore();
    const withFuture = { ...FIG, fieldFromANewerDetector: [1] } as PageFigure;
    expect(await env.api.getPageFigures(DOC, 2, 'v1')).toBeNull();
    await env.api.putPageFigures(DOC, 2, 'v1', [withFuture, { ...FIG, index: 1, label: 'Table 1', kind: 'table' }]);
    expect(await env.api.getPageFigures(DOC, 2, 'v1')).toEqual([withFuture, { ...FIG, index: 1, label: 'Table 1', kind: 'table' }]);
    expect(await env.api.getPageFigures(DOC, 2, 'v2'), 'a new detector version must not read the old results').toBeNull();
    expect(await env.api.getPageFigures(DOC, 3, 'v1')).toBeNull();

    await env.api.putPageFigures(DOC, 2, 'v2', []); // a page with no figures is an answer too
    expect(await env.api.getPageFigures(DOC, 2, 'v2')).toEqual([]);
    expect(await env.api.getPageFigures(DOC, 2, 'v1'), 'the newer run replaces the older one for the page').toBeNull();
  });

  it('is a cache only: it never reaches the sync queue', async () => {
    const env = await freshStore();
    await env.api.putPageFigures(DOC, 0, 'v1', [FIG]);
    expect(outboxRows(env.db)).toEqual([]);
  });
});

describe('privacy: Forget removes every trace of a document\'s notes and drafts', () => {
  const populate = async (env: StoreEnv) => {
    await env.api.writeAnnotations([
      up('threads', threadRow({ id: 'thread-forget-1' })),
      up('comments', commentRow({ id: 'comment-forget-1', threadId: 'thread-forget-1', body: 'Why does zebra crossing matter?' })),
      up('comments', commentRow({ id: 'comment-forget-2', threadId: 'thread-forget-1', body: 'okapi follow-up', createdAt: 1_700_000_000_500 })),
      up('marks', markRow({ id: 'mark-forget-1' })),
    ]);
    await env.api.saveDraft(draftRow({ id: 'draft-forget-1', threadId: 'thread-forget-2', body: 'platypus draft', draftOfTab: T_A }), threadRow({ id: 'thread-forget-2', draftOfTab: T_A }));
    await env.api.putPageFigures(DOC, 0, 'v1', []);
  };

  it('after forgetDocument no row, sync entry or id of the notes and drafts is left', async () => {
    const env = await freshStore();
    await populate(env);
    const needles = ['mark-forget-1', 'thread-forget-1', 'thread-forget-2', 'comment-forget-1', 'comment-forget-2', 'draft-forget-1', DOC];
    expect(rowsMentioning(env.db, 'comment-forget-1').length, 'the probe finds the note before the forget').toBeGreaterThan(0);

    await env.api.forgetDocument(DOC);

    for (const needle of needles) expect(rowsMentioning(env.db, needle), `a trace of "${needle}" is left`).toEqual([]);
    expect(await env.api.listAnnotations(DOC)).toEqual({ marks: [], threads: [], comments: [] });
    expect(await env.api.listDrafts(DOC, T_A)).toEqual([]);
    expect(await env.api.getPageFigures(DOC, 0, 'v1')).toBeNull();
    expect(all(env.db, 'SELECT * FROM outbox')).toEqual([]);
  });

  it('...and the words of the notes and the unsent draft are gone from the search index too (R13: a forgotten PDF leaves no bytes)', async () => {
    // The index keeps its own copy of every note's words. Deleting the rows is not enough for an FTS5 table: its segments keep
    // the old words until they are merged, so Forget has to make the index drop them (for example 'optimize' or 'rebuild').
    const env = await freshStore();
    await populate(env);
    expect(rowsMentioning(env.db, 'zebra').some(([t]) => t.startsWith('comments_fts')), 'the probe finds the words in the index before the forget').toBe(true);

    await env.api.forgetDocument(DOC);

    for (const word of ['zebra', 'okapi', 'platypus']) expect(rowsMentioning(env.db, word), `the word "${word}" is still in the file`).toEqual([]);
  });
});
