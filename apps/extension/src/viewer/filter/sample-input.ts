// The learning filter's view of an open PDF (Phase 3, slice S8). `buildFilterInput` reads what `classify` needs and
// nothing else: the page count and sizes, the Info fields, the form type, the link, and the text of the first and last 5
// pages (plus up to 10 middle pages when those hold almost no words, core's "second look").
//
// It is the one place that decides which pages are read, so the save controller, the fixture extractor
// (scripts/fixtures/extract-filter-inputs.mjs) and the gates all see the same input.
//
// Timing. The caller starts it after the first page is drawn. It reads one page at a time and waits for each answer, so the
// engine's queue (one worker) always has a render request between two text reads, and a render never waits behind more
// than one page of text. The form type is asked last, once per document (the backend remembers the answer, R38).
//
// Privacy. The result holds the text in memory only. This file writes nothing, logs nothing and sends nothing. The
// caller drops the input once `classify` has returned.
import { needsSecondLook, sampleIndexes, secondLookIndexes, type FilterFormType, type FilterInput } from '@sop/core';
import type { OpenResult, PdfBackend } from '@sop/viewer';

/** The two engine calls the sampler makes. A full PdfBackend fits. */
export type FilterBackend = Pick<PdfBackend, 'getPageText' | 'getFormInfo'>;

/** What the sampler reads of the open document: an OpenResult (or `OpenedDocument.open`) fits. */
export type FilterDocument = Pick<OpenResult, 'doc' | 'pageCount' | 'pages' | 'metadata'>;

export interface FilterInputContext {
  /** The link the PDF came from (http(s), file or blob), or null for a file picked from disk. */
  url: string | null;
  fileName: string;
  /** The course or referring page the PDF was opened from. */
  viaPage?: string | null;
  /**
   * Reads one page's text. The default is `backend.getPageText(doc.doc, i)`. The save controller passes its own cached
   * reader, so a page it reads for the filter is not read again when the PDF is saved.
   */
  pageText?: (pageIndex: number) => Promise<string>;
  /** Stops the reading between two pages; the call then rejects with the signal's reason (an AbortError). */
  signal?: AbortSignal;
}

/**
 * The filter's input for an open PDF. Never rejects except for an aborted `ctx.signal`: a page the engine cannot read
 * counts as a page with no text (so a broken file is never saved by score), and an unreadable form type is left out.
 */
export async function buildFilterInput(backend: FilterBackend, doc: FilterDocument, ctx: FilterInputContext): Promise<FilterInput> {
  const readPage = ctx.pageText ?? ((pageIndex: number) => backend.getPageText(doc.doc, pageIndex));

  const read = async (indexes: readonly number[]): Promise<string[]> => {
    const out: string[] = [];
    for (const pageIndex of indexes) {
      ctx.signal?.throwIfAborted();
      try {
        out.push(await readPage(pageIndex));
      } catch {
        out.push('');
      }
    }
    return out;
  };

  const sampleText = await read(sampleIndexes(doc.pageCount));
  if (needsSecondLook(sampleText)) sampleText.push(...(await read(secondLookIndexes(doc.pageCount))));

  ctx.signal?.throwIfAborted();
  const formType = await backend.getFormInfo(doc.doc).then(
    (info): FilterFormType => info.formType,
    () => undefined,
  );

  const { title, author, subject, keywords, creator, producer } = doc.metadata;
  return {
    url: ctx.url,
    fileName: ctx.fileName,
    pageCount: doc.pageCount,
    pageSizes: doc.pages,
    metadata: { title, author, subject, keywords, creator, producer },
    sampleText,
    viaPage: ctx.viaPage ?? null,
    ...(formType !== undefined ? { formType } : {}),
  };
}
