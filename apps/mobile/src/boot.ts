// index.html, where the app starts: a PDF Android handed the app ("Open with", Share) opens in the viewer; otherwise the library.
// Both replace this page, so Back from either leaves the app.
import './platform/chrome-shim';
import { homeUrl, openWaitingPdf } from './platform/app-events';

void openWaitingPdf({ replace: true }).then((opened) => {
  if (!opened) location.replace(homeUrl());
});
