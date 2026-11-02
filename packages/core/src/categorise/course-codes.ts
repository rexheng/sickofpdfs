// Course codes (spec R92): "EC1A1", "CS50", "14.01", "MATH 2301", "PH1105", "ECON 101", found in the link a PDF came from, the folder or
// file name it sits in, and the top of its first page. Pure and synchronous; it never throws and never returns a guess it is not
// fairly sure of. A missed code costs nothing (the owner tags the reading); a wrong one is a wrong tag.
//
// What a code looks like (checked in this order):
//   1. Letters, one digit, a letter and a digit:  EC1A1, EC2B1.
//   2. 2 to 5 letters, then 2 to 4 digits, then at most one letter, with a space, a hyphen or nothing between:  CS50, PH1105,
//      MATH 2301, ECON 101, CS231n. The letters are not a word that only looks like a code (see NOT_A_COURSE).
//   3. MIT's numbers, two digits or fewer, a dot, and two or three digits:  14.01, 6.006. Only with a hint that it is a course
//      (see below), because the same shape is a section number, a price or a version.
//
// What is never returned: years (2023), page and section numbers (12, 2.3), DOIs, arXiv ids, ISBNs, ISSNs, phone numbers, money,
// dates, version numbers, e-mail addresses and web addresses found in page text, and the words that precede such numbers (Figure 12,
// Week 3, Lecture 4, Vol 12, RFC 2616, ISO 9001, CVPR 2018, Windows 10, ...).
//
// Where it looks, most specific first:
//   - the link: the file name, then the folders from the deepest, then the query, then the host's name parts (cs231n.stanford.edu);
//   - the folder: the file name, then the folders from the deepest;
//   - the first page: capital-letter codes anywhere; an MIT-style number only at the start of a line near the top, or after a word
//     such as "course", "subject", "MIT" or "lecture".
// Codes are upper case without the inner space ("MATH2301"), each only once.

export interface CourseCodeSource {
  url?: string;
  path?: string;
  firstPageText?: string;
}

/** Words that look like the letters of a course code but are not. A lower-case set, tested on the letters only. */
const NOT_A_COURSE = new Set(
  (
    // parts of a document
    'week wk lec lect lecture lectures ch chap chapter sec sect section fig figure figs tab table page pg pp vol no nr num number part unit topic class slide slides ' +
    'ex exe exercise exercises hw homework pset ps problem set notes note tut tutorial lab labs assignment assign day mod module quiz test exam midterm final mid ' +
    'reading readings session sess lesson video rec recitation sem seminar workshop project proj draft version ver rev revision copy new old backup sol soln sols ' +
    'solution solutions answer answers eq eqn alg algorithm lemma thm theorem prop def cor ref refs fn ' +
    // files and downloads
    'img image pic photo dsc dscn mvi screenshot scan scanned temp tmp doc docs document file download attach attachment form invoice inv receipt bill statement order ticket id ' +
    // numbering schemes of papers and standards
    'isbn issn doi arxiv rfc iso iec ieee acm din en bs astm ansi dp wp cep nber ipcc ar sr rpt rep report pmid pmc ssrn ' +
    // conferences and journals
    'nips neurips icml cvpr iccv eccv iclr acl emnlp naacl aaai ijcai kdd www sigir uai colt aistats icassp interspeech sigmod vldb chi uist siggraph fy fye ' +
    // things named with a number
    'covid sars h1n1 gpt bert yolo vgg alexnet lenet mnist cifar glue squad cuda sha aes rsa md des ecc utf win amd arm pdf html css js sql tcp udp http https usb hdmi lte wifi ' +
    'xbox iphone ios mac windows linux ubuntu python java php ruby rust rtx gtx tpu gpu cpu ram ssd casp ilsvrc ' +
    // institutions and the numbers on bills (an IBAN or a VAT number is letters and digits too)
    'mit lse ucl kcl hmrc irs vat tva btw iban bic fr de nl gb es be at ie crd ' +
    // money, places and the labels of things that carry a number
    'gbp usd eur jpy chf cad aud nzd cny inr rub sek nok dkk pln czk huf brl mxn zar sgd hkd krw try ' +
    'room box suite floor level grade term year phase stage round batch group team block bldg building apt flat ext tel fax phone mobile ' +
    'macos osx android pixel ver release build patch'
  ).split(/\s+/),
);

/** Words just before an MIT-style number that say it is not a course. */
const NUMBER_WORDS = new Set(
  'section sec chapter ch figure fig table tab eq equation theorem lemma proposition page pp p vol volume no number version v rev step example exercise problem appendix part item line row col column question q note'.split(
    ' ',
  ),
);

/** Words near an MIT-style number that say it is a course. */
const COURSE_HINT = /\b(?:course|subject|class|module|syllabus|lecture|lec|handout|recitation|mit|ocw|problem\s+set|pset|midterm|final\s+exam)\b/i;

/** MIT's department numbers: 1 to 12, 14 to 18, 20 to 22 and 24. */
const MIT_DEPARTMENTS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, 22, 24]);

const CURRENCY_BEFORE = /[$£€¥₹#]\s*$/;
const CURRENCY_AFTER = /^\s*(?:usd|gbp|eur|dollars?|pounds?|euros?|cents?|%|percent)\b|^%/i;

const isYear = (digits: string): boolean => digits.length === 4 && /^(?:19|20)\d\d$/.test(digits);

/** The code for a letters+digits match, or null when it is not one. `letters` and `digits` are as written; `suffix` is at most one letter. */
function letterCode(letters: string, digits: string, suffix: string): string | null {
  if (NOT_A_COURSE.has(letters.toLowerCase())) return null;
  if (isYear(digits)) return null;
  return `${letters}${digits}${suffix}`.toUpperCase();
}

/**
 * Department words that may be written in lower case or Title Case with a space before the number ("math 2301", "Econ 101"). A short
 * lower-case word and a number is usually just that ("of 30", "was 15", "over 1000"), so only these are taken.
 */
const DEPARTMENT_WORDS = new Set(
  'math maths econ phys chem biol bio comp stat stats engl hist psyc psych soc poli phil acct finc fin mgmt mktg cs cse ee ece mech civl engr ling anth geog geol astr neur musc educ'.split(
    ' ',
  ),
);

interface Hit {
  at: number;
  code: string;
}

/**
 * `EC1A1` and `MATH 2301`-style codes in a piece of text, left to right.
 *   - Capital letters, with a space, a hyphen, an underscore or nothing before the digits: MATH 2301, ECON-101, CS50.
 *   - Any case with nothing between: math2301, Math2301.
 *   - Lower case or Title Case with a space: only for the department words above.
 * `caseless` also lets the UK form (EC1A1) be written in lower case, as in links and file names.
 */
function findLetterCodes(text: string, caseless: boolean): Hit[] {
  const hits: Hit[] = [];
  const edgeBefore = '(?<![A-Za-z0-9])';
  const edgeAfter = '(?![A-Za-z0-9])';
  const uk = new RegExp(`${edgeBefore}(${caseless ? '[A-Za-z]' : '[A-Z]'}{2,4})(\\d)([A-Za-z])(\\d)${edgeAfter}`, 'g');
  const joined = new RegExp(`${edgeBefore}([A-Za-z]{2,5})(\\d{2,4})([A-Za-z])?${edgeAfter}`, 'g');
  const apart = new RegExp(`${edgeBefore}([A-Za-z]{2,5})[ \\-_\\u00a0]+(\\d{2,4})([A-Za-z])?${edgeAfter}`, 'g');
  for (const m of text.matchAll(uk)) {
    const letters = m[1] ?? '';
    if (NOT_A_COURSE.has(letters.toLowerCase()) || (!caseless && m[3] !== (m[3] ?? '').toUpperCase())) continue;
    hits.push({ at: m.index ?? 0, code: `${letters}${m[2]}${m[3]}${m[4]}`.toUpperCase() });
  }
  for (const m of text.matchAll(joined)) {
    const code = letterCode(m[1] ?? '', m[2] ?? '', m[3] ?? '');
    if (code !== null) hits.push({ at: m.index ?? 0, code });
  }
  for (const m of text.matchAll(apart)) {
    const letters = m[1] ?? '';
    const capitals = letters === letters.toUpperCase();
    if (!capitals && !DEPARTMENT_WORDS.has(letters.toLowerCase())) continue;
    // A suffix letter after a space-separated number is the start of the next word ("ECON 101 a"), not part of the code.
    const code = letterCode(letters, m[2] ?? '', capitals ? (m[3] ?? '') : '');
    if (code !== null) hits.push({ at: m.index ?? 0, code });
  }
  return hits;
}

/** An MIT-style number, validated: a known department, two or three digits after the dot. Returns "14.01" or null. */
function mitNumber(dept: string, rest: string): string | null {
  const d = Number(dept);
  if (!MIT_DEPARTMENTS.has(d) || dept.length > 2) return null;
  if (rest.length < 2 || rest.length > 3) return null;
  return `${d}.${rest}`;
}

/**
 * MIT's numbers in a link, a path or a file name: `MIT14_01F18_Lec1`; a folder or file that starts with the number (`14.01 Microeconomics`,
 * `14.01_Lecture5.pdf`, `14-01 Microeconomics`, `/courses/6-006-introduction-to-algorithms/`); and `mit-14.01`, `course 6.006`.
 * A dashed number needs a department above 12 (or three digits, or an MIT host), because `10-31` is a date.
 */
function findMitInName(text: string, mitHost: boolean): Hit[] {
  const hits: Hit[] = [];
  const add = (at: number | undefined, dept: string | undefined, rest: string | undefined): void => {
    const n = mitNumber(dept ?? '', rest ?? '');
    if (n !== null) hits.push({ at: at ?? 0, code: n });
  };
  for (const m of text.matchAll(/(?<![A-Za-z])MIT[ _-]?(\d{1,2})[_.-](\d{2,3})(?![0-9])/gi)) add(m.index, m[1], m[2]);
  for (const m of text.matchAll(/(?<![A-Za-z0-9.])(?:mit|course|subject|class|ocw)[ _-]+(\d{1,2})\.(\d{2,3})(?![0-9]|\.\d)/gi)) add(m.index, m[1], m[2]);
  // a folder or file that starts with the number, then a separator and a word (or the extension)
  for (const m of text.matchAll(/(?<=^|[\\/])(\d{1,2})\.(\d{2,3})(?=[ _-]+[A-Za-z]|\.[A-Za-z]{2,5}$|$)/g)) add(m.index, m[1], m[2]);
  for (const m of text.matchAll(/(?<=^|[\\/])(\d{1,2})-(\d{2,3})(?=[ _][A-Za-z]|-[A-Za-z])/g)) {
    const dept = Number(m[1]);
    const rest = m[2] ?? '';
    if (mitHost || dept > 12 || rest.length === 3) add(m.index, m[1], rest);
  }
  return hits;
}

const unique = (codes: readonly string[]): string[] => [...new Set(codes)];

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Codes in a piece of a link or path, in the order they are written, left to right. A file's extension is not part of its name. */
function fromName(text: string, mitHost: boolean): string[] {
  const body = text.replace(/\.[A-Za-z0-9]{1,5}(?=$|[?#])/, '');
  const hits = [...findMitInName(text, mitHost), ...findLetterCodes(body, true)];
  return hits.sort((x, y) => x.at - y.at).map((h) => h.code);
}

function fromUrl(url: string): string[] {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?(?:\/\/)?(?:[^/@?#]*@)?([^/?#:]*)(?::\d+)?([^?#]*)(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return [];
  const host = (m[1] ?? '').toLowerCase();
  const mitHost = /(?:^|\.)mit\.edu$/.test(host);
  const codes: string[] = [];
  // Left to right as the link is written: the host's name parts, then the path, then the query's values.
  for (const label of host.split('.')) {
    if (label !== '' && !/^(?:www|cdn|web|m|en|static|files|download|downloads|docs)$/.test(label)) {
      codes.push(...findLetterCodes(label, true).map((h) => h.code));
    }
  }
  codes.push(...fromName(decode(m[2] ?? ''), mitHost));
  for (const value of decode(m[3] ?? '').split('&').map((kv) => kv.slice(kv.indexOf('=') + 1))) codes.push(...fromName(value, false));
  return codes;
}

function fromPath(path: string): string[] {
  return fromName(decode(path).replace(/\\/g, '/'), false);
}

// ---- first page -------------------------------------------------------------------------------------------------------------------

/** Text with the things that hold numbers that are not courses taken out: addresses, DOIs, ISBNs, arXiv ids, e-mail addresses. */
function withoutNoise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/https?:\/\/\S+|www\.\S+|\b\S+@\S+\.\S+\b/gi, ' ')
    .replace(/\b(?:doi|arxiv)\s*[:/]?\s*\S+/gi, ' ')
    .replace(/\b10\.\d{4,9}\/\S+/g, ' ')
    .replace(/\bisbn(?:-1[03])?\s*:?\s*[\dxX][\dxX -]{8,16}/gi, ' ')
    .replace(/\bissn\s*:?\s*\d{4}-?\d{3}[\dxX]/gi, ' ')
    .replace(/\bpmid\s*:?\s*\d+/gi, ' ');
}

/** The lines at the top of page 1 where a code may stand on its own; further down it needs a word like "course" beside it. */
const HEADER_LINES = 15;
const STRONG_HINT = /\b(?:course|module|subject|class|syllabus|unit code|paper code|course code)\b/i;

function fromFirstPage(raw: string): string[] {
  const lines = withoutNoise(raw)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '');
  const codes: string[] = [];
  lines.forEach((line, index) => {
    const hits: Hit[] = index < HEADER_LINES || STRONG_HINT.test(line) ? findLetterCodes(line, false) : [];
    // MIT-style numbers need a hint: the start of a line near the top that is followed by a title, or a course word before them.
    for (const m of line.matchAll(/(?<![A-Za-z0-9.,/-])(\d{1,2})\.(\d{2,3})(?![0-9]|\.\d|\s*[-–]\s*\d)/g)) {
      const at = m.index ?? 0;
      const before = line.slice(0, at);
      const after = line.slice(at + m[0].length);
      if (CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after)) continue;
      const prevWord = /([A-Za-z]+)\.?\s*$/.exec(before)?.[1]?.toLowerCase();
      if (prevWord !== undefined && NUMBER_WORDS.has(prevWord)) continue;
      const atStart = before.trim() === '' && index < HEADER_LINES && /^[\s:–—-]*[A-Z]/.test(after);
      // "Introduction to Algorithms: 6.006" -- a title line that ends with the number.
      const endsTitle = index < HEADER_LINES && /[A-Za-z][:–—-]\s*$/.test(before) && after.trim() === '';
      const hinted = COURSE_HINT.test(before.slice(-40)) || (before.trim() === '' && index < HEADER_LINES && COURSE_HINT.test(after.slice(0, 40)));
      if (!atStart && !hinted && !endsTitle) continue;
      const n = mitNumber(m[1] ?? '', m[2] ?? '');
      if (n !== null) hits.push({ at, code: n });
    }
    codes.push(...hits.sort((x, y) => x.at - y.at).map((h) => h.code));
  });
  return codes;
}

/**
 * The course codes of a reading, from where it came from. See the file's header for what counts. At most 10 are returned.
 */
export function findCourseCodes(src: CourseCodeSource): string[] {
  const found: string[] = [];
  try {
    if (typeof src?.url === 'string' && src.url !== '') found.push(...fromUrl(src.url.slice(0, 4096)));
    if (typeof src?.path === 'string' && src.path !== '') found.push(...fromPath(src.path.slice(0, 4096)));
    if (typeof src?.firstPageText === 'string' && src.firstPageText !== '') found.push(...fromFirstPage(src.firstPageText.slice(0, 20_000)));
  } catch {
    // Never throws: whatever was found before the problem stands.
  }
  return unique(found).slice(0, 10);
}
