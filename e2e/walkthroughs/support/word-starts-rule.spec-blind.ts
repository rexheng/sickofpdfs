// The pure part of the walkthrough-19 helpers (no browser in here): the rule of R90 worked out from the engine's text, the ink gains read from pictures, the verdict,
// and the key names. Split out so that it can be checked on pictures made here, where the right answer is known (word-starts-rule.spec-blind.test.ts).
import type { Glyph } from '../../../packages/viewer/src/backend/types';
import type { PageMap } from '../../support/tl-blind.spec-blind';
import type { Box } from '../../support/tl-paint.spec-blind';
import type { Shot } from './marks.spec-blind';

/** The share of the device pixels inside `box` (CSS px), leaving out the boxes in `except`, that differ between two shots of the same window by more than `tol` in some channel. */
export function changedShare(a: Shot, b: Shot, box: Box, tol = 2, except: Box[] = []): number {
  const { dpr } = a;
  const x0 = Math.max(0, Math.floor(box.left * dpr));
  const x1 = Math.min(a.img.width, b.img.width, Math.ceil(box.right * dpr));
  const y0 = Math.max(0, Math.floor(box.top * dpr));
  const y1 = Math.min(a.img.height, b.img.height, Math.ceil(box.bottom * dpr));
  let n = 0;
  let hit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const cx = x / dpr;
      const cy = y / dpr;
      if (except.some((e) => cx >= e.left && cx <= e.right && cy >= e.top && cy <= e.bottom)) continue;
      n++;
      const oa = (y * a.img.width + x) * 4;
      const ob = (y * b.img.width + x) * 4;
      if (Math.max(Math.abs(a.img.data[oa] - b.img.data[ob]), Math.abs(a.img.data[oa + 1] - b.img.data[ob + 1]), Math.abs(a.img.data[oa + 2] - b.img.data[ob + 2])) > tol) hit++;
    }
  }
  return n === 0 ? 0 : hit / n;
}

/** How much black there is in `box` (CSS px): the sum over its pixels of 1 - luminance / 255. A heavier stroke raises it. */
export function darknessIn(shot: Shot, box: Box): number {
  const { img, dpr } = shot;
  const x0 = Math.max(0, Math.round(box.left * dpr));
  const x1 = Math.min(img.width, Math.round(box.right * dpr));
  const y0 = Math.max(0, Math.round(box.top * dpr));
  const y1 = Math.min(img.height, Math.round(box.bottom * dpr));
  let sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * img.width + x) * 4;
      sum += 1 - (0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]) / 255;
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------------------------
// The rule, worked out from the engine's text (R90, "What it does")

export type Want = 'bold' | 'plain';
export interface LetterWant {
  /** PDFium char index on the page. */
  index: number;
  ch: string;
  want: Want;
  kind: 'letter' | 'digit' | 'hyphen';
  /** The word this belongs to (letters), the number (digits) or '-' (a hyphen). */
  word: string;
  /** 0-based place of the letter in its word. */
  pos: number;
  /** How many of the word's letters are bold by the rule (letters only). */
  bold: number;
}

/** How many of a word's `n` letters are bold: 1 for a word of 1 to 3 letters, else the first half rounded up. */
export const boldCount = (n: number): number => (n <= 3 ? Math.min(1, n) : Math.ceil(n / 2));

export interface Model {
  wants: LetterWant[];
  /** Words the rule was applied to, by their letter count. */
  words: Map<number, number>;
  /** The words the rule was applied to, in order. */
  list: string[];
  /** Pure numbers found. */
  numbers: string[];
  /** Hyphens found (each one separates two words). */
  hyphens: number;
  /** Tokens the walkthrough does not judge, with the reason: ligatures (one glyph for two letters), letters mixed with digits, accents. */
  skipped: string[];
}

const isLetter = (c: string): boolean => /^\p{L}$/u.test(c);
const isDigit = (c: string): boolean => /^\p{Nd}$/u.test(c);
const HYPHENS = new Set(['-', '‐', '‑']);

/** The words of chars [a, b] (both included) of a page, by the rule. Runs of letters and digits are tokens; everything else ends a token. */
export function modelOf(glyphs: Glyph[], a: number, b: number): Model {
  const m: Model = { wants: [], words: new Map(), list: [], numbers: [], hyphens: 0, skipped: [] };
  let token: { index: number; ch: string }[] = [];
  const flush = (): void => {
    if (token.length === 0) return;
    const text = token.map((t) => t.ch).join('');
    const letters = token.filter((t) => isLetter(t.ch)).length;
    const digits = token.length - letters;
    if (letters === 0) {
      m.numbers.push(text);
      for (const t of token) m.wants.push({ index: t.index, ch: t.ch, want: 'plain', kind: 'digit', word: text, pos: 0, bold: 0 });
    } else if (digits > 0) {
      m.skipped.push(`${text} (letters and digits together: the rule does not say)`);
    } else if (/[^A-Za-z]/.test(text)) {
      m.skipped.push(`${text} (not plain ASCII letters)`);
    } else if (/f[fil]/i.test(text)) {
      m.skipped.push(`${text} (a ligature: one glyph for two letters)`);
    } else {
      const k = boldCount(letters);
      m.words.set(letters, (m.words.get(letters) ?? 0) + 1);
      m.list.push(text);
      token.forEach((t, pos) => m.wants.push({ index: t.index, ch: t.ch, want: pos < k ? 'bold' : 'plain', kind: 'letter', word: text, pos, bold: k }));
    }
    token = [];
  };
  for (let i = a; i <= b; i++) {
    const g = glyphs[i];
    if (g === undefined || g.generated) {
      flush();
      continue;
    }
    const c = g.text;
    if (isLetter(c) || isDigit(c)) {
      token.push({ index: i, ch: c });
      continue;
    }
    flush();
    if (HYPHENS.has(c)) {
      m.hyphens++;
      m.wants.push({ index: i, ch: c, want: 'plain', kind: 'hyphen', word: '-', pos: 0, bold: 0 });
    }
  }
  flush();
  return m;
}

/** The box that is read for a glyph: its ink box, grown by 4% of its size on every side so the heavier edge is inside. */
function readBox(g: Glyph, map: PageMap): Box {
  const t = map.box(g.tight);
  const e = 0.04 * g.fontSize * map.pxPerPt;
  return { left: t.left - e, right: t.right + e, top: t.top - e, bottom: t.bottom + e };
}

/** (ink with the effect) / (ink without) - 1 for one glyph, or NaN when the glyph has no ink to speak of or is not on the screen. */
export function gainOf(g: Glyph, map: PageMap, off: Shot, with_: Shot, view?: Box): number {
  if (g.generated || g.tight.width <= 0 || g.tight.height <= 0) return Number.NaN;
  const box = readBox(g, map);
  if (view !== undefined && (box.left < view.left || box.right > view.right || box.top < view.top || box.bottom > view.bottom)) return Number.NaN;
  const before = darknessIn(off, box);
  if (before < 1) return Number.NaN;
  return darknessIn(with_, box) / before - 1;
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((p, q) => p - q);
  if (s.length === 0) return Number.NaN;
  return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
};

export interface Verdict {
  /** Letters, digits and hyphens that could be judged. */
  assessed: number;
  /** Those the walkthrough could not judge (no ink to speak of, not on the screen, or the bold mark's own yardstick was too small). */
  unjudged: number;
  /** Everything the rule wants and the picture contradicts, one line each. */
  mismatches: string[];
  /** The same mismatches sorted by the part of the rule they break, so a failure can name it. */
  byRule: {
    /** A digit drawn bold ("pure numbers ... are left alone"). */
    numbersBold: string[];
    /** A hyphen drawn bold. */
    hyphensBold: string[];
    /** The first letter of a word drawn plain. */
    firstLetterPlain: string[];
    /** The letter on either side of the split is wrong: the first half is too short or too long (rounding, or the 1-to-3-letter rule). */
    offByOne: string[];
    /** Any other letter wrong (the rest of a word bold, or a bold letter in the middle of the first half plain). */
    other: string[];
  };
  /** The median ink gain of the letters the rule wants bold, and the median of the bold mark's gain on the same letters. */
  medianOn: number;
  medianFull: number;
  /** The median of (ON gain / FULL gain) over those letters: 1 is as heavy as the owner's bold mark; the spec says the start is heavier. */
  strokeRatio: number;
  /** The largest ratio over letters the rule wants plain (a neighbour's heavier edge only reaches a fraction of one). */
  worstPlain: number;
  /** The smallest ratio over letters the rule wants bold. */
  worstBold: number;
  model: Model;
}

/** A letter is drawn bold when it holds at least this share of its own bold-mark gain. */
export const BOLD_AT = 0.5;
/** The bold mark's gain on a letter must be at least this to judge the letter at all. */
export const MIN_YARDSTICK = 0.04;

/**
 * Judges the picture against the rule. `off`, `full` and `on` are three pictures of the same window with the same layout (the page must not move
 * between them); `a` and `b` are the first and last char (both included) of the passage on the page.
 */
export function judge(o: { glyphs: Glyph[]; a: number; b: number; map: PageMap; off: Shot; full: Shot; on: Shot; view?: Box; allBold?: boolean }): Verdict {
  const model = modelOf(o.glyphs, o.a, o.b);
  if (o.allBold === true) for (const w of model.wants) w.want = 'bold';
  const v: Verdict = {
    assessed: 0,
    unjudged: 0,
    mismatches: [],
    byRule: { numbersBold: [], hyphensBold: [], firstLetterPlain: [], offByOne: [], other: [] },
    medianOn: Number.NaN,
    medianFull: Number.NaN,
    strokeRatio: Number.NaN,
    worstPlain: Number.NEGATIVE_INFINITY,
    worstBold: Number.POSITIVE_INFINITY,
    model,
  };
  const onGains: number[] = [];
  const fullGains: number[] = [];
  const ratios: number[] = [];
  const judged: { w: (typeof model.wants)[number]; ratio: number }[] = [];
  for (const w of model.wants) {
    const g = o.glyphs[w.index];
    const full = gainOf(g, o.map, o.off, o.full, o.view);
    const on = gainOf(g, o.map, o.off, o.on, o.view);
    if (!(full >= MIN_YARDSTICK) || Number.isNaN(on)) {
      v.unjudged++;
      continue;
    }
    v.assessed++;
    const ratio = on / full;
    if (w.want === 'bold') {
      onGains.push(on);
      fullGains.push(full);
      ratios.push(ratio);
      v.worstBold = Math.min(v.worstBold, ratio);
    } else {
      v.worstPlain = Math.max(v.worstPlain, ratio);
    }
    judged.push({ w, ratio });
  }
  // Triage (word starts round 3): R90c makes Medium heavier than the owner's bold mark (the yardstick, taken with the
  // switch off), so a plain letter beside a bold one can hold half the yardstick's weight in spill alone. A letter is
  // drawn bold when it holds half the weight the bold starts themselves have (their median ratio, if above 1).
  const boldAt = BOLD_AT * Math.max(1, median(ratios) || 1);
  for (const { w, ratio } of judged) {
    const drawnBold = ratio >= boldAt;
    if (drawnBold === (w.want === 'bold')) continue;
    const where = w.kind === 'letter' ? `letter ${w.pos + 1} of "${w.word}" ('${w.ch}')` : w.kind === 'digit' ? `the digit '${w.ch}' of the number ${w.word}` : `a hyphen`;
    const line = `${where}: the rule wants it ${w.want}, the page draws it ${drawnBold ? 'bold' : 'plain'} (${(ratio * 100).toFixed(0)}% of the bold mark's weight; the rule bolds the first ${w.bold} of ${w.word.length})`;
    v.mismatches.push(line);
    if (w.kind === 'digit') v.byRule.numbersBold.push(line);
    else if (w.kind === 'hyphen') v.byRule.hyphensBold.push(line);
    else if (w.pos === 0 && w.want === 'bold') v.byRule.firstLetterPlain.push(line);
    else if (w.pos === w.bold - 1 || w.pos === w.bold) v.byRule.offByOne.push(line);
    else v.byRule.other.push(line);
  }
  v.medianOn = median(onGains);
  v.medianFull = median(fullGains);
  v.strokeRatio = median(ratios);
  return v;
}

/** One line for the report: what was judged and how heavy the bold was. */
export const describeVerdict = (v: Verdict): string => {
  const pc = (x: number): string => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/a');
  return `${v.assessed} marks judged (${v.unjudged} too small or off screen), ${v.mismatches.length} wrong; bold starts gain ${pc(v.medianOn)} ink against the bold mark's ${pc(v.medianFull)} (ratio ${Number.isFinite(v.strokeRatio) ? v.strokeRatio.toFixed(2) : 'n/a'}); heaviest plain letter ${pc(v.worstPlain)} of a bold mark, lightest bold letter ${pc(v.worstBold)}`;
};

/** The words, numbers and hyphens a passage holds, for a message that proves the passage is a good test of the rule. */
export const describeModel = (m: Model): string =>
  `${[...m.words.entries()].sort((p, q) => p[0] - q[0]).map(([n, c]) => `${c}x${n}-letter`).join(', ')}; ${m.numbers.length} numbers (${[...new Set(m.numbers)].join(' ')}); ${m.hyphens} hyphens; not judged: ${m.skipped.join('; ') || 'none'}`;

/** What a passage must hold for it to be a fair test of the rule, as failures. Empty when it holds them all. */
export function coverageGaps(m: Model): string[] {
  const gaps: string[] = [];
  for (const [n, what] of [[1, 'a one-letter word'], [2, 'a two-letter word'], [3, 'a three-letter word'], [4, 'a four-letter word (half of 4 is 2)']] as const) if (!m.words.has(n)) gaps.push(what);
  if (![...m.words.keys()].some((n) => n >= 5 && n % 2 === 1)) gaps.push('a longer word with an odd number of letters (rounded up)');
  if (![...m.words.keys()].some((n) => n >= 6 && n % 2 === 0)) gaps.push('a longer word with an even number of letters');
  if (m.numbers.length === 0) gaps.push('a number');
  if (m.hyphens === 0) gaps.push('a hyphen');
  return gaps;
}

/** The failure message of a verdict, short enough to read: the first lines of what is wrong. */
export function whatIsWrong(v: Verdict, max = 8): string {
  return `${describeVerdict(v)}\n  ${v.mismatches.slice(0, max).join('\n  ')}${v.mismatches.length > max ? `\n  ... and ${v.mismatches.length - max} more` : ''}`;
}

/** A key as the sheet prints it ("Ctrl+Alt+B", "Shift+F4", "Alt+Plus") as the string Playwright presses. */
export function pressable(sheetKey: string): string {
  const parts = sheetKey.split('+').filter((p) => p !== '');
  const plus = sheetKey.endsWith('++') || sheetKey === '+';
  const names: string[] = [];
  const map: Record<string, string> = { Ctrl: 'Control', Control: 'Control', Alt: 'Alt', Shift: 'Shift', Meta: 'Meta', Cmd: 'Meta', Plus: '+', Minus: '-', Esc: 'Escape', 'Page Up': 'PageUp', 'Page Down': 'PageDown', Space: 'Space' };
  for (const p of parts) names.push(map[p] ?? (p.length === 1 ? p.toLowerCase() : p));
  if (plus) names.push('+');
  return names.join('+');
}

/** Combinations Chrome keeps for itself or that people know as Chrome's: a shortcut here would clash with the browser (R90: "clashes with nothing in Chrome"). */
export const CHROME_KEYS = new Set(
  [
    'Control+n', 'Control+Shift+n', 'Control+t', 'Control+Shift+t', 'Control+w', 'Control+Shift+w', 'Control+Tab', 'Control+Shift+Tab', 'Control+PageUp', 'Control+PageDown', 'Alt+F4',
    'Control+d', 'Control+Shift+d', 'Control+e', 'Control+l', 'Control+h', 'Control+j', 'Control+o', 'Control+r', 'Control+Shift+r', 'Control+Shift+b', 'Control+Shift+o', 'Control+Shift+j',
    'Control+Shift+delete', 'Control+Shift+Delete', 'Control+f', 'Control+g', 'Control+Shift+g', 'Control+p', 'Control+s', 'Control+u', 'Control+a', 'Control+c', 'Control+v', 'Control+x', 'Control+z', 'Control+y',
    'Control+0', 'Control++', 'Control+=', 'Control+-', 'F1', 'F3', 'F5', 'F6', 'F7', 'F11', 'F12', 'Alt+Home', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+d', 'Alt+e', 'Alt+f', 'Alt+Shift+t',
  ].map((k) => k.toLowerCase()),
);

