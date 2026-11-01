import { defineBackground } from 'wxt/utils/define-background';
import { installBackup } from '../backup/service-worker';
import { installCrashRecovery } from '../background/crash-recovery';
import { installOpenLibrary } from '../background/open-library';
import { installStoreBroker } from '../background/store-broker';
import { installFileFallback } from '../background/takeover/file-fallback';
import { installGrants } from '../background/takeover/grants';
import { installTakeoverMessages } from '../background/takeover/messages';
import { registerTakeover } from '../background/takeover/register';
import { installRequestLog } from '../background/takeover/request-log';
import { installTabLifecycle } from '../background/takeover/tab-lifecycle';

// The service worker. Listeners are registered here, synchronously, so that the events they handle wake it.
export default defineBackground(() => {
  installTakeoverMessages();
  installGrants();
  installFileFallback();
  installRequestLog();
  installTabLifecycle();
  installStoreBroker();
  installCrashRecovery();
  installOpenLibrary();
  installBackup();
  registerTakeover().catch((error: unknown) => console.error('sickofpdfs: the takeover is not registered', error));
});
