// Spec-blind tests: the learning filter on the 44 real research fixtures, with PDFium's text (Phase 3, plan T1).
//
// Sources:
//   plan, phase gate 1: "Zero false saves. On the 44 research fixtures ... no non-learning PDF gets the verdict learning. All
//     22 research non-learning files come out not-learning. At most 1 of the 22 learning files is not auto-saved (today it is
//     the MIT 14.01 handout, unsure)."
//   plan T1: "all 22 non-learning not-learning; at least 21 of 22 learning learning, the rest unsure, none not-learning".
//   research 04 B.8: the fixture list, labels and the baseline (content only: 21 saved, 1 ambiguous, 0 false saves).
//   plan S2: the first reason of a not-learning verdict is a "looks like ..." phrase.
//
// Where the inputs come from: the merged engine, in the browser project. packages/viewer/test/spec-blind/
// filter-inputs.spec-blind.browser.test.ts opens every fixture with PDFium and writes the text of the first and last 5
// pages, the page sizes, the Info metadata and the form type to test-assets/spec-blind/filter-inputs/ (gitignored). This file
// reads those files in plain Node. Run the extractor once after `pnpm fixtures`; a missing file fails with the command.
//
// Two ways to meet each file (see filter-kit.ts): 'content-only' (no link; the honest baseline) and 'with-source' (its link,
// the file name Chrome would give it, and the page it came from).
//
// Set SOP_FILTER_TABLE=1 to print one line per fixture and mode.
import { describe, expect, it } from 'vitest';
import {
  LEARNING,
  MANIFEST,
  NOT_LEARNING,
  SOURCE_MODES,
  baseName,
  fixtureInput,
  fixtureRecord,
  inputStrings,
  rulesOf,
  windows,
  wordCount,
} from '../../test/spec-blind/filter-kit';
import type { FilterDecision, ManifestItem, SourceMode } from '../../test/spec-blind/filter-kit';
import { classify } from './classify';
import { detectHardBlocks } from './hard-blocks';

const decisions = new Map<string, FilterDecision>();
function decide(item: ManifestItem, mode: SourceMode): FilterDecision {
  const key = `${mode}:${item.path}`;
  let d = decisions.get(key);
  if (!d) {
    d = classify(fixtureInput(item, mode), rulesOf());
    decisions.set(key, d);
  }
  return d;
}
const show = (d: FilterDecision) => `${d.verdict} (rule ${d.rule}, score ${d.score}) ${JSON.stringify(d.reasons)}`;

describe('the extracted inputs match the manifest', () => {
  it('44 fixtures: 22 learning and 22 not-learning', () => {
    expect(MANIFEST).toHaveLength(44);
    expect(LEARNING).toHaveLength(22);
    expect(NOT_LEARNING).toHaveLength(22);
  });

  it.each(MANIFEST.map((i) => [i.path, i] as const))('%s has page count, sizes and a first-and-last-5-pages sample (plus a second look if it was empty)', (_path, item) => {
    const r = fixtureRecord(item);
    expect(r.pageCount).toBe(item.pages);
    expect(r.pageSizes).toHaveLength(item.pages);
    const edge = Math.min(item.pages, 10);
    if (r.secondLook) {
      expect(r.firstLastWords).toBeLessThan(15);
      expect(r.sampleText.length).toBeGreaterThan(edge);
      expect(r.sampleText.length).toBeLessThanOrEqual(Math.min(item.pages, 20));
    } else {
      expect(r.sampleText).toHaveLength(edge);
    }
    expect(r.sampleText.every((t) => typeof t === 'string')).toBe(true);
  });

  it('only the image-heavy CS50 slides need the second look; the one-page image-only receipt cannot have one', () => {
    const second = MANIFEST.filter((i) => fixtureRecord(i).secondLook).map(baseName);
    expect(second).toEqual(['slides-cs50-2023-lecture0.pdf']);
    const starbucks = NOT_LEARNING.find((i) => i.path.includes('starbucks'))!;
    expect(fixtureRecord(starbucks).firstLastWords).toBe(0);
  });
});

for (const mode of SOURCE_MODES) {
  describe(`44 research fixtures, ${mode}`, () => {
    // ---- the privacy gate: every non-learning file is not-learning
    describe('not-learning files are never saved (gate 1: all 22 come out not-learning)', () => {
      it.each(NOT_LEARNING.map((i) => [baseName(i), i] as const))('%s', (_name, item) => {
        const d = decide(item, mode);
        if (process.env.SOP_FILTER_TABLE) console.info(`${mode.padEnd(12)} NL ${baseName(item).padEnd(52)} ${show(d)}`);
        expect(d.verdict, show(d)).toBe('not-learning');
        expect(d.reasons.length).toBeGreaterThan(0);
      });

      it('none of the 22 gets the verdict learning, and none is merely "not sure"', () => {
        const wrong = NOT_LEARNING.filter((i) => decide(i, mode).verdict !== 'not-learning').map((i) => `${baseName(i)}: ${show(decide(i, mode))}`);
        expect(wrong).toEqual([]);
      });
    });

    // ---- the learning files: saved, or asked; never skipped
    describe('learning files are saved or asked, never skipped', () => {
      it.each(LEARNING.map((i) => [baseName(i), i] as const))('%s', (_name, item) => {
        const d = decide(item, mode);
        if (process.env.SOP_FILTER_TABLE) console.info(`${mode.padEnd(12)} L  ${baseName(item).padEnd(52)} ${show(d)}`);
        expect(['learning', 'unsure'], show(d)).toContain(d.verdict);
        expect(d.reasons.length).toBeGreaterThan(0);
      });

      it('at most 1 of the 22 is not auto-saved (gate 1; T1: at least 21 learning, the rest unsure)', () => {
        const notSaved = LEARNING.filter((i) => decide(i, mode).verdict !== 'learning').map((i) => `${baseName(i)}: ${show(decide(i, mode))}`);
        expect(notSaved.length, `not auto-saved:\n${notSaved.join('\n')}`).toBeLessThanOrEqual(1);
      });
    });

    describe('what a learning decision and a not-learning decision look like', () => {
      it('a learning verdict by score or force save is backed by text: at least 15 words in the sample', () => {
        for (const i of LEARNING) {
          const d = decide(i, mode);
          if (d.verdict === 'learning' && (d.rule === 'score' || d.rule === 'force-save')) {
            expect(wordCount(fixtureRecord(i).sampleText), baseName(i)).toBeGreaterThanOrEqual(15);
          }
        }
      });

      it('no learning fixture trips a hard block: arXiv ids, DOIs, ISBNs, page numbers and tables are not card or ID numbers', () => {
        for (const i of LEARNING) {
          expect(detectHardBlocks(fixtureRecord(i).sampleText), baseName(i)).toEqual([]);
          expect(decide(i, mode).hardBlocks ?? [], baseName(i)).toEqual([]);
          expect(decide(i, mode).rule, baseName(i)).not.toBe('hard-block');
        }
      });

      it('reasons are short fixed labels: nothing is copied from the PDF text, the title, the file name or the link', () => {
        for (const i of MANIFEST) {
          const input = fixtureInput(i, mode);
          const d = decide(i, mode);
          const labels = [...d.reasons, ...(d.signals ?? []).map((s) => s.label)];
          for (const label of labels) expect(label.length, `${baseName(i)}: ${label}`).toBeLessThanOrEqual(120);
          // any 24 characters in a row of a reason that also stand in the input would be a copy
          const seen = windows(inputStrings(input), 24);
          for (const label of labels) {
            const norm = label.replace(/\s+/g, ' ');
            for (let k = 0; k + 24 <= norm.length; k++) expect(seen.has(norm.slice(k, k + 24)), `${baseName(i)} copies input text into "${label}"`).toBe(false);
          }
        }
      });
    });

    describe('scans', () => {
      it('the image-only Starbucks receipt has no text, so it is not saved and the rule says why', () => {
        const item = NOT_LEARNING.find((i) => i.path.includes('starbucks'))!;
        expect(wordCount(fixtureRecord(item).sampleText)).toBeLessThan(15);
        const d = decide(item, mode);
        expect(d.verdict).toBe('not-learning');
        expect(d.rule).toBe('no-text');
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------
describe('real IBANs in real invoices are recognised, in the layouts printers use', () => {
  // Found by looking at the extracted text (all four pass mod 97): "IBAN NL50INGB0683251309" (compact), "IBAN DE30507500940000048567"
  // (compact), "IBAN: DE48 2003 0000 0003 6027 11" (groups of four) and a French layout, "IBAN : FR76 10107 00245 00617052317 39".
  it.each(['invoice-coolblue1-nl.pdf', 'invoice-netpresse-fr.pdf', 'invoice-qualityhosting-de.pdf', 'receipt-hotel-madison-hamburg.pdf'])('%s', (file) => {
    const item = NOT_LEARNING.find((i) => i.path.endsWith(`/${file}`))!;
    expect(detectHardBlocks(fixtureRecord(item).sampleText)).toContain('iban');
  });

  it('one IBAN alone is not a block: those invoices are not-learning by the score, not by rule hard-block', () => {
    for (const file of ['invoice-coolblue1-nl.pdf', 'invoice-netpresse-fr.pdf', 'invoice-qualityhosting-de.pdf', 'receipt-hotel-madison-hamburg.pdf']) {
      const item = NOT_LEARNING.find((i) => i.path.endsWith(`/${file}`))!;
      const kinds = new Set(detectHardBlocks(fixtureRecord(item).sampleText));
      if (kinds.size < 2 && !kinds.has('card')) expect(decide(item, 'content-only').rule, file).not.toBe('hard-block');
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('the chip wording of each not-learning fixture (plan S2: "looks like ..." phrases)', () => {
  // [file, what the first reason must name]. The plan's wording: "looks like an invoice or receipt", "a bank statement",
  // "a payslip", "a tax form", "a ticket or boarding pass", "a contract", "has card or bank numbers".
  const expectations: Array<[string, RegExp]> = [
    ['invoice-aws-sample.pdf', /invoice|receipt/i],
    ['invoice-azure-interior.pdf', /invoice|receipt/i],
    ['invoice-coolblue1-nl.pdf', /invoice|receipt/i],
    ['invoice-flipkart.pdf', /invoice|receipt/i],
    ['invoice-netpresse-fr.pdf', /invoice|receipt/i],
    ['invoice-qualityhosting-de.pdf', /invoice|receipt/i],
    ['invoice-sliced-sample.pdf', /invoice|receipt/i],
    ['receipt-oyo-hotel.pdf', /invoice|receipt/i],
    ['receipt-hotel-madison-hamburg.pdf', /invoice|receipt/i],
    ['bank-statement-five-star-bank-sample.pdf', /bank statement/i],
    ['tax-form-irs-w9.pdf', /tax form/i],
    ['tax-form-irs-w2.pdf', /tax form/i],
    ['tax-form-irs-1040.pdf', /tax form/i],
    ['tax-form-hmrc-sa100-2026.pdf', /tax form/i],
    ['boarding-pass-kitinerary-synthetic-bcbp.pdf', /ticket or boarding pass|boarding pass/i],
    ['ticket-db-public-transport-118NP8.pdf', /ticket|boarding pass|invoice|receipt/i],
    ['payslip-iup-understanding-pay-statement.pdf', /payslip|pay statement|invoice|receipt/i],
  ];

  it.each(expectations)('%s', (file, wanted) => {
    const item = NOT_LEARNING.find((i) => i.path.endsWith(`/${file}`))!;
    const d = decide(item, 'content-only');
    expect(d.verdict).toBe('not-learning');
    expect(d.reasons[0], show(d)).toMatch(/looks like|^an? |^has /i);
    // A file that holds a card or bank number may be labelled "has card or bank numbers" instead (plan S2 lists that phrase).
    const carriesNumbers = detectHardBlocks(fixtureRecord(item).sampleText).length > 0;
    expect(d.reasons[0], show(d)).toMatch(carriesNumbers ? new RegExp(`${wanted.source}|card or bank numbers`, 'i') : wanted);
  });

  it('every not-learning fixture has a first reason (the chip always has words)', () => {
    for (const i of NOT_LEARNING) expect(decide(i, 'content-only').reasons[0]?.length ?? 0, baseName(i)).toBeGreaterThan(3);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('with the link it came from, the files the link vouches for are saved', () => {
  it('the MIT 14.01 handout (the one the plan says is "unsure" on content alone) is saved from ocw.mit.edu', () => {
    const item = LEARNING.find((i) => i.path.includes('handout-mit-14.01'))!;
    expect(decide(item, 'with-source').verdict).toBe('learning');
  });

  it('every file from arxiv.org is saved', () => {
    for (const item of LEARNING.filter((i) => i.url.includes('arxiv.org'))) expect(decide(item, 'with-source').verdict, baseName(item)).toBe('learning');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// DECIDED (spec, "Decided while building the filter"): "Second look for text-poor decks. If the first and last 5 pages hold
// fewer than 15 words, up to 10 middle pages are sampled before the no-text rule applies. Slide decks such as the CS50 lectures
// are judged on their real content. Image-only receipts and scans still never save."
// With PDFium the first and last 5 pages of the CS50 lecture-0 slides hold 7 words (image-only title slides and arrows); the
// extractor now applies the second look, so the sample has the words of 10 middle slides as well.
describe('second look: image-heavy slides are judged on their middle pages', () => {
  const cs50 = () => LEARNING.find((i) => i.path.includes('slides-cs50'))!;

  it('the first and last 5 pages alone are almost empty, and the second look finds real text', () => {
    const r = fixtureRecord(cs50());
    expect(r.firstLastWords).toBeLessThan(15);
    expect(r.secondLook).toBe(true);
    expect(wordCount(r.sampleText)).toBeGreaterThanOrEqual(15);
    expect(r.sampledPageIndexes.length).toBeLessThanOrEqual(20);
  });

  it.each(SOURCE_MODES)('the CS50 lecture 0 slides are saved or asked, not skipped, and not treated as a scan (%s)', (mode) => {
    const d = decide(cs50(), mode);
    expect(['learning', 'unsure'], show(d)).toContain(d.verdict);
    expect(d.rule, show(d)).not.toBe('no-text');
  });

  it('the one-page image-only receipt still never saves', () => {
    const starbucks = NOT_LEARNING.find((i) => i.path.includes('starbucks'))!;
    for (const mode of SOURCE_MODES) expect(decide(starbucks, mode).verdict).toBe('not-learning');
  });
});
