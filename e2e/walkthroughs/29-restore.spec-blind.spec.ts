// Gate 1, Phase 3 plan, item 10: "Restore."
//   "On a fresh profile, restore. Readings, notes, marks and PDFs return and text becomes searchable. A second restore changes nothing. A
//    backup from a newer version is refused with a plain message."
// Spec: '"Restore from backup" in Settings rebuilds the library on a fresh install, merging by fingerprint and id.' Release 1 done-when 8:
// "restoring from it on a fresh install brings everything back." Contracts section 5: "Restore merges by fingerprint and id. The newer `hlc`
// wins, and nothing local is deleted. Then text is re-extracted in the background." "Restore reads any `version` up to the one it knows. It
// refuses a higher one with 'Update sickofpdfs first'." Plan, carried rulings: restore shows what is in the backup ("12 readings, 340 notes,
// 9 PDFs"), "Running it twice changes nothing", changes publish with origin 'restore' so open tabs redraw, and "Restore never brings back a
// forgotten PDF".
//
// A is a browser profile that makes a real backup (the same set-up as the backup walkthrough). B is a second, fresh profile: the backup
// folder is copied file by file into B's private file storage (as if a Google Drive folder had synced to a new computer), and B restores
// from it through Settings. The folder picker is faked as in the backup walkthrough.
//
// Guard: BACKUP_WRITER, then runtime checks that Settings has a Restore button. GUESSES: the Restore button is named "Restore from backup"; it
// picks a folder (a click), shows a dialog that says what is in it with the words of describeBackup ("2 readings, 2 notes, 2 PDFs"), and has
// a button to go on; a refusal is shown in the same dialog; "Indexing 1 of 2" is shown while text is read again (not asserted).
import { rm } from 'node:fs/promises';
import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_ID, expect, opfsList, test, type FixtureServer } from '../support/test';
import { launchExtension, waitForExtensionWorker } from '../support/launch';
import { opfsSha256 } from '../support/save-probe.spec-blind';
import { openViewerIn, store as storeOf, waitForStore } from '../support/store-probe.spec-blind';
import { cardWith } from './support/marks.spec-blind';
import { ATTENTION_TEXT, NOTE_A, NOTE_R, backedUp } from './support/backup-flow.spec-blind';
import {
  ATTENTION,
  BACKUP_WRITER,
  NO_BACKUP,
  PICKER_FOLDER,
  RESNET,
  copyFolderBetween,
  fileMenuHas,
  folderFiles,
  forgetThisPdf,
  installBackupFakes,
  listRows,
  note,
  openLibrary,
  openSettings,
  pageNotBuilt,
  readFolderText,
  restoreButton,
  setPickerFolder,
  shaOf,
  shotOf,
  waitViewerReady,
  writeFolderFile,
} from './support/library-p3.spec-blind';

test.skip(!BACKUP_WRITER, NO_BACKUP);
test.setTimeout(720_000);

const NEWER_FOLDER = 'p3-backup-newer';

/** A viewer tab on a tiny PDF whose only job is to carry the store, so the test can read the library. */
async function probeViewer(context: BrowserContext, server: FixtureServer): Promise<Page> {
  const page = await openViewerIn(context, server.url('/h/plain.pdf'));
  await waitViewerReady(page);
  await waitForStore(page);
  return page;
}

/** The viewer on a saved copy (spec: the saved copy opens even when the link is dead). */
async function openSaved(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXTENSION_ID}/viewer.html?doc=${id}`);
  return page;
}

/** What the restore dialog says and does. Returns the dialog's text before going on, and whether it refused. */
async function restoreFrom(page: Page): Promise<{ text: string; refused: boolean }> {
  await restoreButton(page).click();
  const dialog = page.getByRole('dialog').first();
  await expect(dialog, 'Restore from backup shows what it found').toBeVisible({ timeout: 30_000 });
  await expect(dialog, 'and says what it is').toContainText(/readings?|update sickofpdfs first|not a sickofpdfs|damaged/i, { timeout: 30_000 });
  const text = ((await dialog.textContent()) ?? '').replace(/\s+/g, ' ').trim();
  if (/update sickofpdfs first/i.test(text)) return { text, refused: true };
  const go = dialog.getByRole('button', { name: /^(restore|merge|continue|yes|ok|start)/i }).last();
  await go.click();
  return { text, refused: false };
}

interface Snapshot {
  documents: string[];
  comments: string[];
  marks: number;
  threads: number;
  stats: Record<string, number>;
}

/** Everything a person could see changing: which readings, which notes, how many marks, and the table sizes. */
async function snapshotOf(probe: Page): Promise<Snapshot> {
  const s = storeOf(probe);
  const list = await s.call<{ items: { doc: { id: string } }[] }>('listDocuments', { view: 'all', sort: { by: 'title', dir: 'asc' }, limit: 100 });
  const documents = list.items.map((i) => i.doc.id).sort();
  const comments: string[] = [];
  let marks = 0;
  let threads = 0;
  for (const id of documents) {
    const a = await s.call<{ marks: unknown[]; threads: unknown[]; comments: { id: string; body: string; deletedAt: number | null }[] }>('listAnnotations', id);
    marks += a.marks.length;
    threads += a.threads.length;
    comments.push(...a.comments.filter((c) => c.deletedAt == null).map((c) => `${c.id}:${c.body}`));
  }
  const stats = { ...((await s.stats()) as unknown as Record<string, number>) };
  delete stats.outbox; // restore may queue its rows for sync; that is not something a person sees
  return { documents, comments: comments.sort(), marks, threads, stats };
}

test('on a fresh profile Restore brings back readings, notes, marks and PDFs; text becomes searchable; a second restore changes nothing; a newer backup is refused', async ({ context, openViewer, server, profiles }, testInfo) => {
  // ---- A: a real backup ----
  const a = await backedUp(context, openViewer, server, testInfo);
  const shaA = await shaOf(ATTENTION);
  const shaR = await shaOf(RESNET);
  const before = await snapshotOf(await probeViewer(context, server));
  expect(before.documents.sort(), 'A has the two readings').toEqual([shaA, shaR].sort());
  expect(before.marks, 'A has a mark').toBeGreaterThanOrEqual(1);

  // ---- B: a fresh profile and the backup folder, copied in ----
  const userDataDir = await profiles.copy('seeded');
  const other: BrowserContext = await launchExtension({ userDataDir, viewport: { width: 1280, height: 900 } });
  try {
    await waitForExtensionWorker(other);
    await installBackupFakes(other);
    const settings = await openSettings(other);
    if (await pageNotBuilt(settings)) test.skip(true, 'the Settings page is not built yet (slice S14)');
    if (!(await restoreButton(settings).isVisible())) test.skip(true, 'Settings has no "Restore from backup" yet (slice S17)');
    const files = await copyFolderBetween(a.settings, PICKER_FOLDER, settings, PICKER_FOLDER);
    expect(files, 'the backup folder was copied').toBeGreaterThan(4);
    // a copy of it that a newer version wrote
    await copyFolderBetween(a.settings, PICKER_FOLDER, settings, NEWER_FOLDER);
    const manifestPath = (await folderFiles(settings, NEWER_FOLDER)).find((f) => f.path.endsWith('manifest.json'))!.path;
    const manifest = JSON.parse(await readFolderText(settings, NEWER_FOLDER, manifestPath)) as Record<string, unknown>;
    await writeFolderFile(settings, NEWER_FOLDER, manifestPath, JSON.stringify({ ...manifest, version: 99 }));

    const live = await openLibrary(other, 'library'); // open during the restore: it must redraw by itself
    await expect(live.getByText(/your learning pdfs will appear here/i), 'B starts empty').toBeVisible();
    const probe = await probeViewer(other, server);
    expect((await snapshotOf(probe)).documents, 'B has no readings').toEqual([]);

    // ---- restore ----
    await settings.bringToFront();
    const first = await restoreFrom(settings);
    note(testInfo, 'the restore dialog said', first.text);
    expect(first.refused).toBe(false);
    expect(first.text, 'it says what is in the backup').toMatch(/2 readings/i);
    expect(first.text).toMatch(/2 notes/i);
    expect(first.text).toMatch(/2 PDFs/i);
    await shotOf(settings, testInfo, '04-restore-dialog');

    await expect.poll(async () => (await snapshotOf(probe)).documents.length, { message: 'both readings come back', timeout: 120_000 }).toBe(2);
    const restored = await snapshotOf(probe);
    expect(restored.documents.sort()).toEqual(before.documents);
    expect(restored.comments, 'with the same notes').toEqual(before.comments);
    expect(restored.marks, 'and the same marks').toBe(before.marks);
    expect(restored.threads).toBe(before.threads);
    await live.bringToFront();
    await expect(listRows(live), 'the open library tab redraws by itself').toHaveCount(2, { timeout: 15_000 });
    await shotOf(live, testInfo, '05-library-after-restore');

    // the PDFs: each copy is in B's file storage and is the very file (its SHA-256 is its name)
    await expect.poll(async () => (await opfsList(probe, 'pdf')).length, { message: 'both PDFs are copied back', timeout: 120_000 }).toBe(2);
    for (const path of await opfsList(probe, 'pdf')) expect(await opfsSha256(probe, path), `${path} is the file it is named for`).toBe(path.split('/').pop()!.replace(/\.pdf$/, ''));

    // the saved copy opens with no network, with its note
    const hitsBefore = server.requests(ATTENTION.path);
    const reopened = await openSaved(other, shaA);
    await waitViewerReady(reopened).catch(() => undefined);
    await expect(cardWith(reopened, NOTE_A), 'a restored reading opens from its saved copy, with its note').toBeVisible({ timeout: 30_000 });
    expect(server.requests(ATTENTION.path), 'without asking the web for it').toBe(hitsBefore);
    await shotOf(reopened, testInfo, '06-opened-from-the-saved-copy');
    await reopened.close();

    // the text is read again in the background, and becomes searchable
    const sawProgress: string[] = [];
    await expect
      .poll(
        async () => {
          const body = await settings.evaluate(() => document.body.innerText);
          const m = /indexing \d+ of \d+/i.exec(body);
          if (m !== null && !sawProgress.includes(m[0])) sawProgress.push(m[0]);
          return (await storeOf(probe).call<unknown[]>('searchPages', ATTENTION_TEXT, 5)).length;
        },
        { message: `the text of a restored PDF becomes searchable ("${ATTENTION_TEXT}")`, timeout: 180_000, intervals: [1000, 2000, 3000] },
      )
      .toBeGreaterThan(0);
    note(testInfo, 'progress seen on Settings', sawProgress.join(', ') || '(none)');
    await shotOf(settings, testInfo, '07-indexed');

    // ---- a second restore changes nothing ----
    const afterFirst = await snapshotOf(probe);
    await settings.bringToFront();
    const second = await restoreFrom(settings);
    expect(second.refused).toBe(false);
    await settings.waitForTimeout(8000);
    expect(await snapshotOf(probe), 'running the restore twice changes nothing').toEqual(afterFirst);

    // ---- a backup from a newer version is refused, in plain words, and changes nothing ----
    await setPickerFolder(settings, NEWER_FOLDER);
    const newer = await restoreFrom(settings);
    expect(newer.refused, 'a backup from a newer version is refused').toBe(true);
    expect(newer.text).toMatch(/update sickofpdfs first/i);
    await shotOf(settings, testInfo, '08-newer-refused');
    await settings.keyboard.press('Escape');
    expect(await snapshotOf(probe), 'and nothing changed').toEqual(afterFirst);
    await setPickerFolder(settings, PICKER_FOLDER);

    // ---- a forgotten PDF stays gone ----
    const resnet = await openSaved(other, shaR);
    await waitViewerReady(resnet).catch(() => undefined);
    await expect(cardWith(resnet, NOTE_R)).toBeVisible({ timeout: 30_000 });
    if (await fileMenuHas(resnet, /forget this pdf/i)) await forgetThisPdf(resnet);
    else {
      note(testInfo, 'forget', 'the File menu has no "Forget this PDF" yet: the store was asked directly');
      await storeOf(probe).call('forgetDocument', shaR);
    }
    await expect.poll(async () => (await snapshotOf(probe)).documents, { message: 'the forgotten PDF is gone', timeout: 30_000 }).toEqual([shaA]);
    await settings.bringToFront();
    await restoreFrom(settings); // the old backup still holds it
    await settings.waitForTimeout(10_000);
    expect((await snapshotOf(probe)).documents, 'Restore does not bring a forgotten PDF back').toEqual([shaA]);
  } finally {
    await other.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
