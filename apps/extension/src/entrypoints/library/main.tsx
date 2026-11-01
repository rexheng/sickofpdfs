import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { type ConnectLibrary, LibraryApp } from '../../library/app/App';
import { createStoreLibraryData } from '../../library/data/store-data';
import { openBlobStore } from '../../store/blob-store';
import { connectStore } from '../../store/client';

/** The library tab reads the store, and the saved copies for the thumbnails. */
const fromStore: ConnectLibrary = async () => {
  const [client, blobs] = await Promise.all([connectStore(), openBlobStore().catch(() => null)]);
  return createStoreLibraryData(client, blobs);
};

/**
 * Test builds only: `library.html?fake` shows the in-memory sample library (the screenshots of Gate 3), with
 * `&pdfs=<folder link>` for the sample PDFs' thumbnails and `&empty` for the first-run screen. A production build
 * drops this branch and the fake module with it.
 */
const fromFake: ConnectLibrary | null =
  import.meta.env.MODE === 'test' && new URLSearchParams(location.search).has('fake')
    ? async () => {
        const params = new URLSearchParams(location.search);
        const { createFakeLibraryData } = await import('../../library/data/fake');
        return createFakeLibraryData({ pdfBase: params.get('pdfs'), empty: params.has('empty') });
      }
    : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LibraryApp connect={fromFake ?? fromStore} />
  </StrictMode>,
);
