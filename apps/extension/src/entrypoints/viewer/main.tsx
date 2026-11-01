import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { markViewerTab } from '../../shared/viewer-tabs';
import { claimTabIdentity } from '../../viewer/annotations/tab-presence';
import { App } from '../../viewer/App';

// Claim this tab's id before anything else, so a tab that comes back after a crash gets back the draft it owned (R65), and
// note the tab as a viewer, so the service worker can reopen it after a crash (background/crash-recovery.ts).
void claimTabIdentity();
markViewerTab();

/** The viewer's root element. e2e waits for it before it reads anything else. */
const VIEWER_ROOT_ID = 'viewer-root';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main id={VIEWER_ROOT_ID}>
      <App />
    </main>
  </StrictMode>,
);
