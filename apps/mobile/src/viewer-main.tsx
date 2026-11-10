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
import { installTouchZoom } from './phone/touch-zoom';
import './phone/viewer-phone.css';

listenForAppEvents();
if (isNativeApp()) void SopPlatform.setBars({ dark: true }).catch(() => {});
installTouchZoom();
const outcome = await takeIncomingPdf();
void openWaitingPdf();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <main id="viewer-root">{outcome === 'gone' ? <PdfClosed /> : <App />}</main>
  </StrictMode>,
);
