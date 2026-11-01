// The learning filter's public types (contract §5). Phase 3 only adds optional fields to Task 30's names.
//
// Privacy: a FilterDecision never holds PDF text, numbers or matched strings. Every `reasons` entry and every signal
// `label` is a fixed plain-words phrase written in this package. The only numbers that can appear in a label come from
// the page count, which is a fact about the file's structure.

export type FilterVerdict = 'learning' | 'not-learning' | 'unsure';

/** The page shape the filter needs. The viewer's `PageSize` fits it, so core never imports `viewer`. */
export interface FilterPageSize {
  width: number;
  height: number;
  /** The page's /Rotate. 90 and 270 swap the shown width and height. */
  rotation?: 0 | 90 | 180 | 270;
}

/** The Info fields the filter reads. The viewer's `PdfMetadata` fits it. */
export interface FilterMetadata {
  title: string | null;
  author: string | null;
  subject: string | null;
  keywords: string | null;
  creator: string | null;
  producer: string | null;
}

export type FilterFormType = 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground';

export interface FilterInput {
  /** The link the PDF came from (http(s), file or blob), or null. */
  url: string | null;
  fileName: string;
  pageCount: number;
  pageSizes: FilterPageSize[];
  metadata: FilterMetadata;
  /** Text of the first and last 5 pages, one string per page, first pages first. */
  sampleText: string[];
  /** The course or referring page the PDF was opened from. */
  viaPage?: string | null;
  formType?: FilterFormType;
}

export type FilterRule =
  | 'file-choice'
  | 'hard-block'
  | 'deny-list'
  | 'allow-list'
  | 'force-save'
  | 'score'
  | 'model'
  | 'no-text';

export type HardBlock =
  | 'card'
  | 'iban'
  | 'sort-code-account'
  | 'ni-number'
  | 'ssn'
  | 'utr'
  | 'passport-line'
  | 'boarding-pass';

export interface FilterSignal {
  id: string;
  /** Points added to the score (negative for evidence against). */
  weight: number;
  /** Chip wording, e.g. "References section". */
  label: string;
}

/**
 * Decision D9 (default): a PDF blocked for card or bank numbers can still be saved by the owner's explicit choice.
 * The save comes with a warning line and text indexing off. Set whenever the PDF has a blocking hard block, whatever
 * verdict came back, so the UI reads it at save time. The UI itself is a later slice.
 */
export interface OwnerSavePolicy {
  warning: string;
  indexText: false;
}

export interface FilterDecision {
  verdict: FilterVerdict;
  /** Fixed plain-words labels. For `not-learning` the first one is a "looks like …" phrase for the chip. */
  reasons: string[];
  /** Starts at −1. Absent when a rule decided before the score. */
  score?: number;
  rule?: FilterRule;
  signals?: FilterSignal[];
  /** Kinds only, never the matched text. Present only when the hard block applied. */
  hardBlocks?: HardBlock[];
  forceSave?: 'arxiv+references' | 'doi+abstract+references' | null;
  /** True for `unsure` with text: the tie-breaker (MiniLM) may nudge it. */
  needsModel?: boolean;
  ownerSave?: OwnerSavePolicy;
}

export interface FilterRules {
  /** The owner's choice for this exact file. */
  fileChoice: 'save' | 'never' | null;
  /** Hosts and folder prefixes. */
  deny: string[];
  allow: string[];
}
