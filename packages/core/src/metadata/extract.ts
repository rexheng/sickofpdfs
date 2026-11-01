// What a saved PDF is called and who wrote it (Phase 3, S4): title, authors, year, DOI and arXiv id, from the PDF's Info fields,
// the first two pages' text, the link it came from and its file name. Nothing here asks the network: an id found in the text is
// only an id (the online lookups of S12 can use it later, when the owner turns them on).
//
// Pure and synchronous; it never throws. Everything it reads is untrusted text, and it returns plain strings only.
import { chooseTitle, normalizeText, pageLines, titleFromFileName } from './titles';

export interface MetadataInput {
  fileName: string;
  /** The link the PDF came from (http(s), file or blob), or null. */
  url: string | null;
  /** The PDF's Info fields. The viewer's `PdfMetadata` fits. */
  metadata: { title?: string | null; author?: string | null };
  firstPageText: string;
  secondPageText?: string;
  /** Unix ms, only to know the latest year that makes sense. Defaults to the current time. */
  now?: number;
}

export interface ExtractedMetadata {
  /** Null when the PDF has no usable title, page 1 shows none and the file name is no help: the library then shows the file name. */
  title: string | null;
  authors: string[];
  year: number | null;
  /** Lower case, as `10.1371/journal.pone.0000308`. */
  doi: string | null;
  /** Without the version, as `1706.03762` or `hep-th/9901001`. */
  arxivId: string | null;
}

const MAX_AUTHORS = 100;

// ---- arXiv ids -------------------------------------------------------------------------------------------------------

const NEW_ID = '\\d{4}\\.\\d{4,5}';
const OLD_ID = '[a-z]+(?:-[a-z]+)*(?:\\.[A-Za-z]{2})?\\/\\d{7}';

/** `YYMM.NNNN` (until 1412) or `YYMM.NNNNN` (from 1501), month 01 to 12, from April 2007. */
function validNewId(id: string): boolean {
  const m = /^(\d{2})(\d{2})\.(\d{4,5})$/.exec(id);
  if (!m) return false;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const ym = yy * 100 + mm;
  if (mm < 1 || mm > 12 || ym < 704) return false;
  return (m[3] ?? '').length === (ym <= 1412 ? 4 : 5);
}

const validOldId = (id: string): boolean => /^[a-z]+(?:-[a-z]+)*(?:\.[A-Za-z]{2})?\/\d{7}$/.test(id) && Number(id.slice(-7, -5)) <= 99 && Number(id.slice(-5, -3)) >= 1 && Number(id.slice(-5, -3)) <= 12;

function pickArxivId(re: RegExp, text: string): string | null {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  for (const m of text.matchAll(new RegExp(re.source, flags))) {
    const id = m[1] ?? '';
    if (validNewId(id) || validOldId(id)) return id;
  }
  return null;
}

function arxivFromUrl(url: string | null): string | null {
  if (!url) return null;
  const u = safeDecode(url);
  if (!/^[a-z][a-z0-9+.-]*:\/\/(?:[^/]*\.)?arxiv\.org\//i.test(u)) return null;
  return pickArxivId(new RegExp(`\\/(?:abs|pdf|html|format)\\/(${NEW_ID}|${OLD_ID})(?:v\\d+)?(?=[./?#]|$)`, 'i'), u);
}

function arxivFromText(text: string): string | null {
  return pickArxivId(new RegExp(`arxiv\\s*:\\s*(${NEW_ID}|${OLD_ID})(?:v\\d+)?`, 'i'), text);
}

function arxivFromFileName(fileName: string): string | null {
  const name = safeDecode(fileName.split(/[\\/]/).pop() ?? '');
  const labelled = pickArxivId(new RegExp(`arxiv[\\s_-]*(${NEW_ID}|${OLD_ID.replace('\\/', '[_/]')})(?:v\\d+)?`, 'i'), name);
  if (labelled) return labelled.replace('_', '/');
  // a bare id as the whole name or as a word of it: "1706.03762.pdf", "1706.03762v5.pdf", "attention-1706.03762.pdf"
  return pickArxivId(new RegExp(`(?<![\\d.])(${NEW_ID})(?:v\\d+)?(?![\\d])`), name);
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---- DOIs ------------------------------------------------------------------------------------------------------------

const DOI_BODY = '10\\.\\d{4,9}\\/[^\\s"<>]+';

/** Takes trailing punctuation and an unmatched closing bracket off a DOI found in running text. */
function trimDoi(raw: string): string | null {
  let d = raw;
  for (;;) {
    const before = d;
    d = d.replace(/[.,;:'’”"\]}]+$/, '');
    if (d.endsWith(')') && (d.match(/\(/g) ?? []).length < (d.match(/\)/g) ?? []).length) d = d.slice(0, -1);
    if (d === before) break;
  }
  return /^10\.\d{4,9}\/[^\s]*[A-Za-z0-9]/.test(d) && d.length <= 200 ? d.toLowerCase() : null;
}

function doiFromUrl(url: string | null): string | null {
  if (!url) return null;
  const u = safeDecode(url).split('#')[0] ?? '';
  const m = new RegExp(`(?:^|[/=?&])(${DOI_BODY})`, 'i').exec(u);
  if (!m) return null;
  const body = (m[1] ?? '').split(/[?&]/)[0] ?? '';
  return trimDoi(body.replace(/\.pdf$/i, '').replace(/\/(?:pdf|epdf|full|abstract|fulltext|summary)$/i, ''));
}

/** A DOI with a marker in front of it ("doi:", "DOI ", "doi.org/"), which is almost always the paper's own. */
function markedDoi(lines: readonly string[]): string | null {
  const re = new RegExp(`(?:\\bdoi\\s*[:=]?\\s*|doi\\.org\\/|\\bDOI\\s+)(${DOI_BODY})`, 'i');
  for (const line of lines) {
    const m = re.exec(line);
    const d = m ? trimDoi(m[1] ?? '') : null;
    if (d) return d;
  }
  return null;
}

function bareDoi(lines: readonly string[]): string | null {
  const re = new RegExp(`(?<![\\w/.])(${DOI_BODY})`);
  for (const line of lines) {
    const m = re.exec(line);
    const d = m ? trimDoi(m[1] ?? '') : null;
    if (d) return d;
  }
  return null;
}

// ---- year ------------------------------------------------------------------------------------------------------------

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_YEAR = [
  new RegExp(`\\b${MONTH}\\.?\\s+(?:\\d{1,2}(?:st|nd|rd|th)?,?\\s+)?((?:19|20)\\d{2})\\b`, 'i'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+((?:19|20)\\d{2})\\b`, 'i'),
  /\b((?:19|20)\d{2})-\d{2}-\d{2}\b/,
];

function arxivYear(id: string): number | null {
  const m = /^(\d{2})\d{2}\.\d{4,5}$/.exec(id);
  if (m) return 2000 + Number(m[1]);
  const o = /\/(\d{2})\d{5}$/.exec(id);
  if (o) return Number(o[1]) >= 91 ? 1900 + Number(o[1]) : 2000 + Number(o[1]);
  return null;
}

function yearFromLines(lines: readonly string[], arxivId: string | null, maxYear: number): number | null {
  const ok = (y: number): boolean => Number.isInteger(y) && y >= 1900 && y <= maxYear;
  const first = lines.slice(0, 30);
  // "Citation: Piwowar HA, Day RS (2007) Sharing ..."
  for (const l of lines.slice(0, 40)) {
    const m = /^citation\b.*?\(((?:19|20)\d{2})\)/i.exec(l) ?? /^cite (?:this|as)\b.*?\(((?:19|20)\d{2})\)/i.exec(l);
    if (m && ok(Number(m[1]))) return Number(m[1]);
  }
  const fromId = arxivId ? arxivYear(arxivId) : null;
  if (fromId !== null && ok(fromId)) return fromId;
  // "© 2024 Sheldon Axler", "Copyright c 2013 by ...", "Copyright (C) 2006"
  for (const l of lines.slice(0, 60)) {
    const m = /(?:copyright|©|\(c\))\s*(?:\(?c\)?\s+)?(?:by\s+)?((?:19|20)\d{2})\b/i.exec(l);
    if (m && ok(Number(m[1]))) return Number(m[1]);
  }
  for (const l of first) {
    for (const re of DATE_YEAR) {
      const m = re.exec(l);
      if (m && ok(Number(m[1]))) return Number(m[1]);
    }
  }
  for (const l of lines.slice(0, 12)) {
    const m = /[([]((?:19[5-9]|20[0-4])\d)[)\]]/.exec(l);
    if (m && ok(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

// ---- authors ---------------------------------------------------------------------------------------------------------

const NOT_A_NAME = new Set(
  `admin administrator user users owner author authors unknown anonymous microsoft windows default name pc computer home office me root guest student staff test www
   acrobat adobe latex tex word none null na`.split(/\s+/),
);

/** Words that mean a line is an affiliation, an address, a heading or a note rather than a name. */
const NOT_NAME_WORDS = new Set(
  `university universität université universidad institute institut department dept school faculty laboratory laboratories lab college centre center research
   google brain microsoft facebook meta deepmind openai amazon apple inc ltd llc corp corporation company group foundation hospital academy society press bureau
   council agency office ministry national international royal technology technologies technological sciences science engineering medicine medical mathematical
   mathematics physics economics statistics computer computing applied theoretical project series paper report chapter lecture section figure table abstract
   introduction version edition working discussion road street avenue ave lane drive square hall building floor box park boulevard way place court campus tower
   plaza suite usa uk china germany france canada japan india australia switzerland thesis dissertation submitted degree doctor philosophy requirements partial
   fulfillment fulfilment supervisor advisor committee appendix contents keywords jel email tel phone fax corresponding equal contribution contributed work done
   while internship intern dated term michaelmas lent easter hilary trinity tripos part course notes lecturer taught problem set solutions homework exam midterm
   final spring fall autumn winter summer comments corrections suggestions send please available version dated copyright license licence open access`.split(/\s+/),
);
const FUNCTION_WORDS = new Set('the of for in on with to a an is are at by from this that these those our their its be been'.split(' '));
const PARTICLES = new Set('van von der den de del della di da dos das du la le bin ibn al el ten ter op zu af av y e'.split(' '));
const HONORIFIC = /^(?:prof(?:essor)?\.?|dr\.?|mr\.?|mrs\.?|ms\.?|mx\.?|sir)\s+/i;
/** ", PhD" after a name (not "Md", which is part of some names): case matters here. */
const DEGREE = /(?:,\s*|\s+)(?:Ph\.?\s?D|M\.D|MD|MSc|BSc|FRS|MBA)\.?(?=\s*(?:[,;]|$))/g;
const MARKS = /[∗*†‡§¶⋆✉#⁎]+/gu;

const caps = (word: string): string => word.replace(/\p{L}[\p{L}]*/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

/** "BUEHLER" becomes "Buehler", "O'BRIEN" "O'Brien", "JEAN-PAUL" "Jean-Paul". Names in mixed case are left alone. */
function nameCase(name: string): string {
  const l = name.replace(/[^\p{L}]/gu, '');
  if (l === '' || l !== l.toUpperCase() || l === l.toLowerCase()) return name;
  return name.split(' ').map((w) => (PARTICLES.has(w.toLowerCase()) ? w.toLowerCase() : caps(w))).join(' ');
}

function stripName(raw: string): string {
  let n = raw.trim().replace(HONORIFIC, '').replace(/^by\s+/i, '').trim();
  n = n.replace(/^[\s,;&.-]+|[\s,;&-]+$/g, '').replace(/\s+/g, ' ');
  return n;
}

/** A name written by a person into the Info field: one to six words made of letters, in any script. */
function isInfoName(n: string): boolean {
  const toks = n.split(' ');
  if (toks.length < 1 || toks.length > 6 || letterCount(n) < 2) return false;
  return toks.every((t) => /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(t));
}

const letterCount = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

/** A name read from a page: two to five words, each capitalised, an initial, or a particle, and nothing that belongs to an address or a heading. */
function isPageName(n: string): boolean {
  const toks = n.split(' ');
  if (toks.length < 2 || toks.length > 5) return false;
  let given = 0;
  for (const t of toks) {
    const low = t.toLowerCase().replace(/[.'’-]/g, '');
    // "A." is an initial, "a" and "The" are words
    if (NOT_NAME_WORDS.has(low) || (low.length >= 2 && FUNCTION_WORDS.has(low)) || (low.length === 1 && t === low)) return false;
    if (PARTICLES.has(t) || PARTICLES.has(t.toLowerCase())) continue;
    if (!/^(?:\p{Lu}[\p{L}\p{M}'’-]*\.?|\p{Lu}\.)$/u.test(t) && !/^[\p{Lu}'’.-]{2,}$/u.test(t)) return false;
    if (letterCount(t) >= 2) given += 1;
  }
  return given >= 2 || (given >= 1 && toks.some((t) => /^\p{Lu}\.$/u.test(t)));
}

/** The names in an Info `Author` field. Empty when the field is junk (a user name, a code, symbols). */
export function authorsFromInfo(field: string | null | undefined): string[] {
  if (typeof field !== 'string') return [];
  const s = normalizeText(field).replace(/\S+@\S+/g, ' ').replace(DEGREE, '').trim();
  if (s.length < 2 || s.length > 600) return [];
  if (/[:\\/@_`%#&~^|{}<>=[\]]/.test(s.replace(/&/g, ' ')) || letterCount(s) / s.length < 0.6) return [];
  let parts: string[];
  if (s.includes(';')) {
    parts = s.split(';').map((chunk) => {
      const sub = chunk.split(',').map((x) => x.trim()).filter(Boolean);
      return sub.length === 2 && sub.every((x) => x.split(' ').length <= 2) ? `${sub[1]} ${sub[0]}` : chunk;
    });
  } else {
    const flat = s.replace(/\s+(?:and|&|und|et)\s+/gi, ',');
    const sub = flat.split(',').map((x) => x.trim()).filter(Boolean);
    // "Gruber, Jon" is one person written surname first
    parts = sub.length === 2 && sub.every((x) => x.split(' ').length === 1) && !/\s(?:and|&)\s/i.test(s) ? [`${sub[1]} ${sub[0]}`] : sub;
  }
  const out: string[] = [];
  for (const p of parts) {
    const n = stripName(p);
    if (n === '' || NOT_A_NAME.has(n.toLowerCase().replace(/\d+$/, '').trim()) || !isInfoName(n)) return [];
    const name = nameCase(n);
    if (!out.includes(name)) out.push(name);
  }
  return out.slice(0, MAX_AUTHORS);
}

/** The names on one line of page text, or null when the line is not made of names. */
function namesOnLine(line: string): string[] | null {
  let s = line.replace(/\S+@\S+/g, ' ').replace(/https?:\/\/\S+|www\.\S+/g, ' ').replace(DEGREE, '');
  s = s.replace(MARKS, ',');
  s = s.replace(/(?<=[\p{L}.'’-])\d+(?:,\d+)*/gu, '');
  s = s.replace(/\s+(?:and|AND|&|und)\s+/g, ',').replace(/^\s*(?:and|AND|&)\s+/, '').replace(/\s*&\s*/g, ',');
  const parts = s.split(/[,;]/).map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) return null;
  let chunks = parts.map(stripName).filter((p) => p !== '');
  // no commas, marks or "and": 4, 6 or 8 capitalised words in a row are two, three or four two-word names
  if (chunks.length === 1) {
    const toks = (chunks[0] ?? '').split(' ');
    if (toks.length >= 4 && toks.length <= 10 && toks.length % 2 === 0 && toks.every((t) => /^\p{Lu}[\p{L}\p{M}'’-]+$/u.test(t))) {
      chunks = [];
      for (let i = 0; i < toks.length; i += 2) chunks.push(`${toks[i]} ${toks[i + 1]}`);
    }
  }
  if (chunks.length === 0 || !chunks.every(isPageName)) return null;
  return chunks.map(nameCase);
}

const AUTHOR_STOP = /^(?:abstract|summary|introduction|keywords?|key words|jel\b|contents|table of contents|1\.?\s+introduction|working paper\s+\d|nber working paper|©|copyright|a thesis|submitted)/i;
const AFFILIATION_LINE = /\b(?:university|universit[äé]t?|institute|department|dept\.?|school of|faculty|laborator(?:y|ies)|college|centre|center|research|google|microsoft|facebook|meta|deepmind|openai|inc\.?|ltd\.?|llc|corp\.?|foundation|hospital|academy|road|street|avenue|campus|bureau|council|press)\b/i;
/** Words that say this is a paper, a report or a thesis: only then are names read off page 1 (an invoice has none of them). */
const ACADEMIC = /\babstract\b|\bkeywords?\b|\bjel\b|\buniversity\b|\buniversit[äé]\w*|\binstitute\b|\bdepartment of\b|\bschool of\b|\bfaculty of\b|\blaborator|\bworking paper\b|\bdiscussion paper\b|\bthesis\b|\bdissertation\b|^by$/i;

function isProse(line: string): boolean {
  const ws = line.split(' ').length;
  return (ws >= 9 && !/[,;]/.test(line)) || (ws >= 5 && /[.!?]$/.test(line));
}

/** The names on the lines after the title block of page 1. */
function authorsFromLines(lines: readonly string[], from: number): string[] {
  // without any of those words, a block of names must start with a line of at least three of them
  const academic = lines.slice(0, 60).some((l) => ACADEMIC.test(l));
  const window = lines.slice(Math.max(0, from), Math.max(0, from) + 45);
  const found: string[] = [];
  let sinceStart = 0;
  let misses = 0;
  for (const line of window) {
    sinceStart += 1;
    if (AUTHOR_STOP.test(line)) break;
    if (/^by$/i.test(line)) continue;
    if (/@/.test(line) && letterCount(line.replace(/\S+@\S+/g, '')) < 3) continue;
    if (AFFILIATION_LINE.test(line) && !/^\p{Lu}/u.test(line.replace(HONORIFIC, ''))) continue;
    const names = isProse(line) ? null : namesOnLine(line);
    if (names === null) {
      if (isProse(line)) break;
      misses += 1;
      if (found.length === 0 ? sinceStart > 12 : misses > 6) break;
      continue;
    }
    if (!academic && found.length === 0 && names.length < 3) {
      misses += 1;
      if (sinceStart > 12) break;
      continue;
    }
    misses = 0;
    for (const n of names) if (!found.includes(n)) found.push(n);
  }
  return found.slice(0, MAX_AUTHORS);
}

const surname = (n: string): string => (n.split(' ').pop() ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sameName = (a: string, b: string): boolean => surname(a) === surname(b) && a.charAt(0).toLowerCase() === b.charAt(0).toLowerCase();

// ---- all of it -------------------------------------------------------------------------------------------------------

/**
 * Title, authors, year, DOI and arXiv id for a PDF about to be saved. The Info fields come first (unless they are junk), then
 * page 1, then the link and the file name. Never throws: anything it cannot find is null or an empty list.
 */
export function extractMetadata(input: MetadataInput): ExtractedMetadata {
  try {
    return extract(input);
  } catch {
    return { title: titleFromFileName(input.fileName), authors: [], year: null, doi: null, arxivId: null };
  }
}

function extract(input: MetadataInput): ExtractedMetadata {
  const lines1 = pageLines(typeof input.firstPageText === 'string' ? input.firstPageText : '');
  const lines2 = pageLines(typeof input.secondPageText === 'string' ? input.secondPageText : '');
  const maxYear = new Date(typeof input.now === 'number' ? input.now : Date.now()).getUTCFullYear() + 1;
  const fileName = typeof input.fileName === 'string' ? input.fileName : '';

  const { title, block } = chooseTitle({ infoTitle: input.metadata?.title, fileName, lines: lines1 });

  const arxivId =
    arxivFromUrl(input.url) ?? arxivFromText(lines1.join('\n')) ?? arxivFromText(lines2.slice(0, 8).join('\n')) ?? arxivFromFileName(fileName);

  const doi =
    doiFromUrl(input.url) ?? markedDoi(lines1) ?? bareDoi([...lines1.slice(0, 12), ...lines1.slice(-12)]) ?? markedDoi(lines2.slice(0, 8));

  const year = yearFromLines(lines1, arxivId, maxYear) ?? yearFromLines(lines2.slice(0, 12), arxivId, maxYear);

  const infoNames = authorsFromInfo(input.metadata?.author);
  const pageNames = block ? authorsFromLines(lines1, block.end) : [];
  let authors: string[];
  if (pageNames.length >= 2 && infoNames.length >= 1 && infoNames.every((n) => pageNames.some((p) => sameName(p, n)))) authors = pageNames;
  else if (infoNames.length > 0) authors = infoNames;
  else authors = pageNames;

  return { title, authors, year, doi, arxivId };
}

