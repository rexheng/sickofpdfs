// What `exportMarkdown` reads (contracts §5). The shapes are structural and only name the fields the export uses, so the
// store's rows (`MarkRow`, `ThreadRow`, `CommentRow`) fit them as they are and nothing here imports store or viewer code.
//
// Every row is read defensively: a missing `deletedAt` or `draftOfTab` counts as "not deleted" and "not a draft".
import type { MarkRow, ThreadRow, CommentRow } from '../model/rows';

/** The document, as the export needs to know it. `DocumentRow` fits it; the two link fields are added by the caller. */
export interface ExportDocument {
  /** The fingerprint (SHA-256 hex). It goes in the front matter and in links to the saved copy. */
  id: string;
  title: string | null;
  authors: readonly string[];
  doi?: string | null;
  arxivId?: string | null;
  /**
   * Where the PDF is on the web: its canonical link (tracking and fragments removed). Only an http(s) link counts. Leave it
   * out (or null) for a document that was opened from a file: the front matter then has no `source`, and a link back goes to
   * the viewer instead. A file path is never written to the export.
   */
  sourceLink?: string | null;
  /**
   * The viewer page's address, without a query, for example `chrome-extension://<id>/viewer.html`. A link back to a
   * file-only document is `<viewerBase>?doc=<id>#page=N`. Defaults to `viewer.html`.
   */
  viewerBase?: string | null;
}

export type ExportMark = Pick<MarkRow, 'id' | 'style' | 'color' | 'anchor' | 'pageIndex' | 'sortKey' | 'createdAt' | 'deletedAt'>;
export type ExportThread = Pick<ThreadRow, 'id' | 'anchor' | 'pageIndex' | 'sortKey' | 'createdAt' | 'deletedAt' | 'draftOfTab'>;
export type ExportComment = Pick<CommentRow, 'id' | 'threadId' | 'author' | 'body' | 'meta' | 'createdAt' | 'deletedAt' | 'draftOfTab'>;
