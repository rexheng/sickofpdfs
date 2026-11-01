// Spec-blind tests for detectHardBlocks (Phase 3, slice S1).
//
// Sources:
//   spec, "Learning filter and privacy", rule 2.2: "Hard block: a card number (16 digits, valid checksum, known card prefix),
//     or any two of IBAN, sort code with account number, National Insurance number, US Social Security number, UK tax
//     reference (UTR), passport line or boarding-pass code."
//   plan S1: "detectHardBlocks(texts: readonly string[]): HardBlock[] (kinds only; no matched text is kept). Card = 16
//     digits with a valid checksum and a known prefix. IBAN with its checksum. UK sort code near an 8-digit account. NI
//     number, US SSN, UTR, passport MRZ line, boarding-pass code (M1...). It must not fire on arXiv ids, DOIs, ISBNs,
//     page numbers or number-heavy tables."
//   contract section 5: HardBlock = 'card' | 'iban' | 'sort-code-account' | 'ni-number' | 'ssn' | 'utr' | 'passport-line' | 'boarding-pass'.
//
// A false save is a privacy failure, so the "must fire" rows use realistic layouts (labels, spacing, PDFium's "\r\n"), and
// the "must NOT fire" rows are the near-misses the plan names plus the obvious look-alikes (wrong checksum, wrong length,
// unknown prefix, a longer digit run, an unlabelled number). The result is compared as a SET of kinds: the spec does not say
// whether the array is de-duplicated or sorted.
import { describe, expect, it } from 'vitest';
import { ALL_HARD_BLOCKS, FILLER_PAGE, deepFreeze, ibanValid, lines, luhnValid } from '../../test/spec-blind/filter-kit';
import type { HardBlock } from '../../test/spec-blind/filter-kit';
import { detectHardBlocks } from './hard-blocks';

const kinds = (texts: readonly string[]): HardBlock[] => [...new Set(detectHardBlocks(deepFreeze([...texts])))].sort();
const page = (s: string) => `${FILLER_PAGE}${'\r\n'}${s}${'\r\n'}${FILLER_PAGE}`;

// A deterministic stream of small numbers for the table row (no 4-digit numbers, so no 4-4-4-4 card layout can appear).
function numberTable(rows: number, cols: number): string {
  let seed = 20260501;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const widths = [1, 2, 3, 5, 6, 7];
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const w = widths[next() % widths.length] ?? 3;
      cells.push(String(next()).slice(0, w).padStart(w, '5'));
    }
    out.push(cells.join(' '));
  }
  return out.join('\r\n');
}

describe('test vectors are what these tests say they are (independent checksum check)', () => {
  it.each([
    '4111111111111111',
    '4012888888881881',
    '5555555555554444',
    '5105105105105100',
    '2223003122003222',
    '6011111111111117',
    '3530111333300000',
    '6200000000000005',
  ])('card %s passes Luhn', (n) => expect(luhnValid(n)).toBe(true));
  it.each([
    ['4111111111111112', false],
    ['5555555555554445', false],
    ['1234567890123452', true], // Luhn-valid, but no card scheme starts with 1: the "valid checksum, unknown prefix" row
    ['0000000000000000', true], // same, for the all-zero placeholder
  ])('number %s: Luhn-valid is %s', (n, valid) => expect(luhnValid(n)).toBe(valid));
  it.each(['GB82 WEST 1234 5698 7654 32', 'NL91 ABNA 0417 1643 00', 'GB29 NWBK 6016 1331 9268 19', 'FR14 2004 1010 0505 0001 3M02 606', 'ES91 2100 0418 4502 0005 1332'])(
    'IBAN %s passes mod 97',
    (i) => expect(ibanValid(i)).toBe(true),
  );
  it.each(['GB82 WEST 1234 5698 7654 33', 'NL91 ABNA 0417 1643 01'])('IBAN %s fails mod 97', (i) => expect(ibanValid(i)).toBe(false));
});

interface Row {
  name: string;
  texts: string[];
  expect: HardBlock[];
}

describe('detectHardBlocks: each kind fires on a realistic layout', () => {
  const rows: Row[] = [
    // --- card: 16 digits, valid checksum, known prefix, in every common layout
    { name: 'card: Visa, spaced in fours', texts: [page('Card number: 4111 1111 1111 1111   Expires 12/27')], expect: ['card'] },
    { name: 'card: Visa, no spaces', texts: [page('Payment card 4111111111111111 (CVV on the back)')], expect: ['card'] },
    { name: 'card: Visa, dashes', texts: [page('Card No. 4012-8888-8888-1881')], expect: ['card'] },
    { name: 'card: Mastercard 51-55', texts: [page('Mastercard 5555 5555 5555 4444')], expect: ['card'] },
    { name: 'card: Mastercard 2-series', texts: [page('Card: 2223 0031 2200 3222')], expect: ['card'] },
    { name: 'card: Discover', texts: [page('Discover 6011 1111 1111 1117')], expect: ['card'] },
    { name: 'card: JCB', texts: [page('JCB card 3530 1113 3330 0000')], expect: ['card'] },
    { name: 'card: UnionPay', texts: [page('UnionPay 6200 0000 0000 0005')], expect: ['card'] },
    { name: 'card: on the last of several sampled pages', texts: [FILLER_PAGE, FILLER_PAGE, FILLER_PAGE, 'Paid by card 5105 1051 0510 5100'], expect: ['card'] },
    { name: 'card: the number is the whole page text', texts: ['4111 1111 1111 1111'], expect: ['card'] },
    // --- typographic spaces: PDF generators often set number groups with a no-break or narrow no-break space
    { name: 'card: groups joined by no-break spaces', texts: [page('Card 4111\u00a01111\u00a01111\u00a01111')], expect: ['card'] },
    { name: 'card: groups joined by narrow no-break spaces (French typesetting)', texts: [page('Carte 5555\u202f5555\u202f5555\u202f4444')], expect: ['card'] },
    { name: 'iban: groups joined by no-break spaces', texts: [page('IBAN GB82\u00a0WEST\u00a01234\u00a05698\u00a07654\u00a032')], expect: ['iban'] },
    { name: 'ni-number: pairs joined by no-break spaces', texts: [page('NI number AB\u00a012\u00a034\u00a056\u00a0C')], expect: ['ni-number'] },
    // --- IBAN
    { name: 'iban: GB, spaced', texts: [page('IBAN: GB82 WEST 1234 5698 7654 32')], expect: ['iban'] },
    { name: 'iban: GB, compact', texts: [page('IBAN GB82WEST12345698765432')], expect: ['iban'] },
    { name: 'iban: NL', texts: [page('Rekening: NL91 ABNA 0417 1643 00')], expect: ['iban'] },
    { name: 'iban: FR with letters inside the account', texts: [page('IBAN FR14 2004 1010 0505 0001 3M02 606')], expect: ['iban'] },
    { name: 'iban: ES', texts: [page('IBAN ES91 2100 0418 4502 0005 1332')], expect: ['iban'] },
    // --- UK sort code near an 8-digit account number
    { name: 'sort code + account: hyphenated, labelled, on two lines', texts: [page(lines('Sort code: 40-47-84', 'Account number: 12345678'))], expect: ['sort-code-account'] },
    { name: 'sort code + account: spaced sort code', texts: [page('Sort Code 20 00 00    Acc No 55779911')], expect: ['sort-code-account'] },
    { name: 'sort code + account: account first', texts: [page('Account no. 31926819   Sort code 60-16-13')], expect: ['sort-code-account'] },
    // --- National Insurance number
    { name: 'ni-number: spaced pairs', texts: [page('National Insurance number: AB 12 34 56 C')], expect: ['ni-number'] },
    { name: 'ni-number: compact', texts: [page('NINO JG103759A')], expect: ['ni-number'] },
    { name: 'ni-number: other valid prefix', texts: [page('NI number CE 98 76 54 D')], expect: ['ni-number'] },
    // --- US Social Security number
    { name: 'ssn: labelled', texts: [page('Social Security Number: 512-48-3917')], expect: ['ssn'] },
    { name: 'ssn: bare in a form line', texts: [page('Employee SSN 513-90-4821   Employer EIN 12-3456789')], expect: ['ssn'] },
    // --- UK Unique Taxpayer Reference
    { name: 'utr: grouped 5+5', texts: [page('UTR: 12345 67890')], expect: ['utr'] },
    { name: 'utr: spelled out, compact', texts: [page('Your Unique Taxpayer Reference 1234567890')], expect: ['utr'] },
    // --- passport machine-readable lines (ICAO 9303 TD3 specimen)
    {
      name: 'passport-line: the ICAO specimen, both lines',
      texts: [page(lines('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'))],
      expect: ['passport-line'],
    },
    // --- IATA boarding-pass barcode text
    { name: 'boarding-pass: BCBP string', texts: [page('M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100')], expect: ['boarding-pass'] },
    // --- several kinds in one document
    {
      name: 'two kinds: IBAN and NI number',
      texts: [page('IBAN GB82 WEST 1234 5698 7654 32'), page('National Insurance number AB 12 34 56 C')],
      expect: ['iban', 'ni-number'],
    },
    {
      name: 'three kinds: card, ssn, boarding pass',
      texts: [page('Card 4111 1111 1111 1111'), page('SSN 512-48-3917'), page('M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100')],
      expect: ['boarding-pass', 'card', 'ssn'],
    },
  ];

  it.each(rows)('$name', ({ texts, expect: want }) => {
    expect(kinds(texts)).toEqual([...want].sort());
  });
});

describe('detectHardBlocks: near-misses must NOT fire (plan S1: arXiv ids, DOIs, ISBNs, page numbers, number-heavy tables)', () => {
  const rows: Row[] = [
    // --- the ones the plan names
    { name: 'arXiv ids, new style', texts: [page('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023   arXiv:2301.12345v2   arXiv:1512.03385')], expect: [] },
    { name: 'arXiv id, old style', texts: [page('arXiv:hep-th/9901001v3   math.AG/0309136')], expect: [] },
    { name: 'DOIs with long digit runs', texts: [page(lines('https://doi.org/10.1371/journal.pone.0000308', 'doi:10.1016/j.jfineco.2019.05.001', '10.1007/978-3-319-24574-4_28', '10.1109/TPAMI.2018.2844175', '10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM779>3.0.CO;2-N'))], expect: [] },
    { name: 'ISBN-13, hyphenated and bare', texts: [page(lines('ISBN 978-0-306-40615-7', 'ISBN: 9783161484100', 'ISBN 978 1 4028 9462 6'))], expect: [] },
    { name: 'ISBN-10 (ten digits, must not be read as a UTR)', texts: [page('ISBN-10: 0-306-40615-2   ISBN 0306406152')], expect: [] },
    { name: 'ISSN and page ranges', texts: [page('ISSN 1234-5679   pp. 1021-1034   vol. 17(8)')], expect: [] },
    { name: 'a page-number column (1 to 300, one per line)', texts: [Array.from({ length: 300 }, (_, i) => String(i + 1)).join('\r\n')], expect: [] },
    { name: 'a contents list with dotted leaders', texts: [page(lines('1 Introduction ........ 1', '2 Background ........ 15', '3 Method ........ 42', '4 Results ........ 109', 'Index ........ 1021'))], expect: [] },
    { name: 'a wide table of small numbers (60 rows x 9 columns)', texts: [numberTable(60, 9)], expect: [] },
    { name: 'big money figures with thousands separators', texts: [page('GDP 4,111,111,111,111,111   Population 7,794,798,739   Debt $23,451,002,311.40')], expect: [] },
    // --- wrong checksum or shape
    { name: 'card shape, wrong Luhn checksum', texts: [page('Card number 4111 1111 1111 1112')], expect: [] },
    { name: 'card shape, wrong Luhn (Mastercard)', texts: [page('5555 5555 5555 4445')], expect: [] },
    { name: 'card shape, valid Luhn but no card prefix', texts: [page('Reference 1234 5678 9012 3452   Batch 0000 0000 0000 0000')], expect: [] },
    { name: 'a valid card number buried in a longer digit run', texts: [page('Tracking 00004111111111111111   Barcode 411111111111111199')], expect: [] },
    { name: 'IBAN shape, wrong checksum', texts: [page('IBAN GB82 WEST 1234 5698 7654 33   DE89 3704 0044 0532 0130 01')], expect: [] },
    { name: 'IBAN shape, truncated', texts: [page('IBAN GB82 WEST 1234 5698 7654')], expect: [] },
    { name: 'a part number that only looks like an IBAN', texts: [page('Part AB12CDEF1234567890   Order XY99 ZZZZ 0000 1111')], expect: [] },
    // --- sort code / account need both halves, close together
    { name: 'a sort code with no account number', texts: [page('Sort code: 40-47-84')], expect: [] },
    { name: 'an 8-digit account number with no sort code', texts: [page('Account number: 12345678')], expect: [] },
    { name: 'a dd-dd-dd date and an 8-digit reference are not a sort code and account', texts: [page('Meeting on 12-03-24. Reference 20240312.')], expect: [] },
    { name: 'sort code and account number pages apart', texts: [page('Sort code 40-47-84'), FILLER_PAGE, FILLER_PAGE, FILLER_PAGE, page('Account number 12345678')], expect: [] },
    // --- NI number shape
    { name: 'NI-like without the suffix letter', texts: [page('Ref AB 12 34 56')], expect: [] },
    { name: 'NI-like with a suffix outside A-D', texts: [page('Part XY 12 34 56 Z')], expect: [] },
    { name: 'NI-like inside a longer code', texts: [page('Serial XAB123456CX')], expect: [] },
    // --- SSN shape
    { name: 'SSN-like with an impossible area or group or serial', texts: [page(lines('000-12-3456', '666-12-3456', '900-12-3456', '123-00-4567', '123-45-0000'))], expect: [] },
    { name: 'SSN-like longer hyphenated numbers', texts: [page('Order 1234-56-7890   Code 123-45-67890')], expect: [] },
    { name: 'a form placeholder', texts: [page('Social security number XXX-XX-XXXX')], expect: [] },
    // --- UTR needs its label
    { name: 'ten digits with no UTR label (an NHS number)', texts: [page('NHS number 943 476 5919   Tel 0207 946 0958')], expect: [] },
    { name: 'UTR label with the wrong number of digits', texts: [page('UTR 123456789   UTR 12345678901')], expect: [] },
    // --- passport line and boarding pass shapes
    { name: 'a separator made of "<" is not a passport line', texts: [page('<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<')], expect: [] },
    { name: 'a 44-character upper-case code with no MRZ structure', texts: [page('A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0U1V2')], expect: [] },
    { name: '"M1" in running text', texts: [page('Traffic on the M1 was slow. The M1 Pro chip and the M2 chip; Module M1: Introduction.')], expect: [] },
    // --- nothing at all
    { name: 'ordinary prose', texts: [FILLER_PAGE, FILLER_PAGE], expect: [] },
    { name: 'no text', texts: [], expect: [] },
    { name: 'empty and whitespace pages', texts: ['', '  \r\n ', ''], expect: [] },
  ];

  it.each(rows)('$name', ({ texts, expect: want }) => {
    expect(kinds(texts)).toEqual(want);
  });
});

describe('detectHardBlocks: keeps kinds only, never the matched text (contract section 5 privacy rule)', () => {
  const secrets = [
    'Card 4111 1111 1111 1111',
    'IBAN GB82 WEST 1234 5698 7654 32',
    lines('Sort code: 40-47-84', 'Account number: 12345678'),
    'National Insurance number AB 12 34 56 C',
    'SSN 512-48-3917',
    'UTR: 12345 67890',
    lines('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'),
    'M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100',
  ];

  it('returns only values of the HardBlock union, and the serialised result holds no digits or names', () => {
    const result = detectHardBlocks(secrets.map(page));
    expect([...new Set(result)].sort()).toEqual([...ALL_HARD_BLOCKS].sort());
    for (const k of result) expect(ALL_HARD_BLOCKS).toContain(k);
    const json = JSON.stringify(result);
    expect(json).not.toMatch(/\d/);
    for (const needle of ['4111', 'WEST', '40-47', '12345678', 'AB 12', '512-48', 'ERIKSSON', 'DESMARAIS', 'L898902']) expect(json).not.toContain(needle);
  });

  it('does not change its input and gives the same answer twice', () => {
    const texts = deepFreeze(secrets.map(page));
    expect(kinds(texts)).toEqual(kinds(texts));
  });
});
