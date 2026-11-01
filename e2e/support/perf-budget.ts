// Speed bounds for the e2e suite. The spec's budgets are for the reference laptop, and "CI runs looser smoke versions"
// (Speed budgets). So every speed bound in e2e goes through budgetMs():
//  - SOP_PERF_STRICT=1 (the reference laptop): the spec's own budget;
//  - otherwise (CI, a shared or loaded box): LOOSE_FACTOR times looser, which still catches anything grossly slow.

/** True when the run holds speed to the spec's own budgets. */
export const PERF_STRICT = process.env.SOP_PERF_STRICT === '1';

/** How much looser a speed bound is when the run is not strict. */
export const LOOSE_FACTOR = 3;

/** The bound to assert for a spec budget of `specMs` milliseconds. */
export function budgetMs(specMs: number): number {
  return PERF_STRICT ? specMs : specMs * LOOSE_FACTOR;
}

/** For assertion messages: what the bound is and where it comes from. */
export function budgetNote(specMs: number): string {
  return PERF_STRICT ? `the spec's budget is ${specMs} ms` : `the smoke bound is ${budgetMs(specMs)} ms, ${LOOSE_FACTOR}× the spec's ${specMs} ms (SOP_PERF_STRICT=1 for the real budget)`;
}
