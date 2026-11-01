// "+ New" → Upload PDF (ruling R76): the picked files go into the library as the owner's own choice, without a viewer tab.
// It is the viewer's own save (save-controller.ts), run in the library tab: the same fingerprint, identity check, saved
// copy, rows and page text, and "You saved it" as the reason. Only the owner's click gets here, so nothing is saved that
// they did not choose. "Open file" is different: it only opens the PDF, and the viewer's normal save decision applies.
import type { FilterDecision } from '@sop/core';
import { loadPdfSource, type PdfBackend, PdfPasswordError } from '@sop/viewer';
import type { BlobStore } from '../../store/blob-store';
import type { StoreClient } from '../../store/client';
import { createSaveController } from '../../viewer/save/save-controller';
import { looksLikePdf } from '../shell/open-file';
import type { UploadOutcome } from './types';

export interface UploadDeps {
  store: StoreClient;
  blobs: BlobStore | null;
  /** The engine, made on first use. */
  backend(): PdfBackend;
  now(): number;
}

/** The filter is not asked: the owner chose to save this file. The save below says so ("You saved it"). */
const OWNERS_CHOICE = (): FilterDecision => ({ verdict: 'unsure', reasons: [] });

export async function savePickedPdf(file: File, deps: UploadDeps): Promise<UploadOutcome> {
  if (!(await looksLikePdf(file))) return 'not-pdf';
  const loaded = await loadPdfSource({ kind: 'file', file });
  if ((await deps.store.resolveFingerprint(loaded.sha256)) !== null) return 'already-saved';
  const engine = deps.backend();
  let open;
  try {
    open = await engine.open(await loaded.blob.arrayBuffer());
  } catch (error) {
    return error instanceof PdfPasswordError ? 'needs-password' : 'failed';
  }
  const save = createSaveController({
    opened: { loaded, open, password: null },
    backend: engine,
    store: deps.store,
    blobs: deps.blobs,
    filter: OWNERS_CHOICE,
    incognito: false,
    location: null, // a file picked from disk has no address of its own
    now: () => deps.now(),
  });
  try {
    const saved = (): boolean => save.state.kind === 'saved';
    await save.start();
    // Saved already after the identity check: a stamped copy of a reading the library holds.
    if (saved()) return 'already-saved';
    await save.requestSave();
    return saved() ? 'saved' : 'failed';
  } catch {
    return 'failed';
  } finally {
    save.dispose();
    void engine.close(open.doc).catch(() => {});
  }
}
