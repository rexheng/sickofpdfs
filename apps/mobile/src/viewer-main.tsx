// viewer.html in the app: the extension's viewer (apps/extension/src/viewer/App.tsx) with the app's platform layer underneath and
// the phone's touch gestures on top.
import './platform/chrome-shim';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ext/viewer/App';
import { listenForAppEvents, openWaitingPdf } from './platform/app-events';
import { takeIncomingPdf } from './platform/incoming';
import { isNativeApp, SopPlatform } from './platform/native';
import { PdfClosed } from './phone/PdfClosed';
import { installTouchSelection } from './phone/touch-select';
import { installTouchZoom } from './phone/touch-zoom';
import { startSync } from './platform/sync-host';
import '../../../packages/ui/src/tokens/phone.css';
import './phone/viewer-phone.css';

listenForAppEvents();
// The owner's decision (round 3): in a note box on the phone, Enter makes a new line; only the Comment or Reply button sends.
document.documentElement.dataset.noteEnter = 'newline';
// Sync with the owner's own server, once they connected one (Settings → Cloud). Until then it sends nothing.
startSync();
if (isNativeApp()) void SopPlatform.setBars({ dark: true }).catch(() => {});
installTouchZoom();
installTouchSelection();
const outcome = await takeIncomingPdf();
void openWaitingPdf();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main id="viewer-root">{outcome === 'gone' ? <PdfClosed /> : <App />}</main>
  </StrictMode>,
);
