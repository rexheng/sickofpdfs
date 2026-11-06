// "Save this page to library" (spec R103): what saving a web page does with the library.
//
// - The same link with the same words opens the reading saved before (plan.ts). Changed words make a new reading, linked to
//   the old one (About this PDF shows "Earlier version").
// - The PDF is saved through the viewer's own save (save-controller.ts), as "+ New → Upload PDF" does: the same fingerprint,
//   identity check, saved copy, rows and page text. The page's link is its source.
// - The owner's click is the decision: the learning filter is not asked. The R91 check of every page for card, bank or ID
//   numbers still runs; if it finds them, the reading is saved without searchable text and the D9 warning is given.
import type { DocumentId, FilterDecision } from '@sop/core';
import { loadPdfSource, type PdfBackend } from '@sop/viewer';
import type { BlobStore } from '../store/blob-store';
import type { StoreClient } from '../store/client';
import { webPageReasons } from '../store/reading-flags';
import { createSaveController } from '../viewer/save/save-controller';
import type { Article } from './article';
import { pdfFileName } from './plan';

/** The filter is not asked: the owner chose to save this page (the save says "You saved it"). */
const OWNERS_CHOICE = (): FilterDecision => ({ verdict: 'unsure', reasons: [] });

export interface SavePageDeps {
  store: StoreClient;
  blobs: BlobStore | null;
  backend: PdfBackend;
  now(): number;
}

export interface SavedPage {
  /** `already`: these exact words were in the library already (the same article from another link): that reading. */
  kind: 'saved' | 'already';
  documentId: DocumentId;
  /** D9: the reading has card, bank or ID numbers, so its text is not searchable; null otherwise. */
  warning: string | null;
}

/** Saves the PDF made from `article` as a reading. Rejects when it could not be saved; nothing is left half saved. */
export async function savePageAsReading(article: Article, pdf: Uint8Array, o: { textHash: string; earlier: DocumentId | null }, deps: SavePageDeps): Promise<SavedPage> {
  const file = new File([pdf as BlobPart], pdfFileName(article.title), { type: 'application/pdf' });
  const loaded = await loadPdfSource({ kind: 'file', file });
  const open = await deps.backend.open(await loaded.blob.arrayBuffer());
  const year = yearOf(article.published);
  const save = createSaveController({
    opened: { loaded, open, password: null },
    backend: deps.backend,
    store: deps.store,
    blobs: deps.blobs,
    filter: OWNERS_CHOICE,
    incognito: false,
    // A page saved on this computer (file:) is a file location, as a PDF opened from disk is.
    location: { kind: /^file:/iu.test(article.url) ? 'file' : 'url', raw: article.url, viaPage: null },
    madeFrom: { title: article.title, authors: article.authors, year, reasons: webPageReasons(o) },
    now: () => deps.now(),
  });
  try {
    await save.start();
    // Known already: the same words, saved from another link (a stamped copy, identity rule 2). That reading opens.
    const known = save.documentId();
    if (known !== null) return { kind: 'already', documentId: known, warning: null };
    await save.requestSave();
    const id = save.documentId();
    if (id === null) throw new Error('not-saved: the library did not save the page');
    return { kind: 'saved', documentId: id, warning: save.saveWarning };
  } finally {
    save.dispose();
    void deps.backend.close(open.doc).catch(() => {});
  }
}

function yearOf(published: string | null): number | null {
  if (published === null) return null;
  const t = Date.parse(published);
  const y = Number.isFinite(t) ? new Date(t).getUTCFullYear() : Number(/\b(19|20)\d{2}\b/u.exec(published)?.[0] ?? NaN);
  return Number.isInteger(y) && y >= 1900 && y <= 2100 ? y : null;
}
