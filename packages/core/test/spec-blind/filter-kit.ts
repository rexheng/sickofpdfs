// Shared helpers for the spec-blind learning-filter tests (packages/core/src/filter/*.spec-blind.test.ts).
// Test code only: nothing in src/ imports this file.
//
// It imports only TYPES from src/filter, so a test file that needs one function (hard blocks before the classifier exists)
// loads without the others. Each test imports its function straight from the module the plan names:
//   detectHardBlocks from ./hard-blocks (S1), classify from ./classify and nudge from ./nudge (S2).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FilterDecision, FilterInput, FilterRules, HardBlock } from '../../src/filter/types';

export type { FilterDecision, FilterInput, FilterRules, HardBlock };

/** The one place that turns loose test data into the filter's input type (an `unknown` cast is never "unnecessary", whatever the type says). */
export const asInput = (v: unknown): FilterInput => v as FilterInput;

export const ALL_HARD_BLOCKS: readonly HardBlock[] = ['card', 'iban', 'sort-code-account', 'ni-number', 'ssn', 'utr', 'passport-line', 'boarding-pass'];

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// ---------------------------------------------------------------------------------------------------------------------
// Rules

export const NO_RULES: FilterRules = { fileChoice: null, deny: [], allow: [] };
export const rulesOf = (over: Partial<FilterRules> = {}): FilterRules => ({ ...NO_RULES, ...over });

// ---------------------------------------------------------------------------------------------------------------------
// Synthetic inputs
//
// The neutral filler below is plain prose that none of the spec's signals looks for: no heading words, no academic or
// admin vocabulary, no digits, no symbols. A page of it plus nothing else scores exactly the starting −1 (for a document of
// 3 to 7 pages with no link and no metadata). PDFium puts "\r\n" between lines, so the helpers do too.

const FILLER_LINES = [
  'The morning was quiet in the garden. A kettle whistled somewhere beyond the window and the cat slept on the warm stone',
  'by the door. Nobody hurried. The path wound past the old apple tree, then the shed, then the long hedge where the',
  'sparrows argued every day. By noon the clouds had drifted east and the sun lay flat across the lawn. Neighbours waved',
  'over the fence, talked about the weather, and went back to their tea. It was an ordinary day, and the street was glad',
  'of it. Later the light turned gold, the martins came low over the roofs, and somebody started to sing in the kitchen.',
];
export const FILLER_PAGE = FILLER_LINES.join('\r\n');
export const LINE_END = '\r\n';
export const lines = (...ls: string[]): string => ls.join(LINE_END);

/** n sampled pages of neutral text: the first and last 5 pages of an n-page document (at most 10 entries). */
export const fillerPages = (pageCount: number): string[] => Array.from({ length: Math.min(Math.max(pageCount, 0), 10) }, () => FILLER_PAGE);

export interface Spec {
  url?: string | null;
  fileName?: string;
  viaPage?: string | null;
  pageCount?: number;
  /** One size for every page (default US Letter portrait). */
  pageSize?: { width: number; height: number };
  metadata?: Partial<Record<'title' | 'author' | 'subject' | 'keywords' | 'creator' | 'producer', string | null>>;
  formType?: 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground';
  /** Text that replaces the first sampled pages; the rest of the sample stays neutral filler. */
  pages?: string[];
  /** Text appended to the first sampled page (a heading near the top, a DOI, an arXiv stamp). */
  first?: string;
  /** Text appended to the last sampled page (a References heading, a signature block). */
  last?: string;
  /** The whole sample, if you want full control (replaces `pages`, `first`, `last` and the filler). */
  sampleText?: string[];
}

export function mkInput(spec: Spec = {}): FilterInput {
  const pageCount = spec.pageCount ?? 4;
  const size = spec.pageSize ?? { width: 612, height: 792 };
  const sample = spec.sampleText ?? fillerPages(pageCount).map((filler, i) => spec.pages?.[i] ?? filler);
  if (!spec.sampleText && sample.length > 0) {
    if (spec.first) sample[0] = `${spec.first}${LINE_END}${sample[0] ?? ''}`;
    if (spec.last) sample[sample.length - 1] = `${sample[sample.length - 1] ?? ''}${LINE_END}${spec.last}`;
  }
  const input = {
    url: spec.url ?? null,
    fileName: spec.fileName ?? 'document.pdf',
    pageCount,
    pageSizes: Array.from({ length: pageCount }, () => ({ ...size, rotation: 0 })),
    metadata: { title: null, author: null, subject: null, keywords: null, creator: null, producer: null, pdfId: null, ...spec.metadata },
    sampleText: sample,
    ...(spec.viaPage !== undefined ? { viaPage: spec.viaPage } : {}),
    ...(spec.formType !== undefined ? { formType: spec.formType } : {}),
  };
  return asInput(input);
}

/** A link on a scholarly site that carries no arXiv-style id, so a test that adds a site (+3) does not also add an id. */
export const SCHOLARLY_URL = 'https://arxiv.org/pdf/example-paper';

export const LATEX = { producer: 'pdfTeX-1.40.25', creator: 'LaTeX with hyperref' };

/** Recursively freezes a value, so a function that writes to its input throws (ES modules are strict). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export const wordCount = (texts: readonly string[]): number => texts.join(' ').split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------------------------------------------------------------
// Independent checksum helpers, used only to prove that the test vectors are what the tests say they are.

export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function ibanValid(iban: string): boolean {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /[A-Z]/.test(ch) ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = (rem * (v > 9 ? 100 : 10) + v) % 97;
  }
  return rem === 1;
}

// ---------------------------------------------------------------------------------------------------------------------
// Real fixtures: the manifest (committed) and the inputs the browser extractor wrote (gitignored)

export interface ManifestItem {
  path: string;
  label: 'learning' | 'not-learning';
  pages: number;
  url: string;
  source_page: string;
  type: string;
  edge_case: boolean;
}

export const MANIFEST: ManifestItem[] = (JSON.parse(readFileSync(`${REPO_ROOT}docs/research/classifier-fixtures/manifest.json`, 'utf8')) as { items: ManifestItem[] }).items;

export interface FixtureRecord {
  path: string;
  label: 'learning' | 'not-learning';
  sourceUrl: string;
  pageCount: number;
  pageSizes: Array<{ width: number; height: number; rotation: number }>;
  metadata: { title: string | null; author: string | null; subject: string | null; keywords: string | null; creator: string | null; producer: string | null; pdfId: string | null };
  formType: 'none' | 'acroform' | 'xfa-full' | 'xfa-foreground';
  sampledPageIndexes: number[];
  /** Words in the first and last 5 pages alone (the second-look test). */
  firstLastWords: number;
  /** True when those pages held fewer than 15 words and up to 10 middle pages were added (spec, "Decided while building the filter"). */
  secondLook: boolean;
  sampleText: string[];
}

const INPUT_DIR = process.env.SOP_FILTER_INPUTS ?? `${REPO_ROOT}test-assets/spec-blind/filter-inputs`;
export const EXTRACT_HINT =
  'The real-fixture inputs are missing. Run `pnpm fixtures`, then ' +
  '`pnpm vitest run --project browser packages/viewer/test/spec-blind/filter-inputs.spec-blind.browser.test.ts` ' +
  '(it writes test-assets/spec-blind/filter-inputs/**/*.json with PDFium text).';

const cache = new Map<string, FixtureRecord>();
export function fixtureRecord(item: ManifestItem): FixtureRecord {
  const hit = cache.get(item.path);
  if (hit) return hit;
  const file = `${INPUT_DIR}/${item.path}.json`;
  if (!existsSync(file)) throw new Error(`${item.path}: ${EXTRACT_HINT}`);
  const rec = JSON.parse(readFileSync(file, 'utf8')) as FixtureRecord;
  cache.set(item.path, rec);
  return rec;
}

/**
 * Two ways the owner meets a file:
 * - 'content-only': only what is inside the PDF (the research's "honest baseline": no link, a neutral file name).
 * - 'with-source': the link it came from (the manifest url), the file name Chrome would give it, and the page it was linked from.
 */
export type SourceMode = 'content-only' | 'with-source';
export const SOURCE_MODES: SourceMode[] = ['content-only', 'with-source'];

function fileNameFromUrl(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'document');
  return /\.pdf$/i.test(last) ? last : `${last}.pdf`;
}

export function fixtureInput(item: ManifestItem, mode: SourceMode): FilterInput {
  const r = fixtureRecord(item);
  const base = { pageCount: r.pageCount, pageSizes: r.pageSizes, metadata: r.metadata, formType: r.formType, sampleText: r.sampleText };
  const input =
    mode === 'content-only'
      ? { ...base, url: null, fileName: 'document.pdf' }
      : { ...base, url: item.url, fileName: fileNameFromUrl(item.url), viaPage: item.source_page };
  return asInput(input);
}

export const baseName = (item: ManifestItem): string => item.path.split('/').pop() ?? item.path;
export const LEARNING = MANIFEST.filter((i) => i.label === 'learning');
export const NOT_LEARNING = MANIFEST.filter((i) => i.label === 'not-learning');

/** Every run of `len` characters in the whitespace-normalised input text (for "a reason copies nothing from the PDF"). */
export function windows(texts: readonly string[], len: number): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    const s = t.replace(/\s+/g, ' ');
    for (let i = 0; i + len <= s.length; i++) out.add(s.slice(i, i + len));
  }
  return out;
}

/** Text-bearing string fields of a FilterInput, for leak checks. */
export function inputStrings(input: FilterInput): string[] {
  const m = input.metadata as unknown as Record<string, string | null>;
  return [...input.sampleText, input.fileName, input.url ?? '', input.viaPage ?? '', ...Object.values(m).filter((v): v is string => typeof v === 'string')];
}
