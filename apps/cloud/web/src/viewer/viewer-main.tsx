// viewer.html on the web (CL14): the extension's viewer (apps/extension/src/viewer/App.tsx) over this tab's copy of the owner's
// library, with the PDF streamed from the cloud (open-cloud.ts). It is reached from a reading's page ("Open PDF"):
// `/viewer?doc=<sha>&name=<title>#page=N`.
//
// Like the web library, it is a sync client (sync/engine.ts): the library comes down first, so the PDF opens with its notes, and
// every mark, comment and edit made here goes to the cloud a moment later (and on to Chrome and the phone). Nothing is kept on
// this computer.
//
// On a phone the viewer is the phone app's (layout.ts): touch selection with handles, the action bar, pinch zoom and the notes
// as a bottom sheet.
import '../platform/chrome-shim';
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import '../../../../../packages/ui/src/tokens/phone.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TextButton } from '@sop/ui';
import { App } from '@ext/viewer/App';
import { parseViewerUrl } from '@ext/shared/viewer-url';
import { connectStore } from '@ext/store/client';
import { installTouchSelection } from '@mobile/phone/touch-select';
import { installTouchZoom } from '@mobile/phone/touch-zoom';
import phoneCss from '@mobile/phone/viewer-phone.css?inline';
import { goToSignIn } from '../sync/api';
import { setWebLibrary, startWebSync, type WebSync } from '../sync/engine';
import { leaveViewer } from './back';
import { DownloadProgress, useDownloading } from './DownloadProgress';
import { PHONE_LAYOUT } from './layout';
import { startCloudDownload } from './open-cloud';
import styles from './viewer-main.module.css';

const doc = parseViewerUrl(location.href).doc ?? '';
// The PDF starts coming down at once, while the library does.
startCloudDownload(doc);

if (PHONE_LAYOUT) {
  const style = document.createElement('style');
  style.textContent = phoneCss;
  document.head.append(style);
  document.documentElement.dataset.phoneViewer = '';
  installTouchZoom();
  installTouchSelection();
}

let sync: WebSync | null = null;

/** The store and the first sync round (the library comes down). "Try again" runs the round again. */
async function connect(): Promise<void> {
  if (sync === null) {
    const store = await connectStore({ timeoutMs: 15_000 });
    sync = startWebSync(store);
    setWebLibrary({ store, sync });
    await sync.ready;
    return;
  }
  await sync.now();
}

function Root() {
  const [ready, setReady] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [attempt, setAttempt] = useState(0);
  const downloading = useDownloading();
  useEffect(() => {
    let live = true;
    setReady('loading');
    connect().then(
      () => live && setReady('ready'),
      () => live && setReady('failed'),
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  return (
    <>
      {ready === 'ready' ? (
        <App />
      ) : (
        <div className={styles.waiting}>
          {ready === 'failed' ? (
            <div className={styles.card} data-theme="light">
              <h1 className={styles.title}>Can’t reach your cloud</h1>
              <p className={styles.line}>Your notes are safe there. Check your connection, then try again.</p>
              <div className={styles.actions}>
                <TextButton label="Back to library" onClick={leaveViewer} />
                <TextButton label="Try again" variant="tonal" onClick={() => setAttempt((n) => n + 1)} />
              </div>
            </div>
          ) : downloading ? (
            <DownloadProgress inline />
          ) : (
            <p role="status" className={styles.status}>
              Opening your notes…
            </p>
          )}
        </div>
      )}
      {ready === 'ready' && <DownloadProgress />}
    </>
  );
}

async function boot(): Promise<void> {
  // The page holds nothing private; the library comes only after the Worker says this is the owner.
  const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  if (me !== null && me.status === 401) {
    goToSignIn();
    return;
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <main id="viewer-root">
        <Root />
      </main>
    </StrictMode>,
  );
}

void boot();
