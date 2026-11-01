// The backup's part of the service worker. One call from `entrypoints/background.ts` registers all of it, synchronously, so the
// events below wake the worker.
//
//  - The badge: the offscreen document asks for it with a message (badge.ts).
//  - A backup needs the offscreen document, which Chrome only starts when something asks for the store. When the browser starts
//    and a backup folder is chosen, the service worker starts it, so a night that was missed is caught up without a tab open.
import { ensureOffscreen } from '../background/offscreen';
import { installBackupBadge, restoreBackupBadge } from './badge';
import { openHandleStore } from './handle-store';

async function wakeBackup(): Promise<void> {
  // In Incognito the extension only views PDFs: there is no library, so no backup.
  if (chrome.extension.inIncognitoContext) return;
  const handles = await openHandleStore();
  try {
    if ((await handles.getTarget()) === null) return;
  } finally {
    handles.close();
  }
  await ensureOffscreen();
}

export function installBackup(): void {
  installBackupBadge();
  chrome.runtime.onStartup.addListener(() => {
    restoreBackupBadge().catch(() => {});
    wakeBackup().catch((error: unknown) => console.error('sickofpdfs: the backup did not start', error));
  });
}
