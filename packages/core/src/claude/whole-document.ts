// "Ask about the whole document": every page's passages in reading order, up to a token budget. A separate path from
// the default pack, always behind a cost estimate (contract §6).
import type { DocumentId } from '../ids';
import { passageSpans, toPassage, tokensOf } from './paragraphs';
import type { Passage } from './types';

export interface WholeDocumentSource {
  documentId: DocumentId;
  pageCount: number;
  text(pageIndex: number): Promise<string>;
  textSource(pageIndex: number): string;
}

export interface WholeDocumentPack {
  passages: Passage[];
  tokens: number;
  /** True when the document did not fit and the last pages were left out. */
  truncated: boolean;
  /** The page after the last one included (equals pageCount when everything fit). */
  nextPage: number;
}

/** Reads pages in order and stops before the first page that would not fit whole, so a page is never half sent. */
export async function packWholeDocument(src: WholeDocumentSource, maxTokens: number): Promise<WholeDocumentPack> {
  const passages: Passage[] = [];
  let tokens = 0;
  let page = 0;
  for (; page < src.pageCount; page++) {
    const spans = passageSpans(await src.text(page));
    const cost = spans.reduce((s, x) => s + tokensOf(x.text.length), 0);
    if (tokens + cost > maxTokens) break;
    for (const s of spans) passages.push(toPassage(src.documentId, page, src.textSource(page), s, passages.length));
    tokens += cost;
  }
  return { passages, tokens, truncated: page < src.pageCount, nextPage: page };
}

/** How many tokens the whole document is, for the estimate before asking. */
export async function wholeDocumentTokens(src: Pick<WholeDocumentSource, 'pageCount' | 'text'>): Promise<number> {
  let t = 0;
  for (let i = 0; i < src.pageCount; i++) for (const s of passageSpans(await src.text(i))) t += tokensOf(s.text.length);
  return t;
}
