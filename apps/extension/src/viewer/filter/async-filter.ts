// The learning filter as the viewer runs it (contracts §5: "the async filter is `classify`, then the MiniLM worker when
// `needsModel`"). The spec's order:
//   1. identity first: a PDF the library holds is never classified again (the save controller does that before this);
//   2. your choice for this exact file ("Never save this file"), read before any page text (`fileChoice`);
//   3. the sample, `classify` with your deny and allow lists, and the tie-breaker plus `nudge` only for "not sure".
//
// Fail safe: if the owner's choices or lists cannot be read, the filter never saves on its own. A `learning` verdict
// becomes "not sure", and the owner decides. The tie-breaker can only move a "not sure" PDF (core's `nudge`); if it is
// missing, slow or fails, the PDF stays "not sure".
//
// Privacy: everything here runs in memory. A decision holds fixed labels only, never PDF text. Nothing is logged.
import { classify, type FilterDecision, type FilterInput, nudge, type Sha256 } from '@sop/core';
import type { FilterLists, FilterRulesSource } from './rules-source';
import { type TieBreaker, tieBreakerText } from './tie-breaker';

/**
 * How long the decision waits for the tie-breaker (S10: about 1.5 s cold, 0.2 s warm; about 2 s on a loaded test box)
 * before the PDF just stays "not sure". Generous, so a slow computer gets the same answer as a fast one; the chip shows
 * nothing meanwhile, so it is kept under S10's own 30 s limit.
 */
export const MODEL_TIMEOUT_MS = 15_000;

const NO_LISTS: FilterLists = { deny: [], allow: [] };
const EMPTY_INPUT: FilterInput = {
  url: null,
  fileName: '',
  pageCount: 0,
  pageSizes: [],
  metadata: { title: null, author: null, subject: null, keywords: null, creator: null, producer: null },
  sampleText: [],
};

/** The decision for a file the owner chose never to save. `classify` decides it before it reads anything. */
export function neverSaveDecision(): FilterDecision {
  return classify(EMPTY_INPUT, { fileChoice: 'never', deny: [], allow: [] });
}

/** The chip's words for a PDF the owner chose never to save ("you chose never to save this file"). */
export const NEVER_SAVE_REASON = neverSaveDecision().reasons[0] ?? 'you chose never to save this file';
/** The chip's words after "Forget this PDF". */
export const FORGOTTEN_REASON = 'removed from your library';
/** Why a PDF the filter would have saved is only "not sure": the owner's choices could not be read. */
const CHOICES_UNREAD = 'couldn’t check your choices for this file';

export interface ViewerFilterDeps {
  /** The opened file's fingerprint. */
  fingerprint: Sha256;
  /** The owner's rules; null leaves the lists empty and never saves on its own. */
  rules: FilterRulesSource | null;
  /** S10's `createTieBreaker` (a MiniLM worker in this tab, made on demand); null: "not sure" stays "not sure". */
  tieBreaker: (() => TieBreaker) | null;
  timeoutMs?: number;
}

export interface ViewerFilter {
  /** Step 2: the owner's choice for this file, before any page is read. Null when there is none (or it could not be read). */
  fileChoice(): Promise<FilterDecision | null>;
  /** Step 3: the save controller's `filter`. */
  filter(input: FilterInput): Promise<FilterDecision>;
}

export function createViewerFilter(d: ViewerFilterDeps): ViewerFilter {
  /** False when the owner's choice for this file or their lists could not be read: then nothing is saved on its own. */
  let choicesKnown = d.rules !== null;

  return {
    async fileChoice() {
      if (d.rules === null) return null;
      try {
        return (await d.rules.fileChoice(d.fingerprint)) === 'never' ? neverSaveDecision() : null;
      } catch {
        choicesKnown = false;
        return null;
      }
    },

    async filter(input) {
      const forced = forcedDecision();
      if (forced !== null) return forced;
      let lists = NO_LISTS;
      if (d.rules !== null) {
        try {
          lists = await d.rules.lists();
        } catch {
          choicesKnown = false;
        }
      }
      let decision = classify(input, { fileChoice: null, ...lists });
      if (decision.verdict === 'unsure' && decision.needsModel === true && d.tieBreaker !== null) {
        decision = await tieBreak(decision, input, d.tieBreaker, d.timeoutMs ?? MODEL_TIMEOUT_MS);
      }
      if (!choicesKnown && decision.verdict === 'learning') {
        return { ...decision, verdict: 'unsure', reasons: [CHOICES_UNREAD, ...decision.reasons].slice(0, 4), needsModel: false };
      }
      return decision;
    },
  };
}

/**
 * Step 3 of the spec: MiniLM nudges a "not sure" score. It runs only here, for a "not sure" PDF with text, after the
 * first page is drawn (the save controller samples after the store connects, which waits for that). The worker is ended
 * after this one use. A model that cannot run, or is too slow, leaves the PDF "not sure": never a save on a failure.
 */
async function tieBreak(decision: FilterDecision, input: FilterInput, make: () => TieBreaker, timeoutMs: number): Promise<FilterDecision> {
  let model: TieBreaker | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    model = make();
    const text = tieBreakerText(input.sampleText);
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const sim = await Promise.race([model.similarities(text), late]);
    return sim === null ? decision : nudge(decision, sim);
  } catch {
    return decision;
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      model?.dispose();
    } catch {
      // the worker goes with the tab anyway
    }
  }
}

/** Test builds only: the key that forces a verdict, so a walkthrough can have a "not sure" or "not learning" PDF at will. */
export const FORCE_VERDICT_KEY = 'sop.test.filterVerdict';

const FORCED: Record<string, FilterDecision> = {
  unsure: { verdict: 'unsure', reasons: ['not sure if this is a reading'] },
  'not-learning': { verdict: 'not-learning', reasons: ['looks like an invoice or receipt'] },
  learning: { verdict: 'learning', reasons: ['References section'] },
};

/**
 * `wxt build --mode test` only (e2e): `localStorage['sop.test.filterVerdict']` set to `unsure`, `not-learning` or
 * `learning` forces that verdict. A production build drops this branch (`import.meta.env.MODE` is fixed at build time).
 * The owner's own "Never save this file" still comes first.
 */
function forcedDecision(): FilterDecision | null {
  if (import.meta.env.MODE !== 'test') return null;
  let wanted: string | null;
  try {
    wanted = globalThis.localStorage?.getItem(FORCE_VERDICT_KEY) ?? null;
  } catch {
    return null;
  }
  const d = wanted === null ? undefined : FORCED[wanted];
  return d === undefined ? null : { ...d, reasons: [...d.reasons] };
}
