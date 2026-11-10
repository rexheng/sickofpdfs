// library.html in the app: the extension's library pages over the app's own store worker.
import './platform/chrome-shim';
import '@sop/ui/tokens.css';
import '../../../packages/ui/src/tokens/phone.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryApp } from '@ext/library/app/App';
import { createStoreLibraryData } from '@ext/library/data/store-data';
import { openBlobStore } from '@ext/store/blob-store';
import { connectStore } from '@ext/store/client';
import { listenForAppEvents, openWaitingPdf } from './platform/app-events';
import { isNativeApp, SopPlatform } from './platform/native';

listenForAppEvents();
// A phone is too narrow for the list's columns: the library starts in grid view (the owner can still switch).
try {
  if (localStorage.getItem('library.layout') === null) localStorage.setItem('library.layout', 'grid');
} catch {
  // no storage: the list it is
}
if (isNativeApp()) void SopPlatform.setBars({ dark: false }).catch(() => {});
void openWaitingPdf();

const fromStore = async () => {
  const [client, blobs] = await Promise.all([connectStore(), openBlobStore().catch(() => null)]);
  return createStoreLibraryData(client, blobs);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LibraryApp connect={fromStore} />
  </StrictMode>,
);
