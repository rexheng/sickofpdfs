// Spec-blind tests for nudge(d, sim): step 3 of the learning filter, the MiniLM tie-breaker (Phase 3, slice S2).
//
// Sources:
//   spec, "Learning filter and privacy", step 3: "Not sure: a small bundled model (MiniLM, about 20 ms) nudges the score. If
//     still unsure, the chip asks you." Step 4: scans with no text are never saved automatically.
//   contract section 5: "nudge(d, sim): step 3: MiniLM, verdicts only for 'unsure'"; FilterRule includes 'model'.
//   research 04 B.3: S' = S + clamp(10 * (simLearn - simNot), -2, +2); S' >= 3 learning, S' <= 0 not learning, else ask.
//   plan T1: "nudge can only change unsure".
//
// The spec does not print the formula, so the rows below are chosen to be right under the research formula AND under any
// sensible reading: a clear margin moves a mid-range score across the nearest threshold, a zero margin changes nothing,
// and the direction of the margin decides the direction of the change. Exact-formula rows use values that are exact in
// binary floating point (0.5, 0.25) so a different but equivalent computation cannot disagree by rounding.
import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../../test/spec-blind/filter-kit';
import type { FilterDecision } from '../../test/spec-blind/filter-kit';
import { nudge } from './nudge';

const unsure = (score: number, over: Partial<FilterDecision> = {}): FilterDecision => ({
  verdict: 'unsure',
  reasons: ['References section', '30 pages'],
  score,
  rule: 'score',
  needsModel: true,
  ...over,
});
const sim = (learning: number, notLearning: number) => ({ learning, notLearning });
const SCORES = [0.5, 1, 1.5, 2, 2.5];
const FIXED = (d: FilterDecision) => ({ verdict: d.verdict, rule: d.rule, score: d.score });

describe('nudge moves a "not sure" answer toward the side the model prefers', () => {
  it.each([
    ['a clear learning margin (1.5 -> over 3)', unsure(1.5), sim(0.75, 0.25), 'learning'],
    ['a clear learning margin from 1', unsure(1), sim(0.75, 0.25), 'learning'],
    ['a clear not-learning margin (1.5 -> under 0)', unsure(1.5), sim(0.25, 0.75), 'not-learning'],
    ['a clear not-learning margin from 1', unsure(1), sim(0.25, 0.75), 'not-learning'],
    ['a clear learning margin from 2.5', unsure(2.5), sim(0.9, 0.1), 'learning'],
    ['a clear not-learning margin from 0.5', unsure(0.5), sim(0.1, 0.9), 'not-learning'],
  ])('%s', (_name, d, s, verdict) => {
    const out = nudge(deepFreeze(d), s);
    expect(out.verdict).toBe(verdict);
    expect(out.rule).toBe('model');
    expect(out.needsModel ?? false).toBe(false);
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  it.each(SCORES)('no margin (equal similarities) leaves a score of %f still unsure', (score) => {
    const out = nudge(deepFreeze(unsure(score)), sim(0.5, 0.5));
    expect(out.verdict).toBe('unsure');
    expect(out.needsModel ?? false).toBe(false); // the model has run; the chip asks the owner now
  });

  it('a tiny margin is not enough to cross a threshold', () => {
    expect(nudge(deepFreeze(unsure(1.5)), sim(0.5625, 0.5)).verdict).toBe('unsure');
    expect(nudge(deepFreeze(unsure(1.5)), sim(0.5, 0.5625)).verdict).toBe('unsure');
  });

  it('the nudge is capped (research: +/-2), so the model alone cannot rescue a very low score', () => {
    // 0.5 + 2 = 2.5 at most under the cap; an uncapped formula (10 * 0.9 = +9) would save it
    const out = nudge(deepFreeze(unsure(0.5)), sim(0.95, 0.05));
    expect(out.verdict).toBe('unsure');
  });

  it('a margin in the model\'s favour never lowers the verdict, one against never raises it (a grid of 5 scores x 21 margins)', () => {
    const rank = { 'not-learning': 0, unsure: 1, learning: 2 } as const;
    for (const score of SCORES) {
      for (let i = -10; i <= 10; i++) {
        const margin = i / 10;
        const out = nudge(deepFreeze(unsure(score)), sim(0.5 + margin / 2, 0.5 - margin / 2));
        if (margin > 0) expect(rank[out.verdict], `score ${score} margin ${margin}`).toBeGreaterThanOrEqual(rank.unsure);
        if (margin < 0) expect(rank[out.verdict], `score ${score} margin ${margin}`).toBeLessThanOrEqual(rank.unsure);
        if (margin === 0) expect(out.verdict).toBe('unsure');
      }
    }
  });

  it('the verdict is monotone in the margin: a bigger margin for "learning" never gives a lower verdict', () => {
    const rank = { 'not-learning': 0, unsure: 1, learning: 2 } as const;
    for (const score of SCORES) {
      let last = -1;
      for (let i = -20; i <= 20; i++) {
        const m = i / 20;
        const r = rank[nudge(deepFreeze(unsure(score)), sim(0.5 + m / 2, 0.5 - m / 2)).verdict];
        expect(r, `score ${score} margin ${m}`).toBeGreaterThanOrEqual(last);
        last = r;
      }
    }
  });

  it('does not change its input', () => {
    const d = deepFreeze(unsure(1.5));
    const s = deepFreeze(sim(0.75, 0.25));
    expect(() => nudge(d, s)).not.toThrow();
    expect(d).toEqual(unsure(1.5));
  });
});

describe('nudge can only change "unsure" (contract section 5, plan T1)', () => {
  const settled: Array<[string, FilterDecision]> = [
    ['learning by score', { verdict: 'learning', reasons: ['References section'], score: 4.5, rule: 'score' }],
    ['not-learning by score', { verdict: 'not-learning', reasons: ['looks like an invoice or receipt'], score: -3, rule: 'score' }],
    ['learning by force save', { verdict: 'learning', reasons: ['arXiv id, References'], score: 5.5, rule: 'force-save', forceSave: 'arxiv+references' }],
    ['learning by your allow list', { verdict: 'learning', reasons: ['On your allow list'], rule: 'allow-list' }],
    ['not-learning by your deny list', { verdict: 'not-learning', reasons: ['On your deny list'], rule: 'deny-list' }],
    ['learning by your choice', { verdict: 'learning', reasons: ['You chose to save this file'], rule: 'file-choice' }],
    ['not-learning by your choice', { verdict: 'not-learning', reasons: ['You chose not to save this file'], rule: 'file-choice' }],
    ['not-learning by hard block', { verdict: 'not-learning', reasons: ['has card or bank numbers'], rule: 'hard-block', hardBlocks: ['card'] }],
    ['not-learning, a scan with no text', { verdict: 'not-learning', reasons: ['a scan with no text'], rule: 'no-text' }],
  ];
  const extremes = [sim(1, 0), sim(0, 1), sim(0.9, 0.1), sim(0.1, 0.9), sim(0.5, 0.5)];

  it.each(settled)('%s is returned as it is, whatever the model says', (_name, d) => {
    for (const s of extremes) {
      const out = nudge(deepFreeze(d), s);
      expect(FIXED(out), JSON.stringify(s)).toEqual(FIXED(d));
      expect(out.reasons).toEqual(d.reasons);
      expect(out.hardBlocks ?? null).toEqual(d.hardBlocks ?? null);
      expect(out.forceSave ?? null).toEqual(d.forceSave ?? null);
    }
  });

  it('a hard block can never be turned into learning by the model (the privacy case)', () => {
    const blocked: FilterDecision = { verdict: 'not-learning', reasons: ['has card or bank numbers'], score: 5.5, rule: 'hard-block', hardBlocks: ['card'] };
    for (const s of extremes) expect(nudge(deepFreeze(blocked), s).verdict).toBe('not-learning');
  });

  it('an "unsure" scan with no text is never turned into learning (scans are never saved automatically)', () => {
    const scan: FilterDecision = { verdict: 'unsure', reasons: ['a scan from a course page'], rule: 'no-text' };
    for (const s of extremes) expect(nudge(deepFreeze(scan), s).verdict).not.toBe('learning');
  });

  it('a model answer that is not a number cannot save anything', () => {
    for (const s of [sim(Number.NaN, Number.NaN), sim(Number.NaN, 0.5), sim(Number.POSITIVE_INFINITY, 0), sim(1e9, -1e9)]) {
      const out = nudge(deepFreeze(unsure(1.5)), s);
      if (Number.isNaN(s.learning) || Number.isNaN(s.notLearning)) expect(out.verdict).toBe('unsure');
      else expect(['learning', 'unsure']).toContain(out.verdict); // an absurd margin is capped, never beyond the cap
    }
  });
});
