// The open flow's save step (Task 30): as soon as the PDF is open, the tab's save controller is made, published for
// tests and Phase 2, and started. It waits for the library store (which connects after the first page is drawn) in the
// `checking` state, so the first mark always has a controller to ask. This is the only place identity starts; App.tsx
// makes no store call of its own.
import { canonicalLink, cleanLink, standInFilter } from '@sop/core';
import type { PdfBackend } from '@sop/viewer';
import { useEffect, useState } from 'react';
import { type BlobStore, openBlobStore } from '../../store/blob-store';
import type { ViewerParams } from '../../shared/viewer-url';
import { isIncognito } from '../incognito';
import type { OpenedDocument } from '../open-document';
import { publishRuntime } from '../runtime';
import { libraryStore } from '../use-store';
import { createSaveController, type SaveControllerImpl, type SaveLocation } from './save-controller';

/**
 * Where the PDF was opened from: its cleaned link or its file URL, and the course or web page it came from (the page
 * the service worker saw embed it, else the navigation's Referer; never the `back` in the viewer's address, which any
 * web page can write). Null for a file picked from disk, which has no address of its own.
 */
export function saveLocationOf(params: ViewerParams, opened: OpenedDocument): SaveLocation | null {
  const source = params.source;
  if (source === null || opened.loaded.sourceUrl === null) return null;
  const file = /^file:/i.test(source);
  if (!file && !/^https?:/i.test(source)) return null;
  const via = opened.back ?? opened.referrer ?? null;
  return { kind: file ? 'file' : 'url', raw: file ? source : cleanLink(source), viaPage: via === null ? null : canonicalLink(via) };
}

let blobStore: Promise<BlobStore | null> | null = null;

/** The tab's blob store, opened once. Without private file storage a save keeps no copy of the PDF. */
function tabBlobStore(): Promise<BlobStore | null> {
  blobStore ??= openBlobStore().catch(() => null);
  return blobStore;
}

/**
 * The tab's save controller for `opened`: made when the PDF is open, disposed when another one replaces it. Null while
 * no PDF is open. `onFailure` hears of a save or Undo that failed.
 */
export function useSave(o: { opened: OpenedDocument | null; params: ViewerParams; backend: PdfBackend; onFailure: (what: 'save' | 'forget') => void }): SaveControllerImpl | null {
  const { opened, params, backend, onFailure } = o;
  const [save, setSave] = useState<SaveControllerImpl | null>(null);
  useEffect(() => {
    if (opened === null) return;
    // In Incognito nothing is opened: no library, no file storage.
    const incognito = isIncognito();
    const store = incognito ? null : libraryStore();
    // Opened after the store (which waits for the first page), so nothing competes with drawing it; none without a library.
    const blobs = store === null ? null : store.then((s) => (s === null ? null : tabBlobStore()));
    const controller = createSaveController({
      opened,
      backend,
      store,
      blobs,
      filter: standInFilter,
      incognito,
      location: saveLocationOf(params, opened),
      now: () => Date.now(),
    });
    publishRuntime({
      blobStore: null,
      save: { state: () => controller.state, documentId: () => controller.documentId(), firstMark: () => controller.firstMark() },
    });
    void blobs?.then((b) => publishRuntime({ blobStore: b }));
    setSave(controller);
    controller.start().catch(() => {}); // it settles on a state whatever happens
    return () => {
      controller.dispose();
      setSave(null);
    };
  }, [opened, params, backend]);
  useEffect(() => save?.onFailure(onFailure), [save, onFailure]);
  return save;
}
