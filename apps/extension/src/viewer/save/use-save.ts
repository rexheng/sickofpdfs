// The open flow's save step (Task 30): as soon as the PDF is open, the tab's save controller is made, published for
// tests and Phase 2, and started. It waits for the library store (which connects after the first page is drawn) in the
// `checking` state, so the first mark always has a controller to ask. This is the only place identity starts; App.tsx
// makes no store call of its own.
// Phase 3 (S11): the real learning filter (filter/async-filter.ts) with the owner's rules (filter/rules-source.ts).
import { canonicalLink, cleanLink } from '@sop/core';
import type { PdfBackend } from '@sop/viewer';
import { useEffect, useState } from 'react';
import { LOCAL_ONLY_DB, type LocalOnlyStore, openLocalOnlyStore } from '../../local-only/secrets-store';
import { type BlobStore, openBlobStore } from '../../store/blob-store';
import type { ViewerParams } from '../../shared/viewer-url';
import { isIncognito } from '../incognito';
import type { OpenedDocument } from '../open-document';
import { publishRuntime } from '../runtime';
import { libraryStore } from '../use-store';
import { createViewerFilter } from '../filter/async-filter';
import { createRulesSource } from '../filter/rules-source';
import { createTieBreaker } from '../filter/tie-breaker';
import { scrubBackups } from './backup-scrub';
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

let localOnly: Promise<LocalOnlyStore | null> | null = null;

/** The tab's local-only store (never-save, reports, the forgotten list), opened the first time the filter asks. */
function tabLocalOnly(): Promise<LocalOnlyStore | null> {
  localOnly ??= openLocalOnlyStore().catch(() => null);
  return localOnly;
}

/** Whether the local-only database exists: reading the owner's choices must not create it. */
async function localOnlyExists(): Promise<boolean> {
  try {
    return (await indexedDB.databases()).some((db) => db.name === LOCAL_ONLY_DB);
  } catch {
    return true; // cannot tell: open it (an empty one holds nothing)
  }
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
    // Nothing is saved in Incognito, so there are no rules to read or keep there either.
    const rules = store === null ? null : createRulesSource({ local: tabLocalOnly, localExists: localOnlyExists, store: () => store });
    // The tie-breaker (S10) is made only when a PDF is "not sure", and its worker ends after that one use.
    const filter = createViewerFilter({ fingerprint: opened.loaded.sha256, rules, tieBreaker: () => createTieBreaker() });
    const controller = createSaveController({
      opened,
      backend,
      store,
      blobs,
      filter: (input) => filter.filter(input),
      fileChoice: () => filter.fileChoice(),
      rules,
      scrubBackups,
      incognito,
      location: saveLocationOf(params, opened),
      now: () => Date.now(),
    });
    publishRuntime({
      blobStore: null,
      save: { state: () => controller.state, documentId: () => controller.documentId(), firstMark: () => controller.firstMark(), decision: () => controller.decision },
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
