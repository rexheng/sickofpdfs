// Spec-blind tests for Task 30, the stand-in filter: until the real learning filter is plugged in (Phase 3), every PDF is "not sure".
//
// Sources:
//   interface file (Tasks 30+31): `standInFilter(input) -> { verdict: 'unsure', reasons: ['No filter yet: your first mark saves it'] }`.
//   spec, Learning filter and privacy: "Local traces. A PDF that isn't saved leaves no history row, thumbnail, search entry or log line";
//     contracts section 5: "Privacy. A FilterDecision never holds PDF text, numbers or matched strings. Reasons are fixed labels."
//   CLAUDE.md non-negotiables: "nothing saved from non-learning PDFs" (so the stand-in may never say 'learning' and auto-save a
//     receipt) and "no lost notes" (so it never says 'not-learning' for a paper either: the owner's first mark must still save it).
//
// Plain data in, plain data out: the inputs are the shapes of FilterInput (packages/core/src/filter/types.ts).
import { describe, expect, it } from 'vitest';
import { standInFilter } from './stand-in';
import type { FilterInput } from './types';

const META = { title: null, author: null, subject: null, keywords: null, creator: null, producer: null };
const PAGE = { width: 612, height: 792 };
const input = (o: Partial<FilterInput>): FilterInput => ({ url: null, fileName: 'file.pdf', pageCount: 1, pageSizes: [PAGE], metadata: META, sampleText: [], ...o });

const CARD = '4111 1111 1111 1111';
const IBAN = 'GB82 WEST 1234 5698 7654 32';

describe('the stand-in filter says "not sure" about everything, and keeps what it saw to itself', () => {
  it.each([
    { name: 'a paper from arXiv', i: input({ url: 'https://arxiv.org/pdf/1706.03762', fileName: 'attention.pdf', pageCount: 15, sampleText: ['Abstract', 'References'] }) },
    { name: 'a receipt with a card number', i: input({ fileName: 'receipt.pdf', sampleText: [`Total £4.20 paid by card ${CARD}`] }) },
    { name: 'a bank statement with an IBAN', i: input({ url: 'https://bank.example/statement.pdf', fileName: 'statement.pdf', sampleText: [`Account ${IBAN}`] }) },
    { name: 'a scan with no text at all', i: input({ fileName: 'scan.pdf', pageCount: 120, sampleText: ['', ''] }) },
    { name: 'a 600-page book', i: input({ fileName: 'book.pdf', pageCount: 600, sampleText: ['Chapter 1', 'Index'] }) },
    { name: 'a picked file with no link', i: input({ url: null, fileName: 'x.pdf' }) },
  ])('$name: "unsure", with the one fixed reason', ({ i }) => {
    const decision = standInFilter(i);
    expect(decision.verdict, 'never "learning" (would auto-save a receipt) and never "not-learning" (would ask before the first mark of a real paper)').toBe('unsure');
    expect(decision.reasons).toEqual(['No filter yet: your first mark saves it']);
    expect(JSON.stringify(decision), 'a decision never holds what the PDF said').not.toMatch(/4111|WEST|arxiv|statement|Total/i);
  });
});
