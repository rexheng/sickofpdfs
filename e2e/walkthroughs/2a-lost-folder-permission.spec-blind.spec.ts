// Gate 1, Phase 3 plan, item 11: "Lost folder permission."
//   "The action icon shows a badge. One click re-allows it and the backup completes."
// Spec, "Backups (Release 1)": "Chrome may ask you to re-allow the folder after a restart; Phase 0 tests this, and the extension icon shows a
// badge whenever a backup is waiting for your click." Plan, Phase 3 "Frontier check": "Whether a picked folder stays `granted` is still W-B1.
// So the backup must work when permission is lost: badge, then one click." Risks: "The design assumes it can be lost."
//
// HOW PERMISSION IS "LOST". Chrome decides that, and a test cannot ask Chrome to forget a grant. So the answer a folder handle gives to
// `queryPermission` is switched to "prompt" in the pages of the extension and in its hidden document (where the writer runs), through a
// switch in the extension's localStorage; `requestPermission` flips the switch back to "granted", but only inside a click, as Chrome insists.
// If the writer checks the permission somewhere else (a worker), this test cannot make it lose it and fails at "the icon shows a badge".
//
// GUESSES: the badge is the action's badge text (chrome.action.getBadgeText) and is empty when nothing is waiting; somewhere in the library
// (the Home page, Settings, or the banner on any page) there is a control with "allow" in its name that asks Chrome again ("Backup is waiting.
// Click to allow."); a new note after the permission went starts a backup that cannot finish.
//
// Guard: BACKUP_WRITER, then runtime checks that Settings has a Backup section.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { cardWith, ATTENTION as ATTENTION_FX, LINES, openPaper, postNote } from './support/marks.spec-blind';
import { NOTE_A, backedUp } from './support/backup-flow.spec-blind';
import {
  BACKUP_WRITER,
  NO_BACKUP,
  PICKER_FOLDER,
  backUpNowButton,
  backupFilesMentioning,
  fakePermissionInHiddenDocument,
  findBackup,
  libraryUrl,
  note,
  openLibrary,
  setFolderPermission,
  shotOf,
  waitForBackup,
  waitForStore,
} from './support/library-p3.spec-blind';

test.skip(!BACKUP_WRITER, NO_BACKUP);
test.setTimeout(480_000);

const NOTE_LATER = 'A note made while the folder was waiting for permission';
const ALLOW = /allow/i;

/** The control that asks again: a button or link whose name says "allow", on the library's pages. */
async function findAllowControl(page: Page): Promise<Locator | null> {
  for (const route of ['home', 'library', 'settings'] as const) {
    await page.goto(libraryUrl(route));
    const control = page.getByRole('button', { name: ALLOW }).or(page.getByRole('link', { name: ALLOW })).first();
    if (await control.isVisible({ timeout: 3000 }).catch(() => false)) return control;
  }
  return null;
}

test('when Chrome wants the folder allowed again the icon shows a badge, one click allows it, and the backup completes', async ({ context, openViewer, server, sw }, testInfo) => {
  const s = await backedUp(context, openViewer, server, testInfo);
  const first = s.backup;
  expect(await sw.evaluate(() => chrome.action.getBadgeText({})), 'while the folder is allowed there is no badge').toBe('');

  // Chrome forgets the permission (after a restart, say)
  await setFolderPermission(s.settings, 'prompt');
  await fakePermissionInHiddenDocument(context, s.settings);

  // a new session with a new note
  const page = await openPaper(openViewer, server, ATTENTION_FX);
  await waitForStore(page);
  await expect(cardWith(page, NOTE_A)).toBeVisible({ timeout: 20_000 });
  await postNote(page, ATTENTION_FX, LINES.l9, NOTE_LATER);
  await page.close();
  if (await backUpNowButton(s.settings).isVisible()) await backUpNowButton(s.settings).click();

  // the icon shows a badge, and nothing was written
  await expect.poll(() => sw.evaluate(() => chrome.action.getBadgeText({})), { message: 'the extension icon shows a badge: a backup is waiting for a click', timeout: 90_000, intervals: [500, 1000, 2000] }).not.toBe('');
  note(testInfo, 'the badge says', await sw.evaluate(() => chrome.action.getBadgeText({})));
  const stalled = (await findBackup(s.settings, PICKER_FOLDER))!;
  expect(stalled.manifest.createdAt, 'no new backup was written while permission was missing').toBe(first.manifest.createdAt);
  expect(await backupFilesMentioning(s.settings, PICKER_FOLDER, NOTE_LATER), 'and the new note is not in the folder').toEqual([]);

  // the library says so, and one click allows it
  const lib = await openLibrary(context, 'home');
  const allow = await findAllowControl(lib);
  expect(allow, 'the library shows "Backup is waiting. Click to allow." (a control with "allow" in its name)').not.toBeNull();
  await shotOf(lib, testInfo, '04-backup-is-waiting');
  await allow!.click();

  // the backup completes, and the badge goes
  const done = await waitForBackup(s.settings, PICKER_FOLDER, { after: first.manifest.createdAt, timeout: 120_000, message: 'one click on "allow" lets the waiting backup complete' });
  const mdFiles = await Promise.all(done.list('notes/').map((p) => done.text(p)));
  expect(mdFiles.join('\n'), 'the backup that completed holds the new note').toContain(NOTE_LATER);
  await expect.poll(() => sw.evaluate(() => chrome.action.getBadgeText({})), { message: 'and the badge goes away', timeout: 60_000 }).toBe('');
  await shotOf(lib, testInfo, '05-backup-done');
  await setFolderPermission(s.settings, null);
});
