// The stand-in learning filter (Task 30): until the real filter is wired in, every PDF is "not sure", so nothing is
// saved on its own and the owner decides. A Phase 3 slice swaps it for `classify` through the save controller's
// injectable `filter`.
import type { FilterDecision, FilterInput } from './types';

/** The stand-in's one reason, shown as the "Not sure: Save?" chip's tooltip. */
export const STAND_IN_REASONS: readonly string[] = Object.freeze(['No filter yet: your first mark saves it']);

/** Always `unsure`. It reads nothing of the PDF (the input is there for the real filter's signature). */
export const standInFilter: (input: FilterInput) => FilterDecision = () => {
  return { verdict: 'unsure', reasons: [...STAND_IN_REASONS] };
};
