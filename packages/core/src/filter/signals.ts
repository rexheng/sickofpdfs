// Turns a FilterInput into evidence: a list of weighted signals and the score they add up to. Weights are the spec's
// table. The score starts at -1, so an unknown PDF needs evidence. Nothing here keeps text: the output is fixed labels,
// numbers, and yes/no flags.

import {
  classifyHost,
  nameWords,
  parseLink,
  type HostClass,
  type LinkParts,
} from './hosts';
import {
  ADMIN_GROUPS,
  academicWordCount,
  labelKind,
  labelPoints,
  countCitations,
  cvEvidence,
  currencyCount,
  groupMatches,
  hasAbstractHeading,
  hasArxivInName,
  hasArxivInText,
  hasChapterHeading,
  hasDoi,
  hasIsbn,
  hasReferencesHeading,
  hasThesisWording,
  isGeneratorProducer,
  isLatexProducer,
  mathSymbolCount,
  type AdminKind,
} from './terms';
import { capField, capPages } from './limits';
import type { FilterInput, FilterPageSize, FilterSignal } from './types';

export const BIAS = -1;
/** Fewer words than this in the sampled pages means a scan or an image-only file. */
export const NO_TEXT_WORDS = 15;
/** Admin term groups stop counting after this many. */
const ADMIN_CAP = 5;

// soft hyphen, zero-width space, non-joiner, joiner, word joiner and byte-order mark
const INVISIBLE = new RegExp([0xad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join('|'), 'g');
const WORD = /[\p{L}\p{N}]+/gu;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/** The sampled pages, cut to the limits in limits.ts and tidied for matching. */
export function normalizePages(sample: readonly string[]): string[] {
  return capPages(sample).map((page) => page.normalize('NFKC').replaceAll(/\r\n?|\f/g, '\n').replaceAll(INVISIBLE, ''));
}

export function countWords(text: string): number {
  const latin = text.match(WORD)?.length ?? 0;
  // a run of Chinese, Japanese or Korean characters is one "word" to the pattern above; count about two per word
  const cjk = text.match(CJK)?.length ?? 0;
  return latin + Math.floor(cjk / 2);
}

export interface Evidence {
  signals: FilterSignal[];
  /** BIAS plus every signal's weight. */
  score: number;
  /** The sum of the positive weights only. */
  positive: number;
  words: number;
  pages: string[];
  link: LinkParts | null;
  via: LinkParts | null;
  host: HostClass;
  /** Kinds of admin wording found, most groups first. */
  adminKinds: AdminKind[];
  nameNegative: boolean;
  /** Course words in the link, file name or title. */
  courseName: boolean;
  /** Slide-deck page shape with 10 or more pages. */
  deck: boolean;
  receiptRoll: boolean;
  xfa: boolean;
  /** Flags the rules use. References is false for a CV, whose "References" heading means referees. */
  arxiv: boolean;
  doi: boolean;
  abstract: boolean;
  references: boolean;
  /** Looks like a CV: a private document whatever else it cites. */
  cvLike: boolean;
}

function shown(p: FilterPageSize | undefined): { w: number; h: number } | null {
  if (!p || !(p.width > 0) || !(p.height > 0)) return null;
  return p.rotation === 90 || p.rotation === 270 ? { w: p.height, h: p.width } : { w: p.width, h: p.height };
}

function slideShape(p: { w: number; h: number } | null): boolean {
  if (!p || p.w <= p.h) return false;
  const r = p.w / p.h;
  return Math.abs(r - 4 / 3) < 0.05 || Math.abs(r - 16 / 9) < 0.06 || Math.abs(r - 1.6) < 0.04;
}

function mergeHost(a: HostClass, b: HostClass): HostClass {
  return {
    scholarly: a.scholarly || b.scholarly,
    lms: a.lms || b.lms,
    academic: a.academic || b.academic,
    negative: a.negative || b.negative,
  };
}

/** When two kinds tie, the more specific one comes first. */
const KIND_ORDER: readonly AdminKind[] = ['tax', 'payslip', 'bank', 'ticket', 'contract', 'medical', 'insurance', 'cv', 'letter', 'personal'];

/**
 * The kind of admin wording the chip should name. Invoice or receipt is the general fallback: it labels the chip only when
 * nothing more specific matched. Among the specific kinds, each group adds its `points` (tax-authority wording counts 6,
 * the others 2 or 1), and ties go to the order above.
 */
export function rankKinds(entries: readonly { kind: AdminKind; points: number }[]): AdminKind[] {
  const points = new Map<AdminKind, number>();
  for (const e of entries) if (e.kind !== 'invoice') points.set(e.kind, (points.get(e.kind) ?? 0) + e.points);
  if (points.size === 0) return entries.length ? ['invoice'] : [];
  return [...points.keys()].sort((a, b) => (points.get(b) as number) - (points.get(a) as number) || KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b));
}

export function gatherEvidence(input: FilterInput): Evidence {
  const pages = normalizePages(input.sampleText);
  const head = pages.slice(0, 5).join('\n');
  const front = pages.slice(0, 2).join('\n');
  const text = pages.join('\n');
  const words = countWords(text);
  const pageCount = input.pageCount > 0 ? input.pageCount : pages.length;

  const link = parseLink(input.url);
  const via = parseLink(input.viaPage);
  const host = mergeHost(classifyHost(link), classifyHost(via));
  const fileName = capField(input.fileName);
  const name = nameWords(link, fileName, capField(input.metadata.title));
  const producer = `${capField(input.metadata.creator)} ${capField(input.metadata.producer)}`;
  const first = shown(input.pageSizes[0]);

  const signals: FilterSignal[] = [];
  const add = (id: string, weight: number, label: string): void => {
    if (weight !== 0) signals.push({ id, weight, label });
  };

  // ---- the link and file name ----
  const arxivName = hasArxivInName(fileName);
  if (host.scholarly) add('host-scholarly', 3, 'Scholarly website');
  else if (host.lms) add('host-lms', 2, 'Course website');
  else if (host.academic) add('host-academic', 1, 'University website');
  if (host.negative) add('host-negative', -4, 'Bank, shop, airline or tax website');
  if (name.negative) add('name-negative', -2, 'Paperwork words in the link, file name or title');
  if (name.course) add('name-course', 1, 'Course words in the link, file name or title');
  if (arxivName) add('arxiv-name', 3, 'arXiv number in the file name');

  // ---- text ----
  const arxivText = hasArxivInText(text);
  if (arxivText) add('arxiv-text', 4, 'arXiv number');
  const doi = hasDoi(text);
  if (doi) add('doi', 2, 'DOI');
  const abstract = hasAbstractHeading(front);
  if (abstract) add('abstract', 2, 'Abstract');

  const matched = ADMIN_GROUPS.filter((g) => groupMatches(g, text));
  const cv = cvEvidence(pages[0] ?? '', text, pageCount, new Set(matched.map((g) => g.id)));
  const references = hasReferencesHeading(text) && !cv.hinted;
  if (references) add('references', 2.5, 'References section');
  if (hasThesisWording(head)) add('thesis', 2, 'Thesis wording');
  if (hasChapterHeading(head)) add('chapter', 1.5, 'Chapter, lecture or contents headings');
  if (hasIsbn(text)) add('isbn', 1.5, 'ISBN');

  const cites = countCitations(text);
  if (cites >= 20) add('citations', 2.5, 'Many citations');
  else if (cites >= 5) add('citations', 1.5, 'Citations');

  const vocab = (1000 * academicWordCount(text)) / Math.max(1, words);
  if (vocab >= 8) add('vocabulary', 2, 'Academic wording');
  else if (vocab >= 3) add('vocabulary', 1, 'Academic wording');

  const math = (100 * mathSymbolCount(text)) / Math.max(1, text.length);
  if (math >= 1.5) add('math', 1.5, 'Maths symbols');
  else if (math >= 0.5) add('math', 1, 'Maths symbols');

  // ---- the file itself ----
  if (isLatexProducer(producer)) add('latex', 1.5, 'Made with LaTeX');
  if (isGeneratorProducer(producer)) add('generator', -1, 'Made by invoice or report software');

  if (pageCount >= 100) add('pages', 2.5, `${pageCount} pages`);
  else if (pageCount >= 30) add('pages', 2, `${pageCount} pages`);
  else if (pageCount >= 8) add('pages', 1, `${pageCount} pages`);
  else if (pageCount <= 2) add('pages', -1, pageCount === 1 ? 'Only 1 page' : 'Only 2 pages');

  const receiptRoll = first !== null && (first.w < 300 || first.h / first.w > 2.2);
  if (receiptRoll) add('receipt-roll', -2, 'Receipt-roll page shape');
  const deck = slideShape(first) && pageCount >= 10;
  if (deck) add('slides', 1, 'Slide-deck page shape');
  const xfa = input.formType === 'xfa-full' || input.formType === 'xfa-foreground';
  if (xfa) add('xfa-form', -2, 'Tax-form file type');

  // ---- evidence against ----
  // At most ADMIN_CAP groups count against the PDF; when more matched, the ones that say most about what it is come first
  const counted = [...matched].sort((a, b) => labelPoints(b) - labelPoints(a)).slice(0, ADMIN_CAP);
  for (const g of counted) add(labelKind(g, text) === g.kind ? `admin:${g.id}` : `admin:${g.id}:plain`, -1, g.label);

  const money = (1000 * currencyCount(text)) / Math.max(1, words);
  if (money >= 30) add('currency', -3, 'Many money amounts');
  else if (money >= 15) add('currency', -2, 'Many money amounts');
  else if (money >= 5) add('currency', -1, 'Money amounts');

  const adminKinds = rankKinds(matched.map((g) => ({ kind: labelKind(g, text), points: labelPoints(g) })));

  let score = BIAS;
  let positive = 0;
  for (const s of signals) {
    score += s.weight;
    if (s.weight > 0) positive += s.weight;
  }

  return {
    signals,
    score,
    positive,
    words,
    pages,
    link,
    via,
    host,
    adminKinds,
    nameNegative: name.negative,
    courseName: name.course,
    deck,
    receiptRoll,
    xfa,
    arxiv: arxivText || arxivName,
    doi,
    abstract,
    references,
    cvLike: cv.cvLike,
  };
}
