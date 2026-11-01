// The learning filter, steps 1 and 2 of the spec. Pure and synchronous. Rule order:
//   1. your choice for this exact file
//   2. hard block (card and ID numbers), unless positive evidence is 8 or more
//   3. your deny list, then your allow list
//   4. force save (an arXiv id with References, or a DOI with Abstract and References)
//   5. the score: 3 or more saves, 0 or less does not, between is "unsure" and may go to the tie-breaker
// A PDF with no text is never saved by score: "unsure" from a scholarly or course site, otherwise "not-learning".
//
// A FilterDecision never holds PDF text. Every reason is a fixed phrase from this file.

import { detectHardBlocks, hardBlockApplies } from './hard-blocks';
import { listMatches } from './rules';
import { gatherEvidence, NO_TEXT_WORDS, rankKinds, type Evidence } from './signals';
import { ADMIN_GROUPS, type AdminKind } from './terms';
import type { FilterDecision, FilterInput, FilterRules, FilterSignal, HardBlock } from './types';

/** Positive evidence at or above this overrides a hard block (a paper that quotes an example IBAN). */
export const HARD_BLOCK_OVERRIDE = 8;
export const SAVE_AT = 3;
export const NOT_SAVE_AT = 0;

export const LOOKS_LIKE: Readonly<Record<AdminKind, string>> = {
  invoice: 'looks like an invoice or receipt',
  bank: 'looks like a bank statement',
  payslip: 'looks like a payslip',
  tax: 'looks like a tax form',
  ticket: 'looks like a ticket or boarding pass',
  contract: 'looks like a contract',
  medical: 'looks like a medical or lab letter',
  insurance: 'looks like an insurance letter',
  letter: 'looks like a letter',
  cv: 'looks like a CV or job application',
  personal: 'looks like a personal document',
};

export const HARD_BLOCK_REASON = 'has card or bank numbers';
export const HARD_BLOCK_WARNING =
  'This PDF has card, bank or ID numbers. It is saved only because you chose to, and its text is not searchable.';

const BLOCK_LABEL: Readonly<Record<HardBlock, string>> = {
  card: 'a card number',
  iban: 'an IBAN',
  'sort-code-account': 'a sort code with an account number',
  'ni-number': 'a National Insurance number',
  ssn: 'a Social Security number',
  utr: 'a tax reference (UTR)',
  'passport-line': 'a passport line',
  'boarding-pass': 'a boarding-pass code',
};

const MAX_REASONS = 4;

function topPositive(signals: readonly FilterSignal[], n: number): string[] {
  const out: string[] = [];
  const sorted = signals.filter((s) => s.weight > 0).sort((a, b) => b.weight - a.weight);
  for (const s of sorted) {
    if (!out.includes(s.label)) out.push(s.label);
    if (out.length >= n) break;
  }
  return out;
}

function topNegative(signals: readonly FilterSignal[], n: number): string[] {
  const out: string[] = [];
  const sorted = signals.filter((s) => s.weight < 0).sort((a, b) => a.weight - b.weight);
  for (const s of sorted) {
    if (!out.includes(s.label)) out.push(s.label);
    if (out.length >= n) break;
  }
  return out;
}

/** The "looks like …" phrase a not-learning chip shows, from the strongest evidence of what the PDF is. */
function looksLike(e: Evidence): string {
  const kind = e.adminKinds[0];
  if (kind) return LOOKS_LIKE[kind];
  if (e.xfa) return LOOKS_LIKE.tax;
  if (e.receiptRoll) return 'looks like a till receipt';
  if (e.nameNegative) return LOOKS_LIKE.invoice;
  if (e.host.negative) return 'looks like paperwork from a bank, shop or airline site';
  return 'looks like something other than a reading';
}

/** The "looks like …" phrase for a decision that kept its signals: the kind with most admin groups, else null. */
export function looksLikeFromSignals(signals: readonly FilterSignal[] | undefined): string | null {
  const kinds: AdminKind[] = [];
  for (const s of signals ?? []) {
    const g = s.id.startsWith('admin:') ? ADMIN_GROUPS.find((x) => `admin:${x.id}` === s.id) : undefined;
    if (g) kinds.push(g.kind);
  }
  const best = rankKinds(kinds)[0];
  return best ? LOOKS_LIKE[best] : null;
}

function ownerSave(blocks: readonly HardBlock[]): Pick<FilterDecision, 'hardBlocks' | 'ownerSave'> {
  return { hardBlocks: [...blocks], ownerSave: { warning: HARD_BLOCK_WARNING, indexText: false } };
}

function noText(e: Evidence): FilterDecision {
  // a scan from a scholarly or course page asks; anything else is left alone
  const scholarlyOrCourse = (e.host.scholarly || e.host.lms) && !e.host.negative && !e.nameNegative;
  if (scholarlyOrCourse) {
    return {
      verdict: 'unsure',
      reasons: ['a page with no text to check', e.host.scholarly ? 'from a scholarly website' : 'from a course website'],
      rule: 'no-text',
      signals: e.signals.filter((s) => s.id.startsWith('host-')),
    };
  }
  return { verdict: 'not-learning', reasons: ['looks like a scan with no text'], rule: 'no-text' };
}

export function classify(input: FilterInput, rules: FilterRules): FilterDecision {
  // 1. your choice for this exact file
  if (rules.fileChoice === 'never') {
    return { verdict: 'not-learning', reasons: ['you chose never to save this file'], rule: 'file-choice' };
  }

  const blocks = detectHardBlocks(input.sampleText);
  const blocking = hardBlockApplies(blocks);

  if (rules.fileChoice === 'save') {
    // a hard-blocked PDF saved by choice keeps its warning and its text indexing off (decision D9)
    const keepBlock = blocking && gatherEvidence(input).positive < HARD_BLOCK_OVERRIDE;
    return {
      verdict: 'learning',
      reasons: ['you chose to save this file'],
      rule: 'file-choice',
      ...(keepBlock ? ownerSave(blocks) : {}),
    };
  }

  const e = gatherEvidence(input);

  // 2. hard block
  const blocked = blocking && e.positive < HARD_BLOCK_OVERRIDE;
  if (blocked) {
    return {
      verdict: 'not-learning',
      reasons: [HARD_BLOCK_REASON, ...blocks.map((b) => BLOCK_LABEL[b])],
      rule: 'hard-block',
      ...ownerSave(blocks),
    };
  }

  // 3. your lists: deny beats allow
  if (listMatches(rules.deny, input.url, input.viaPage)) {
    return { verdict: 'not-learning', reasons: ['matches your deny list'], rule: 'deny-list' };
  }
  if (listMatches(rules.allow, input.url, input.viaPage)) {
    return { verdict: 'learning', reasons: ['matches your allow list'], rule: 'allow-list' };
  }

  // 4. force save
  if (e.arxiv && e.references) {
    return {
      verdict: 'learning',
      reasons: ['arXiv number and References section', ...topPositive(e.signals, MAX_REASONS)].slice(0, MAX_REASONS),
      rule: 'force-save',
      forceSave: 'arxiv+references',
      signals: e.signals,
    };
  }
  if (e.doi && e.abstract && e.references) {
    return {
      verdict: 'learning',
      reasons: ['DOI, Abstract and References section', ...topPositive(e.signals, MAX_REASONS)].slice(0, MAX_REASONS),
      rule: 'force-save',
      forceSave: 'doi+abstract+references',
      signals: e.signals,
    };
  }

  // a PDF with no text is never saved by score
  if (e.words < NO_TEXT_WORDS) return noText(e);

  // A CV is a private document however many papers it lists. No score saves it.
  if (e.cvLike) {
    return { verdict: 'not-learning', reasons: [LOOKS_LIKE.cv], score: e.score, rule: 'score', signals: e.signals };
  }

  // 5. the score
  const score = e.score;
  if (score >= SAVE_AT) {
    return {
      verdict: 'learning',
      reasons: topPositive(e.signals, MAX_REASONS - 1),
      score,
      rule: 'score',
      signals: e.signals,
    };
  }
  if (score <= NOT_SAVE_AT) {
    return {
      verdict: 'not-learning',
      reasons: [looksLike(e), ...topNegative(e.signals, 2)].slice(0, MAX_REASONS),
      score,
      rule: 'score',
      signals: e.signals,
    };
  }
  return {
    verdict: 'unsure',
    reasons: ['not sure if this is a reading', ...topPositive(e.signals, 2), ...topNegative(e.signals, 1)].slice(0, MAX_REASONS),
    score,
    rule: 'score',
    signals: e.signals,
    needsModel: true,
  };
}
