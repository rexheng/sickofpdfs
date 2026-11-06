// "Save this page to library" (spec R103): what saving this page will do, decided before anything is made. Small on purpose:
// the toolbar menu uses it, and must open at once.
import type { DocumentId } from '@sop/core';
import type { StoreClient } from '../store/client';
import { webPageOf } from '../store/reading-flags';
import type { Article } from './article';

/** What saving this page will do. */
export type PagePlan = { kind: 'existing'; documentId: DocumentId } | { kind: 'new'; earlier: DocumentId | null };

type PlanStore = Pick<StoreClient, 'documentAtLink' | 'getDocument'>;

/** The same page with the same words is the reading saved before; changed words make a new version of it. */
export async function planPageSave(store: PlanStore, article: Pick<Article, 'url'>, textHash: string): Promise<PagePlan> {
  const id = await store.documentAtLink(article.url);
  if (id === null) return { kind: 'new', earlier: null };
  const doc = await store.getDocument(id);
  const web = doc === null ? null : webPageOf(doc.saveReasons);
  // A PDF that was once opened from this link is not an earlier version of the page.
  if (doc === null || web === null) return { kind: 'new', earlier: null };
  return web.textHash === textHash ? { kind: 'existing', documentId: id } : { kind: 'new', earlier: id };
}

/** A file name for the PDF: the title, without characters a file name cannot have. */
export function pdfFileName(title: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const base = title.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
  return `${base === '' ? 'Web page' : base}.pdf`;
}
