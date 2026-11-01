// The OCR scorer (plan 7.0; Gate 2 reuses it). Plain ES module, no dependencies, runs in Node or a browser.
// Everything compares a recognised page against its known text:
//   cer            character error rate: Levenshtein distance / reference length, on normalised text with spaces collapsed
//   findability    share of true words of 4+ letters that a case-insensitive Ctrl+F finds in the recognised text
//   wordRecall     multiset share of ALL true words (edge punctuation stripped, case-insensitive) present in the recognised words
//   accentRecall   share of true words that contain an accented letter and are found exactly; accentFoldedRecall: found once accents are ignored
//   boxHitRate     share of recognised words whose centre lies inside some true word's box (plan: "word-box hit rate")
//   boxCoverage    share of true words whose box holds the centre of some recognised word
// All counts are returned raw (found / total) so pages can be pooled by adding them.

/** NFKC, one kind of quote and dash, no soft hyphens or zero-width marks, no hyphen at the end of a word (line-end hyphens are not text). */
export function normalize(s) {
  return s
    .normalize('NFKC')
    .replace(/[­​-‍⁠﻿￾￿]/g, '')
    .replace(/[‘’‚‛`´]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[     ]/g, ' ')
    .replace(/-(?=\s|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const EDGE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
/** Tokens of a text: split on spaces, strip punctuation at both ends, drop empties. */
export const tokens = (text) =>
  normalize(text)
    .split(' ')
    .map((t) => t.replace(EDGE, ''))
    .filter(Boolean);

/** Levenshtein distance of two strings (code points), two rows. */
export function editDistance(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  let prev = new Int32Array(y.length + 1);
  let cur = new Int32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    const xi = x[i - 1];
    for (let j = 1; j <= y.length; j++) {
      const c = xi === y[j - 1] ? 0 : 1;
      const v = prev[j - 1] + c;
      const d = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = v < d ? (v < ins ? v : ins) : d < ins ? d : ins;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length];
}

const stripAccents = (s) => s.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC');
const hasAccent = (s) => /[^\u0000-\u007f]/.test(s) && stripAccents(s) !== s;

/**
 * @param {string} truth  known text of the page
 * @param {string} hyp    recognised text of the page (words in reading order)
 * @returns raw counts for one page
 */
export function scoreText(truth, hyp) {
  const t = normalize(truth);
  const h = normalize(hyp);
  const cerErrors = editDistance(t, h);

  const tTok = tokens(truth);
  const hTok = tokens(hyp);
  const hFlat = h.toLowerCase();
  const hFolded = stripAccents(hFlat);

  // findability: true words of 4+ letters, a case-insensitive substring search
  const long = tTok.filter((w) => /^\p{L}{4,}$/u.test(w));
  const found = long.filter((w) => hFlat.includes(w.toLowerCase())).length;

  // multiset recall of all words
  const bag = new Map();
  for (const w of hTok) bag.set(w.toLowerCase(), (bag.get(w.toLowerCase()) ?? 0) + 1);
  let matched = 0;
  for (const w of tTok) {
    const k = w.toLowerCase();
    const n = bag.get(k) ?? 0;
    if (n > 0) {
      matched++;
      bag.set(k, n - 1);
    }
  }

  const acc = tTok.filter((w) => /^\p{L}{3,}$/u.test(w) && hasAccent(w));
  const accExact = acc.filter((w) => hFlat.includes(w.toLowerCase())).length;
  const accFolded = acc.filter((w) => hFolded.includes(stripAccents(w.toLowerCase()))).length;

  return {
    cerErrors,
    refChars: Array.from(t).length,
    findFound: found,
    findTotal: long.length,
    wordsMatched: matched,
    wordsTotal: tTok.length,
    hypWords: hTok.length,
    accTotal: acc.length,
    accExact,
    accFolded,
  };
}

/**
 * Box scoring. Both lists are in the same space (points on the same page). `truth` is [{text, box}], `hyp` is [{text, box}].
 * @returns raw counts: hypHit / hypTotal (precision-like), truthCovered / truthTotal, and hitAndEqual (centre inside a true word that has the same text).
 */
export function scoreBoxes(truth, hyp) {
  const inside = (b, x, y) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
  let hypHit = 0;
  let hitAndEqual = 0;
  const covered = new Array(truth.length).fill(false);
  for (const w of hyp) {
    const cx = w.box.x + w.box.width / 2;
    const cy = w.box.y + w.box.height / 2;
    let hit = -1;
    for (let i = 0; i < truth.length; i++) {
      if (inside(truth[i].box, cx, cy)) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) {
      hypHit++;
      const a = tokens(w.text)[0]?.toLowerCase();
      const b = tokens(truth[hit].text)[0]?.toLowerCase();
      if (a && a === b) hitAndEqual++;
      covered[hit] = true;
    }
  }
  return { hypHit, hypTotal: hyp.length, truthCovered: covered.filter(Boolean).length, truthTotal: truth.length, hitAndEqual };
}

/**
 * A source page's word boxes as they sit on the generated scan page (spikes/phase0/scripts/make-scan-fixture.mjs): the
 * source raster is rotated by skewDeg about its centre (y down, so +skew turns the content clockwise), then stretched to
 * `scan` (Letter, 612 x 792 pt). Boxes come out as the axis-aligned box of the rotated rectangle.
 */
export function toScanSpace(words, srcSize, skewDeg, scan = { width: 612, height: 792 }) {
  const rad = (skewDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = srcSize.width / 2;
  const cy = srcSize.height / 2;
  const sx = scan.width / srcSize.width;
  const sy = scan.height / srcSize.height;
  return words.map((w) => {
    const xs = [];
    const ys = [];
    for (const [px, py] of [
      [w.box.x, w.box.y],
      [w.box.x + w.box.width, w.box.y],
      [w.box.x + w.box.width, w.box.y + w.box.height],
      [w.box.x, w.box.y + w.box.height],
    ]) {
      const u = px - cx;
      const v = py - cy;
      xs.push((cx + cos * u - sin * v) * sx);
      ys.push((cy + sin * u + cos * v) * sy);
    }
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { text: w.text, box: { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y } };
  });
}

/** Adds raw counts of several pages. */
export function pool(list) {
  const sum = {};
  for (const r of list) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') sum[k] = (sum[k] ?? 0) + v;
  return sum;
}

/** Raw counts -> the headline ratios (all in 0..1). */
export function ratios(s) {
  const r = (a, b) => (b ? a / b : null);
  return {
    cer: r(s.cerErrors, s.refChars),
    findability: r(s.findFound, s.findTotal),
    wordRecall: r(s.wordsMatched, s.wordsTotal),
    accentRecall: r(s.accExact, s.accTotal),
    accentFoldedRecall: r(s.accFolded, s.accTotal),
    boxHitRate: r(s.hypHit, s.hypTotal),
    boxCoverage: r(s.truthCovered, s.truthTotal),
    boxHitAndEqual: r(s.hitAndEqual, s.hypTotal),
  };
}

/**
 * Recognised words -> page text: one line per OCR line, words separated by spaces. A word that ends a line with a hyphen is joined
 * to the lower-case word that starts the next line ("illus-" + "trated" -> "illustrated"), which is what PDFium does for real text and
 * what the 7.1 text merge must do, so Ctrl+F finds the whole word. Same rule for every engine.
 */
export function wordsToText(words, { dehyphenate = true } = {}) {
  const lines = [];
  for (const w of words) {
    if (!lines.length || lines[lines.length - 1].line !== w.line) lines.push({ line: w.line, words: [] });
    lines[lines.length - 1].words.push(w.text);
  }
  if (dehyphenate) {
    for (let i = 0; i + 1 < lines.length; i++) {
      const a = lines[i].words;
      const b = lines[i + 1].words;
      if (a.length && b.length && /\p{L}-$/u.test(a[a.length - 1]) && /^\p{Ll}/u.test(b[0])) {
        a[a.length - 1] = a[a.length - 1].slice(0, -1) + b.shift();
      }
    }
  }
  return lines.map((l) => l.words.join(' ')).join('\n');
}
