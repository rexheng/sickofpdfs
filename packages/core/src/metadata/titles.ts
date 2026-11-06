// Titles (Phase 3, S4). A PDF's Info title is often junk ("Microsoft Word - x.docx", "untitled", its own file name, a
// typesetter's job number), and many papers have none, so the title is chosen in this order:
//   1. the Info title, if it is not junk;
//   2. the title block on page 1 (the first line that looks like a title, plus the lines that wrap with it);
//   3. the file name, if it reads like words a person chose;
//   4. nothing (null): the library then shows the file name itself.
//
// Pure and synchronous. No network, no clock. Page text is untrusted: nothing here evaluates or renders it, and a title is
// only ever returned as a plain string.

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/** NFKC (ligatures and superscript digits become plain letters and digits), control characters out, whitespace as single spaces. */
export function normalizeText(s: string): string {
  return s.normalize('NFKC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

/** The lines of a page's text, normalised, with the empty ones left out. */
export function pageLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = normalizeText(raw);
    if (line !== '') out.push(line);
  }
  return out;
}

const letters = (s: string): string => s.replace(/[^\p{L}]/gu, '');
const words = (s: string): string[] => s.split(' ').filter((w) => w !== '');

/** Share of the letters in `s` that are upper case (0 when it has no cased letters). */
function upperShare(s: string): number {
  let cased = 0;
  let upper = 0;
  for (const ch of letters(s)) {
    if (ch.toLowerCase() === ch.toUpperCase()) continue;
    cased += 1;
    if (ch === ch.toUpperCase()) upper += 1;
  }
  return cased === 0 ? 0 : upper / cased;
}

// ---- junk ------------------------------------------------------------------------------------------------------------

const JUNK_WORDS = new Set([
  'untitled', 'untitled document', 'untitled presentation', 'document', 'doc', 'presentation', 'powerpoint presentation', 'slide', 'title',
  'titel', 'titre', 'titolo', 'titulo', 'título', 'cover', 'cover page', 'front cover', 'title page', 'new document', 'sans titre', 'unbenannt',
  'sin título', 'sin titulo', 'senza titolo', 'naamloos', 'microsoft word', 'word document', 'pdf', 'pdf document', 'scan', 'scans', 'scanned document',
  'scanned documents', 'scanned image', 'image', 'test', 'temp', 'tmp', 'default', 'manuscript', 'draft', 'final', 'unknown', 'none', 'null', 'n/a',
  'page', 'layout', 'print', 'output', 'report', 'paper', 'article', 'file', 'download', 'attachment', 'scan001', 'untitled-1', 'new', 'copy',
  'microsoft powerpoint', 'microsoft excel', 'acrobat', 'adobe acrobat', 'adobe pdf', 'ghostscript', 'text', 'main', 'index', 'home', 'chapter', 'notes',
]);

const JUNK_PATTERNS: readonly RegExp[] = [
  /^(?:microsoft\s+)?(?:word|powerpoint|excel|publisher|visio|office)\s*[-–—:]\s*/i,
  /\.(?:pdf|docx?|dotx?|pptx?|xlsx?|tex|dvi|ps|eps|indd|qxd|odt|rtf|txt|html?|cdr|psd|ai|pub|fm|wpd|vsd|xps|md|key|pages|latex)$/i,
  /^(?:untitled|document|doc|presentation|slide|scan|image|img|dsc|page|layout|file|new document|bez tytułu|sans titre|unbenannt|naamloos|sin t[ií]tulo|senza titolo)[\s_-]*\d*$/i,
  /^(?:elsevier editorial system|manuscript draft|pscript5|acrobat distiller|adobe acrobat|(?:gpl |esp )?ghostscript|latex template|template\b|your (?:paper )?title|paper title|title of (?:the )?(?:paper|article|work)|insert (?:your )?title|lorem ipsum|click here|cover sheet|powerpoint presentation)/i,
  // a typesetter's job name with the page range it printed: "pone.0000308 1..5"
  /\s\d+\.\.\d+$/,
  // an address or a path, not a title
  /^[a-z][a-z0-9+.-]*:\/\//i,
  /^[a-z]:\\/i,
  /^(?:\/|\\\\)[\w./\\-]+$/,
  // LaTeX left in the field, or a replacement character from a bad conversion
  /\\[a-zA-Z]+\s*\{|�/,
  // a typesetter's note at the top of a preprint: "Typeset using LATEX twocolumn style in AASTeX63" (TB5)
  /^(?:typeset (?:using|with|in|by)|prepared (?:using|with))\b/i,
];

/**
 * Whether an Info title is not worth showing: empty, too short or too long, one of the generic names programs give a new
 * file, a file name, a path, a lone code ("s41586-021-03819-2"), or mostly not letters. `fileName` is the PDF's own name.
 */
export function isJunkTitle(title: string | null | undefined, fileName?: string | null): boolean {
  if (typeof title !== 'string') return true;
  const t = normalizeText(title);
  if (t.length < 3 || t.length > 200) return true;
  if (letters(t).length < 3 || letters(t).length / t.length < 0.25) return true;
  if (JUNK_WORDS.has(t.toLowerCase())) return true;
  if (JUNK_PATTERNS.some((re) => re.test(t))) return true;
  // a single token with digits in it is a code, not a title ("CS50", "1706.03762", "w29000")
  if (!t.includes(' ') && /\d/.test(t)) return true;
  if (fileName) {
    const squash = (s: string): string => s.toLowerCase().replace(/\.[a-z0-9]{1,5}$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
    const name = fileName.split(/[\\/]/).pop() ?? fileName;
    if (squash(t) === squash(name) || squash(t) === squash(safeDecode(name))) return true;
  }
  return false;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---- cleaning --------------------------------------------------------------------------------------------------------

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'via', 'with', 'per', 'nor']);
/** Two-letter words that are words, not acronyms, when a title is in capitals. */
const SHORT_WORDS = new Set(['is', 'it', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'me', 'my', 'no', 'of', 'on', 'or', 'so', 'to', 'up', 'we', 'am', 'an', 'oh']);

function casePart(part: string, first: boolean): string {
  const lower = part.toLowerCase();
  const l = letters(part);
  if (/\d/.test(part) && l.length <= 3) return part; // "3D", "F23", "W-2"
  if (l.length > 0 && l.length <= 2 && !SHORT_WORDS.has(lower.replace(/[^\p{L}]/gu, ''))) return part; // an acronym: "AI", "US", "ML"
  if (!first && SMALL.has(lower.replace(/[^\p{L}]/gu, ''))) return lower;
  return lower.replace(/\p{L}/u, (c) => c.toUpperCase());
}

/** A title set in capitals ("DEEP HEDGING") becomes "Deep Hedging". Mixed-case text is left as it was. */
export function toTitleCase(s: string): string {
  const toks = s.split(' ');
  return toks
    .map((tok, i) => {
      const afterColon = i > 0 && /[:.?!]$/.test(toks[i - 1] ?? '');
      return tok
        .split('-')
        .map((part, j) => casePart(part, (i === 0 || afterColon) && j === 0))
        .join('-');
    })
    .join(' ');
}

/** A title ready to show: normalised, footnote marks and surrounding quotes off, and capitals made into a title. */
export function cleanTitle(raw: string): string {
  let t = normalizeText(raw);
  t = t.replace(/[∗*†‡§¶⋆✉#⁎]+$/u, '');
  t = t.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').trim();
  t = t.replace(/\s+[-–—]\s+$/, '').trim();
  if (!/[.!?]\s+\S/.test(t)) t = t.replace(/\.+$/, '');
  if (upperShare(t) >= 0.85 && letters(t).length >= 4) t = toTitleCase(t);
  return t;
}

// ---- the file name ---------------------------------------------------------------------------------------------------

const NAME_JUNK = /^(?:document|download|file|scan|image|img|dsc|new|untitled|doc|copy|page|print|output|final|draft|test|temp|tmp|attachment|view|paper|report|slides|presentation|article|main|index|export|unknown|screenshot|photo|pic|capture|scanned)[\s\d()_-]*$/i;

/**
 * The PDF's file name as a title, when it reads like words a person chose ("Smith 2020 Learning Theory.pdf"). A name that is a
 * code, a camera or scanner name, or a generic word comes back as null.
 */
export function titleFromFileName(fileName: string | null | undefined): string | null {
  if (typeof fileName !== 'string') return null;
  let base = safeDecode(fileName.split(/[\\/]/).pop() ?? '');
  base = base.replace(/\.pdf$/i, '').replace(/[_+]+/g, ' ');
  // dots between words are separators; dots inside numbers ("6.006", "1706.03762") are not
  base = base.replace(/(?<=\p{L})\.(?=\p{L})/gu, ' ').replace(/-+/g, ' ');
  const t = normalizeText(base);
  if (t.length < 4 || t.length > 120) return null;
  if (NAME_JUNK.test(t)) return null;
  const digits = (t.match(/\d/g) ?? []).length;
  if (digits / t.length > 0.3 || /\d{5,}/.test(t)) return null;
  if (words(t).length < 2 && t.length < 8) return null;
  if (isJunkTitle(t)) return null;
  return t.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

// ---- the title block on page 1 ---------------------------------------------------------------------------------------

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_ONLY = new RegExp(
  `^(?:${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\.?,?\\s+\\d{4}|${MONTH}\\.?,?\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.]\\d{1,2}[/.]\\d{2,4})$`,
  'i',
);
const HAS_DATE = new RegExp(`(?:\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b|\\b\\d{1,2}\\s+${MONTH}\\.?,?\\s+\\d{4}\\b|\\b${MONTH}\\s+\\d{4}\\b|\\b\\d{4}-\\d{2}-\\d{2}\\b)`, 'i');

/** Lines that label a document or run along the top of a page: never the title. */
const LABEL_LINE =
  /^(?:typeset (?:using|with|in|by)\b|prepared (?:using|with)\b|preprint|pre-print|working paper|discussion paper|technical report|research article|original article|review article|short communication|research report|article|letter|abstract|summary|contents|table of contents|keywords?|key words|submitted|accepted|received|published|draft|confidential|copyright|©|\(c\)|all rights reserved|under review|to appear|nber working paper series|national bureau of economic research|cover|title page|front matter|version|page \d+|doi\b|arxiv\b|issn\b|isbn\b|www\.|https?:|available (?:at|online)|journal of\b|proceedings of\b|transactions on\b|ieee transactions|annals of\b|conference on\b|workshop on\b|symposium on\b|volume\b|vol\.|issue\b|no\.\s*\d|number\s+\d|report no|series\b|a (?:thesis|dissertation)\b)/i;
const SECTION_WORD = /^(?:abstract|introduction|contents|preface|foreword|references|bibliography|acknowledg(?:e)?ments?|appendix|summary|overview|chapter\s+\d+|table of contents|index|page|lecture\s+\d+|section\s+\d+)\.?$/i;
const BOILERPLATE_WORDS = /\b(?:permission|hereby grants?|proper attribution|licen[cs]e[sd]?|copyright|all rights|reproduc\w+|redistribut\w+|creative commons|distributed under|published by|this work|terms of use)\b/i;
const AFFILIATION_START = /^(?:university|universität|université|universidad|massachusetts institute|department|school|faculty|institute|college|centre|center|laboratory|laboratoire|dept\.?|division|graduate department)\b/i;

/** A line that is clutter at the top of a page rather than a title. */
function isNoiseLine(line: string): boolean {
  if (line.length < 2) return true;
  if (/^[\d\s.\-–—()[\]/]+$/.test(line)) return true; // a page number, "- 1 -", "1 / 12"
  if (/@|\bwww\.|https?:\/\//i.test(line)) return true;
  if (DATE_ONLY.test(line)) return true;
  const ws = words(line);
  if (line.includes('|') && ws.length >= 3) return true; // a running header: "Nature | Vol 596 | 26 August 2021 | 583"
  if (HAS_DATE.test(line) && ws.length >= 3 && ws.length <= 14 && !/^\p{Lu}[^.]*:\s/u.test(line)) return true; // a footer with a date in it
  if (LABEL_LINE.test(line)) return true;
  if (SECTION_WORD.test(line)) return true;
  if (/^\p{Ll}/u.test(line)) return true; // the middle of a sentence
  if (/^[^\p{L}\p{N}"'“‘(]/u.test(line)) return true; // a bullet, a note mark, a rule
  if (/[%$€£=]/.test(line)) return true; // a table row
  if (ws.length >= 7 && BOILERPLATE_WORDS.test(line)) return true;
  if (ws.length >= 6 && /[.]$/.test(line) && !/:\s/.test(line)) return true; // a sentence
  if (letters(line).length / line.length < 0.5) return true;
  if (AFFILIATION_START.test(line)) return true;
  return false;
}

const CONTINUES = new Set(['of', 'the', 'and', 'in', 'for', 'with', 'to', 'a', 'an', 'on', 'by', 'from', 'at', 'as', 'or', 'via', 'into', 'under', 'over', 'between', 'among', 'through', 'using', 'towards', 'toward', 'vs', 'versus', 'than', 'that', 'which', 'whose', 'is', 'are']);

function endsOpen(line: string): boolean {
  if (/[:,;(–—-]$/.test(line)) return true;
  const last = (words(line).pop() ?? '').toLowerCase().replace(/[^\p{L}]/gu, '');
  return CONTINUES.has(last);
}

export interface PageTitle {
  /** The cleaned title. */
  title: string;
  /** Index (into the lines given) of the first title line, and of the line after the last. */
  start: number;
  end: number;
}

const MAX_SCAN = 40;
const MAX_TITLE_LINES = 4;
const MAX_TITLE_CHARS = 220;

/** The title block of a page: the first line that looks like a title, and the lines that wrap with it. Null when there is none. */
export function titleFromLines(lines: readonly string[]): PageTitle | null {
  const n = Math.min(lines.length, MAX_SCAN);
  for (let i = 0; i < n; i++) {
    const first = lines[i] ?? '';
    if (isNoiseLine(first)) continue;
    const ws = words(first);
    if (ws.length < 2 && !(ws.length === 1 && letters(first).length >= 6 && /^\p{Lu}/u.test(first))) continue;
    if (ws.length > 32 || first.length > MAX_TITLE_CHARS) continue;
    const block = [first];
    let j = i + 1;
    while (j < n && block.length < MAX_TITLE_LINES) {
      const next = lines[j] ?? '';
      const prev = block[block.length - 1] ?? '';
      if (isNoiseLine(next) && !/^\p{Ll}/u.test(next)) break;
      if (/^by\b/i.test(next)) break;
      if (/^\p{Ll}/u.test(next) && /[.!?]$/.test(next) && words(next).length > 6) break;
      const open = endsOpen(prev);
      const lowerStart = /^\p{Ll}/u.test(next);
      const bothCaps = upperShare(prev) >= 0.85 && upperShare(next) >= 0.85 && prev.length >= 38 && !/[,;]/.test(next) && !/\d/.test(next) && !/\bAND\b.*\bAND\b/.test(next);
      if (!open && !lowerStart && !bothCaps) break;
      if (block.join(' ').length + next.length > MAX_TITLE_CHARS) break;
      block.push(next);
      j += 1;
    }
    let text = '';
    for (const l of block) text = text === '' ? l : /\S-$/.test(text) && /^\p{Ll}/u.test(l) ? `${text}${l}` : `${text} ${l}`;
    const title = cleanTitle(text);
    if (title.length < 3 || isJunkTitle(title)) {
      i = j - 1;
      continue;
    }
    return { title, start: i, end: j };
  }
  return null;
}

/** Everything `extractMetadata` needs to know about the title. */
export interface ChosenTitle {
  title: string | null;
  /** Where the title block is on page 1 (when it was found), so authors can be read from the lines after it. */
  block: PageTitle | null;
}

export function chooseTitle(input: { infoTitle: string | null | undefined; fileName: string | null | undefined; lines: readonly string[] }): ChosenTitle {
  const block = titleFromLines(input.lines);
  if (!isJunkTitle(input.infoTitle, input.fileName)) {
    const t = cleanTitle(input.infoTitle ?? '');
    if (t.length >= 3 && !isJunkTitle(t, input.fileName)) return { title: t, block };
  }
  if (block && !isJunkTitle(block.title, input.fileName)) return { title: block.title, block };
  return { title: titleFromFileName(input.fileName), block };
}
