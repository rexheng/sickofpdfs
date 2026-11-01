// Test support only (spec-blind tests for the annotation store, drafts and session). Builders for the row shapes of
// contracts section 2, written from the contract, not from any implementation. Types only come from packages/core.
import type { Anchor, CommentRow, DocumentId, MarkRow, ThreadRow } from '../../../../packages/core/src/index';
import type { CommentId, MarkId, TabId, ThreadId } from '../../../../packages/core/src/ids';

export const DOC = 'ab'.repeat(32) as DocumentId;
export const DOC2 = 'cd'.repeat(32) as DocumentId;
export const T_A = 'tab-aaaa' as TabId;
export const T_B = 'tab-bbbb' as TabId;
export const T_C = 'tab-cccc' as TabId;

export const mid = (s: string) => s as MarkId;
export const tid = (s: string) => s as ThreadId;
export const cid = (s: string) => s as CommentId;

/** What `saveDocument` takes (Task 28); the same sample the store's own e2e tests use (id 'ab' x 32). */
export const SAMPLE_INPUT = {
  id: DOC,
  byteSize: 123_456,
  pageCount: 8,
  title: 'Parallel trends in practice',
  authors: ['A. Author'],
  pdfId: null,
  hasText: true,
  encrypted: false,
  blobStored: false,
  saveReasons: ['spec-blind test'],
  location: { kind: 'url' as const, raw: 'https://example.org/paper.pdf', viaPage: null },
  openedAt: 1_700_000_000_000,
};
export const SAMPLE_INPUT_2 = { ...SAMPLE_INPUT, id: DOC2, title: 'Another paper', location: null };

export function textAnchor(page: number, start: number, end: number, quote = 'difference-in-differences', extra: Record<string, unknown> = {}): Extract<Anchor, { kind: 'text' }> {
  return {
    kind: 'text',
    quote: { quote, prefix: 'the ', suffix: ' estimator' },
    start: { page, index: start },
    end: { page, index: end },
    rects: [{ page, rects: [[0.1, 0.2 + page * 0.01, 0.5, 0.22 + page * 0.01]] }],
    ...extra,
  };
}

const STAMP = { rev: 0, hlc: 'caller-hlc-must-be-ignored', deletedAt: null };

export function markRow(o: Omit<Partial<MarkRow>, 'id'> & { id: string }): MarkRow {
  const anchor = o.anchor ?? textAnchor(0, 10, 20);
  return {
    ...STAMP,
    documentId: DOC,
    style: 'highlight',
    color: 1,
    anchor,
    pageIndex: anchor.kind === 'text' ? anchor.start.page : 'page' in anchor ? anchor.page : 0,
    sortKey: 0.2,
    author: 'me',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...o,
    id: mid(o.id),
  } as MarkRow;
}

export function threadRow(o: Omit<Partial<ThreadRow>, 'id'> & { id: string }): ThreadRow {
  return {
    ...STAMP,
    documentId: DOC,
    anchor: textAnchor(0, 10, 20),
    pageIndex: 0,
    sortKey: 0.2,
    placement: 'placed',
    draftOfTab: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...o,
    id: tid(o.id),
  } as ThreadRow;
}

export function commentRow(o: Omit<Partial<CommentRow>, 'id' | 'threadId'> & { id: string; threadId: string }): CommentRow {
  return {
    ...STAMP,
    documentId: DOC,
    author: 'me',
    body: 'a note',
    draftOfTab: null,
    meta: {},
    createdAt: 1_700_000_000_000,
    editedAt: null,
    ...o,
    id: cid(o.id),
    threadId: tid(o.threadId),
  } as CommentRow;
}

/** A comment draft owned by `tab`. */
export const draftRow = (o: Omit<Partial<CommentRow>, 'id' | 'threadId' | 'draftOfTab'> & { id: string; threadId: string; draftOfTab: TabId }) => commentRow(o) as CommentRow & { draftOfTab: TabId };

/** The six anchor kinds of contracts section 2, with a few fields the v1 readers never heard of. */
export const ANCHORS: { name: string; anchor: Anchor; markable: boolean }[] = [
  { name: 'text', anchor: textAnchor(1, 40, 52, 'parallel trends', { futureField: { deep: [1, 2] } }), markable: true },
  { name: 'text (OCR source)', anchor: textAnchor(2, 5, 25, 'placebo outcomes', { textSource: 'ocr:tesseract@5.3' }), markable: true },
  { name: 'text across two pages', anchor: { ...textAnchor(0, 300, 340), end: { page: 1, index: 12 }, rects: [{ page: 0, rects: [[0.1, 0.9, 0.9, 0.95]] }, { page: 1, rects: [[0.1, 0.05, 0.4, 0.08]] }] }, markable: true },
  { name: 'area', anchor: { kind: 'area', page: 3, rect: [0.1, 0.1, 0.6, 0.4], dHash: '00ff00ff00ff00ff' }, markable: true },
  {
    name: 'figure with pin',
    anchor: {
      kind: 'figure', page: 4, rect: [0.1, 0.1, 0.9, 0.5], sub: { point: [0.3, 0.2] },
      figure: { label: 'Figure 2', captionQuote: { quote: 'Figure 2: Event study', prefix: '', suffix: '', position: { page: 4, index: 800 } }, imageSha256: null, dHash: 'ffffffff00000000', detector: 'objects', detectorVersion: '1', objectIndices: [3, 4] },
    },
    markable: true,
  },
  { name: 'point', anchor: { kind: 'point', page: 5, point: [0.25, 0.75] }, markable: false },
  { name: 'page', anchor: { kind: 'page', page: 6 }, markable: false },
  { name: 'document', anchor: { kind: 'document' }, markable: false },
];

/** The page number a row sits on (null for a document note). */
export const pageOf = (a: Anchor): number | null => (a.kind === 'document' ? null : a.kind === 'text' ? a.start.page : a.page);
