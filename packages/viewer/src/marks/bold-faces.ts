// How much synthetic bold a face gets (ruling R90b): the PDF's own bold where the document has a bold face of the same
// family, otherwise a typical regular-to-bold gain, and little for text that is already bold. The engine worker keeps
// one BoldFaces per document and fills it with the faces it meets, measured on their own letters (stemMeasures).
//
// A gain has three parts, all in ems: `x`, how much wider the stems get (both sides together); `top`, how far the
// tops of the letters rise (the x-height and cap height); `bottom`, how far their bottoms drop (the baseline). A real
// bold's horizontal strokes thicken mostly inward, into the counters, while its x-height rises only a little and its
// baseline not at all, so the vertical parts are read from the letters' tops and bottoms, not from their strokes.
import type { StemMeasures } from './synthetic-bold';

/** A typical regular-to-bold gain (the standard faces' own bolds: Times 0.055, Helvetica 0.052, Courier 0.041). */
export const TYPICAL_BOLD = { x: 0.05, top: 0.01, bottom: 0, stem: 0.08 } as const;
/** Text that is already bold gets this share of the typical gain: its word starts still show, without smudging. */
export const ALREADY_BOLD_SHARE = 0.4;
/** PDFium's weight (FPDFFont_GetWeight) for a regular face reads up to about 540, for a bold one 570 and up. */
export const BOLD_FONT_WEIGHT = 560;
/** A matched gain is kept within these (ems), so a stray measure never makes a smudge or nothing. */
const MATCHED = { x: [0.015, 0.11], top: [0, 0.025], bottom: [0, 0.01] } as const;

/** Where a face's bold amount came from. */
export type BoldSource = 'matched' | 'typical' | 'already-bold';

export interface BoldGain {
  /** Stem gain across, ems (both sides together). */
  x: number;
  /** How far the tops rise and the bottoms drop, ems. */
  top: number;
  bottom: number;
  /** The face's own stem width, ems: how far the drawing may round the stem gain up (bold-painter.ts). */
  stem: number;
  from: BoldSource;
}

export interface FaceStyle {
  /** The family, from the name with its subset tag and style words taken off ("nimbusromno9l", "times", "cmr"). */
  family: string;
  italic: boolean;
  bold: boolean;
  /** A Black, Heavy or Extra face (by its name: foundries' weights differ): bold, but never another face's matched bold. */
  heavy: boolean;
}

/** Computer Modern and the EC fonts: the bold of each roman, italic and slanted face, by name. */
const CM_FACES: [RegExp, string, boolean, boolean][] = [
  [/^cmbx(\d+)$/, 'cmr', false, true],
  [/^cmb(\d+)$/, 'cmr', false, true],
  [/^cmr(\d+)$/, 'cmr', false, false],
  [/^cmbxti(\d+)$/, 'cmti', true, true],
  [/^cmti(\d+)$/, 'cmti', true, false],
  [/^cmbxsl(\d+)$/, 'cmsl', true, true],
  [/^cmsl(\d+)$/, 'cmsl', true, false],
  [/^cmssbx(\d+)$/, 'cmss', false, true],
  [/^cmss(\d+)$/, 'cmss', false, false],
  [/^sfbx(\d+)$/, 'sfrm', false, true],
  [/^sfrm(\d+)$/, 'sfrm', false, false],
  [/^sfbi(\d+)$/, 'sfti', true, true],
  [/^sfti(\d+)$/, 'sfti', true, false],
];

const BOLD_WORDS = /bold|black|heavy|semi|demi|extra|ultra|medi|^bd$|-bd|bx|blk/;
const HEAVY_WORDS = /black|heavy|extra|ultra|blk/;
const ITALIC_WORDS = /ital|oblique|obl|slant|kursiv|^it$|it$/;

/**
 * A face's family and style from its PostScript name (FPDFFont_GetBaseFontName) and PDFium's weight:
 * "ABCDEF+NimbusRomNo9L-Medi" is family "nimbusromno9l", bold; "Times-Roman" is "times"; "Arial,BoldItalic" is
 * "arial", bold italic; "TimesNewRomanPS-BoldMT" and "TimesNewRomanPSMT" are both "timesnewromanps"; "CMBX10" is the
 * bold of "cmr". A weight of BOLD_FONT_WEIGHT or more is bold whatever the name says.
 */
export function faceStyle(baseName: string, weight = 0): FaceStyle {
  const name = baseName.replace(/^[A-Z]{6}\+/, '').toLowerCase();
  for (const [re, family, italic, bold] of CM_FACES) if (re.test(name)) return { family, italic, bold: bold || weight >= BOLD_FONT_WEIGHT, heavy: false };
  const cut = name.search(/[-,]/);
  let family = cut < 0 ? name : name.slice(0, cut);
  let style = cut < 0 ? '' : name.slice(cut + 1);
  if (cut < 0) {
    // "ArialBold", "TimesNewRomanPSMT": style words glued to the end.
    const m = /(bold|black|heavy|semibold|demibold|medium|italic|oblique|regular|roman|book)+(mt|ps)?$/.exec(family);
    if (m && m.index > 0) {
      style = m[0];
      family = family.slice(0, m.index);
    }
  }
  family = family.replace(/(mt|ps)$/, '').replace(/(mt|ps)$/, '');
  const heavy = HEAVY_WORDS.test(style);
  return { family, italic: ITALIC_WORDS.test(style), bold: BOLD_WORDS.test(style) || weight >= BOLD_FONT_WEIGHT, heavy };
}

/** A face as measured: its style, PDFium's weight, and its letters' measures (stemMeasures, ems). */
export interface FaceMeasures {
  style: FaceStyle;
  weight: number;
  letters: Map<string, StemMeasures>;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const clamp = (v: number, [min, max]: readonly [number, number]) => Math.min(max, Math.max(min, v));

/** A face's own stem width (the median of its measured letters), ems. */
function stemOf(face: FaceMeasures): number | null {
  return median([...face.letters.values()].flatMap((m) => (m.stem === null ? [] : [m.stem])));
}

/**
 * The faces of one document, and each one's bold. A regular face's matched gain is kept once found, so a face is
 * emboldened the same on every later page.
 */
export class BoldFaces {
  private readonly faces = new Map<string, FaceMeasures>();
  private readonly locked = new Map<string, BoldGain>();

  has(name: string): boolean {
    return this.faces.has(name);
  }

  add(name: string, face: FaceMeasures): void {
    if (!this.faces.has(name)) this.faces.set(name, face);
  }

  /** The bold for face `name` (added before). */
  gainFor(name: string): BoldGain {
    const face = this.faces.get(name);
    const stem = (face && stemOf(face)) ?? TYPICAL_BOLD.stem;
    if (!face) return { ...TYPICAL_BOLD, from: 'typical' };
    if (face.style.bold) return { x: TYPICAL_BOLD.x * ALREADY_BOLD_SHARE, top: TYPICAL_BOLD.top * ALREADY_BOLD_SHARE, bottom: 0, stem, from: 'already-bold' };
    const known = this.locked.get(name);
    if (known) return known;
    // Its own bold; else, for an italic face with no bold italic (or the other way round), its sibling's gain.
    const matched = this.match(face, face.style.italic) ?? this.siblingGain(face);
    if (matched) {
      const gain = { ...matched, stem };
      this.locked.set(name, gain);
      return gain;
    }
    return { ...TYPICAL_BOLD, stem, from: 'typical' };
  }

  /** The gain from `face` to the bold of its family with slant `italic`, letter by letter; null when there is none. */
  private match(face: FaceMeasures, italic: boolean): Omit<BoldGain, 'stem'> | null {
    let partner: FaceMeasures | null = null;
    for (const f of this.faces.values()) {
      if (!f.style.bold || f.style.heavy || f.style.family !== face.style.family || f.style.italic !== italic) continue;
      if (partner === null || Math.abs((f.weight || 700) - 700) < Math.abs((partner.weight || 700) - 700)) partner = f;
    }
    if (partner === null) return null;
    const gains: number[] = [];
    const tops: number[] = [];
    const bottoms: number[] = [];
    for (const [letter, m] of face.letters) {
      const b = partner.letters.get(letter);
      if (!b) continue;
      if (m.stem !== null && b.stem !== null) gains.push(b.stem - m.stem);
      if (m.top !== null && b.top !== null) tops.push(b.top - m.top);
      if (m.bottom !== null && b.bottom !== null) bottoms.push(m.bottom - b.bottom);
    }
    const x = median(gains);
    if (x === null || x <= 0) return null;
    return { x: clamp(x, MATCHED.x), top: clamp(median(tops) ?? TYPICAL_BOLD.top, MATCHED.top), bottom: clamp(median(bottoms) ?? 0, MATCHED.bottom), from: 'matched' };
  }

  /** An italic face whose family has no bold italic takes its upright sibling's matched gain (and the other way round). */
  private siblingGain(face: FaceMeasures): Omit<BoldGain, 'stem'> | null {
    for (const f of this.faces.values()) {
      if (f.style.bold || f.style.family !== face.style.family || f.style.italic === face.style.italic) continue;
      const m = this.match(f, f.style.italic);
      if (m) return m;
    }
    return null;
  }
}
