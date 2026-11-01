// Spec-blind tests for classify: the rules, their order, the score's weights and thresholds (Phase 3, slice S2).
//
// Sources:
//   spec, "Learning filter and privacy": the score starts at -1; the rules in order (your choice for this exact file, hard
//     block, deny and allow lists, force save, the score); 3 or more saves, 0 or less does not, between is "not sure";
//     scans with no text are never saved automatically; the weight table.
//   contract section 5: FilterInput, FilterDecision, FilterRules, FilterRule, the privacy rule, the order of rules.
//   plan S2: "Hard block: a card alone, or any two others, unless positive evidence is 8 or more. A scan with no text is never
//     saved by score: unsure from scholarly or course pages, else not-learning with rule no-text. ... non-English headings
//     (Resume, Zusammenfassung, Literaturverzeichnis, Bibliographie). Reasons are fixed plain-words labels ... The first
//     reason of a not-learning verdict is a 'looks like ...' phrase."
//   research 04 B.2/B.3 for what a "heading", an "admin term group" and "positive evidence" are.
//
// Every score row builds its input from neutral filler (see filter-kit.ts) so the expected score is the starting -1 plus the
// ONE weight under test. I cross-checked these expected numbers against the research prototype on the same texts.
import { describe, expect, it } from 'vitest';
import { ALL_HARD_BLOCKS, FILLER_PAGE, LATEX, SCHOLARLY_URL, deepFreeze, lines, mkInput, rulesOf } from '../../test/spec-blind/filter-kit';
import type { FilterDecision, FilterRules, HardBlock, Spec } from '../../test/spec-blind/filter-kit';
import { classify } from './classify';

const VERDICTS = ['learning', 'not-learning', 'unsure'];
const RULES = ['file-choice', 'hard-block', 'deny-list', 'allow-list', 'force-save', 'score', 'model', 'no-text'];

/** Classifies a frozen input with frozen rules (so a function that writes to either throws) and checks the shape of the answer. */
function run(spec: Spec, rules: Partial<FilterRules> = {}): FilterDecision {
  const d = classify(deepFreeze(mkInput(spec)), deepFreeze(rulesOf(rules)));
  expect(d, 'classify must be synchronous').not.toBeInstanceOf(Promise);
  expect(VERDICTS).toContain(d.verdict);
  if (d.rule !== undefined) expect(RULES).toContain(d.rule);
  expect(Array.isArray(d.reasons)).toBe(true);
  for (const r of d.reasons) {
    expect(typeof r).toBe('string');
    expect(r.trim().length).toBeGreaterThan(0);
    expect(r.length, `reason too long to be a fixed label: ${r}`).toBeLessThanOrEqual(120);
    expect(r).not.toMatch(/[\r\n]/);
  }
  for (const s of d.signals ?? []) {
    expect(typeof s.id).toBe('string');
    expect(Number.isFinite(s.weight)).toBe(true);
    expect(s.label.length).toBeLessThanOrEqual(80);
  }
  for (const k of d.hardBlocks ?? []) expect(ALL_HARD_BLOCKS).toContain(k);
  if (d.rule === 'score' && d.verdict === 'unsure') expect(d.needsModel, 'a not-sure score goes to the model').toBe(true);
  if (d.verdict !== 'unsure') expect(d.needsModel ?? false, 'only a not-sure answer needs the model').toBe(false);
  return d;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text snippets, in the forms PDFium gives them (one line per "\r\n")

const ARXIV_STAMP = 'arXiv:2301.12345v2 [cs.LG] 3 Feb 2023';
const DOI_LINE = 'https://doi.org/10.1371/journal.pone.0000308';
const ABSTRACT = lines('Abstract', 'We describe a small garden and the birds that visit it.');
const REFS = lines('References', 'A. Author. A Title. Journal of Things, 2020.');
const ADMIN_7 = lines('Subtotal', 'VAT', 'Payment method', 'Amount due', 'Boarding pass', 'Net pay', 'Landlord');

const SNIPPET: Record<HardBlock, string> = {
  card: 'Card number 4111 1111 1111 1111',
  iban: 'IBAN GB82 WEST 1234 5698 7654 32',
  'sort-code-account': lines('Sort code: 40-47-84', 'Account number: 12345678'),
  'ni-number': 'National Insurance number AB 12 34 56 C',
  ssn: 'Social Security Number 512-48-3917',
  utr: 'UTR: 12345 67890',
  'passport-line': lines('P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', 'L898902C36UTO7408122F1204159ZE184226B<<<<<10'),
  'boarding-pass': 'M1DESMARAIS/LUC       EABC123 YULFRAAC 0834 326J001A0025 100',
};

// Positive evidence is the sum of the positive weights. These two specs have exactly 6.5 and 9.0 and no hard block:
//   scholarly site +3, 30+ pages +2, LaTeX +1.5  = 6.5  (score 5.5, so a learning paper)
//   the same plus a References heading +2.5      = 9.0  (score 8.0)
const POS_6_5: Spec = { url: SCHOLARLY_URL, pageCount: 30, metadata: LATEX };
const POS_9_0: Spec = { ...POS_6_5, last: REFS };

// ---------------------------------------------------------------------------------------------------------------------
describe('the score: it starts at -1 and each signal moves it by the spec\'s weight', () => {
  it('an unknown PDF with text and nothing else scores -1 and is not learning', () => {
    const d = run({ pageCount: 4 });
    expect(d.score).toBeCloseTo(-1, 5);
    expect(d.verdict).toBe('not-learning');
    expect(d.rule).toBe('score');
  });

  // spec: "Long document: 100+ / 30+ / 8+ pages; 2 or fewer pages: +2.5 / +2 / +1; -1"
  it.each([
    [1, -2],
    [2, -2],
    [3, -1],
    [7, -1],
    [8, 0],
    [29, 0],
    [30, 1],
    [99, 1],
    [100, 1.5],
    [714, 1.5],
  ])('a %i-page document with neutral text scores %f', (pageCount, score) => {
    expect(run({ pageCount }).score).toBeCloseTo(score, 5);
  });

  // spec weight table, one row at a time: [name, spec, score]
  const weights: Array<[string, Spec, number]> = [
    ['arXiv id in the text +4', { first: ARXIV_STAMP }, 3],
    ['arXiv id in the file name +3', { fileName: '2301.12345v2.pdf' }, 2],
    ['arXiv id in text and in the file name add up (+4 +3)', { first: ARXIV_STAMP, fileName: '2301.12345.pdf' }, 6],
    ['References heading +2.5', { last: REFS }, 1.5],
    ['Bibliography heading +2.5', { last: lines('Bibliography', 'A. Author. A Title. Journal of Things, 2020.') }, 1.5],
    ['Literaturverzeichnis heading +2.5 (research B.9)', { last: lines('Literaturverzeichnis', 'A. Autor. Ein Titel. Zeitschrift, 2020.') }, 1.5],
    ['Bibliographie heading +2.5 (research B.9)', { last: lines('Bibliographie', 'A. Auteur. Un titre. Revue, 2020.') }, 1.5],
    ['REFERENCES in capitals +2.5 (IEEE style)', { last: lines('REFERENCES', 'A. Author. A Title. Journal of Things, 2020.') }, 1.5],
    ['a numbered heading "6. References" +2.5', { last: lines('6. References', 'A. Author. A Title. Journal of Things, 2020.') }, 1.5],
    ['a References heading with trailing spaces and a no-break space +2.5', { last: lines('References \u00a0 ', 'A. Author. A Title. Journal of Things, 2020.') }, 1.5],
    ['Abstract heading +2', { first: ABSTRACT }, 1],
    ['ABSTRACT in capitals +2', { first: lines('ABSTRACT', 'We describe a small garden and the birds that visit it.') }, 1],
    ['Zusammenfassung heading +2 (research B.9)', { first: lines('Zusammenfassung', 'Wir beschreiben einen kleinen Garten und seine Voegel.') }, 1],
    ['Resume heading +2 (research B.9)', { first: lines('Résumé', 'Nous décrivons un petit jardin et ses oiseaux.') }, 1],
    ['DOI +2', { first: DOI_LINE }, 1],
    ['DOI written "DOI: 10.1038/..." +2', { first: 'DOI: 10.1038/s41586-021-03819-2' }, 1],
    ['thesis wording +2', { first: 'Submitted in partial fulfilment of the requirements for the degree of Doctor of Philosophy' }, 1],
    ['ISBN +1.5', { first: 'ISBN 978-0-306-40615-7' }, 0.5],
    ['Chapter n +1.5', { first: 'Chapter 1' }, 0.5],
    ['Lecture n +1.5', { first: 'Lecture 3' }, 0.5],
    ['Contents +1.5', { first: 'Contents' }, 0.5],
    ['LaTeX producer (pdfTeX) +1.5', { metadata: { producer: 'pdfTeX-1.40.25' } }, 0.5],
    ['LaTeX producer (XeTeX) +1.5', { metadata: { producer: 'XeTeX 0.999994' } }, 0.5],
    ['LaTeX producer (LuaTeX) +1.5', { metadata: { producer: 'LuaTeX-1.15.0' } }, 0.5],
    ['one admin term group -1', { first: 'Subtotal' }, -2],
    ['the same admin group over and over still counts once', { first: lines('Subtotal', 'Subtotal', 'Subtotal: see subtotal', 'SUBTOTAL') }, -2],
    ['three admin term groups -3', { first: lines('Subtotal', 'VAT', 'Payment method') }, -4],
    ['admin term groups stop at -5', { first: ADMIN_7 }, -6],
    ['receipt-roll page shape -2', { pageSize: { width: 222, height: 1046 } }, -3],
    ['XFA form (full) -2', { formType: 'xfa-full' }, -3],
    ['XFA form (foreground) -2', { formType: 'xfa-foreground' }, -3],
    ['invoice-generator software (wkhtmltopdf) -1', { metadata: { producer: 'wkhtmltopdf 0.12.5' } }, -2],
    ['invoice-generator software (TCPDF) -1', { metadata: { producer: 'TCPDF 6.0.023 (http://www.tcpdf.org)' } }, -2],
    ['lots of currency amounts -3', { first: Array.from({ length: 40 }, (_, i) => `£${(i + 1) * 3}.50`).join(' ') }, -4],
    ['a scholarly site (arXiv) +3', { url: SCHOLARLY_URL }, 2],
    ['a university domain (.ac.uk) +1', { url: 'https://www.example.ac.uk/files/x.pdf' }, 0],
    ['a university domain (.edu) +1', { url: 'https://www.example.edu/files/x.pdf' }, 0],
    ['a bank site -4', { url: 'https://www.barclays.co.uk/documents/abc.pdf' }, -5],
    ['a payment site -4', { url: 'https://www.paypal.com/documents/abc.pdf' }, -5],
    ['"receipt" in the link path -2', { url: 'https://shop.example.com/receipt/123.pdf' }, -3],
  ];
  it.each(weights)('%s', (_name, spec, score) => {
    expect(run({ pageCount: 4, ...spec }).score).toBeCloseTo(score, 5);
  });

  it('a slide-deck page shape (16:9 or 4:3, 10 or more pages) adds +1; fewer pages do not', () => {
    const portrait12 = run({ pageCount: 12 }).score;
    const deck169 = run({ pageCount: 12, pageSize: { width: 720, height: 405 } }).score;
    const deck43 = run({ pageCount: 12, pageSize: { width: 720, height: 540 } }).score;
    const short9 = run({ pageCount: 9, pageSize: { width: 720, height: 405 } }).score;
    expect(deck169! - portrait12!).toBeCloseTo(1, 5);
    expect(deck43! - portrait12!).toBeCloseTo(1, 5);
    expect(short9).toBeCloseTo(run({ pageCount: 9 }).score!, 5);
  });

  it.each([
    ['link.springer.com', 'https://link.springer.com/content/pdf/article.pdf'],
    ['www.jstor.org', 'https://www.jstor.org/stable/pdf/article.pdf'],
    ['papers.ssrn.com', 'https://papers.ssrn.com/sol3/Delivery.cfm/paper.pdf'],
    ['www.nber.org', 'https://www.nber.org/system/files/working_papers/paper.pdf'],
    ['www.sciencedirect.com', 'https://www.sciencedirect.com/science/article/pdfft'],
    ['openstax.org', 'https://openstax.org/books/principles-economics-3e/pdf'],
  ])('%s is a scholarly site (+3), so a neutral document scores 2', (_host, url) => {
    expect(run({ pageCount: 4, url }).score).toBeCloseTo(2, 5);
  });

  it.each([
    'https://arxiv.org.evil.example/pdf/example-paper',
    'https://notarxiv.org/pdf/example-paper',
    'https://evil.example/arxiv.org/pdf/example-paper',
    'https://evil.example/pdf?from=https://arxiv.org/abs/example-paper',
  ])('a look-alike address earns no scholarly credit: %s', (url) => {
    expect(run({ pageCount: 4, url }).score).toBeCloseTo(-1, 5);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('thresholds: 3 or more saves, 0 or less does not, in between is "not sure" and asks the model', () => {
  type Row = { name: string; spec: Spec; score: number; verdict: 'learning' | 'not-learning' | 'unsure' };
  const rows: Row[] = [
    { name: 'score -1', spec: { pageCount: 4 }, score: -1, verdict: 'not-learning' },
    { name: 'score 0 exactly does not save', spec: { pageCount: 8 }, score: 0, verdict: 'not-learning' },
    { name: 'score 0.5 is not sure', spec: { pageCount: 4, metadata: LATEX }, score: 0.5, verdict: 'unsure' },
    { name: 'score 1.5 is not sure', spec: { pageCount: 100 }, score: 1.5, verdict: 'unsure' },
    { name: 'score 2 is not sure', spec: { pageCount: 4, url: SCHOLARLY_URL }, score: 2, verdict: 'unsure' },
    { name: 'score 2.5 is not sure (just under)', spec: { pageCount: 30, metadata: LATEX }, score: 2.5, verdict: 'unsure' },
    { name: 'score 3 exactly saves', spec: { pageCount: 8, url: SCHOLARLY_URL }, score: 3, verdict: 'learning' },
    { name: 'score 3 exactly saves (pages and LaTeX)', spec: { pageCount: 100, metadata: LATEX }, score: 3, verdict: 'learning' },
    { name: 'score 3.5 saves', spec: { pageCount: 4, url: SCHOLARLY_URL, metadata: LATEX }, score: 3.5, verdict: 'learning' },
    { name: 'an arXiv id alone saves (score 3)', spec: { pageCount: 4, first: ARXIV_STAMP }, score: 3, verdict: 'learning' },
    { name: 'a bank site drags a 120-page LaTeX document from 3 down to -1', spec: { pageCount: 120, metadata: LATEX, url: 'https://www.barclays.co.uk/documents/abc.pdf' }, score: -1, verdict: 'not-learning' },
  ];
  it.each(rows)('$name', ({ spec, score, verdict }) => {
    const d = run(spec);
    expect(d.score).toBeCloseTo(score, 5);
    expect(d.verdict).toBe(verdict);
    expect(d.rule).toBe('score');
    expect(d.reasons.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('rule order: your choice, hard block, lists, force save, score', () => {
  const card = SNIPPET.card;

  describe('1. your choice for this exact file comes first', () => {
    it.each([
      ['never beats a strong paper', POS_9_0, { fileChoice: 'never' as const }, 'not-learning'],
      ['never beats an allow-list match', { ...POS_9_0 }, { fileChoice: 'never' as const, allow: ['arxiv.org'] }, 'not-learning'],
      ['never beats force save', { first: ARXIV_STAMP, last: REFS }, { fileChoice: 'never' as const }, 'not-learning'],
      ['save beats a card number (default D9: you may save a hard-blocked PDF)', { ...POS_6_5, first: card }, { fileChoice: 'save' as const }, 'learning'],
      ['save beats a deny-list match', { pageCount: 4, url: 'https://shop.example.com/a.pdf' }, { fileChoice: 'save' as const, deny: ['shop.example.com'] }, 'learning'],
      ['save beats a bank site and an invoice', { pageCount: 1, url: 'https://www.barclays.co.uk/statements/x.pdf', first: ADMIN_7 }, { fileChoice: 'save' as const }, 'learning'],
      ['save beats "scan with no text"', { pageCount: 3, sampleText: ['', '', ''] }, { fileChoice: 'save' as const }, 'learning'],
      ['never beats "scholarly site with no text"', { pageCount: 3, url: SCHOLARLY_URL, sampleText: ['', '', ''] }, { fileChoice: 'never' as const }, 'not-learning'],
    ])('%s', (_name, spec, rules, verdict) => {
      const d = run(spec, rules);
      expect(d.verdict).toBe(verdict);
      expect(d.rule).toBe('file-choice');
    });

    it('no stored choice (null) changes nothing', () => {
      expect(run(POS_6_5, { fileChoice: null })).toEqual(run(POS_6_5));
    });
  });

  // DECIDED (spec, "Decided while building the filter"): "Your own choice to save always wins (D9). This holds even over a card
  // or bank-number block. A warning shows, and the file's text is not indexed." The warning and the indexing switch live in the
  // save controller; what the filter can do is save, say it was the owner's choice, and keep naming the blocked KINDS (never
  // the numbers) so the controller knows to warn and to switch indexing off. That last part is my reading (guess).
  describe('1b. your own save wins over a hard block (D9)', () => {
    const cases: Array<[string, HardBlock[]]> = [
      ['a card number', ['card']],
      ['an IBAN with a sort code and account', ['iban', 'sort-code-account']],
      ['a National Insurance number with a UTR', ['ni-number', 'utr']],
      ['a passport line with a boarding-pass code', ['passport-line', 'boarding-pass']],
      ['every kind at once', [...ALL_HARD_BLOCKS]],
    ];

    it.each(cases)('%s: saved by choice', (_name, kinds) => {
      const spec: Spec = { pageCount: 3, first: kinds.map((k) => SNIPPET[k]).join('\r\n') };
      const without = run(spec);
      expect([without.verdict, without.rule], 'without the choice it is blocked').toEqual(['not-learning', 'hard-block']);
      const d = run(spec, { fileChoice: 'save' });
      expect([d.verdict, d.rule]).toEqual(['learning', 'file-choice']);
      expect(d.reasons.length).toBeGreaterThan(0);
    });

    it.each(cases)('%s: the decision still names the blocked kinds (so the warning shows and indexing stays off), and holds no number', (_name, kinds) => {
      const d = run({ pageCount: 3, first: kinds.map((k) => SNIPPET[k]).join('\r\n') }, { fileChoice: 'save' });
      expect(d.hardBlocks ?? []).toEqual(expect.arrayContaining(kinds));
      expect(JSON.stringify(d)).not.toMatch(/\d{4}|WEST|ERIKSSON|DESMARAIS/);
    });

    it('a document with no hard block does not carry the warning kinds', () => {
      const d = run({ pageCount: 3 }, { fileChoice: 'save' });
      expect([d.verdict, d.rule]).toEqual(['learning', 'file-choice']);
      expect(d.hardBlocks ?? []).toEqual([]);
    });

    it('your choice never to save still wins over everything, including a strong paper', () => {
      const d = run(POS_9_0, { fileChoice: 'never', allow: ['arxiv.org'] });
      expect([d.verdict, d.rule]).toEqual(['not-learning', 'file-choice']);
    });
  });

  describe('2. a hard block comes before the lists, force save and the score', () => {
    it('a card number blocks a paper that would score as learning', () => {
      const d = run({ ...POS_6_5, first: card });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
      expect(d.hardBlocks).toContain('card');
      expect(d.reasons[0]).toMatch(/card or bank numbers/i);
    });

    it('hard block beats the allow list ("Always for this site" cannot save a card number)', () => {
      const d = run({ ...POS_6_5, first: card }, { allow: ['arxiv.org'] });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
    });

    it('hard block beats the deny list in the rule label (the first rule that applies decides)', () => {
      const d = run({ ...POS_6_5, first: card }, { deny: ['arxiv.org'] });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
    });

    it('hard block beats force save when positive evidence is under 8', () => {
      // arXiv id +4 and References +2.5 = 6.5 of positive evidence, and force save would apply.
      const d = run({ pageCount: 4, first: `${ARXIV_STAMP}${'\r\n'}${card}`, last: REFS });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
    });

    it('a hard-blocked document is never "not sure": it is not-learning outright', () => {
      const d = run({ pageCount: 4, first: card });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
    });
  });

  describe('3. deny and allow lists come before force save and the score', () => {
    it('a deny-list match beats force save', () => {
      const d = run({ url: SCHOLARLY_URL, first: ARXIV_STAMP, last: REFS }, { deny: ['arxiv.org'] });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('deny-list');
    });

    it('a deny-list match beats a high score', () => {
      const d = run({ pageCount: 100, metadata: LATEX, url: 'https://courses.example.org/week1.pdf' }, { deny: ['courses.example.org'] });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('deny-list');
    });

    it('an allow-list match saves a document the score would not (an unsure one)', () => {
      const d = run({ pageCount: 4, metadata: LATEX, url: 'https://readings.example.org/a.pdf' }, { allow: ['readings.example.org'] });
      expect(d.verdict).toBe('learning');
      expect(d.rule).toBe('allow-list');
    });

    it('an allow-list match saves a document the score would reject (no hard block)', () => {
      const d = run({ pageCount: 1, first: lines('Subtotal', 'VAT', 'Payment method'), url: 'https://shop.example.com/a.pdf' }, { allow: ['shop.example.com'] });
      expect(d.verdict).toBe('learning');
      expect(d.rule).toBe('allow-list');
    });

    // GUESS (research B.7: "per-file decision > deny > allow > classifier"): when both lists match, deny wins.
    it('when a link is on both lists, deny wins', () => {
      const d = run({ pageCount: 100, metadata: LATEX, url: 'https://courses.example.org/week1.pdf' }, { deny: ['courses.example.org'], allow: ['courses.example.org'] });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('deny-list');
    });

    it('an empty or non-matching list changes nothing', () => {
      expect(run(POS_6_5, { deny: ['example.com'], allow: ['other.example.org'] })).toEqual(run(POS_6_5));
    });
  });

  describe('4. force save comes before the score', () => {
    it('an arXiv id plus a References section saves, and says which rule did it', () => {
      const d = run({ pageCount: 4, first: ARXIV_STAMP, last: REFS });
      expect(d.verdict).toBe('learning');
      expect(d.rule).toBe('force-save');
      expect(d.forceSave).toBe('arxiv+references');
    });

    it('a DOI plus an Abstract plus References saves', () => {
      const d = run({ pageCount: 4, first: lines(ABSTRACT, DOI_LINE), last: REFS });
      expect(d.verdict).toBe('learning');
      expect(d.rule).toBe('force-save');
      expect(d.forceSave).toBe('doi+abstract+references');
    });

    it('force save works with PDFium\'s "\\r\\n" line ends and with plain "\\n"', () => {
      for (const eol of ['\r\n', '\n']) {
        const d = run({ pageCount: 4, first: ARXIV_STAMP, last: ['References', 'A. Author. A Title.'].join(eol) });
        expect(d.rule, `eol ${JSON.stringify(eol)}`).toBe('force-save');
      }
    });

    it('force save overrules admin terms that would pull the score under 3', () => {
      // -1 +4 +2.5 and -5 for seven admin groups = 0.5, which the score alone would call not sure.
      const d = run({ pageCount: 4, first: `${ARXIV_STAMP}${'\r\n'}${ADMIN_7}`, last: REFS });
      expect(d.verdict).toBe('learning');
      expect(d.rule).toBe('force-save');
    });

    it('an arXiv id without a References section is not force save (it is just the score)', () => {
      const d = run({ pageCount: 4, first: ARXIV_STAMP });
      expect(d.verdict).toBe('learning'); // -1 + 4 = 3
      expect(d.rule).toBe('score');
      expect(d.forceSave ?? null).toBeNull();
    });

    it('a DOI plus References without an Abstract is not force save', () => {
      const d = run({ pageCount: 4, first: DOI_LINE, last: REFS });
      expect(d.rule).toBe('score'); // -1 + 2 + 2.5 = 3.5, saved by the score
      expect(d.forceSave ?? null).toBeNull();
    });

    it('a document with neither leg is left to the score', () => {
      const d = run({ pageCount: 4, first: 'Contents' });
      expect(d.rule).toBe('score');
    });
  });

  describe('positive evidence of 8 or more overrides a hard block (spec: "such as a paper quoting an example IBAN")', () => {
    it('two kinds with 6.5 of evidence block', () => {
      const d = run({ ...POS_6_5, first: `${SNIPPET.iban}${'\r\n'}${SNIPPET['ni-number']}` });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
      expect(d.hardBlocks).toEqual(expect.arrayContaining(['iban', 'ni-number']));
    });

    it('two kinds with 9.0 of evidence do not block: the paper is saved', () => {
      const d = run({ ...POS_9_0, first: `${SNIPPET.iban}${'\r\n'}${SNIPPET['ni-number']}` });
      expect(d.verdict).toBe('learning');
      expect(d.rule).not.toBe('hard-block');
    });

    it('exactly 8.0 overrides (3 site + 2 pages + 1.5 LaTeX + 1.5 Chapter)', () => {
      const d = run({ ...POS_6_5, first: lines('Chapter 1', SNIPPET.iban, SNIPPET['ni-number']) });
      expect(d.verdict).toBe('learning');
      expect(d.rule).not.toBe('hard-block');
    });

    it('7.5 does not override (3 site + 2 pages + 1.5 LaTeX + 1 slide-deck shape)', () => {
      const d = run({ ...POS_6_5, pageSize: { width: 720, height: 405 }, first: lines(SNIPPET.iban, SNIPPET['ni-number']) });
      expect(d.verdict).toBe('not-learning');
      expect(d.rule).toBe('hard-block');
    });

    it('a paper with an arXiv id, References, an arXiv file name and an example IBAN plus NI number is saved by force save', () => {
      // 4 + 3 + 2.5 = 9.5 of positive evidence
      const d = run({ pageCount: 4, fileName: '2301.12345.pdf', first: lines(ARXIV_STAMP, SNIPPET.iban, SNIPPET['ni-number']), last: REFS });
      expect(d.verdict).toBe('learning');
      expect(d.rule).toBe('force-save');
    });

    // SPEC WORDING: the spec says "Only positive evidence of 8 or more on its own overrides it" about the whole hard-block
    // rule (card included); contract section 5 and plan S2 can be read as "a card alone blocks" with the override on the
    // others only. I follow the spec and the research prototype (veto unless pos >= 8, for card and ids alike).
    it('a card number in a paper with 9.0 of evidence does not block (spec reading)', () => {
      const d = run({ ...POS_9_0, first: SNIPPET.card });
      expect(d.verdict).toBe('learning');
      expect(d.rule).not.toBe('hard-block');
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the hard-block rule: a card alone, or any two of the others', () => {
  const NON_CARD = ALL_HARD_BLOCKS.filter((k): k is Exclude<HardBlock, 'card'> => k !== 'card');
  const pairs: Array<[HardBlock, HardBlock]> = NON_CARD.flatMap((a, i) => NON_CARD.slice(i + 1).map((b): [HardBlock, HardBlock] => [a, b]));

  it('there are 21 pairs of the seven non-card kinds', () => expect(pairs).toHaveLength(21));

  it('a card number alone blocks', () => {
    const d = run({ ...POS_6_5, first: SNIPPET.card });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'hard-block']);
  });

  it.each(NON_CARD)('%s alone does NOT block (a learning paper that mentions one is still saved)', (kind) => {
    const d = run({ ...POS_6_5, first: SNIPPET[kind] });
    expect(d.verdict, `${kind} alone`).toBe('learning');
    expect(d.rule).toBe('score');
  });

  it.each(pairs)('%s together with %s blocks', (a, b) => {
    const d = run({ ...POS_6_5, first: `${SNIPPET[a]}${'\r\n'}${SNIPPET[b]}` });
    expect([d.verdict, d.rule], `${a} + ${b}`).toEqual(['not-learning', 'hard-block']);
    expect(d.hardBlocks).toEqual(expect.arrayContaining([a, b]));
  });

  it('the same kind twice is still one kind (two SSNs do not make a pair)', () => {
    const d = run({ ...POS_6_5, first: lines(SNIPPET.ssn, 'Spouse Social Security Number 513-90-4821') });
    expect(d.verdict).toBe('learning');
  });

  it('a hard block names its kinds and nothing else; the first reason is the plain-words label', () => {
    const d = run({ pageCount: 3, first: lines(SNIPPET.iban, SNIPPET['sort-code-account']) });
    expect(d.hardBlocks).toEqual(expect.arrayContaining(['iban', 'sort-code-account']));
    expect(d.reasons[0]).toMatch(/card or bank numbers/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('lists match hosts and folder prefixes properly (a look-alike address never matches)', () => {
  type Row = { name: string; entry: string; url: string | null; fileName?: string; match: boolean };
  const rows: Row[] = [
    { name: 'host entry matches a link on that host', entry: 'moodle.lse.ac.uk', url: 'https://moodle.lse.ac.uk/pluginfile.php/1/mod_resource/content/1/file.pdf', match: true },
    { name: 'a host entry typed in capitals still matches (guess)', entry: 'Moodle.LSE.ac.uk', url: 'https://moodle.lse.ac.uk/pluginfile.php/1/mod_resource/content/1/file.pdf', match: true },
    { name: 'host entry does not match a longer host that starts with it', entry: 'moodle.lse.ac.uk', url: 'https://moodle.lse.ac.uk.evil.example/f.pdf', match: false },
    { name: 'host entry does not match a host that merely ends the same way', entry: 'moodle.lse.ac.uk', url: 'https://notmoodle.lse.ac.uk/f.pdf', match: false },
    { name: 'host entry does not match the host written in a query string', entry: 'moodle.lse.ac.uk', url: 'https://evil.example/?next=https://moodle.lse.ac.uk/f.pdf', match: false },
    { name: 'host entry does not match the host written in the path', entry: 'moodle.lse.ac.uk', url: 'https://evil.example/moodle.lse.ac.uk/f.pdf', match: false },
    { name: 'host entry does not match the host written after #', entry: 'moodle.lse.ac.uk', url: 'https://evil.example/f.pdf#moodle.lse.ac.uk', match: false },
    { name: 'host entry does not match a file name', entry: 'moodle.lse.ac.uk', url: null, fileName: 'moodle.lse.ac.uk.pdf', match: false },
    { name: 'folder prefix (web) matches a file inside it', entry: 'https://example.org/readings/', url: 'https://example.org/readings/week1.pdf', match: true },
    { name: 'folder prefix (web) does not match a sibling folder that starts the same', entry: 'https://example.org/readings/', url: 'https://example.org/readings-private/x.pdf', match: false },
    { name: 'folder prefix (web) does not match the same path on another host', entry: 'https://example.org/readings/', url: 'https://evil.example/readings/x.pdf', match: false },
    { name: 'folder prefix (web) does not match the same words deeper in another path', entry: 'https://example.org/readings/', url: 'https://example.org/other/readings/x.pdf', match: false },
    { name: 'folder prefix (file) matches a file inside it', entry: 'file:///C:/Users/me/Readings/', url: 'file:///C:/Users/me/Readings/week1.pdf', match: true },
    { name: 'folder prefix (file) does not match a sibling folder', entry: 'file:///C:/Users/me/Readings/', url: 'file:///C:/Users/me/Receipts/a.pdf', match: false },
    { name: 'folder prefix (file) does not match a folder that starts the same', entry: 'file:///C:/Users/me/Readings/', url: 'file:///C:/Users/me/Readings-old/a.pdf', match: false },
  ];

  // the allow list saves a document the score would not
  it.each(rows)('allow: $name', ({ entry, url, fileName, match }) => {
    const d = run({ pageCount: 4, url, ...(fileName ? { fileName } : {}) }, { allow: [entry] });
    if (match) {
      expect([d.verdict, d.rule]).toEqual(['learning', 'allow-list']);
    } else {
      expect(d.rule).not.toBe('allow-list');
    }
  });

  // the deny list stops a document the score would save (100 pages + LaTeX = score 3)
  it.each(rows)('deny: $name', ({ entry, url, fileName, match }) => {
    const d = run({ pageCount: 100, metadata: LATEX, url, ...(fileName ? { fileName } : {}) }, { deny: [entry] });
    if (match) {
      expect([d.verdict, d.rule]).toEqual(['not-learning', 'deny-list']);
    } else {
      expect(d.rule).not.toBe('deny-list');
    }
  });

  it('a link that is null never matches a list (a PDF opened from a file picker or a blob)', () => {
    const d = run({ pageCount: 4, url: null }, { allow: ['moodle.lse.ac.uk'], deny: ['example.org'] });
    expect(d.rule).toBe('score');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('scans with no text are never saved by score', () => {
  const blank = (n: number) => Array.from({ length: Math.min(n, 10) }, () => '');
  const SCHOLARLY = SCHOLARLY_URL;
  const COURSE = 'https://moodle.lse.ac.uk/pluginfile.php/1/mod_resource/content/1/file.pdf';

  it('from an unknown site: not-learning, rule no-text', () => {
    const d = run({ pageCount: 12, sampleText: blank(12), url: 'https://example.com/scan.pdf', fileName: 'scan.pdf' });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'no-text']);
  });

  it('with no link at all (a file picked from disk): not-learning, rule no-text', () => {
    const d = run({ pageCount: 12, sampleText: blank(12), url: null });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'no-text']);
  });

  it.each([
    ['a scholarly site', { url: SCHOLARLY }],
    ['a course page (an LMS link)', { url: COURSE }],
    ['a course page the file was linked from', { url: 'https://example.com/scan.pdf', viaPage: 'https://moodle.lse.ac.uk/course/view.php?id=1234' }],
  ])('from %s: unsure (the chip asks), rule no-text, and no model run (there is no text to compare)', (_name, extra) => {
    const d = run({ pageCount: 12, sampleText: blank(12), ...extra });
    expect([d.verdict, d.rule]).toEqual(['unsure', 'no-text']);
    expect(d.needsModel ?? false).toBe(false);
  });

  it('whitespace, line breaks and control characters count as no text', () => {
    const d = run({ pageCount: 5, sampleText: ['\r\n \r\n', ' \t ', '\u0000\u0000', '', '\u00a0\r\n'], url: 'https://example.com/scan.pdf' });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'no-text']);
  });

  // DECIDED (spec, second look): after the extra middle pages are sampled the no-text rule applies to the whole sample. The sampler
  // does the looking; classify only ever sees the final sampleText (up to 20 entries), so it must judge that.
  it('a long scan whose middle pages were sampled too and are blank is still a scan (20 blank entries)', () => {
    const d = run({ pageCount: 192, sampleText: Array.from({ length: 20 }, () => ''), url: 'https://example.com/scan.pdf' });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'no-text']);
  });

  it('a long deck whose edge pages are images but whose middle pages hold text is judged on that text, not as a scan', () => {
    const sampleText = [...blank(5), ...Array.from({ length: 10 }, () => FILLER_PAGE), ...blank(5)];
    const d = run({ pageCount: 192, pageSize: { width: 720, height: 405 }, sampleText, url: 'https://example.com/lecture0.pdf' });
    expect(d.rule).toBe('score');
    expect(d.verdict).toBe('unsure'); // -1 +2.5 (100+ pages) +1 (slide-deck shape) = 2.5
    expect(d.score).toBeCloseTo(2.5, 5);
    expect(d.needsModel).toBe(true);
  });

  it('the same long scan with a few words of text on one middle page is still too little to judge', () => {
    const sampleText = [...blank(5), 'Slide 7', ...Array.from({ length: 9 }, () => ''), ...blank(5)];
    const d = run({ pageCount: 192, pageSize: { width: 720, height: 405 }, sampleText, url: 'https://example.com/scan.pdf' });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'no-text']);
  });

  it('an empty sample (no pages sampled) counts as no text', () => {
    const d = run({ pageCount: 5, sampleText: [], url: 'https://example.com/scan.pdf' });
    expect([d.verdict, d.rule]).toEqual(['not-learning', 'no-text']);
  });

  it('the score is not used: a 400-page LaTeX scan from a university site with an arXiv file name is still not saved', () => {
    const d = run({ pageCount: 400, sampleText: blank(400), metadata: LATEX, fileName: '2301.12345.pdf', url: 'https://www.example.ac.uk/files/x.pdf' });
    expect(d.verdict).not.toBe('learning');
    expect(d.rule).toBe('no-text');
  });

  it('even an allow-list-free scholarly scan is never "learning" on its own', () => {
    const d = run({ pageCount: 30, sampleText: blank(30), metadata: LATEX, url: SCHOLARLY });
    expect(d.verdict).toBe('unsure');
  });

  it('a hard-blocked document is judged on its text, so a scan has none to block (it stays no-text)', () => {
    const d = run({ pageCount: 2, sampleText: blank(2) });
    expect(d.hardBlocks ?? []).toEqual([]);
  });

  it('a page with a few words of watermark but nothing else is not "a document with text" (never learning)', () => {
    const d = run({ pageCount: 1, sampleText: ['Scanned by CamScanner'], url: 'https://example.com/scan.pdf', fileName: 'scan.pdf' });
    expect(d.verdict).not.toBe('learning');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the chip wording for a not-learning verdict (plan S2)', () => {
  const invoice = lines('Invoice', 'Invoice number: 2026-004711', 'Bill to: Ms A. Student', 'Subtotal £14,660.00', 'VAT £0.00', 'Total amount due £14,660.00', 'Payment method: bank transfer');

  it('the first reason is a "looks like ..." phrase', () => {
    const d = run({ pageCount: 1, first: invoice });
    expect(d.verdict).toBe('not-learning');
    expect(d.reasons[0]).toMatch(/looks like|invoice|receipt/i);
  });

  it('the invoice wording is the plan\'s "an invoice or receipt"', () => {
    const d = run({ pageCount: 1, first: invoice });
    expect(d.reasons[0]).toMatch(/invoice or receipt/i);
  });

  // DECIDED (spec, "Decided while building the filter"): "The first reason of a not-learning verdict is a plain 'looks like ...'
  // phrase for the most specific admin group that matched. For example: 'looks like a tax form', 'an invoice or receipt', 'a bank
  // statement'." So when a file matches a specific group AND the general invoice words, the specific one is named.
  describe('the chip names the most specific group that matched', () => {
    const generic = lines('Invoice', 'Invoice number: 2026-004711', 'Bill to: Ms A. Student', 'Subtotal £14,660.00', 'Total amount due £14,660.00', 'Payment method: bank transfer');
    const specific: Array<[string, string, RegExp]> = [
      ['a tax form', lines('Self Assessment tax return', 'Unique Taxpayer Reference', 'HMRC', 'Internal Revenue Service', 'taxpayer'), /tax form/i],
      ['a payslip', lines('Payslip', 'Gross pay', 'Net pay', 'Deductions', 'PAYE', 'Year to date'), /payslip/i],
      ['a bank statement', lines('Statement date', 'Opening balance', 'Closing balance', 'Direct debit', 'Sort code'), /bank statement/i],
      ['a ticket or boarding pass', lines('Boarding pass', 'Gate A36', 'Seat 14C', 'Flight AK 1996', 'Booking reference (PNR)'), /ticket or boarding pass/i],
      ['a contract', lines('Landlord', 'Tenant', 'hereinafter', 'terms and conditions', 'Signature of Tenant'), /contract/i],
    ];

    it.each(specific)('%s wins over the general invoice wording that is also on the page', (_name, block, wanted) => {
      const d = run({ pageCount: 2, first: lines(block, generic) });
      expect(d.verdict).toBe('not-learning');
      expect(d.reasons[0], JSON.stringify(d.reasons)).toMatch(/looks like|^an? |^has /i);
      expect(d.reasons[0], JSON.stringify(d.reasons)).toMatch(wanted);
      expect(d.reasons[0]).not.toMatch(/invoice or receipt/i);
    });

    it.each(specific)('%s is named on its own as well', (_name, block, wanted) => {
      const d = run({ pageCount: 2, first: block });
      expect(d.verdict).toBe('not-learning');
      expect(d.reasons[0], JSON.stringify(d.reasons)).toMatch(wanted);
    });

    it('with only the general words, it is an invoice or receipt', () => {
      expect(run({ pageCount: 2, first: generic }).reasons[0]).toMatch(/invoice or receipt/i);
    });
  });

  it('a learning verdict by score gives labels such as the plan\'s "References section, DOI, 40 pages"', () => {
    const d = run({ pageCount: 40, first: DOI_LINE, last: REFS, metadata: LATEX });
    expect(d.verdict).toBe('learning');
    expect(d.reasons.length).toBeGreaterThan(0);
    expect(d.reasons.join(' | ')).toMatch(/references/i);
  });

  it('every decision carries at least one reason (the chip tooltip is never empty)', () => {
    for (const spec of [{ pageCount: 4 }, POS_6_5, { pageCount: 4, first: 'Chapter 1' }, { pageCount: 1, first: invoice }] as Spec[]) {
      expect(run(spec).reasons.length, JSON.stringify(spec).slice(0, 60)).toBeGreaterThan(0);
    }
  });
});

