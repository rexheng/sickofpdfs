// The set-up the backup, lost-permission and restore walkthroughs share: a library with two saved readings and a note on each, a key in the
// private store, an unsaved invoice that was only opened, a (faked) folder picked in Settings, and the first backup in it.
// See 28-backup.spec-blind.spec.ts for how the folder is picked and what is guessed about Settings.
import type { BrowserContext, Page } from '@playwright/test';
import { seedSecret, test, type FixtureServer } from '../../support/test';
import { LINES, ATTENTION as ATTENTION_FX, openPaper, postNote, saveFirst, selectPassage, type OpenViewer, type TlFixture } from './marks.spec-blind';
import {
  INVOICE,
  PICKER_FOLDER,
  RESNET,
  backUpNowButton,
  chooseFolderButton,
  fakeApiKey,
  hasBackupSection,
  installBackupFakes,
  openSettings,
  pageNotBuilt,
  shotOf,
  waitForBackup,
  waitForStore,
  waitViewerReady,
  type FoundBackup,
} from './library-p3.spec-blind';

export const RESNET_FX: TlFixture = { name: 'resnet', file: RESNET.file, page: 0, dir: 'ltr' };
export const NOTE_A = 'Backup note on the attention paper';
export const NOTE_R = 'Backup note on the resnet paper';
/** A phrase from the attention paper's page 1 (the abstract), for "is its text searchable". */
export const ATTENTION_TEXT = 'dominant sequence transduction';
export const RESNET_PASSAGE = { from: 'Deep Residual', to: 'Image Recognition' };

export interface BackedUp {
  settings: Page;
  /** The key-shaped secret that was put into the private store (built at run time). */
  key: string;
  attentionId: string;
  resnetId: string;
  backup: FoundBackup;
}

/** Two saved readings with a note each, an unsaved invoice that was only opened, a key in the private store, a folder picked, a first backup. */
export async function backedUp(context: BrowserContext, openViewer: OpenViewer, server: FixtureServer, testInfo: Parameters<typeof shotOf>[1]): Promise<BackedUp> {
  await installBackupFakes(context);
  const key = fakeApiKey();

  const a = await openPaper(openViewer, server, ATTENTION_FX);
  await waitForStore(a);
  const attentionId = await saveFirst(a);
  await postNote(a, ATTENTION_FX, LINES.l1, NOTE_A);
  await selectPassage(a, ATTENTION_FX, LINES.l5); // a highlight, so the backup holds a mark as well as a note
  await a.keyboard.press('h');
  await a.waitForTimeout(800);
  await seedSecret(a, key);
  const r = await openPaper(openViewer, server, RESNET_FX);
  await waitForStore(r);
  const resnetId = await saveFirst(r);
  await postNote(r, RESNET_FX, RESNET_PASSAGE, NOTE_R);
  const invoice = await openViewer(server.url(INVOICE.path)); // only opened: it must leave nothing in a backup
  await waitViewerReady(invoice);
  await waitForStore(invoice);

  const settings = await openSettings(context);
  if (await pageNotBuilt(settings)) test.skip(true, 'the Settings page is not built yet (slice S14)');
  if (!(await hasBackupSection(settings))) test.skip(true, 'Settings has no Backup section yet (slice S13/S14)');
  await shotOf(settings, testInfo, '01-settings-before');
  await chooseFolderButton(settings).click();
  await shotOf(settings, testInfo, '02-settings-folder-picked');

  // the session ends: the tabs that made notes close
  await a.close();
  await r.close();
  if (await backUpNowButton(settings).isVisible()) await backUpNowButton(settings).click();
  const backup = await waitForBackup(settings, PICKER_FOLDER, { message: 'a backup should appear in the picked folder after the folder is chosen and the session has ended' });
  await shotOf(settings, testInfo, '03-settings-after-backup');
  return { settings, key, attentionId, resnetId, backup };
}
