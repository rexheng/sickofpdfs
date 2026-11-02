// R91 (round 2, N1): the hard-block check at save time reads every page, in full. These rows place a card number where the
// filter's sample and its character caps would not reach it. Written by the filterfix implementer (rule 7 exception the
// brief allowed for this logic); a spec-blind author may replace it.
import { describe, expect, it } from 'vitest';
import { hardBlockOnEveryPage } from './classify';
import { detectHardBlocks, detectHardBlocksOnEveryPage } from './hard-blocks';
import { PAGE_CHAR_CAP, TOTAL_CHAR_CAP } from './limits';

const CARD = 'Card number 4111 1111 1111 1111';
const PROSE = 'The fisherman unloads the quay and the harbour wall. ';
const filler = (chars: number): string => PROSE.repeat(Math.ceil(chars / PROSE.length)).slice(0, chars);
const pages = (n: number, at: number, text: string): string[] => Array.from({ length: n }, (_, i) => (i === at ? text : filler(3000)));

describe('the hard block on every page', () => {
  const rows: [string, string[]][] = [
    ['page 7 of 12 (outside the first and last 5)', pages(12, 6, CARD)],
    ['page 300 of 600 (past the total character cap)', pages(600, 299, CARD)],
    ['past the first 20,000 characters of a page', [filler(PAGE_CHAR_CAP + 5000) + CARD]],
    ['across the edge of the first window of a page', [filler(PAGE_CHAR_CAP - 12) + CARD + filler(500)]],
    ['far down a very long page', [filler(TOTAL_CHAR_CAP * 2) + CARD]],
  ];
  it.each(rows)('finds a card number %s', (_name, texts) => {
    expect(detectHardBlocksOnEveryPage(texts)).toEqual(['card']);
    expect(hardBlockOnEveryPage(null, texts)?.ownerSave.indexText).toBe(false);
  });

  it('where the sample check alone would miss them', () => {
    expect(detectHardBlocks(pages(600, 299, CARD))).toEqual([]);
    expect(detectHardBlocks([filler(PAGE_CHAR_CAP + 5000) + CARD])).toEqual([]);
  });

  it('two kinds on two different pages block together; one kind alone does not', () => {
    const iban = 'IBAN GB82 WEST 1234 5698 7654 32';
    const ni = 'National Insurance number AB 12 34 56 C'; // QQ is the example prefix, which never counts
    const two = pages(20, 3, iban);
    two[15] = ni;
    expect(hardBlockOnEveryPage(null, two)?.hardBlocks).toEqual(['iban', 'ni-number']);
    expect(hardBlockOnEveryPage(null, pages(20, 3, iban))).toBeNull();
  });

  it('a PDF with none is not blocked', () => {
    expect(hardBlockOnEveryPage(null, pages(50, 0, filler(3000)))).toBeNull();
  });
});
