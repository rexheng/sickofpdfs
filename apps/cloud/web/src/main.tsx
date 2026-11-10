// The web library: the extension's library pages (Home, My library, Courses, Recent, Starred, Notes, Trash) over this tab's
// copy of the owner's library, kept in step with the cloud (sync/engine.ts). A reading's own page (/d/<sha>) and Settings are
// the web's own (reading/, settings/).
import './platform/chrome-shim';
import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import '../../../../packages/ui/src/tokens/phone.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LibraryApp } from '@ext/library/app/App';
import type { LibraryData } from '@ext/library/data/types';
import { createStoreLibraryData } from '@ext/library/data/store-data';
import { connectStore, type StoreClient } from '@ext/store/client';
import { goToSignIn } from './sync/api';
import { setWebLibrary, startWebSync, type WebSync } from './sync/engine';
import { remotePalette } from './sync/remote-search';

// A phone is too narrow for the list's columns: the library starts in grid view there (the owner can still switch).
try {
  if (matchMedia('(max-width: 720px)').matches && localStorage.getItem('library.layout') === null) localStorage.setItem('library.layout', 'grid');
} catch {
  // no storage: the list it is
}

let started: Promise<LibraryData> | null = null;
let engine: Promise<{ store: StoreClient; sync: WebSync; first: boolean }> | null = null;

/** The store, the first sync round, then the library's data. "Try again" after a failure runs the round again. */
function connect(): Promise<LibraryData> {
  started ??= (async () => {
    const first = engine === null;
    engine ??= connectStore({ timeoutMs: 15_000 }).then((store) => {
      const sync = startWebSync(store);
      setWebLibrary({ store, sync });
      return { store, sync, first: true };
    });
    const { store, sync } = await engine.catch((e: unknown) => {
      engine = null;
      throw e;
    });
    await (first ? sync.ready : sync.now());
    const data = createStoreLibraryData(store, null);
    // Upload comes with the web upload (next round); the web library has no PDF files of its own.
    return { ...data, palette: remotePalette(store), savedPdf: () => Promise.resolve(null) };
  })().catch((e: unknown) => {
    started = null;
    throw e;
  });
  return started;
}

async function boot(): Promise<void> {
  // The page itself holds nothing private; the library comes only after the Worker says this is the owner.
  const me = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  if (me !== null && me.status === 401) {
    goToSignIn();
    return;
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <LibraryApp connect={connect} />
    </StrictMode>,
  );
}

void boot();
