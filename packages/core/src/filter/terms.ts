// The words the score looks for in the sampled pages. Patterns are plain data. Anything that matches is turned into a
// yes/no or a count in signals.ts, and only a fixed label ever leaves the filter.
//
// Regexes here have no `g` flag, so `.test` keeps no state between calls. Patterns are linear: no nested repeats.

import { isArxivId } from './validators';

// ---- positive evidence ----

/** Headings are matched line by line. */
const HEADING_ABSTRACT = /^[ \t]*(?:abstract|executive summary|résumé|zusammenfassung|resumen|riassunto|samenvatting|sommario)[ \t]*(?:[:.—–-]?[ \t]*$|[:.—–-][ \t]*\S)/im;
const HEADING_REFERENCES = /^[ \t]*(?:\d+\.?[ \t]*|[ivx]+\.[ \t]*)?(?:references|bibliography|works cited|literature cited|literaturverzeichnis|bibliographie|références|bibliografía|bibliografia|referenzen|literatur|literatuur|referencias)[ \t]*[:.]?[ \t]*$/im;
const HEADING_CHAPTER = /^[ \t]*(?:chapter|lecture|week|kapitel|chapitre|capítulo|capitulo|hoofdstuk|vorlesung|woche)[ \t]+\d+|^[ \t]*(?:table of )?(?:contents|inhaltsverzeichnis|inhalt|table des matières|sommaire|índice|inhoudsopgave)[ \t]*$/im;
const THESIS = /submitted in (?:partial )?fulfil?ment|doctor of philosophy|\bph\.?d\.? thesis|master'?s thesis|\bdissertation\b|thèse de doctorat|doktorarbeit|masterarbeit|bachelorarbeit|diplomarbeit|tesis doctoral/i;

const DOI = /(?<![\d.])10\.\d{4,9}\/[-._;()/:a-z0-9]+/i;
const ISBN = /\bISBN(?:-1[03])?:?\s?[0-9][-0-9 ]{9,16}[0-9x]\b/i;
// In text the literal "arXiv:" or an arxiv.org link is the evidence; the digits need no further check.
const ARXIV_TEXT = /arxiv:\s?\d{4}\.\d{4,5}|arxiv\.org\/(?:abs|pdf)\/\d{4}\.\d{4,5}(?!\d)|arxiv:\s?[a-z-]+(?:\.[a-z]{2})?\/\d{7}/i;
const ARXIV_NAME = /(?<![\d.])(\d{4}\.\d{4,5})(?:v\d+)?(?![\d])/g;

export const hasAbstractHeading = (t: string): boolean => HEADING_ABSTRACT.test(t);
export const hasReferencesHeading = (t: string): boolean => HEADING_REFERENCES.test(t);
export const hasChapterHeading = (t: string): boolean => HEADING_CHAPTER.test(t);
export const hasThesisWording = (t: string): boolean => THESIS.test(t);
export const hasDoi = (t: string): boolean => DOI.test(t);
export const hasIsbn = (t: string): boolean => ISBN.test(t);

/** An arXiv stamp or arxiv.org link in the text (new-style or old-style id). */
export const hasArxivInText = (t: string): boolean => ARXIV_TEXT.test(t);

/** A checked arXiv id in a file name, such as "2301.12345v2.pdf" or "arxiv-1706.03762-attention.pdf". */
export function hasArxivInName(name: string): boolean {
  for (const m of name.matchAll(ARXIV_NAME)) {
    if (isArxivId(m[1])) return true;
  }
  return false;
}

const CITATION = /\[\d{1,3}(?:[,–-]\s?\d{1,3})*\]|\([A-Z][A-Za-z'-]+(?: et al\.|(?: and| &) [A-Z][A-Za-z'-]+)?,? (?:19|20)\d{2}[a-z]?[);,]|\bet al\./g;
export function countCitations(t: string): number {
  return t.match(CITATION)?.length ?? 0;
}

const ACADEMIC_WORDS = /\b(?:theorem|lemma|proof|corollary|proposition|definition|exercise|problem set|lecture|chapter|equation|hypothesis|methodology|literature|empirical|estimat\w+|regression|figure|appendix|learning objectives|syllabus|tutorial|seminar|we show|we propose|in this paper|in this chapter|solution|satz|beweis|gleichung|théorème|démonstration|preuve|hypothèse|teorema|hipótesis)\b/gi;
export function academicWordCount(t: string): number {
  return t.match(ACADEMIC_WORDS)?.length ?? 0;
}

const MATH_SYMBOL = /[=∑∫∂√≤≥≈≠∞±∈∀∃αβγδεθλμπσφωΣΠΔΩ]/g;
export function mathSymbolCount(t: string): number {
  return t.match(MATH_SYMBOL)?.length ?? 0;
}

const LATEX_PRODUCER = /latex|pdftex|xetex|luatex|\btex\b|beamer/i;
export const isLatexProducer = (producer: string): boolean => LATEX_PRODUCER.test(producer);

// ---- evidence against ----

const CURRENCY = /(?:[£$€₹¥]|\b(?:USD|GBP|EUR|INR|CAD|CHF)\b)\s?\d[\d,.]*|\b\d[\d.,]*[.,]\d{2}\s?(?:€|EUR|\$|£)/g;
export function currencyCount(t: string): number {
  return t.match(CURRENCY)?.length ?? 0;
}

const GENERATOR_PRODUCER = /wkhtmltopdf|apache fop|itext|tcpdf|fpdf|reportlab|jasper|crystal reports|reporting services|bi publisher|stripe|odoo|antenna house|xsl formatter|sliced invoices|pypdf2|docraptor/i;
export const isGeneratorProducer = (producer: string): boolean => GENERATOR_PRODUCER.test(producer);

/** What a group of admin words says the PDF is. Each kind has a fixed "looks like" phrase in classify.ts. */
export type AdminKind =
  | 'invoice'
  | 'bank'
  | 'payslip'
  | 'tax'
  | 'ticket'
  | 'contract'
  | 'medical'
  | 'insurance'
  | 'letter'
  | 'cv'
  | 'personal';

export interface AdminGroup {
  id: string;
  kind: AdminKind;
  /** Chip wording for the signal. */
  label: string;
  /** Any one of these decides. */
  strong?: RegExp;
  /** Words that are also common in readings: the group counts only when `needed` distinct ones appear. */
  weak?: readonly RegExp[];
  needed?: number;
}

const w = (...parts: string[]): RegExp => new RegExp(parts.join('|'), 'i');

export const ADMIN_GROUPS: readonly AdminGroup[] = [
  {
    id: 'invoice-words', kind: 'invoice', label: 'Invoice or receipt wording',
    strong: w('\\binvoices?\\b', '\\breceipts?\\b', '\\bbill(?:ed)? to\\b', '\\bship(?:ped)? to\\b', '\\bsold to\\b', '\\border confirmation\\b', '\\bpacking slip\\b', '\\bcredit note\\b', '\\bpurchase order\\b', '\\bdelivery note\\b', 'penalty charge notice', 'thank you for your (?:order|purchase)'),
  },
  {
    id: 'reference-numbers', kind: 'invoice', label: 'Order, account or customer numbers',
    strong: w('(?:invoice|order|account|customer|booking|reference|confirmation|quote|quotation|estimate)\\s*(?:no\\.?|number|#|nr\\.?)'),
  },
  {
    id: 'amount-due', kind: 'invoice', label: 'Amount due',
    strong: w('amount due', 'balance due', 'total due', 'amount payable', 'amount to pay', 'total to pay', 'payment due', 'please pay'),
  },
  { id: 'subtotal', kind: 'invoice', label: 'Subtotal and totals', strong: w('\\bsub-?total\\b', '\\bgrand total\\b') },
  {
    id: 'payment-terms', kind: 'invoice', label: 'Payment terms',
    strong: w('payment (?:method|terms|due|details)', 'pay(?:ment)? within \\d+ days'),
  },
  {
    id: 'card-words', kind: 'invoice', label: 'Card payment wording',
    strong: w('card ending', 'mastercard', '\\bvisa\\b', 'card ?holder', 'card number', 'last 4 digits'),
  },
  {
    id: 'sales-tax', kind: 'invoice', label: 'VAT or sales tax',
    strong: w('\\bvat\\b', '\\bgst\\b', '\\btva\\b', '\\bmwst\\b', '\\bust\\b', '\\bbtw\\b', '\\biva\\b', '\\bsales tax\\b'),
  },
  {
    id: 'invoice-words-other-languages', kind: 'invoice', label: 'Invoice wording in another language',
    strong: w('rechnung', 'facture', 'factuur', 'quittung', 'kassenbon', 'fahrkarte', '\\bbeleg\\b', '\\brekening\\b', '\\bfactura\\b', '\\bfattura\\b', '\\brecibo\\b', '\\bscontrino\\b'),
  },
  {
    id: 'fees', kind: 'invoice', label: 'Fees and amounts owing',
    weak: [/tuition fees?/i, /student (?:number|id|reference)/i, /fee (?:schedule|statement)/i, /amount (?:owing|outstanding)/i, /outstanding balance/i, /remittance/i, /payable to/i],
    needed: 2,
  },
  {
    id: 'utility-words', kind: 'invoice', label: 'Bill wording',
    weak: [/meter (?:reading|number)/i, /\bkwh\b/i, /standing charge/i, /\btariff\b/i, /\bmpan\b|\bmprn\b/i, /unit rate/i, /supply address/i, /your bill/i],
    needed: 2,
  },
  {
    id: 'travel-words', kind: 'ticket', label: 'Ticket or boarding pass wording',
    strong: w('boarding pass', '\\bpnr\\b', 'e-?ticket', 'booking ref(?:erence)?', 'booking confirmation', 'reservation (?:number|no\\b|code)'),
    weak: [/\bgate\b/i, /\bseat\b/i, /\bflight\b/i, /\bdeparture\b/i, /\barrival\b/i, /\bpassenger\b/i, /\bitinerary\b/i, /check-?in\b/i, /check-?out\b/i],
    needed: 2,
  },
  {
    id: 'bank-words', kind: 'bank', label: 'Bank statement wording',
    strong: w('statement (?:date|period)', 'sort code', '\\biban\\b', '\\bswift code\\b', 'bic/swift', 'opening balance', 'closing balance', 'available balance', 'direct debit', 'balance brought forward', 'overdraft', 'kontoauszug', 'kontostand', 'relevé de compte', 'extracto bancario', 'estratto conto'),
  },
  {
    id: 'payslip-words', kind: 'payslip', label: 'Payslip wording',
    strong: w('pay ?slip', 'pay statement', 'net pay', 'gross pay', 'national insurance', 'tax code', '\\bpaye\\b', '\\bytd\\b', '\\bp60\\b', '\\bp45\\b', 'gehaltsabrechnung', 'bulletin de (?:paie|salaire)', 'loonstrook'),
    weak: [/\bdeductions\b/i, /year[- ]to[- ]date/i],
    needed: 2,
  },
  {
    id: 'tax-words', kind: 'tax', label: 'Tax form wording',
    strong: w('omb no', 'internal revenue service', '\\bhmrc\\b', 'self assessment', '\\butr\\b', 'social security number'),
    weak: [/taxpayer/i, /tax return/i, /\bw-?2\b/i, /\b1099\b/i],
    needed: 2,
  },
  {
    id: 'contract-parties', kind: 'contract', label: 'Contract wording',
    weak: [/\blandlord\b/i, /\btenant\b/i, /\blessor\b/i, /\blessee\b/i, /\blicensor\b/i, /\blicensee\b/i, /the parties/i, /the employer\b/i, /the employee\b/i, /the buyer\b/i, /the seller\b/i, /\bvermieter\b/i, /\bmieter\b/i, /\bbailleur\b/i, /\blocataire\b/i, /\barrendador\b/i, /\binquilino\b/i],
    needed: 2,
  },
  {
    id: 'contract-formalities', kind: 'contract', label: 'Signing and witness wording',
    strong: w('hereinafter', 'in witness whereof', 'signature of', 'witness(?:ed)? by', 'executed as a deed', 'envelope id', 'certificate of completion', 'electronically signed', 'tenancy agreement', 'assured shorthold', 'mietvertrag', 'contrat de location', 'contrato de arrendamiento', 'arbeitsvertrag', 'contrat de travail'),
    weak: [/\bsignatory\b/i, /\bwhereas\b/i, /\bsigned by\b/i, /\bsignature\b/i, /date of signing/i],
    needed: 3,
  },
  {
    id: 'contract-clauses', kind: 'contract', label: 'Contract clauses',
    weak: [/this agreement/i, /governing law/i, /governed by the law/i, /terms and conditions/i, /\bnotice period\b/i, /\bindemnif/i, /\bdeposit\b/i, /\bprobation\b/i, /\btermination\b/i, /\bconfidentiality\b/i],
    needed: 3,
  },
  {
    id: 'loan-words', kind: 'contract', label: 'Loan or mortgage wording',
    weak: [/\bmortgage\b/i, /loan agreement/i, /\bapr\b/i, /monthly repayments?/i, /\bborrower\b/i, /\blender\b/i, /outstanding balance/i, /\bmonthly payment\b/i],
    needed: 3,
  },
  {
    id: 'letter-words', kind: 'letter', label: 'Letter wording',
    strong: w('dear (?:sir|madam|mr|mrs|ms|dr|hiring|sirs)', 'yours (?:sincerely|faithfully)', 'i am writing to (?:apply|enquire|inquire|complain|confirm|inform)', 'please find enclosed', 'we (?:are pleased|regret) to inform you', 'kind regards'),
  },
  {
    id: 'cv-words', kind: 'cv', label: 'CV wording',
    strong: w('curriculum vitae', 'references available (?:on|upon) request', 'career objective'),
  },
  {
    id: 'personal-details', kind: 'personal', label: 'Personal details',
    weak: [/date of birth/i, /place of birth/i, /nationality/i, /marital status/i, /passport (?:no|number)/i, /home address/i, /telephone number/i, /driving licen[cs]e/i],
    needed: 2,
  },
  {
    id: 'student-record', kind: 'personal', label: 'Student record wording',
    strong: w('transcript of (?:results|records|marks)', 'academic transcript', 'degree certificate', 'statement of results'),
    weak: [/student (?:number|id)\b/i, /date of birth/i, /registration number/i, /\bcredits\b/i, /degree classification/i, /\bgrade\b/i],
    needed: 3,
  },
  {
    id: 'medical-words', kind: 'medical', label: 'Medical or lab wording',
    weak: [/specimen/i, /reference range/i, /sample (?:collected|received|date)/i, /nhs number/i, /hospital number/i, /patient (?:name|id|number|details)/i, /date of birth/i, /referring (?:doctor|clinician)/i, /requested by/i],
    needed: 2,
  },
  {
    id: 'insurance-words', kind: 'insurance', label: 'Insurance wording',
    weak: [/policy (?:number|no\b|holder|schedule|document)/i, /policyholder/i, /\binsured\b/i, /\binsurer\b/i, /\bpremium\b/i, /\bexcess\b/i, /claim (?:number|no\b|reference)/i, /\brenewal\b/i, /sum insured/i, /underwritten by/i],
    needed: 3,
  },
];

// A CV is a private document: contact details, a name, and sections such as Education and Experience. Evidence is added
// up in points. Section headings are matched as whole lines, so a word inside a sentence never counts.
const CV_STRONG_HEADING = /^[ \t]*(?:work experience|professional experience|relevant experience|employment history|work history|employment|experience|professional summary|career summary|career objective|personal details|personal profile|personal statement|volunteer(?:ing)? experience|key skills|technical skills|referees?)[ \t]*:?[ \t]*$/gim;
const CV_SUPPORT_HEADING = /^[ \t]*(?:education|skills|languages|interests|hobbies|certifications|awards|publications|achievements|profile)[ \t]*:?[ \t]*$/gim;
const CV_TITLE = /^[ \t]*(?:curriculum vitae|cv|r\u00e9sum\u00e9|resume)[ \t]*$/im;
const CONTACT_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const CONTACT_PHONE = /\b(?:tel|telephone|phone|mobile|mob|cell)\b[.:]?\s*\(?\+?\d[\d ()-]{6,}\d|\+\d{1,3}[ -]?\(?\d{1,4}\)?[ -]?\d[\d -]{5,}\d/i;
const CONTACT_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b|\b[A-Z]{2} \d{5}(?:-\d{4})?\b/;
const CONTACT_PROFILE = /linkedin\.com\/in\//i;
/** A CV is rarely longer than this; a long document with a few CV-like headings is a book or a report. */
const CV_MAX_PAGES = 15;
const CV_POINTS = 4;

export interface CvEvidence {
  /** Looks like a CV: no score may save it. */
  cvLike: boolean;
  /** Some CV signs, not enough to decide. A "References" heading then probably lists referees. */
  hinted: boolean;
}

/**
 * @param frontPage the text of page 1, where a CV carries its name and contact block
 * @param text the whole sample
 * @param adminIds ids of the admin groups that matched (`cv-words` is the words "curriculum vitae" or similar)
 */
export function cvEvidence(frontPage: string, text: string, pageCount: number, adminIds: ReadonlySet<string>): CvEvidence {
  if (adminIds.has('cv-words')) return { cvLike: true, hinted: true };
  const strong = new Set<string>();
  for (const m of text.matchAll(CV_STRONG_HEADING)) strong.add(m[0].trim().toLowerCase().replace(/:$/, ''));
  const support = new Set<string>();
  for (const m of text.matchAll(CV_SUPPORT_HEADING)) support.add(m[0].trim().toLowerCase().replace(/:$/, ''));
  const sections = 2 * strong.size + support.size + (CV_TITLE.test(frontPage) ? 3 : 0);
  const contact =
    Number(CONTACT_EMAIL.test(frontPage)) +
    Number(CONTACT_PHONE.test(frontPage)) +
    Number(CONTACT_POSTCODE.test(frontPage)) +
    Number(CONTACT_PROFILE.test(frontPage));
  const points = sections + contact;
  const short = pageCount <= CV_MAX_PAGES;
  return { cvLike: short && sections >= 1 && points >= CV_POINTS, hinted: short && sections >= 1 && points >= CV_POINTS - 1 };
}

/** True when the group matches the text. */
export function groupMatches(g: AdminGroup, text: string): boolean {
  if (g.strong?.test(text)) return true;
  if (!g.weak) return false;
  const needed = g.needed ?? 2;
  let n = 0;
  for (const re of g.weak) {
    if (re.test(text) && ++n >= needed) return true;
  }
  return false;
}
