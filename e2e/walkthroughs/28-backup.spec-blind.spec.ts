// Gate 1, Phase 3 plan, item 9: "Backup."
//   "Choose a folder (test folder). Make a note. A backup appears with the PDFs, the notes as Markdown and `library.json`. Run it on 8 days:
//    7 snapshots remain. No file holds the API key. Forgetting a PDF removes it at the next run."
// Spec, "Backups (Release 1)": "Every night, and after each session with new notes, a backup goes to a folder you pick ...: saved PDFs, notes
// as Markdown, and the library data as JSON. It never includes your API key, sign-in tokens, the never-save list or anything from unsaved PDFs
// ... a test checks every backup for the key." Contracts section 5, "Backup format v1": manifest.json, library.json ("camelCase row types, drafts
// excluded"), snapshots/library-<YYYY-MM-DD>.json ("the last 7 nightly copies"), pdf/<sha[0..2]>/<sha>.pdf, notes/<title-slug>-<sha[0..8]>.md.
// Carried requirement R75: "Forgetting a document also removes it from every backup snapshot in the backup folder ... including its notes, page
// text and PDF copy. The Forget dialog says 'Removed from your library and your backups'."
//
// HOW THE FOLDER IS PICKED. The real folder picker cannot be driven headless (the plan, P0-8). So every page of the extension gets a
// `showDirectoryPicker` that answers with a folder in its private file storage (OPFS); that is a FileSystemDirectoryHandle like any other,
// and it can be stored in IndexedDB and written through createWritable(). The backup is then read back out of that folder, file by file.
//
// GUESSES (the spec is silent on all three): (1) Settings has a "Backup" heading and a button to pick the folder, whose name has "folder" or
// "backup" in it; (2) a backup is made soon after the folder is picked and after a session with new notes ends (the tab closes), and Settings
// may have a "Back up now" button, which the test uses when it exists; (3) the backup root is the folder `sickofpdfs-backup` inside the picked
// folder (contracts: "The folder inside the one the owner picks"), but the test finds manifest.json wherever it is.
//
// Guard: BACKUP_WRITER (apps/extension/src/backup/ exists), then a runtime check that Settings has a Backup section.
import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, test } from '../support/test';
import { waitForExtensionWorker } from '../support/launch';
import { store as storeOf } from '../support/store-probe.spec-blind';
import { cardWith, shutRail } from './support/marks.spec-blind';
import { NOTE_A, NOTE_R, backedUp } from './support/backup-flow.spec-blind';
import {
  ATTENTION,
  BACKUP_WRITER,
  DAY,
  INVOICE,
  INVOICE_PHRASE,
  NO_BACKUP,
  PICKER_FOLDER,
  RESNET,
  backUpNowButton,
  backupFilesMentioning,
  fileMenuHas,
  fileOf,
  findBackup,
  forgetThisPdf,
  isoDay,
  note,
  shaOf,
  shotOf,
  waitForBackup,
  waitForStore,
  waitViewerReady,
  writeFolderFile,
  folderFiles,
} from './support/library-p3.spec-blind';

test.skip(!BACKUP_WRITER, NO_BACKUP);
test.setTimeout(480_000);

test('a backup holds the PDFs, the notes as Markdown and library.json, and never the key or an unsaved PDF', async ({ context, openViewer, server }, testInfo) => {
  const s = await backedUp(context, openViewer, server, testInfo);
  const { backup: b } = s;
  const shaA = await shaOf(ATTENTION);
  const shaR = await shaOf(RESNET);

  // manifest.json (written last)
  expect(b.manifest.format).toBe('sop-backup');
  expect(b.manifest.version, 'format version 1').toBe(1);
  expect(Object.keys(b.manifest.pdfs).sort(), 'the manifest names the two saved PDFs').toEqual([shaA, shaR].sort());
  expect(b.manifest.pdfs[shaA], 'with their sizes').toBe(statSync(fileOf(ATTENTION)).size);
  expect(b.manifest.counts.documents).toBe(2);
  expect(b.manifest.counts.pdfs).toBe(2);
  expect(b.manifest.counts.comments, 'two notes').toBeGreaterThanOrEqual(2);
  expect(b.manifest.counts.threads).toBe(2);

  // the PDFs, once each, byte for byte
  for (const [sha, f] of [[shaA, ATTENTION], [shaR, RESNET]] as const) {
    const path = `pdf/${sha.slice(0, 2)}/${sha}.pdf`;
    expect(b.has(path), `${path} is in the backup`).toBe(true);
    expect(createHash('sha256').update(await b.bytes(path)).digest('hex'), 'and is the same file').toBe(createHash('sha256').update(readFileSync(fileOf(f))).digest('hex'));
  }
  expect(b.list('pdf/'), 'only the two saved PDFs: nothing from the unsaved invoice').toHaveLength(2);

  // library.json: the eleven tables, camelCase rows, no drafts
  // Triage (Phase 3 gate, R92 "Tags are kept in backups"): tags, reading_tags and auto_tag_removed joined the first eight.
  const dump = JSON.parse(await b.text('library.json')) as { tables: Record<string, { id?: string; documentId?: string; body?: string; draftOfTab?: string | null }[]> };
  expect(Object.keys(dump.tables).sort(), 'the eleven tables').toEqual(['aliases', 'auto_tag_removed', 'comments', 'documents', 'history', 'locations', 'marks', 'reading_tags', 'settings', 'tags', 'threads']);
  expect(dump.tables.documents.map((d) => d.id).sort()).toEqual([shaA, shaR].sort());
  expect(dump.tables.comments.map((c) => c.body).sort(), 'both notes are in it').toEqual([NOTE_A, NOTE_R].sort());
  for (const t of ['marks', 'threads', 'comments']) {
    expect(dump.tables[t].every((row) => row.draftOfTab == null), `${t}: drafts are left out`).toBe(true);
  }

  // notes as Markdown: one file for the paper with a note, named by title and the first 8 hex digits of its fingerprint
  const notes = b.list('notes/');
  expect(notes.filter((p) => p.endsWith(`-${shaA.slice(0, 8)}.md`)), 'a Markdown file for the attention paper').toHaveLength(1);
  const md = await b.text(notes.find((p) => p.endsWith(`-${shaA.slice(0, 8)}.md`))!);
  expect(md, 'it holds the note').toContain(NOTE_A);
  expect(md, 'and names the document').toContain(shaA);

  // snapshots: today's copy of library.json
  const today = [isoDay(Date.now(), true), isoDay(Date.now(), false)];
  expect(b.list('snapshots/').some((p) => today.some((d) => p === `snapshots/library-${d}.json`)), "a snapshot of today's library.json").toBe(true);

  // what it must never hold
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, s.key), 'no file in the backup holds the API key').toEqual([]);
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, INVOICE_PHRASE), 'nothing from the unsaved invoice').toEqual([]);
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, await shaOf(INVOICE)), "and not even the invoice's fingerprint").toEqual([]);
  for (const f of await folderFiles(s.settings, PICKER_FOLDER)) {
    expect(f.path, 'no file of the private stores, the search tables or the outbox').not.toMatch(/sop-local|sop-device|page_text|fts|outbox/i);
  }
  note(testInfo, 'files in the backup', (await folderFiles(s.settings, PICKER_FOLDER)).map((f) => `${f.path} (${f.size})`).join('\n'));
});

test('eight nights leave seven snapshots', async ({ context, openViewer, server, sw }, testInfo) => {
  const s = await backedUp(context, openViewer, server, testInfo);
  const { backup: first } = s;
  const todayUtc = isoDay(Date.now(), true);
  const todayName = first.list('snapshots/').map((p) => /library-(\d{4}-\d{2}-\d{2})\.json$/.exec(p)?.[1]).find((d) => d !== undefined)!;
  const base = JSON.parse(await first.text(`snapshots/library-${todayName}.json`)) as unknown;
  const root = first.root === '' ? '' : `${first.root}/`;

  // seven earlier nights are already there: today - 9 ... today - 3
  const earlier = [3, 4, 5, 6, 7, 8, 9].map((n) => isoDay(Date.now() - n * DAY, todayName === todayUtc));
  for (const day of earlier) await writeFolderFile(s.settings, PICKER_FOLDER, `${root}snapshots/library-${day}.json`, JSON.stringify(base));
  expect((await findBackup(s.settings, PICKER_FOLDER))!.list('snapshots/')).toHaveLength(8);

  // another run, as if a night had passed
  const lastRun = first.manifest.createdAt;
  await writeFolderFile(s.settings, PICKER_FOLDER, `${root}manifest.json`, JSON.stringify({ ...first.manifest, createdAt: Date.now() - 2 * DAY }));
  if (await backUpNowButton(s.settings).isVisible()) await backUpNowButton(s.settings).click();
  else {
    note(testInfo, 'second run', 'no "Back up now" button: the extension was reloaded so that the start-up catch-up runs');
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await waitForExtensionWorker(context);
  }
  const second = await waitForBackup(s.settings, PICKER_FOLDER, { after: Date.now() - DAY, timeout: 120_000, message: 'a second backup should be made' });
  expect(second.manifest.createdAt, 'the manifest was rewritten by the new run').toBeGreaterThan(lastRun - 1);

  const snapshots = second.list('snapshots/').sort();
  note(testInfo, 'snapshots after the second run', snapshots.join(', '));
  expect(snapshots, 'seven snapshots remain').toHaveLength(7);
  expect(snapshots.some((p) => p.includes(isoDay(Date.now() - 9 * DAY, todayName === todayUtc))), 'the oldest is gone').toBe(false);
  expect(snapshots.some((p) => p.includes(isoDay(Date.now() - 3 * DAY, todayName === todayUtc))), 'the newest earlier ones stay').toBe(true);
  expect(snapshots.some((p) => p.includes(todayName)), "and today's is there").toBe(true);
  // the others are untouched: the library itself is still whole
  expect((JSON.parse(await second.text('library.json')) as { tables: { documents: unknown[] } }).tables.documents).toHaveLength(2);
});

test('forgetting a PDF removes it from the backup: its copy, its notes and its rows, in library.json and in every snapshot', async ({ context, openViewer, server }, testInfo) => {
  const s = await backedUp(context, openViewer, server, testInfo);
  const shaA = await shaOf(ATTENTION);
  const shaR = await shaOf(RESNET);
  // an older snapshot that holds both readings, as a night or two ago would
  const root = s.backup.root === '' ? '' : `${s.backup.root}/`;
  await writeFolderFile(s.settings, PICKER_FOLDER, `${root}snapshots/library-${isoDay(Date.now() - 2 * DAY)}.json`, await s.backup.text('library.json'));
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, shaR), 'before: the resnet paper is in the backup').not.toEqual([]);

  // forget it, as the owner does: open it, File, Forget this PDF
  const page = await openViewer(server.url(RESNET.path));
  await waitViewerReady(page);
  await waitForStore(page);
  // Triage (Phase 3 gate, R98): the rail stays open at 1280 px, so the note shows as a margin marker; shut it to see the card.
  await shutRail(page);
  await expect(cardWith(page, NOTE_R), 'its note is there').toBeVisible({ timeout: 20_000 });
  let forgot = { asked: false, text: '' };
  if (await fileMenuHas(page, /forget this pdf/i)) forgot = await forgetThisPdf(page);
  else {
    note(testInfo, 'forget', 'the File menu has no "Forget this PDF" yet: the library forgot it and the backup was told, as the Forget flow does (R75)');
    await storeOf(page).call('forgetDocument', s.resnetId);
    // Triage (p3s13b): the Forget flow is "the library forgets, then the backup scrub hook" (R75). Asking the store alone is not that flow, and the
    // spec does not say that a plain backup run rewrites old snapshots (see p3s13-triage.md, spec gap 1), so the stand-in calls the hook too.
    // The hook is only on the library pages in a test build (`__sopBackup`), so it is called from the Settings page.
    const hookReply = await s.settings.evaluate((id) => (globalThis as unknown as { __sopBackup: { forget(id: string): Promise<{ status: string }> } }).__sopBackup.forget(id), s.resnetId);
    note(testInfo, 'the backup scrub answered', hookReply.status);
  }
  note(testInfo, 'the Forget dialog said', forgot.asked ? forgot.text : '(it did not ask)');
  if (forgot.asked) expect(forgot.text, 'the dialog says it also clears the backups').toMatch(/backup/i);

  // the next run (or the forget itself) takes it out of the folder
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    if (i === 8 && (await backUpNowButton(s.settings).isVisible())) await backUpNowButton(s.settings).click();
    gone = (await backupFilesMentioning(s.settings, PICKER_FOLDER, shaR)).length === 0;
    if (!gone) await s.settings.waitForTimeout(2000);
  }
  const left = await backupFilesMentioning(s.settings, PICKER_FOLDER, shaR);
  expect(left, 'no file in the backup mentions the forgotten PDF: not its copy, notes, library rows or any snapshot').toEqual([]);
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, NOTE_R), 'nor its note').toEqual([]);
  const after = await findBackup(s.settings, PICKER_FOLDER);
  expect(after!.has(`pdf/${shaA.slice(0, 2)}/${shaA}.pdf`), 'the other paper is still backed up').toBe(true);
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, NOTE_A), 'with its note').not.toEqual([]);
  await shotOf(s.settings, testInfo, '04-after-forget');
});
