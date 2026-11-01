// A document to save in store tests: a 12-page paper opened from a web link. Plain data, so tests can pass it into a page.
import type { DocumentId } from '../../packages/core/src/ids';
import type { SaveDocumentInput } from '../../apps/extension/src/store/store-api';

export const SAMPLE_INPUT: SaveDocumentInput = {
  id: 'ab'.repeat(32) as DocumentId,
  byteSize: 1_234_567,
  pageCount: 12,
  title: 'Household Wealth and Income over the Life Cycle',
  authors: ['A. Author', 'B. Author'],
  pdfId: 'cd'.repeat(16),
  hasText: true,
  encrypted: false,
  blobStored: false,
  saveReasons: ['first-mark'],
  location: { kind: 'url', raw: 'https://example.org/papers/wealth.pdf?utm_source=newsletter', viaPage: null },
  openedAt: 1_793_000_000_000,
};
