// Test data: page texts of a paper as a download site prints them, a download stamp at the foot of every page. Shared by
// the stamp tests, Task 28's store tests and e2e/support/stamped-pdf.ts (which draws the same pages into a real PDF).
// Deterministic: the same arguments always give the same text. No imports, so any project can load it.

export type StampBody = 'jstor-body' | 'other-body';

export interface StampSampleOptions {
  /** How many pages. Default 8. */
  pages?: number;
  /** How many characters of body text on each page, the stamp not counted. Default 3,750 (8 pages are 30,000). */
  charsPerPage?: number;
  /** Which paper's words. The two share no words in the same places. Default 'jstor-body'. */
  body?: StampBody;
}

const DEFAULT_PAGES = 8;
const DEFAULT_CHARS_PER_PAGE = 3750;

/** Each paper has its own pieces, so two papers' text is as unlike as two real papers' is. */
const SYLLABLES: Record<StampBody, readonly string[]> = {
  'jstor-body': ['ba', 'ne', 'ri', 'to', 'cal', 'mon', 'ter', 'ex', 'pre', 'sion', 'ing', 'ta', 'lo', 'de', 'ver', 'an', 'is', 'um', 'cos', 'pa'],
  'other-body': ['ku', 'ze', 'fo', 'yan', 'wi', 'gor', 'hep', 'qua', 'dru', 'vel', 'jin', 'obs', 'ly', 'mu', 'xen', 'ar', 'th', 'ok', 'sh', 'ui'],
};
const SEEDS: Record<StampBody, number> = { 'jstor-body': 0x2c1b3c6d, 'other-body': 0x6d2b79f5 };

/** mulberry32: a small, fixed pseudo-random generator, so the text never changes. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One made-up word of one to four syllables. */
function word(body: StampBody, next: () => number): string {
  const syllables = SYLLABLES[body];
  let w = '';
  for (let n = 1 + Math.floor(next() * 4); n > 0; n--) w += syllables[Math.floor(next() * syllables.length)];
  return w;
}

/** The body text of one page: exactly `chars` characters, words and single spaces, no digits, no line breaks. */
function bodyPage(body: StampBody, pageIndex: number, chars: number): string {
  const next = random(SEEDS[body] + Math.imul(pageIndex + 1, 0x9e3779b1));
  let text = '';
  for (;;) {
    const w = word(body, next);
    const room = chars - text.length - (text ? 1 : 0);
    if (w.length > room) {
      // The last word is cut to fit exactly, so every page has the same length whatever the words are.
      return text + (text && room > 0 ? ' ' : '') + w.slice(0, Math.max(room, 0));
    }
    text += (text ? ' ' : '') + w;
  }
}

/** The body text of each page of a paper, without any stamp. */
export function bodyPages(body: StampBody = 'jstor-body', pages = DEFAULT_PAGES, charsPerPage = DEFAULT_CHARS_PER_PAGE): string[] {
  return Array.from({ length: pages }, (_, i) => bodyPage(body, i, charsPerPage));
}

/** The two lines JSTOR prints at the foot of every page of a download. */
export function stampLines(ip: string, date: string): string {
  return `This content downloaded from ${ip} on ${date}\nAll use subject to https://about.jstor.org/terms`;
}

/**
 * A paper's page texts as the engine returns them for a download: the body, a line break, then the stamp lines. The same
 * `body` and a different `ip` or `date` is the same paper downloaded again; a different `body` is a different paper.
 * Defaults: 8 pages of 3,750 characters, the 'jstor-body' paper.
 */
export function pagesWithStamp(ip: string, date: string, o: StampSampleOptions = {}): string[] {
  const body = bodyPages(o.body ?? 'jstor-body', o.pages ?? DEFAULT_PAGES, o.charsPerPage ?? DEFAULT_CHARS_PER_PAGE);
  return body.map((text) => `${text}\n${stampLines(ip, date)}`);
}
