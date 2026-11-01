// Step 3 of the spec: the small bundled model (MiniLM) nudges an "unsure" score. It can move only "unsure" PDFs.
// A decision that is already learning or not-learning, or that has no score, comes back untouched.

import { looksLikeFromSignals, NOT_SAVE_AT, SAVE_AT } from './classify';
import type { FilterDecision, FilterSignal, FilterVerdict } from './types';

export interface Similarities {
  /** Cosine similarity to the "study material" prototype sentences. */
  learning: number;
  /** Cosine similarity to the "paperwork" prototype sentences. */
  notLearning: number;
}

/** The most the model can add to or take from the score. */
export const NUDGE_LIMIT = 2;
const NUDGE_PER_UNIT = 10;

export function nudgeAmount(sim: Similarities): number | null {
  const diff = sim.learning - sim.notLearning;
  if (!Number.isFinite(diff)) return null;
  const raw = Math.max(-NUDGE_LIMIT, Math.min(NUDGE_LIMIT, NUDGE_PER_UNIT * diff));
  return Math.round(raw * 100) / 100;
}

export function nudge(d: FilterDecision, sim: Similarities): FilterDecision {
  if (d.verdict !== 'unsure' || d.score === undefined) return d;
  const amount = nudgeAmount(sim);
  if (amount === null) return d;

  const score = Math.round((d.score + amount) * 100) / 100;
  const verdict: FilterVerdict = score >= SAVE_AT ? 'learning' : score <= NOT_SAVE_AT ? 'not-learning' : 'unsure';
  const signals: FilterSignal[] = [...(d.signals ?? [])];
  if (amount !== 0) {
    signals.push({
      id: 'model',
      weight: amount,
      label: amount > 0 ? 'Reads like study material' : 'Reads like paperwork',
    });
  }
  const base = { ...d, score, signals, needsModel: false };
  const kept = d.reasons.filter((r) => r !== 'not sure if this is a reading');
  if (verdict === 'learning') {
    return { ...base, verdict, rule: 'model', reasons: ['reads like study material', ...kept].slice(0, 4) };
  }
  if (verdict === 'not-learning') {
    const first = looksLikeFromSignals(d.signals) ?? 'looks like paperwork, not a reading';
    return { ...base, verdict, rule: 'model', reasons: [first, ...kept].slice(0, 4) };
  }
  return { ...base, verdict };
}
