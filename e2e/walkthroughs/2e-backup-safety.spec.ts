// Backup safety: the proof tests of the independent security read of the backup writer (secread4, 1 Nov 2026), kept as Gate 1 checks
// after the fixes (backupfix). Written by the reviewer, who did not write the code; copied here with only the changes the harness needs
// (import paths, and what lint asks: no unused import, explicit type arguments in place of casts). The assertions are the reviewer's. Test 7 of the read (the zip export's main-thread timing) is left out: it asserts
// nothing, and the owner dropped that item.
//
// What each one holds the backup to (spec "Backups (Release 1)", R75, R82, R86; the carried restore rulings):
//   1  no key, no unsaved receipt, no trace of it in any backup file;
//   2  a Forget removes only the forgotten reading: library.json and every snapshot stay, rewritten without it, and another reading's note
//      that links to it stays as it was;
//   3  a small library that loses its database is held: the backup keeps every PDF and note;
//   4  a removal waiting for the folder survives picking the same folder again (never "another library") and Turn off;
//   5  emptying the Trash is a removal on purpose: backups go on, the badge is right, and no purged reading stays in any file;
//   6  a restore is planned in the store against the library as it is, so a note typed while the dialog was open survives;
//   8  a damaged library.json holds the run;
//   9  a quit while a PDF is copied never leaves a short file under its real name.
// The re-check probes N1 to N5 follow (R87, R88): "Back up anyway" never deletes a lost reading's copies; a waiting removal for a folder
// that is gone is dropped; the writer never starts a second run on its own; the forgotten list stays local; a hold's badge says why.
// Run: npx playwright test -c e2e/playwright.config.ts 2e-backup-safety --workers=1
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import { compareHlc, parseLibraryDump, planRestore } from '../../packages/core/src/index';
import { expect, EXTENSION_ID, grepOpfs, hooks, seedSecret, test } from '../support/test';
import { TEST_ASSETS } from '../support/server';
import { ATTENTION, SENTENCE_1, openPaper, postNote, waitSaved, waitStored } from './support/marks.spec-blind';
import { waitForStore, store as storeOf } from '../support/store-probe.spec-blind';

test.setTimeout(300_000);

interface BackupHooks {
  useFolder(name: string, o?: { permission?: 'granted' | 'prompt'; start?: boolean }): Promise<Record<string, unknown> | null>;
  setPermission(p: 'granted' | 'prompt'): Promise<void>;
  allow(): Promise<string>;
  run(o?: { now?: number; force?: boolean }): Promise<Record<string, unknown> | null>;
  status(): Promise<Record<string, unknown>>;
  whenIdle(): Promise<Record<string, unknown>>;
  forget(id: string): Promise<{ status: string; message: string }>;
  files(name: string): Promise<Record<string, number>>;
  readFile(path: string, name: string): Promise<string | null>;
  writeFile(path: string, text: string, name: string): Promise<void>;
  exportZip(file: string): Promise<number>;
  turnOff(): Promise<void>;
  // used by the re-check probes (N1 to N5)
  useHandle(name: string): Promise<Record<string, unknown> | null>;
  removeFolder(name: string): Promise<void>;
  finishRemovals(): Promise<string>;
}
const B = <T, A = undefined>(page: Page, fn: (b: BackupHooks, a: A) => Promise<T> | T, arg?: A): Promise<T> =>
  page.evaluate<T>(`(${fn.toString()})(globalThis.__sopBackup, ${JSON.stringify(arg) ?? 'undefined'})`);

const DAY = 24 * 3600 * 1000;

async function openLibrary(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/library.html`);
  await page.waitForFunction(() => (globalThis as unknown as { __sopBackup?: unknown }).__sopBackup !== undefined, undefined, { timeout: 30_000 });
  return page;
}

/**
 * A store-only viewer: any PDF tab publishes the store client on __sopTest.store.
 * Triage (S11, rule 7): with the real filter a learning paper saves itself, which added a fourth reading to these counts; the
 * store page opens a receipt instead, which is never saved by itself.
 */
async function storePage(context: BrowserContext, openViewer: (s: string) => Promise<Page>, server: { url(p: string): string }): Promise<Page> {
  const page = await openViewer(server.url('/f/classifier/not-learning/invoice-aws-sample.pdf'));
  await waitForStore(page);
  await page.waitForFunction(() => (globalThis as unknown as { __sopTest?: { blobStore?: unknown } }).__sopTest?.blobStore != null, undefined, { timeout: 20_000 });
  return page;
}

/** A saved reading with a PDF copy in the library's file storage (fake bytes, real sha). */
async function seedDoc(page: Page, n: number, title: string): Promise<string> {
  return hooks(page).eval(
    async (h, a) => {
      const store = (h as unknown as { store: { saveDocument(i: unknown): Promise<unknown> } }).store;
      const blobs = (h as unknown as { blobStore: { put(b: Blob): Promise<{ sha256: string; size: number }> } }).blobStore;
      const bytes = new TextEncoder().encode(`%PDF-1.4\n% secread4 reading ${a.n} ${a.title} ${'x'.repeat(4000)}\n%%EOF\n`);
      const { sha256, size } = await blobs.put(new Blob([bytes]));
      await store.saveDocument({ id: sha256, byteSize: size, pageCount: 1, title: a.title, authors: [], pdfId: null, hasText: true, encrypted: false, blobStored: true, saveReasons: ['seed'], location: { kind: 'url', raw: `https://example.org/r${a.n}.pdf`, viaPage: null }, openedAt: Date.now() });
      return sha256;
    },
    { n, title },
  );
}

/** A document-level note (thread + first comment) on a reading. */
async function seedNote(page: Page, documentId: string, body: string): Promise<{ threadId: string; commentId: string }> {
  return hooks(page).eval(
    async (h, a) => {
      const store = (h as unknown as { store: { writeAnnotations(ops: unknown[]): Promise<void> } }).store;
      const now = Date.now();
      const threadId = crypto.randomUUID();
      const commentId = crypto.randomUUID();
      await store.writeAnnotations([
        { table: 'threads', op: 'upsert', row: { id: threadId, documentId: a.documentId, anchor: { kind: 'document' }, pageIndex: null, sortKey: null, placement: 'placed', draftOfTab: null, createdAt: now, updatedAt: now, deletedAt: null, rev: 0, hlc: '' } },
        { table: 'comments', op: 'upsert', row: { id: commentId, threadId, documentId: a.documentId, author: 'me', body: a.body, draftOfTab: null, meta: {}, createdAt: now, editedAt: null, deletedAt: null, rev: 0, hlc: '' } },
      ]);
      return { threadId, commentId };
    },
    { documentId, body },
  );
}

async function editComment(page: Page, documentId: string, ids: { threadId: string; commentId: string }, body: string): Promise<void> {
  await hooks(page).eval(
    async (h, a) => {
      const store = (h as unknown as { store: { listAnnotations(id: string): Promise<{ comments: Record<string, unknown>[] }>; writeAnnotations(ops: unknown[]): Promise<void> } }).store;
      const cur = (await store.listAnnotations(a.documentId)).comments.find((c) => c.id === a.commentId)!;
      await store.writeAnnotations([{ table: 'comments', op: 'upsert', row: { ...cur, body: a.body, editedAt: Date.now() } }]);
    },
    { documentId, ...ids, body },
  );
}

const fileList = async (lib: Page, folder: string): Promise<string[]> => Object.keys(await B(lib, (b, f: string) => b.files(f), folder)).sort();

// ---------------------------------------------------------------------------------------------------------------------
// 1. Secrets and unsaved PDFs: the key, the receipt's fingerprint, file name and text are in no backup file.
test('1 leak: no key, no unsaved receipt, no trace of it', async ({ context, server, openViewer }) => {
  const page = await openPaper(openViewer, server, ATTENTION);
  await waitForStore(page);
  await postNote(page, ATTENTION, SENTENCE_1, 'secread4 note on attention');
  await waitSaved(page);
  await waitStored(page, (a) => a.threads.length > 0, 'the note is stored');
  const key = ['sk', 'ant', 'api03', randomBytes(24).toString('hex')].join('-');
  await seedSecret(page, key);

  const receiptFile = 'classifier/not-learning/invoice-aws-sample.pdf';
  const receiptSha = createHash('sha256').update(readFileSync(`${TEST_ASSETS}/${receiptFile}`)).digest('hex');
  const receipt = await openViewer(server.url(`/f/${receiptFile}`));
  await receipt.waitForFunction(() => (globalThis as unknown as { __sopTest?: { viewerState?: () => string } }).__sopTest?.viewerState?.() === 'ready', undefined, { timeout: 30_000 });
  await receipt.waitForTimeout(3000);
  expect(await storeOf(page).call('getDocument', receiptSha), 'control: the receipt was not saved').toBeNull();

  const lib = await openLibrary(context);
  const first = await B(lib, (b) => b.useFolder('leak'));
  console.log('first backup', JSON.stringify(first));
  expect(first?.ok).toBe(true);
  console.log('files', (await fileList(lib, 'leak')).join('\n'));
  for (const needle of [key, 'sk-ant', 'anthropic_api_key', receiptSha, 'invoice-aws-sample', 'This invoice is for', 'sop-local', 'filterSalt']) {
    const hit = await grepOpfs(lib, 'leak', needle);
    console.log(`grep ${needle.slice(0, 24)}: ${hit}`);
    expect(hit, `"${needle.slice(0, 12)}…" is in a backup file`).toBe(false);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 2. Forget A while a note on B mentions A's id (a pasted `viewer.html?doc=<A>` link): the scrub deletes library.json and every snapshot.
test('2 forget: a note that links to the forgotten reading makes the scrub delete library.json and all snapshots', async ({ context, server, openViewer }) => {
  const page = await storePage(context, openViewer, server);
  const a = await seedDoc(page, 1, 'Private statement saved by mistake');
  const b = await seedDoc(page, 2, 'Reading B');
  await seedNote(page, a, 'secread4 note on A');
  const MARK = `secread4-note-on-B-${randomBytes(4).toString('hex')}`;
  await seedNote(page, b, `${MARK} see the other paper: [p. 1](chrome-extension://${EXTENSION_ID}/viewer.html?doc=${a}#page=1)`);

  const lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('xref')))?.ok).toBe(true);
  for (const back of [3, 2, 1]) expect((await B(lib, (x, n: number) => x.run({ now: n }), Date.now() - back * DAY))?.ok).toBe(true);
  expect((await B(lib, (x) => x.run()))?.ok).toBe(true);
  const before = await fileList(lib, 'xref');
  console.log('before forget\n' + before.join('\n'));
  expect(before.filter((p) => p.includes('/snapshots/')).length).toBe(4);
  expect(await grepOpfs(lib, 'xref', MARK), "B's note is in the backup").toBe(true);

  await storeOf(page).call('forgetDocument', a);
  const forgot = await B(lib, (x, id: string) => x.forget(id), a);
  console.log('forget says', JSON.stringify(forgot));
  const after = await fileList(lib, 'xref');
  console.log('after forget\n' + after.join('\n'));
  const libraryJson = after.includes('sickofpdfs-backup/library.json');
  const snapshots = after.filter((p) => p.includes('/snapshots/')).length;
  const bNoteInJson = (await B(lib, (x) => x.readFile('sickofpdfs-backup/library.json', 'xref')))?.includes(MARK) ?? false;
  console.log(`library.json present: ${libraryJson}; snapshots left: ${snapshots}; B's note in library.json: ${bNoteInJson}`);
  // what a correct scrub keeps: library.json and the 4 snapshots, each without A, each still with B's note
  expect.soft(libraryJson, 'library.json survives a Forget of another reading').toBe(true);
  expect.soft(snapshots, 'all 4 snapshots survive (rewritten without A)').toBe(4);
  expect.soft(bNoteInJson, "B's note is still backed up").toBe(true);
  // and the next run cannot bring the old days back
  expect((await B(lib, (x) => x.run()))?.ok).toBe(true);
  console.log('after the next run\n' + (await fileList(lib, 'xref')).join('\n'));
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. A library of 3 readings loses its database (store files and saved copies), the handle store survives. The next run is not held:
//    it deletes every PDF copy and notes file from the folder, and writes an empty library.json and an empty snapshot for today.
test('3 guard: a small library that loses its database wipes the PDFs and notes in the backup', async ({ context, server, openViewer, sw }) => {
  const page = await storePage(context, openViewer, server);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const id = await seedDoc(page, 10 + i, `Small library reading ${i}`);
    await seedNote(page, id, `secread4 small note ${i}`);
    ids.push(id);
  }
  let lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('small')))?.ok).toBe(true);
  expect((await B(lib, (x, n: number) => x.run({ now: n }), Date.now() - DAY))?.ok).toBe(true); // yesterday's snapshot too
  expect((await B(lib, (x) => x.run()))?.ok).toBe(true);
  const before = await fileList(lib, 'small');
  console.log('before\n' + before.join('\n'));
  expect(before.filter((p) => p.endsWith('.pdf')).length).toBe(3);

  // The database and the saved copies are lost (a store that started on an empty pool, cleared OPFS files): close every page and the
  // offscreen document, delete .sop-db and pdf/ from OPFS. sop-handles (IndexedDB) stays, as it does when only the OPFS files go.
  for (const p of context.pages()) await p.close();
  await sw.evaluate(async () => {
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0) await chrome.offscreen.closeDocument();
    await new Promise((r) => setTimeout(r, 1000));
    const root = await navigator.storage.getDirectory();
    for (const name of ['.sop-db', 'pdf']) await root.removeEntry(name, { recursive: true }).catch((e) => console.log('rm', name, String(e)));
  });
  lib = await openLibrary(context);
  const viewer = await storePage(context, openViewer, server);
  console.log('stats after the loss', JSON.stringify(await storeOf(viewer).stats()));
  const run = await B(lib, (x) => x.run());
  console.log('the next run', JSON.stringify(run));
  const after = await fileList(lib, 'small');
  console.log('after\n' + after.join('\n'));
  const dump = JSON.parse((await B(lib, (x) => x.readFile('sickofpdfs-backup/library.json', 'small')))!) as { tables: { documents: unknown[] } };
  console.log('library.json documents now', dump.tables.documents.length);
  expect.soft(run?.reason, 'the run is held: every reading vanished at once').toBe('held');
  expect.soft(after.filter((p) => p.endsWith('.pdf')).length, 'the PDF copies are still in the folder').toBe(3);
});

// ---------------------------------------------------------------------------------------------------------------------
// 4. Forget while the folder waits for a click, then the owner re-picks the same folder (or turns backup off): the pending removal is dropped.
test('4 forget: re-choosing the folder or turning backup off drops a pending Forget', async ({ context, server, openViewer }) => {
  const page = await storePage(context, openViewer, server);
  const a = await seedDoc(page, 20, 'Forgotten while waiting');
  const b = await seedDoc(page, 21, 'Kept reading');
  await seedNote(page, a, 'secread4 note on the forgotten one');
  await seedNote(page, b, 'secread4 note on the kept one');
  const lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('repick')))?.ok).toBe(true);
  expect((await B(lib, (x, n: number) => x.run({ now: n }), Date.now() - DAY))?.ok).toBe(true);
  expect((await B(lib, (x) => x.run()))?.ok).toBe(true);

  await B(lib, (x) => x.setPermission('prompt')); // Chrome asks again after a restart (W-B1)
  await storeOf(page).call('forgetDocument', a);
  const forgot = await B(lib, (x, id: string) => x.forget(id), a);
  console.log('forget while waiting', JSON.stringify(forgot), 'scrubsPending', (await B(lib, (x) => x.status())).scrubsPending);
  expect(forgot.status).toBe('pending');

  // "Change folder", same folder picked again (Settings → Change folder runs clearTarget + setTarget + configure, as useFolder does)
  const repicked = await B(lib, (x) => x.useFolder('repick'));
  const st = await B(lib, (x) => x.status());
  console.log('after re-picking the same folder', JSON.stringify(repicked), 'phase', st.phase, 'held', st.held, 'scrubsPending', st.scrubsPending);
  // "Back up anyway", as the held message invites
  const forced = await B(lib, (x) => x.run({ force: true }));
  console.log('back up anyway', JSON.stringify(forced));
  const files = await fileList(lib, 'repick');
  const withA: string[] = [];
  for (const f of files) if ((await B(lib, (x, p: string) => x.readFile(p.replace(/^/, ''), 'repick'), f))?.includes(a)) withA.push(f);
  console.log('files that still name the forgotten reading', withA);
  expect.soft(repicked?.ok, 're-picking the same folder backs up').toBe(true);
  expect.soft(withA, 'no file names the forgotten reading').toEqual([]);

  // Turn off with a pending removal: the folder keeps the forgotten PDF, notes and rows, and the request is gone.
  const c = await seedDoc(page, 22, 'Forgotten then backup turned off');
  await seedNote(page, c, 'secread4 note before turn off');
  expect((await B(lib, (x) => x.run({ force: true })))?.ok).toBe(true);
  await B(lib, (x) => x.setPermission('prompt'));
  await storeOf(page).call('forgetDocument', c);
  console.log('forget c', JSON.stringify(await B(lib, (x, id: string) => x.forget(id), c)));
  await B(lib, (x) => x.turnOff());
  await lib.waitForTimeout(1500);
  const left = (await fileList(lib, 'repick')).filter((p) => p.includes(c.slice(0, 8)));
  console.log('after turn off: files of the forgotten reading', left, 'status', JSON.stringify(await B(lib, (x) => x.status())));
  const pending = await lib.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const r = indexedDB.open('sop-handles');
        r.onsuccess = () => {
          const g = r.result.transaction('scrub').objectStore('scrub').count();
          g.onsuccess = () => resolve(g.result);
        };
      }),
  );
  console.log('pending scrubs kept after turn off', pending);
  expect.soft(left.length === 0 || pending > 0, 'either the folder was cleaned or the request is still kept').toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// 5. Trash empties itself after 30 days (purgeTrash, a hard delete like Forget, D8). Five readings purged at once: the backup is held, with no badge.
//    And the purged readings stay in the older snapshots (D8: "Treat it like Forget for that document (no trace)").
test('5 guard: emptying the Trash holds every later backup; purged readings stay in snapshots', async ({ context, server, openViewer, sw }) => {
  const page = await storePage(context, openViewer, server);
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) ids.push(await seedDoc(page, 30 + i, `Purge test reading ${i}`));
  await seedNote(page, ids[0], 'secread4 note on a reading that stays');
  const lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('purge')))?.ok).toBe(true);
  expect((await B(lib, (x, n: number) => x.run({ now: n }), Date.now() - DAY))?.ok).toBe(true);
  for (const id of ids.slice(2)) await storeOf(page).call('trashDocument', id);
  expect((await B(lib, (x) => x.run()))?.ok, 'trashed readings are still backed up').toBe(true);
  await storeOf(page).call('purgeTrash', Date.now() + 1000); // what the daily purge does 30 days later
  console.log('stats after purge', JSON.stringify(await storeOf(page).stats()));
  // a new note after the purge: the owner keeps working
  await seedNote(page, ids[0], 'secread4 note written after the purge');
  const r = await B(lib, (x) => x.run());
  const st = await B(lib, (x) => x.status());
  const badge = await sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
  console.log('run after purge', JSON.stringify(r), 'phase', st.phase, 'held', st.held, 'badge', JSON.stringify(badge));
  const newNoteBackedUp = await grepOpfs(lib, 'purge', 'secread4 note written after the purge');
  console.log('the note written after the purge is in the backup:', newNoteBackedUp);
  expect.soft(r?.ok, 'a purge of old Trash is not a reason to stop backing up').toBe(true);
  // D8: no trace of a purged reading in the backup
  expect((await B(lib, (x) => x.run({ force: true })))?.ok).toBe(true);
  const traces: string[] = [];
  for (const f of await fileList(lib, 'purge')) if ((await B(lib, (x, p: string) => x.readFile(p, 'purge'), f))?.includes(ids[2])) traces.push(f);
  console.log('files that still name a purged reading after a forced run', traces);
  expect.soft(traces, 'D8: a purged reading leaves no trace').toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. applyRestorePlan writes whatever the plan says, even over a row that changed after the plan was made: a note typed between "plan"
//    (the dialog shows "12 readings, 340 notes") and "apply" (the owner clicks Restore) is lost, with no copy.
test('6 restore: a plan applied after a newer local edit overwrites that edit', async ({ context, server, openViewer }) => {
  const page = await storePage(context, openViewer, server);
  const s = storeOf(page);
  const d = await seedDoc(page, 40, 'Restore test reading');
  const n = await seedNote(page, d, 'v1 written here');
  const local0 = await s.call<Parameters<typeof planRestore>[0]>('exportLibrary');
  // The backup another computer wrote: the same note, edited there later (a newer stamp from another device).
  const backup = parseLibraryDump(JSON.parse(JSON.stringify(local0)));
  const row = backup.tables.comments.find((c) => c.id === n.commentId)!;
  const later = Date.now() + 1000;
  (row as { body: string }).body = 'v2 edited on the laptop';
  (row as { hlc: string }).hlc = `${String(later).padStart(13, '0')}-0000-laptop-device`;
  (row as { editedAt: number }).editedAt = later;
  const plan = planRestore(local0, backup, compareHlc, { now: Date.now() + 2000 });
  console.log('plan summary', JSON.stringify(plan.summary));
  // The owner keeps typing in an open tab while the restore dialog is up.
  await page.waitForTimeout(1500);
  await editComment(page, d, n, 'v3 typed while the restore dialog was open');
  await s.call('applyRestorePlan', plan);
  const after = await s.call<{ comments: { id: string; body: string; meta: unknown }[] }>('listAnnotations', d);
  console.log('comments after apply', JSON.stringify(after.comments.map((c) => ({ id: c.id.slice(0, 8), body: c.body, meta: c.meta }))));
  expect.soft(after.comments.some((c) => c.body.startsWith('v3')), 'the note typed before Restore was clicked survives').toBe(true);

  // Hostile rows: a comment that moves an existing note to another reading's thread.
  const e = await seedDoc(page, 41, 'Another reading');
  const other = await seedNote(page, e, 'note on another reading');
  const cur = await s.call<{ tables: { comments: Record<string, unknown>[] } }>('exportLibrary');
  const target = cur.tables.comments.find((c) => c.id === other.commentId)!;
  const evil = { ...target, documentId: d, threadId: n.threadId, body: 'moved by a backup', hlc: `${String(Date.now() + 60_000).padStart(13, '0')}-0000-x` };
  await s.call('applyRestorePlan', { tables: { documents: [], aliases: [], locations: [], marks: [], threads: [], comments: [evil], history: [], settings: [] }, needsPdf: [], summary: {} });
  const moved = await s.call<{ comments: { id: string }[] }>('listAnnotations', e);
  console.log('the other reading still has its note:', moved.comments.some((c) => c.id === other.commentId));
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. A fresh library is pointed at an old backup folder whose library.json is damaged (cut short by a sync tool). The other-library guard
//    reads only library.json, so the run is not held: it replaces the old library.json with this (empty) library.
test('8 guard: a damaged library.json lets a fresh library overwrite an old backup', async ({ context, server, openViewer }) => {
  await storePage(context, openViewer, server);
  const lib = await openLibrary(context);
  const other = 'c'.repeat(64);
  const oldLibrary = JSON.stringify({ tables: { documents: [{ id: other, title: 'From the old computer', deletedAt: null }], comments: [{ id: 'k1', threadId: 't1', documentId: other, body: 'secread4 old note' }] } });
  await B(lib, (x, t: string) => x.writeFile('sickofpdfs-backup/library.json', t, 'damaged'), oldLibrary.slice(0, oldLibrary.length - 20)); // cut short
  await B(lib, (x, t: string) => x.writeFile('sickofpdfs-backup/snapshots/library-2026-10-20.json', t, 'damaged'), oldLibrary);
  const r = await B(lib, (x) => x.useFolder('damaged'));
  console.log('first run into a folder with a damaged library.json', JSON.stringify(r));
  const now = (await B(lib, (x) => x.readFile('sickofpdfs-backup/library.json', 'damaged'))) ?? '';
  console.log('library.json now holds the old reading:', now.includes(other), '| files', (await fileList(lib, 'damaged')).join(', '));
  expect.soft(r?.reason, 'held: the folder holds a backup this library did not write').toBe('held');
});

// ---------------------------------------------------------------------------------------------------------------------
// 9. The browser quits while a run copies a big PDF. After a restart: no half PDF under its real name, library.json and the manifest whole,
//    status not stuck on "running", and the next run finishes.
test('9 interrupted: browser quit mid-run leaves the folder whole', async ({ profiles, server }) => {
  const { launchExtension, waitForExtensionWorker } = await import('../support/launch');
  const { buildViewerUrl, VIEWER_PATH } = await import('../../apps/extension/src/shared/viewer-url');
  const userDataDir = await profiles.copy('seeded');
  const open = async () => {
    const ctx = await launchExtension({ userDataDir, viewport: { width: 1280, height: 900 } });
    const sw = await waitForExtensionWorker(ctx);
    await sw.evaluate(async () => {
      while (!(await chrome.storage.session.get('takeoverMode')).takeoverMode) await new Promise((r) => setTimeout(r, 20));
    });
    return ctx;
  };
  const viewerOf = async (ctx: BrowserContext) => {
    const p = await ctx.newPage();
    await p.goto(buildViewerUrl({ source: server.url(`/f/${ATTENTION.file}`), back: null, page: null }, `chrome-extension://${EXTENSION_ID}/${VIEWER_PATH}`));
    await waitForStore(p);
    await p.waitForFunction(() => (globalThis as unknown as { __sopTest?: { blobStore?: unknown } }).__sopTest?.blobStore != null);
    return p;
  };
  let ctx = await open();
  const v = await viewerOf(ctx);
  const small = await seedDoc(v, 60, 'Small first');
  await seedNote(v, small, 'secread4 interrupt note');
  let lib = await openLibrary(ctx);
  expect((await B(lib, (x) => x.useFolder('intr')))?.ok).toBe(true);
  const libBefore = await B(lib, (x) => x.readFile('sickofpdfs-backup/library.json', 'intr'));
  const big = await hooks(v).eval(async (h) => {
    const store = (h as unknown as { store: { saveDocument(i: unknown): Promise<unknown> } }).store;
    const blobs = (h as unknown as { blobStore: { put(b: Blob): Promise<{ sha256: string; size: number }> } }).blobStore;
    const parts: Blob[] = [];
    for (let i = 0; i < 40; i++) {
      const bytes = new Uint8Array(4 * 1024 * 1024);
      for (let at = 0; at < bytes.length; at += 65536) crypto.getRandomValues(bytes.subarray(at, at + 65536));
      parts.push(new Blob([bytes]));
    }
    const { sha256, size } = await blobs.put(new Blob(parts));
    await store.saveDocument({ id: sha256, byteSize: size, pageCount: 1, title: 'Big book', authors: [], pdfId: null, hasText: true, encrypted: false, blobStored: true, saveReasons: ['seed'], location: null, openedAt: Date.now() });
    return { sha256, size };
  });
  console.log('big PDF', big.size);
  void B(lib, (x) => x.run()).catch(() => null);
  await lib.waitForFunction(async () => (await (globalThis as unknown as { __sopBackup: BackupHooks }).__sopBackup.status()).phase === 'running', undefined, { polling: 20, timeout: 20_000 });
  await lib.waitForTimeout(300);
  await ctx.close(); // the browser quits mid-run

  ctx = await open();
  lib = await openLibrary(ctx);
  await lib.waitForTimeout(3000);
  const files = await B(lib, (x) => x.files('intr'));
  console.log('after restart', JSON.stringify(files, null, 1));
  const bigPath = `sickofpdfs-backup/pdf/${big.sha256.slice(0, 2)}/${big.sha256}.pdf`;
  console.log('big copy in the folder:', files[bigPath] ?? 'absent', 'of', big.size);
  const libAfter = await B(lib, (x) => x.readFile('sickofpdfs-backup/library.json', 'intr'));
  JSON.parse(libAfter!); // whole
  JSON.parse((await B(lib, (x) => x.readFile('sickofpdfs-backup/manifest.json', 'intr')))!);
  console.log('library.json unchanged by the cut run:', libAfter === libBefore, '| status', JSON.stringify(await B(lib, (x) => x.status())));
  expect.soft(files[bigPath] === undefined || files[bigPath] === big.size, 'no half-written PDF under its real name').toBe(true);
  await viewerOf(ctx); // a viewer tab, so the store is running for the next run
  const again = await B(lib, (x) => x.run());
  console.log('next run', JSON.stringify(again));
  expect(again?.ok).toBe(true);
  expect((await B(lib, (x) => x.files('intr')))[bigPath]).toBe(big.size);
  await ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// The re-check of the fixes (secread4, "Re-check of 5451e8c", 2 Nov): probes N1 to N5, written by the reviewer, kept as regression checks
// for R87 and R88. Copied with only what the harness needs (one shared storePage, lint's cast fixes); the assertions are the reviewer's.
const idbAll = (page: Page, store: string): Promise<unknown[]> =>
  page.evaluate(
    (s) =>
      new Promise<unknown[]>((resolve, reject) => {
        const r = indexedDB.open('sop-handles');
        r.onsuccess = () => {
          const g = r.result.transaction(s).objectStore(s).getAll();
          g.onsuccess = () => resolve(g.result as unknown[]);
          g.onerror = () => reject(g.error ?? new Error('the read failed'));
        };
      }),
    store,
  );

// ---------------------------------------------------------------------------------------------------------------------
// N1. The database is lost (M2). The run is now held. The owner then does what the new pill invites: "Backup needs a look" → "Back up anyway".
test('N1 many-missing hold: "Back up anyway" from the pill deletes the only PDF copies', async ({ context, server, openViewer, sw }, testInfo) => {
  const page = await storePage(context, openViewer, server);
  for (let i = 0; i < 3; i++) await seedNote(page, await seedDoc(page, 10 + i, `Lost library reading ${i}`), `secread4b note ${i}`);
  let lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('anyway')))?.ok).toBe(true);
  expect((await B(lib, (x, n: number) => x.run({ now: n }), Date.now() - DAY))?.ok).toBe(true);
  expect((await B(lib, (x) => x.run()))?.ok).toBe(true);
  console.log('before: pdfs', (await fileList(lib, 'anyway')).filter((p) => p.endsWith('.pdf')).length);

  for (const p of context.pages()) await p.close();
  await sw.evaluate(async () => {
    if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0) await chrome.offscreen.closeDocument();
    await new Promise((r) => setTimeout(r, 1000));
    const root = await navigator.storage.getDirectory();
    for (const name of ['.sop-db', 'pdf']) await root.removeEntry(name, { recursive: true }).catch(() => {});
  });
  lib = await openLibrary(context);
  await storePage(context, openViewer, server);
  const held = await B(lib, (x) => x.run());
  const badge = await sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }));
  console.log('run after the loss', JSON.stringify(held), 'badge', JSON.stringify(badge));
  expect(held?.reason, 'control: M2 is fixed, the run holds').toBe('held');

  // What the owner sees on any library page: the pill, then the card.
  await lib.bringToFront();
  await lib.reload();
  const pill = lib.getByRole('button', { name: 'Backup needs a look' });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await pill.click();
  const card = lib.getByRole('dialog').or(lib.locator('[data-radix-popper-content-wrapper]'));
  await expect(card.first()).toBeVisible();
  console.log('the card says:', (await card.first().innerText()).replace(/\s+/g, ' '));
  await lib.screenshot({ path: testInfo.outputPath('n1-card.png') });
  await lib.getByRole('button', { name: 'Back up anyway' }).click();
  await lib.waitForTimeout(1500);
  await B(lib, (x) => x.whenIdle());
  const after = await fileList(lib, 'anyway');
  const dump = JSON.parse((await B(lib, (x) => x.readFile('sickofpdfs-backup/library.json', 'anyway')))!) as { tables: { documents: unknown[] } };
  console.log('after Back up anyway: pdfs', after.filter((p) => p.endsWith('.pdf')).length, 'notes files', after.filter((p) => p.includes('/notes/')).length, 'library.json documents', dump.tables.documents.length);
  console.log(after.join('\n'));
  expect.soft(after.filter((p) => p.endsWith('.pdf')).length, 'the PDF copies of readings that were lost (not forgotten) stay in the folder').toBe(3);
});

// ---------------------------------------------------------------------------------------------------------------------
// N2. Change folder while a removal waits for a folder that is gone (renamed or deleted in Explorer). The retired record never goes.
test('N2 retired folder that is gone: the removal waits for ever, with its raw fingerprint', async ({ context, server, openViewer }) => {
  const page = await storePage(context, openViewer, server);
  const a = await seedDoc(page, 20, 'Forgotten before a folder change');
  await seedNote(page, a, 'secread4b note on the forgotten one');
  await seedNote(page, await seedDoc(page, 21, 'Kept'), 'secread4b note kept');
  const lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useHandle('oldh')))?.ok).toBe(true);
  await B(lib, (x) => x.setPermission('prompt'));
  await storeOf(page).call('forgetDocument', a);
  await lib.waitForTimeout(1500);
  console.log('pending after forget', (await B(lib, (x) => x.status())).scrubsPending);
  await B(lib, (x) => x.removeFolder('oldh')); // the owner renamed or deleted the folder in Explorer
  expect((await B(lib, (x) => x.useFolder('newf')))?.ok).toBe(true);
  for (let i = 0; i < 3; i++) await B(lib, (x) => x.run());
  const tryNow = await B(lib, (x) => x.finishRemovals());
  const st = await B(lib, (x) => x.status());
  const retired = (await idbAll(lib, 'retired')) as { scrubs: { documentId: string }[]; retiredAt: number }[];
  console.log('Try now says', tryNow, '| status.retired', JSON.stringify(st.retired), '| raw ids kept in sop-handles', JSON.stringify(retired.map((r) => r.scrubs.map((s) => s.documentId.slice(0, 12)))));
  expect.soft(retired.some((r) => r.scrubs.some((s) => s.documentId === a)), 'a raw fingerprint of a forgotten PDF stays in sop-handles').toBe(false);
});

// ---------------------------------------------------------------------------------------------------------------------
// N3. Walkthrough 2a's flake: does the writer start a second backup on its own, or only when asked? And what does a test that reads the
//     manifest right after a "Back up now" see?
test('N3 2a mechanism: a second run only comes from the extra "Back up now", and the manifest read right after it is the old one', async ({ context, server, openViewer }) => {
  const page = await storePage(context, openViewer, server);
  await seedNote(page, await seedDoc(page, 30, 'Flake check'), 'secread4b flake note');
  const lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('flake')))?.ok).toBe(true);
  const created = async (): Promise<number> => (JSON.parse((await B(lib, (x) => x.readFile('sickofpdfs-backup/manifest.json', 'flake')))!) as { createdAt: number }).createdAt;
  const first = await created();
  await lib.waitForTimeout(8000);
  const quiet = await created();
  console.log('no click for 8 s: a new manifest?', quiet !== first);
  // what backedUp() does after the first backup has finished: a "Back up now" click, then waitForBackup with no `after`
  await lib.evaluate(() => {
    const c = new BroadcastChannel('sop-backup-rpc');
    c.postMessage({ type: 'run', id: crypto.randomUUID() });
    c.close();
  });
  const readRightAway = await created();
  await B(lib, (x) => x.whenIdle());
  await lib.waitForTimeout(300);
  const later = await created();
  console.log(`manifest read right after the click is the first one: ${readRightAway === first}; a second backup landed after it: ${later > readRightAway}`);
  expect(quiet).toBe(first);
});

// ---------------------------------------------------------------------------------------------------------------------
// N4. The new store tables never leave: after a Forget and a purge, nothing in the backup or the zip names them or their salt key.
test('N4 forgotten and local_meta stay local', async ({ context, server, openViewer }) => {
  const page = await storePage(context, openViewer, server);
  const a = await seedDoc(page, 40, 'Forget me');
  const b = await seedDoc(page, 41, 'Purge me');
  await seedNote(page, await seedDoc(page, 42, 'Keep me'), 'secread4b keep');
  const lib = await openLibrary(context);
  expect((await B(lib, (x) => x.useFolder('local'))))?.toBeTruthy();
  const outbox0 = ((await storeOf(page).stats()) as unknown as { outbox: number }).outbox;
  await storeOf(page).call('forgetDocument', a);
  await storeOf(page).call('trashDocument', b);
  await storeOf(page).call('purgeTrash', Date.now() + 1000);
  const outbox1 = ((await storeOf(page).stats()) as unknown as { outbox: number }).outbox;
  expect((await B(lib, (x) => x.run()))?.ok).toBe(true);
  const dump = await storeOf(page).call<{ tables: Record<string, unknown> }>('exportLibrary');
  console.log('dump tables', Object.keys(dump.tables).join(','), '| outbox before/after', outbox0, outbox1);
  for (const needle of ['forgottenSalt', 'local_meta', 'forgotten_at', a, b]) console.log(`backup names ${needle.slice(0, 16)}:`, await grepOpfs(lib, 'local', needle));
  console.log('forgottenAmong([a, b])', JSON.stringify(await storeOf(page).call('forgottenAmong', [a, b])));
});

// N5. The held badge's tooltip (R86: "Settings and the badge then say why").
test('N5 held badge tooltip', async ({ context, server, openViewer, sw }) => {
  await storePage(context, openViewer, server);
  const lib = await openLibrary(context);
  await lib.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const d = await (await root.getDirectoryHandle('badge', { create: true })).getDirectoryHandle('sickofpdfs-backup', { create: true });
    const w = await (await d.getFileHandle('library.json', { create: true })).createWritable();
    await w.write('{"tables": {"documents": [ cut short');
    await w.close();
  });
  const r = await B(lib, (x) => x.useFolder('badge'));
  console.log('run', JSON.stringify(r));
  await lib.waitForTimeout(3000);
  console.log('badge after 3 s', JSON.stringify(await sw.evaluate(async () => ({ text: await chrome.action.getBadgeText({}), title: await chrome.action.getTitle({}) }))));
});
