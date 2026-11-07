// Bold on text with no outline to redraw (ruling R106): a scan's recognised text, a Type3 glyph, a scanner's own invisible
// text layer. The letters' own ink on the page's picture is made heavier, as synthetic bold makes real text heavier
// (R90b, R90c): their dark pixels grow outward a little, in their own ink colour, on the picture's pixel grid. Paper,
// stains and show-through stay as they are. Nothing is drawn where a word has no clear ink.
//
// It works in two steps, so every picture of a page (its full render, or the base and its tiles) bolds the same letters:
// - planInk reads one picture of the page. For each word: its paper and ink, judged in the word's own box (Otsu's
//   threshold on luminance, so cream or grey paper, uneven light, white-on-dark and coloured text all work; too little
//   contrast and the word is left out); its letters, as connected ink, cut or joined so there is one a char (letters
//   that touch are cut at the column of least ink, a stroke the scan broke is joined to its char); which letters are
//   bold (the marked chars, so a letter is never half bold); and its line's stroke width. In page points, for any zoom.
// - paintInk grows the bold letters on any picture of the page, each the letter it overlaps in the plan. Each side
//   grows as far as the stroke width says (TYPICAL_BOLD's regular-to-bold gain, times the look's gain) and as the gap to
//   its neighbour allows (R90c: each gap keeps at least KEEP_GAP_PX and KEEP_GAP_SHARE, the space to the next word
//   KEEP_SPACE_SHARE), and no counter closes (MIN_COUNTER_PX, COUNTER_KEEP). What a tight gap does not allow goes upward
//   and into edge darkening, so small text between tight neighbours still reads as bold. The growth moves the letter's
//   own pixels: each row (and column, upward) is shifted by a fraction of a pixel and kept where it is darker, so the
//   edge keeps its softness and the core its colour.
//
// The text direction is a quarter turn in the picture (the glyphs' angle after the page's and the view's turns); each
// line is read into an upright frame, so the rest only knows left to right.
import type { Glyph, PdfRect } from '../backend/types';
import type { TurnMatrix } from '../view/page-transform';
import { TYPICAL_BOLD } from './bold-faces';
import { type BoldRange, KEEP_GAP_PX, KEEP_GAP_SHARE, MIN_COUNTER_PX } from './bold-painter';
import { COUNTER_KEEP } from './synthetic-bold';

/** One word of text with no outline: its chars' boxes (unrotated page points, reading order), and which are bold. */
export interface InkWord {
  chars: PdfRect[];
  /** Chars [from, to) are bold. */
  from: number;
  to: number;
  /** Glyph.angle: the text direction in unrotated page space, clockwise degrees. */
  angle: number;
}

/**
 * A picture of a page, as RGBA. `read` gives a block of rows holding at least device px [x, x + w) × [y, y + h): its
 * top-left px is (block.x, block.y) and its rows are `block.width` px long. Px the picture does not have read as alpha 0.
 */
export interface InkSource {
  read(x: number, y: number, w: number, h: number): InkBlock;
}

export interface InkBlock {
  data: Uint8ClampedArray;
  x: number;
  y: number;
  width: number;
}

type Rgb = readonly [number, number, number];

/** A word as one picture read it: its paper and ink, its letters (page points) and its line's stroke width (points). */
export interface PlannedWord {
  word: InkWord;
  light: boolean;
  groundLum: number;
  inkLum: number;
  ground: Rgb;
  ink: Rgb;
  stroke: number;
  letters: { box: PdfRect; bold: boolean }[];
}

export interface InkPlan {
  words: PlannedWord[];
}

/** What paintInk draws: device px of the picture, ink over paper where the bold grew, the rest left as the ground. */
export interface InkPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  /** RGBA; where nothing grew, white (dark ink, for `darken`) or black (light ink, for `lighten`). */
  rgba: Uint8ClampedArray;
  tone: 'dark' | 'light';
}

/** Total growth across, as a share of the stroke width: the typical face's own regular-to-bold gain (0.05 em on a 0.08 em stem). */
const GROW_SHARE = TYPICAL_BOLD.x / TYPICAL_BOLD.stem;
/** Growth upward, as a share of the growth across (a face's bold rises 0.01 em while its stems gain 0.05 em; the baseline stays). */
const UP_SHARE = 0.2;
/** Paper and ink closer than this (of 255, luminance) is no clear ink: the word is left alone. */
const MIN_CONTRAST = 36;
/** A word box whose ink class is outside these shares holds no letters (a blank, a solid block, a photo). */
const INK_SHARE = [0.01, 0.6] as const;
/** The region read round a word, in its line's height: across and up and down. */
const PAD_U = 0.15;
const PAD_V = 0.24;
/** How far (in the line's height) past a word's first and last letter the next word's ink is looked for. */
const SPACE_SEEN = 0.7;
/** The space between two words keeps at least this share of itself (a gap between letters: KEEP_GAP_SHARE), so words never run together. */
const KEEP_SPACE_SHARE = 0.75;
/** Edge darkening that makes up for growth across a letter could not have (all of it: this much; R90c's Strong is 2.2). */
const LOST_BOOST = 1.6;
/** A pixel at least this far from paper to ink is part of a letter. */
const MASK_T = 0.5;
/** Edge pixels lighter than this (towards paper) are noise, not a letter's edge. */
const RING_T = 0.06;

// ---- words ----

const isInk = (g: Glyph | undefined): g is Glyph => g !== undefined && !g.generated && g.text.trim() !== '' && g.box.width > 0 && g.box.height > 0;
const sideways = (angle: number) => Math.round(angle / 90) % 2 === 1;

/** Whether two boxes share a line for text at `angle`: they overlap across the line by half the smaller. */
function sameLine(a: PdfRect, b: PdfRect, angle: number): boolean {
  const [a0, a1, b0, b1] = sideways(angle) ? [a.x, a.x + a.width, b.x, b.x + b.width] : [a.y, a.y + a.height, b.y, b.y + b.height];
  return Math.min(a1, b1) - Math.max(a0, b0) >= 0.5 * Math.min(a1 - a0, b1 - b0);
}

/** The words chars `runs` cover (each whole word, with the covered chars marked), from the page's glyphs. */
export function inkWordsOf(glyphs: readonly Glyph[], runs: readonly BoldRange[]): InkWord[] {
  const out: InkWord[] = [];
  for (const run of runs) {
    for (let i = Math.max(0, run.start); i < Math.min(run.end, glyphs.length); i++) {
      const g = glyphs[i];
      if (!isInk(g)) continue;
      let s = i;
      while (isInk(glyphs[s - 1]) && sameLine(glyphs[s - 1].box, glyphs[s].box, g.angle)) s--;
      let e = i + 1;
      while (isInk(glyphs[e]) && sameLine(glyphs[e - 1].box, glyphs[e].box, g.angle)) e++;
      out.push({ chars: glyphs.slice(s, e).map((c) => c.box), from: i - s, to: Math.min(e, run.end) - s, angle: g.angle });
      i = e - 1;
    }
  }
  return out;
}

// ---- frames: a part of the picture, turned so its text runs left to right ----

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Quarter turns of the text in the picture. */
  q: number;
  U: number;
  V: number;
  /** The picture's px: the frame's (u, v) is at 4 · (p0 + u·su + v·sv) of `data`. */
  data: Uint8ClampedArray;
  p0: number;
  su: number;
  sv: number;
}

const quarterOf = (device: TurnMatrix, angle: number): number => {
  const r = (angle * Math.PI) / 180;
  const dx = device[0] * Math.cos(r) + device[2] * Math.sin(r);
  const dy = device[1] * Math.cos(r) + device[3] * Math.sin(r);
  return (((Math.round(Math.atan2(dy, dx) / (Math.PI / 2)) % 4) + 4) % 4);
};

/** Device px (continuous) → the frame's upright coordinates. */
function toLocal(f: Pick<Frame, 'x' | 'y' | 'w' | 'h' | 'q'>, x: number, y: number): [number, number] {
  switch (f.q) {
    case 1:
      return [y - f.y, f.x + f.w - x];
    case 2:
      return [f.x + f.w - x, f.y + f.h - y];
    case 3:
      return [f.y + f.h - y, x - f.x];
    default:
      return [x - f.x, y - f.y];
  }
}

/**
 * Where the frame's pixel (u, v) is in the device px (rows `stride` px long) of a `w` × `h` frame turned `q`: p0 + u·su + v·sv.
 * (Turned 1: u runs down and v to the left; 2: both back; 3: u up and v to the right.)
 */
function stepsOf(q: number, w: number, h: number, stride = w): [number, number, number] {
  switch (q) {
    case 1:
      return [w - 1, stride, -1];
    case 2:
      return [(h - 1) * stride + w - 1, -1, -stride];
    case 3:
      return [(h - 1) * stride, -stride, 1];
    default:
      return [0, 1, stride];
  }
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const deviceBox = (d: TurnMatrix, r: PdfRect): Box => {
  const xs = [r.x, r.x + r.width];
  const ys = [r.y, r.y + r.height];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const px of xs)
    for (const py of ys) {
      const X = d[0] * px + d[2] * py + d[4];
      const Y = d[1] * px + d[3] * py + d[5];
      x0 = Math.min(x0, X);
      x1 = Math.max(x1, X);
      y0 = Math.min(y0, Y);
      y1 = Math.max(y1, Y);
    }
  return { x0, y0, x1, y1 };
};

const localBox = (f: Pick<Frame, 'x' | 'y' | 'w' | 'h' | 'q'>, b: Box): Box => {
  const [u0, v0] = toLocal(f, b.x0, b.y0);
  const [u1, v1] = toLocal(f, b.x1, b.y1);
  return { x0: Math.min(u0, u1), y0: Math.min(v0, v1), x1: Math.max(u0, u1), y1: Math.max(v0, v1) };
};

function readFrame(src: InkSource, b: Box, q: number): Frame {
  const x = Math.floor(b.x0);
  const y = Math.floor(b.y0);
  const w = Math.max(1, Math.ceil(b.x1) - x);
  const h = Math.max(1, Math.ceil(b.y1) - y);
  const [U, V] = q % 2 === 1 ? [h, w] : [w, h];
  const block = src.read(x, y, w, h);
  const [p0, su, sv] = stepsOf(q, w, h, block.width);
  return { x, y, w, h, q, U, V, data: block.data, p0: p0 + (y - block.y) * block.width + (x - block.x), su, sv };
}

// ---- one word in a frame ----

interface Levels {
  light: boolean;
  groundLum: number;
  inkLum: number;
  ground: Rgb;
  ink: Rgb;
}

const clip = (b: Box, f: Frame): Box => ({ x0: Math.max(0, Math.floor(b.x0)), y0: Math.max(0, Math.floor(b.y0)), x1: Math.min(f.U, Math.ceil(b.x1)), y1: Math.min(f.V, Math.ceil(b.y1)) });

/** The word's paper and ink in region `r` of the frame (Otsu's threshold), or null where there is no clear ink. */
function levelsOf(f: Frame, r: Box): Levels | null {
  const hist = new Uint32Array(256);
  // Each luminance's colours, summed: the paper's and the ink's colour come from these.
  const sums = new Float64Array(3 * 256);
  let n = 0;
  const { data, p0, su, sv } = f;
  for (let v = r.y0; v < r.y1; v++)
    for (let u = r.x0, p = 4 * (p0 + u * su + v * sv); u < r.x1; u++, p += 4 * su) {
      if (data[p + 3] < 128) continue;
      const R = data[p];
      const G = data[p + 1];
      const B = data[p + 2];
      const l = (54 * R + 183 * G + 19 * B + 128) >> 8;
      hist[l]++;
      sums[3 * l] += R;
      sums[3 * l + 1] += G;
      sums[3 * l + 2] += B;
      n++;
    }
  if (n < 16) return null;
  let total = 0;
  for (let k = 0; k < 256; k++) total += k * hist[k];
  let wB = 0;
  let sumB = 0;
  let best = -1;
  let cut = 0;
  for (let k = 0; k < 256; k++) {
    wB += hist[k];
    if (wB === 0 || wB === n) continue;
    sumB += k * hist[k];
    const mB = sumB / wB;
    const mF = (total - sumB) / (n - wB);
    const between = wB * (n - wB) * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      cut = k;
    }
  }
  let low = 0;
  for (let k = 0; k <= cut; k++) low += hist[k];
  const light = low > n - low; // the ink is the smaller class: light ink when the dark class is the larger
  const inkCount = light ? n - low : low;
  if (inkCount < INK_SHARE[0] * n || inkCount > INK_SHARE[1] * n) return null;
  // The paper: the median of the larger class. The ink: 30% into the ink class from its extreme (its solid core).
  const pick = (from: number, to: number, share: number) => {
    const step = from <= to ? 1 : -1;
    let count = 0;
    for (let k = from; k !== to + step; k += step) count += hist[k];
    let seen = 0;
    for (let k = from; k !== to + step; k += step) {
      seen += hist[k];
      if (seen >= share * count) return k;
    }
    return to;
  };
  const groundLum = light ? pick(0, cut, 0.5) : pick(cut + 1, 255, 0.5);
  const inkLum = light ? pick(255, cut + 1, 0.3) : pick(0, cut, 0.3);
  if (Math.abs(groundLum - inkLum) < MIN_CONTRAST) return null;
  const g = [0, 0, 0];
  const k = [0, 0, 0];
  let gn = 0;
  let kn = 0;
  const span = groundLum - inkLum;
  for (let l = 0; l < 256; l++) {
    if (hist[l] === 0) continue;
    const t = (groundLum - l) / span;
    const acc = t < 0.2 ? g : t > 0.8 ? k : null;
    if (!acc) continue;
    for (let c = 0; c < 3; c++) acc[c] += sums[3 * l + c];
    if (acc === g) gn += hist[l];
    else kn += hist[l];
  }
  if (gn === 0 || kn === 0) return null;
  return { light, groundLum, inkLum, ground: [g[0] / gn, g[1] / gn, g[2] / gn], ink: [k[0] / kn, k[1] / kn, k[2] / kn] };
}

/** Ink coverage of region `r` (0 paper to 1 ink), by the word's levels. */
function coverage(f: Frame, r: Box, l: Pick<Levels, 'groundLum' | 'inkLum'>): Float32Array {
  const W = r.x1 - r.x0;
  const out = new Float32Array(W * (r.y1 - r.y0));
  const span = l.groundLum - l.inkLum;
  const { data, p0, su, sv } = f;
  for (let v = r.y0, o = 0; v < r.y1; v++)
    for (let u = r.x0, p = 4 * (p0 + u * su + v * sv); u < r.x1; u++, p += 4 * su, o++) {
      if (data[p + 3] < 128) continue;
      const t = (l.groundLum - ((54 * data[p] + 183 * data[p + 1] + 19 * data[p + 2] + 128) >> 8)) / span;
      out[o] = t <= 0 ? 0 : t >= 1 ? 1 : t;
    }
  return out;
}

/** A connected piece of ink in a region: its pixels (region indices) and box. */
interface Piece {
  /** Its px, as region indices. */
  px: Int32Array;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

/** The ink's connected pieces (8-connected, coverage ≥ MASK_T) of a W × H coverage map. */
function piecesOf(t: Float32Array, W: number, H: number): { pieces: Piece[]; label: Int32Array } {
  const label = new Int32Array(W * H);
  // Every ink px, piece after piece: each piece's px are a run of it.
  const order = new Int32Array(W * H);
  if (stackBuf.length < W * H) stackBuf = new Int32Array(Math.max(W * H, 2 * stackBuf.length));
  const stack = stackBuf;
  const pieces: Piece[] = [];
  let end = 0;
  for (let s = 0; s < W * H; s++) {
    if (label[s] !== 0 || t[s] < MASK_T) continue;
    const id = pieces.length + 1;
    const start = end;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    let top = 0;
    label[s] = id;
    stack[top++] = s;
    while (top > 0) {
      const i = stack[--top];
      const u = i % W;
      const v = (i - u) / W;
      order[end++] = i;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
      for (let dv = -1; dv <= 1; dv++) {
        const vv = v + dv;
        if (vv < 0 || vv >= H) continue;
        for (let du = -1; du <= 1; du++) {
          const uu = u + du;
          if (uu < 0 || uu >= W) continue;
          const j = vv * W + uu;
          if (label[j] === 0 && t[j] >= MASK_T) {
            label[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    pieces.push({ px: order.subarray(start, end), u0, u1, v0, v1 });
  }
  return { pieces, label };
}

let stackBuf = new Int32Array(4096);

/** A letter: pieces of ink that overlap across (a letter and its dot, a broken stroke). */
interface Letter {
  pieces: Piece[];
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  mass: number;
}

function lettersOf(pieces: readonly Piece[]): Letter[] {
  const sorted = [...pieces].sort((a, b) => a.u0 - b.u0);
  const out: Letter[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    const overlap = last ? Math.min(last.u1, p.u1) - Math.max(last.u0, p.u0) + 1 : -1;
    if (last && overlap >= 0.5 * Math.min(last.u1 - last.u0 + 1, p.u1 - p.u0 + 1)) {
      last.pieces.push(p);
      last.u0 = Math.min(last.u0, p.u0);
      last.u1 = Math.max(last.u1, p.u1);
      last.v0 = Math.min(last.v0, p.v0);
      last.v1 = Math.max(last.v1, p.v1);
      last.mass += p.px.length;
    } else out.push({ pieces: [p], u0: p.u0, u1: p.u1, v0: p.v0, v1: p.v1, mass: p.px.length });
  }
  return out;
}

/** A word's region in a frame: its chars' box, the region read round it, and the line height (frame px). */
function regionOf(f: Frame, d: TurnMatrix, word: InkWord): { box: Box; r: Box; lh: number } | null {
  let box: Box | null = null;
  for (const c of word.chars) {
    const b = localBox(f, deviceBox(d, c));
    box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  }
  if (!box) return null;
  const lh = box.y1 - box.y0;
  const r = clip({ x0: box.x0 - PAD_U * lh, y0: box.y0 - PAD_V * lh, x1: box.x1 + PAD_U * lh, y1: box.y1 + PAD_V * lh }, f);
  if (r.x1 - r.x0 < 2 || r.y1 - r.y0 < 2 || lh < 3) return null;
  return { box, r, lh };
}

/** Whether a piece is part of the word: its centre is inside the word's box (a little wider), and it is no wider than the word or taller than a line and a bit. */
const ofWord = (p: Piece, r: Box, box: Box, lh: number) => {
  const cu = r.x0 + (p.u0 + p.u1 + 1) / 2;
  const cv = r.y0 + (p.v0 + p.v1 + 1) / 2;
  return cu >= box.x0 - 0.08 * lh && cu <= box.x1 + 0.08 * lh && cv >= box.y0 - 0.1 * lh && cv <= box.y1 + 0.1 * lh && p.u1 - p.u0 < box.x1 - box.x0 + 0.5 * lh && p.v1 - p.v0 < 1.8 * lh;
};

/**
 * The word's letters with each that covers the centres of several chars' `cells` (letters that touch in the scan: small
 * text, a heavy face) cut into one letter a char, at the column of least ink near each boundary between cells. The cut
 * letters then each keep their own gap (R90c), and each can be bold or not.
 */
function splitLetters(letters: readonly Letter[], cells: readonly (readonly [number, number])[], t: Float32Array, W: number): Letter[] {
  const out: Letter[] = [];
  for (const l of letters) {
    const inside = cells.filter(([c0, c1]) => (c0 + c1) / 2 >= l.u0 && (c0 + c1) / 2 <= l.u1 + 1);
    if (inside.length < 2) {
      out.push(l);
      continue;
    }
    // Ink a column, over the letter's own px.
    const cols = new Float64Array(l.u1 - l.u0 + 1);
    for (const p of l.pieces) for (const i of p.px) cols[(i % W) - l.u0] += t[i];
    const cuts: number[] = [];
    for (let j = 0; j + 1 < inside.length; j++) {
      const at = (inside[j][1] + inside[j + 1][0]) / 2;
      const reach = Math.max(1, 0.3 * (inside[j][1] - inside[j][0]));
      let best = -1;
      for (let u = Math.max(l.u0 + 1, Math.floor(at - reach)); u <= Math.min(l.u1, Math.ceil(at + reach)); u++)
        if (best < 0 || cols[u - l.u0] < cols[best - l.u0] || (cols[u - l.u0] === cols[best - l.u0] && Math.abs(u - at) < Math.abs(best - at))) best = u;
      if (best > (cuts[cuts.length - 1] ?? l.u0)) cuts.push(best);
    }
    const parts: number[][] = cuts.map(() => []).concat([[]]);
    for (const p of l.pieces)
      for (const i of p.px) {
        const u = i % W;
        let k = 0;
        while (k < cuts.length && u >= cuts[k]) k++;
        parts[k].push(i);
      }
    for (const list of parts) {
      if (list.length === 0) continue;
      const px = Int32Array.from(list);
      const piece: Piece = { px, u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity };
      for (const i of px) {
        const u = i % W;
        const v = (i - u) / W;
        if (u < piece.u0) piece.u0 = u;
        if (u > piece.u1) piece.u1 = u;
        if (v < piece.v0) piece.v0 = v;
        if (v > piece.v1) piece.v1 = v;
      }
      out.push({ pieces: [piece], u0: piece.u0, u1: piece.u1, v0: piece.v0, v1: piece.v1, mass: px.length });
    }
  }
  return out;
}

/**
 * `letters` (left to right) shared out among chars whose cells are `cells` (same px, in order): one letter per char,
 * each the run of pieces that best fits, by the least squared distance between a run's ends and its cell's. There are
 * more letters than chars.
 */
function shareOut(letters: readonly Letter[], cells: readonly (readonly [number, number])[]): Letter[] {
  const G = letters.length;
  const N = cells.length;
  // best[i][j]: the least cost of the first j letters for the first i chars; from[i][j]: where char i's run starts.
  const best = Array.from({ length: N + 1 }, () => new Float64Array(G + 1).fill(Infinity));
  const from = Array.from({ length: N + 1 }, () => new Int32Array(G + 1));
  best[0][0] = 0;
  for (let i = 1; i <= N; i++)
    for (let j = i; j <= G - (N - i); j++)
      for (let k = i - 1; k < j; k++) {
        const before = best[i - 1][k];
        if (before === Infinity) continue;
        let u0 = Infinity;
        let u1 = -Infinity;
        for (let g = k; g < j; g++) {
          u0 = Math.min(u0, letters[g].u0);
          u1 = Math.max(u1, letters[g].u1 + 1);
        }
        const [c0, c1] = cells[i - 1];
        const cost = before + (u0 - c0) ** 2 + (u1 - c1) ** 2;
        if (cost < best[i][j]) {
          best[i][j] = cost;
          from[i][j] = k;
        }
      }
  const out: Letter[] = [];
  for (let i = N, j = G; i > 0; i--) {
    const k = from[i][j];
    const run = letters.slice(k, j);
    out.unshift({
      pieces: run.flatMap((l) => l.pieces),
      u0: Math.min(...run.map((l) => l.u0)),
      u1: Math.max(...run.map((l) => l.u1)),
      v0: Math.min(...run.map((l) => l.v0)),
      v1: Math.max(...run.map((l) => l.v1)),
      mass: run.reduce((m, l) => m + l.mass, 0),
    });
    j = k;
  }
  return out;
}

/** How many of a letter's ink px have their centre in [a, b) across (region px). */
function massWithin(l: Letter, W: number, a: number, b: number): number {
  let inside = 0;
  for (const p of l.pieces)
    for (const i of p.px) {
      const u = (i % W) + 0.5;
      if (u >= a && u < b) inside++;
    }
  return inside;
}

/** Horizontal ink runs of a letter (frame px, each with its edge pixels' share): its stroke widths. */
function runsOf(l: Letter, t: Float32Array, label: Int32Array, W: number, lh: number, out: number[]): void {
  const ids = new Set(l.pieces.map((p) => label[p.px[0]]));
  for (let v = l.v0; v <= l.v1; v++) {
    let u = l.u0;
    while (u <= l.u1) {
      if (!ids.has(label[v * W + u])) {
        u++;
        continue;
      }
      let e = u;
      let w = 0;
      while (e <= l.u1 && ids.has(label[v * W + e])) w += t[v * W + e++];
      if (u > 0) w += t[v * W + u - 1];
      if (e < W) w += t[v * W + e];
      if (e - u < 0.45 * lh) out.push(w);
      u = e;
    }
  }
}

const median = (a: number[]): number | undefined => {
  if (a.length === 0) return undefined;
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
};

/** Px a point along a frame's text direction. */
const pxPerPtAlong = (d: TurnMatrix, angle: number) => {
  const r = (angle * Math.PI) / 180;
  return Math.hypot(d[0] * Math.cos(r) + d[2] * Math.sin(r), d[1] * Math.cos(r) + d[3] * Math.sin(r));
};

/** Frame px → unrotated page points. */
function toPage(f: Frame, inverse: TurnMatrix, u: number, v: number): [number, number] {
  // the frame's continuous (u, v) → device: the inverse of toLocal
  let x: number;
  let y: number;
  switch (f.q) {
    case 1:
      [x, y] = [f.x + f.w - v, f.y + u];
      break;
    case 2:
      [x, y] = [f.x + f.w - u, f.y + f.h - v];
      break;
    case 3:
      [x, y] = [f.x + v, f.y + f.h - u];
      break;
    default:
      [x, y] = [f.x + u, f.y + v];
  }
  return [inverse[0] * x + inverse[2] * y + inverse[4], inverse[1] * x + inverse[3] * y + inverse[5]];
}

function invert(m: TurnMatrix): TurnMatrix {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/** Words in a row on one line, for one frame each. */
function linesOf(words: readonly InkWord[]): InkWord[][] {
  const lines: InkWord[][] = [];
  for (const w of words) {
    const line = lines[lines.length - 1];
    const prev = line?.[line.length - 1];
    if (prev && prev.angle === w.angle && sameLine(unionOf(prev.chars), unionOf(w.chars), w.angle)) line.push(w);
    else lines.push([w]);
  }
  return lines;
}

const unionOf = (rs: readonly PdfRect[]): PdfRect => {
  const x0 = Math.min(...rs.map((r) => r.x));
  const y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.width));
  const y1 = Math.max(...rs.map((r) => r.y + r.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** The frame of a line: its words' boxes, padded, in the picture. */
function lineFrame(src: InkSource, d: TurnMatrix, words: readonly InkWord[]): Frame | null {
  const b = lineBox(d, words);
  return b ? readFrame(src, b, quarterOf(d, words[0].angle)) : null;
}

/** The device px a line's frame reads: its words' boxes, padded (null with no chars). */
function lineBox(d: TurnMatrix, words: readonly InkWord[]): Box | null {
  const all = words.flatMap((w) => w.chars);
  if (all.length === 0) return null;
  const b = deviceBox(d, unionOf(all));
  const across = quarterOf(d, words[0].angle) % 2 === 1;
  // The line's height: its chars' size across the text, in px.
  const lh = Math.max(...all.map((c) => {
    const cb = deviceBox(d, c);
    return across ? cb.x1 - cb.x0 : cb.y1 - cb.y0;
  }));
  const pad = (k: number) => k * Math.max(lh, 1);
  // Along the line, room to find the words either side of the first and last (SPACE_SEEN).
  const padX = across ? pad(PAD_V + 0.05) : pad(SPACE_SEEN + 0.05);
  const padY = across ? pad(SPACE_SEEN + 0.05) : pad(PAD_V + 0.05);
  return { x0: Math.floor(b.x0 - padX), y0: Math.floor(b.y0 - padY), x1: Math.ceil(b.x1 + padX), y1: Math.ceil(b.y1 + padY) };
}

/**
 * The lines paintInk paints for `plan` on a picture made with `device`: each one's frame (device px: what it reads and
 * what its patch covers) and its words. paintInk's `line` paints one of them.
 */
export function inkLines(device: TurnMatrix, plan: InkPlan): { box: Box; words: InkWord[] }[] {
  return linesOf(plan.words.map((p) => p.word)).map((words) => ({ box: lineBox(device, words)!, words }));
}

// ---- planning ----

/**
 * Reads the words in `pic` (made with `device`: unrotated page points → its px) and decides, for each, its paper and ink,
 * its letters and which are bold, and its line's stroke width. Words with no clear ink are left out.
 */
export function planInk(pic: InkSource, device: TurnMatrix, words: readonly InkWord[], keep = false): InkPlan {
  const inverse = invert(device);
  const out: PlannedWord[] = [];
  const kept = new Map<InkWord, WordRead>();
  for (const line of linesOf(words)) {
    const f = lineFrame(pic, device, line);
    if (!f) continue;
    const runs: number[] = [];
    const made: PlannedWord[] = [];
    for (const word of line) {
      const at = regionOf(f, device, word);
      if (!at) continue;
      const { box, r, lh } = at;
      const levels = levelsOf(f, r);
      if (!levels) continue;
      const W = r.x1 - r.x0;
      const t = coverage(f, r, levels);
      const { pieces, label } = piecesOf(t, W, r.y1 - r.y0);
      if (keep) kept.set(word, { f, at, t, pieces, label });
      let letters = lettersOf(pieces.filter((p) => ofWord(p, r, box, lh)));
      if (letters.length === 0) continue;
      // The marked chars, laid over the word's real ink: the OCR boxes are estimates, the ink is not.
      const inkU0 = r.x0 + letters[0].u0;
      const inkU1 = r.x0 + Math.max(...letters.map((l) => l.u1)) + 1;
      const charU = word.chars.map((c) => localBox(f, deviceBox(device, c)));
      const along = (u: number) => inkU0 + ((u - box.x0) / Math.max(1e-6, box.x1 - box.x0)) * (inkU1 - inkU0);
      const whole = word.from <= 0 && word.to >= word.chars.length;
      // More pieces than chars (a thin stroke broken in the scan: an "m" in three stems): the pieces are shared out
      // among the chars in order, each char the run of pieces nearest where its box says it is.
      const cells = charU.map((c) => [along(c.x0) - r.x0, along(c.x1) - r.x0] as const);
      letters = splitLetters(letters, cells, t, W);
      if (letters.length > word.chars.length) letters = shareOut(letters, cells);
      const s0 = whole ? -Infinity : along(charU[word.from].x0);
      const s1 = whole ? Infinity : along(charU[Math.max(word.from, word.to - 1)].x1);
      // One letter a char: the marked chars are those letters. Fewer (letters that touch in the scan): a letter is
      // bold when most of its ink is inside the marked chars.
      const oneEach = letters.length === word.chars.length;
      const bold = letters.map((l, k) => whole || (oneEach ? k >= word.from && k < word.to : 2 * massWithin(l, W, s0 - r.x0, s1 - r.x0) > l.mass));
      letters.forEach((l, k) => bold[k] && runsOf(l, t, label, W, lh, runs));
      made.push({
        word,
        ...levels,
        stroke: 0,
        letters: letters.map((l, k) => {
          const [ax, ay] = toPage(f, inverse, r.x0 + l.u0, r.y0 + l.v0);
          const [bx, by] = toPage(f, inverse, r.x0 + l.u1 + 1, r.y0 + l.v1 + 1);
          return { box: { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) }, bold: bold[k] };
        }),
      });
      if (runs.length === 0) runs.push(0.06 * lh); // no clean stroke to measure: a typical stem for its size
    }
    const k = pxPerPtAlong(device, line[0].angle);
    const stroke = (median(runs) ?? 0) / k;
    for (const m of made) {
      m.stroke = stroke;
      out.push(m);
    }
  }
  const plan: InkPlan = { words: out };
  if (keep) reads.set(plan, { device, words: kept });
  return plan;
}

/** One word as a picture was read for its plan: what paintInk needs again on that same picture. */
interface WordRead {
  f: Frame;
  at: NonNullable<ReturnType<typeof regionOf>>;
  t: Float32Array;
  pieces: Piece[];
  label: Int32Array;
}

/** What planInk read (with `keep`), for the first paintInk on the same picture (with `reuse`); dropped once used. */
const reads = new WeakMap<InkPlan, { device: TurnMatrix; words: Map<InkWord, WordRead> }>();

// ---- painting ----

/** How heavy: the gain on the typical regular-to-bold growth, and edge darkening (paintBold's `gain` and `boost`). */
export interface InkLook {
  gain: number;
  boost: number;
}

/** Holes in letter `n`'s own ink (the eye of "e", the bowl of "a"): each one's widest run across and up and down. */
function holesOf(l: Letter, n: number, owner: Int32Array, label: Int32Array, W: number): { w: number; h: number }[] {
  const bw = l.u1 - l.u0 + 1;
  const bh = l.v1 - l.v0 + 1;
  // 1 ink, 2 paper reached from outside, 3 a hole seen
  const cell = new Uint8Array(bw * bh);
  for (let v = 0; v < bh; v++)
    for (let u = 0; u < bw; u++) {
      const i = (l.v0 + v) * W + l.u0 + u;
      if (label[i] !== 0 && owner[i] === n) cell[v * bw + u] = 1;
    }
  const stack = new Int32Array(bw * bh);
  const rowRun = new Int32Array(bh);
  const colRun = new Int32Array(bw);
  /** Fills the paper at `s` with `mark`; returns how many px. */
  const fill = (s: number, mark: number): number => {
    let top = 0;
    let count = 0;
    cell[s] = mark;
    stack[top++] = s;
    const visit = (k: number) => {
      if (cell[k] !== 0) return;
      cell[k] = mark;
      stack[top++] = k;
    };
    while (top > 0) {
      const i = stack[--top];
      count++;
      const u = i % bw;
      const v = (i - u) / bw;
      if (mark === 3) {
        rowRun[v]++;
        colRun[u]++;
      }
      if (u > 0) visit(i - 1);
      if (u < bw - 1) visit(i + 1);
      if (v > 0) visit(i - bw);
      if (v < bh - 1) visit(i + bw);
    }
    return count;
  };
  // Paper reached from the box's edge is outside the letter.
  for (let u = 0; u < bw; u++) {
    if (cell[u] === 0) fill(u, 2);
    if (cell[(bh - 1) * bw + u] === 0) fill((bh - 1) * bw + u, 2);
  }
  for (let v = 0; v < bh; v++) {
    if (cell[v * bw] === 0) fill(v * bw, 2);
    if (cell[v * bw + bw - 1] === 0) fill(v * bw + bw - 1, 2);
  }
  const holes: { w: number; h: number }[] = [];
  for (let s = 0; s < bw * bh; s++) {
    if (cell[s] !== 0) continue;
    rowRun.fill(0);
    colRun.fill(0);
    if (fill(s, 3) < 2) continue;
    let w = 0;
    let h = 0;
    for (const r of rowRun) w = Math.max(w, r);
    for (const c of colRun) h = Math.max(h, c);
    holes.push({ w, h });
  }
  return holes;
}

/**
 * The narrowest gap between letter `a` and letter `b` on its right, over the rows both have ink in: between where each
 * one's edge crosses half ink (found between the px either side of it), so a gap is known to a fraction of a px.
 */
function gapBetween(a: Letter, b: Letter, na: number, nb: number, owner: Int32Array, label: Int32Array, t: Float32Array, W: number): number {
  let gap = Infinity;
  for (let v = Math.max(a.v0, b.v0); v <= Math.min(a.v1, b.v1); v++) {
    let ar = -1;
    for (let u = a.u1; u >= a.u0; u--)
      if (label[v * W + u] !== 0 && owner[v * W + u] === na) {
        ar = u;
        break;
      }
    let bl = -1;
    for (let u = b.u0; u <= b.u1; u++)
      if (label[v * W + u] !== 0 && owner[v * W + u] === nb) {
        bl = u;
        break;
      }
    if (ar < 0 || bl < 0) continue;
    const edge = (u: number, out: number) => {
      const inside = t[v * W + u];
      const beyond = out >= 0 && out < W ? t[v * W + out] : 0;
      return inside > beyond ? (inside - MASK_T) / (inside - beyond) : 0.5;
    };
    const here = bl - ar - edge(ar, ar + 1) - edge(bl, bl - 1);
    if (here < gap) gap = Math.max(0, here);
  }
  return gap;
}

/**
 * The space from letter `l` (letter `n` of a word in region `r`) to the next ink beyond it in the frame, on the side
 * `dir` (1: right): the next word, or punctuation not in this word. Read from the frame itself (the region holds only
 * this word), with the word's levels, at most `reach` px out; Infinity where there is none.
 */
function spaceGap(f: Frame, r: Box, l: Letter, n: number, owner: Int32Array, label: Int32Array, t: Float32Array, W: number, lv: Pick<Levels, 'groundLum' | 'inkLum'>, dir: -1 | 1, reach: number): number {
  const span = lv.groundLum - lv.inkLum;
  const tAt = (u: number, v: number) => {
    if (u < 0 || u >= f.U) return 0;
    const p = 4 * (f.p0 + u * f.su + v * f.sv);
    if (f.data[p + 3] < 128) return 0;
    const x = (lv.groundLum - ((54 * f.data[p] + 183 * f.data[p + 1] + 19 * f.data[p + 2] + 128) >> 8)) / span;
    return x <= 0 ? 0 : x >= 1 ? 1 : x;
  };
  let gap = Infinity;
  for (let v = l.v0; v <= l.v1; v++) {
    let e = -1;
    if (dir > 0) {
      for (let u = l.u1; u >= l.u0; u--)
        if (label[v * W + u] !== 0 && owner[v * W + u] === n) {
          e = u;
          break;
        }
    } else
      for (let u = l.u0; u <= l.u1; u++)
        if (label[v * W + u] !== 0 && owner[v * W + u] === n) {
          e = u;
          break;
        }
    if (e < 0) continue;
    const fv = r.y0 + v;
    const fe = r.x0 + e;
    const inside = t[v * W + e];
    let before = tAt(fe + dir, fv);
    const out = inside > before ? (inside - MASK_T) / (inside - before) : 0.5;
    for (let k = 1; k <= reach; k++) {
      const here = tAt(fe + dir * k, fv);
      if (here >= MASK_T) {
        // the other ink's edge, between this px and the one before it
        const into = here > before ? (here - MASK_T) / (here - before) : 0.5;
        gap = Math.min(gap, Math.max(0, k - out - into));
        break;
      }
      before = here;
    }
  }
  return gap;
}

/** Work space reused from letter to letter (a letter's box is small, but there are many): slot `k`, `n` floats, zeroed. */
const scratch: Float32Array[] = [];
function scratchFloats(k: number, n: number): Float32Array {
  let a = scratch[k];
  if (!a || a.length < n) scratch[k] = a = new Float32Array(Math.max(n, 2 * (a?.length ?? 0), 4096));
  const view = a.subarray(0, n);
  view.fill(0);
  return view;
}

/**
 * Letter `n`'s ink in its box: how far each of its px is from the paper towards the ink (summed over the colour
 * channels; its ink and soft edge, the rest 0), and where its ink starts and ends on each row.
 */
function letterSource(owner: Int32Array, label: Int32Array, n: number, W: number, u0: number, v0: number, bw: number, bh: number, at: PxAt, ground: Rgb, sign: number): { dark: Float32Array; rowL: Int32Array; rowR: Int32Array } {
  const dark = scratchFloats(3, bw * bh);
  const rowL = new Int32Array(bh).fill(-1);
  const rowR = new Int32Array(bh).fill(-1);
  const { data, p0, su, sv, rx, ry } = at;
  const g = sign * (ground[0] + ground[1] + ground[2]);
  for (let y = 0; y < bh; y++)
    for (let x = 0; x < bw; x++) {
      const i = (v0 + y) * W + u0 + x;
      if (owner[i] !== n) continue;
      const p = 4 * (p0 + (rx + u0 + x) * su + (ry + v0 + y) * sv);
      const d = g - sign * (data[p] + data[p + 1] + data[p + 2]);
      dark[y * bw + x] = d > 0 ? d : 0;
      if (label[i] !== 0) {
        if (rowL[y] === -1) rowL[y] = u0 + x;
        rowR[y] = u0 + x;
      }
    }
  return { dark, rowL, rowR };
}

/** Where a word's region is in the picture's px: (u, v) of the region is at 4 · (p0 + (rx + u)·su + (ry + v)·sv) of `data`. */
interface PxAt {
  data: Uint8ClampedArray;
  p0: number;
  su: number;
  sv: number;
  rx: number;
  ry: number;
}

/** Gives each soft edge pixel (not ink, but not paper) to the letter whose ink it touches first. */
function ringOwners(owner: Int32Array, label: Int32Array, t: Float32Array, W: number, H: number): void {
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      if (owner[i] !== -1 || t[i] < RING_T) continue;
      let o = -1;
      for (let dv = -1; dv <= 1 && o === -1; dv++) {
        const vv = v + dv;
        if (vv < 0 || vv >= H) continue;
        for (let du = -1; du <= 1; du++) {
          const uu = u + du;
          if (uu < 0 || uu >= W) continue;
          const j = vv * W + uu;
          if (label[j] !== 0 && owner[j] >= 0) {
            o = owner[j]!;
            break;
          }
        }
      }
      owner[i] = o;
    }
}

/** Where a letter's grown box sits: in its word's region, the region in the frame, and the frame in the patch. */
interface Spot {
  u0: number;
  v0: number;
  bw: number;
  bh: number;
  rx: number;
  ry: number;
  W: number;
  U: number;
  p0: number;
  su: number;
  sv: number;
}

/**
 * Writes a letter's grown ink `g` (how far from the paper, summed over the channels) into the patch where it is darker
 * than the picture (lighter, for light ink) and than what is there, in the word's own ink colour (from its paper towards
 * its ink, as far as `g` says: so the letter's core keeps its own darkness). Edge darkening (`boost`) is left off on a
 * side whose gap is tight. Whether any px grew.
 */
function writeGrown(g: Float32Array, rowL: Int32Array, rowR: Int32Array, tightL: boolean, tightR: boolean, boost: number, s: Spot, at: PxAt, cov: Float32Array, rgba: Uint8ClampedArray, ground: Rgb, ink: Rgb, sign: number, span: number): boolean {
  // Per unit of darkness, each channel's step from the paper towards the ink.
  const hr = (ground[0] - ink[0]) / span;
  const hg = (ground[1] - ink[1]) / span;
  const hb = (ground[2] - ink[2]) / span;
  const g0 = sign * (ground[0] + ground[1] + ground[2]);
  let drew = false;
  for (let y = 0; y < s.bh; y++) {
    const rl = rowL[y];
    const rr = rowR[y];
    const v = s.v0 + y;
    const fv = s.ry + v;
    for (let x = 0; x < s.bw; x++) {
      let sum = g[y * s.bw + x];
      if (sum <= 0) continue;
      const u = s.u0 + x;
      if (boost > 0 && !(tightL && (rl === -1 || u < rl)) && !(tightR && (rr === -1 || u > rr))) {
        const c = Math.min(1, sum / span);
        sum *= (1 - (1 - c) ** (1 + boost)) / c;
      }
      const p = 4 * (at.p0 + (at.rx + u) * at.su + (at.ry + v) * at.sv);
      const was = g0 - sign * (at.data[p] + at.data[p + 1] + at.data[p + 2]);
      if (sum <= was + 0.01 * span) continue;
      const fu = s.rx + u;
      const fi = fv * s.U + fu;
      if (sum <= cov[fi]) continue;
      cov[fi] = sum;
      const q = 4 * (s.p0 + fu * s.su + fv * s.sv);
      rgba[q] = ground[0] - sum * hr;
      rgba[q + 1] = ground[1] - sum * hg;
      rgba[q + 2] = ground[2] - sum * hb;
      drew = true;
    }
  }
  return drew;
}

/**
 * Grows `src` (W × H) by `left` and `right` px across and `up` px upward. Each side: the max over the whole px it
 * reaches (k), blended with the max one px further by the fraction left over, so an edge moves by a fraction of a px
 * and stays anti-aliased.
 */
function grow(src: Float32Array, W: number, H: number, left: number, right: number, up: number, slot: number): Float32Array {
  const across = scratchFloats(slot, W * H);
  const kr = Math.floor(right);
  const fr = right - kr;
  const kl = Math.floor(left);
  const fl = left - kl;
  for (let v = 0; v < H; v++) {
    const row = v * W;
    for (let u = 0; u < W; u++) {
      let c = src[row + u];
      if (right > 0) {
        // the ink on the left grows right
        let m = 0;
        for (let j = Math.max(0, u - kr); j <= u; j++) if (src[row + j] > m) m = src[row + j]!;
        const far = u - kr - 1 >= 0 ? Math.max(m, src[row + u - kr - 1]) : m;
        const g = (1 - fr) * m + fr * far;
        if (g > c) c = g;
      }
      if (left > 0) {
        let m = 0;
        for (let j = u; j <= Math.min(W - 1, u + kl); j++) if (src[row + j] > m) m = src[row + j]!;
        const far = u + kl + 1 < W ? Math.max(m, src[row + u + kl + 1]) : m;
        const g = (1 - fl) * m + fl * far;
        if (g > c) c = g;
      }
      across[row + u] = c;
    }
  }
  if (up <= 0) return across;
  const out = scratchFloats(slot + 1, W * H);
  const ku = Math.floor(up);
  const fu = up - ku;
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      // the ink below grows up
      let m = 0;
      for (let j = v; j <= Math.min(H - 1, v + ku); j++) if (across[j * W + u] > m) m = across[j * W + u]!;
      const far = v + ku + 1 < H ? Math.max(m, across[(v + ku + 1) * W + u]) : m;
      out[v * W + u] = (1 - fu) * m + fu * far;
    }
  return out;
}

/**
 * Paints the plan's bold letters grown on `pic` (made with `device`): the lines that meet the device px box `area`
 * (all without it), or line `only` alone (inkLines). With `reuse`, the first paint of the picture the plan was read
 * from uses that reading. Returns the patches to blend over the picture (dark ink with darken, light ink with lighten), and how many
 * letters grew.
 */
export function paintInk(pic: InkSource, device: TurnMatrix, plan: InkPlan, look: InkLook, area?: Box, reuse = false, only?: number): { patches: InkPatch[]; letters: number } {
  const patches: InkPatch[] = [];
  const read = reuse ? reads.get(plan) : undefined;
  reads.delete(plan);
  const again = read !== undefined && read.device.every((v, i) => v === device[i]) ? read.words : undefined;
  let grown = 0;
  const inverse = invert(device);
  const boost = Math.max(0, Math.min(3, look.boost));
  const lines = linesOf(plan.words.map((p) => p.word));
  let next = 0;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const planned = plan.words.slice(next, next + line.length);
    next += line.length;
    if (only !== undefined && li !== only) continue;
    if (!planned.some((pw) => pw.letters.some((l) => l.bold))) continue;
    if (area) {
      const b = deviceBox(device, unionOf(line.flatMap((w) => w.chars)));
      const m = Math.max(4, 0.6 * Math.min(b.x1 - b.x0, b.y1 - b.y0));
      if (b.x1 + m < area.x0 || b.x0 - m > area.x1 || b.y1 + m < area.y0 || b.y0 - m > area.y1) continue;
    }
    const f = again?.get(line[0])?.f ?? lineFrame(pic, device, line);
    if (!f) continue;
    const k = pxPerPtAlong(device, line[0].angle);
    const [p0, su, sv] = stepsOf(f.q, f.w, f.h);
    // What grew in this frame, per tone: its coverage (frame px) and the patch (device px), made when first needed.
    const outs: Partial<Record<'dark' | 'light', { cov: Float32Array; rgba: Uint8ClampedArray }>> = {};
    const outOf = (tone: 'dark' | 'light') => {
      let o = outs[tone];
      if (!o) {
        const rgba = new Uint8ClampedArray(4 * f.w * f.h);
        new Uint32Array(rgba.buffer).fill(tone === 'dark' ? 0xffffffff : 0xff000000);
        outs[tone] = o = { cov: new Float32Array(f.U * f.V), rgba };
      }
      return o;
    };
    for (const pw of planned) {
      if (!pw.letters.some((l) => l.bold)) continue;
      const known = again?.get(pw.word);
      const region = known?.at ?? regionOf(f, device, pw.word);
      if (!region) continue;
      const { box, r, lh } = region;
      const W = r.x1 - r.x0;
      const H = r.y1 - r.y0;
      const t = known?.t ?? coverage(f, r, pw);
      const { pieces, label } = known ?? piecesOf(t, W, H);
      // The letters as this picture shows them; each is bold when its centre is in a letter the plan made bold. (A
      // picture sharper than the plan's may part two letters the plan saw as one: each keeps its own gap.)
      const all = pw.letters.every((pl) => pl.bold);
      let found = lettersOf(pieces.filter((p) => ofWord(p, r, box, lh)));
      if (found.length === 0) continue;
      {
        const inkU0 = found[0].u0;
        const inkU1 = Math.max(...found.map((l) => l.u1)) + 1;
        // frame px across → region px, laid over the word's ink
        const along = (u: number) => inkU0 + ((u - box.x0) / Math.max(1e-6, box.x1 - box.x0)) * (inkU1 - inkU0);
        found = splitLetters(found, pw.word.chars.map((c) => {
          const cb = localBox(f, deviceBox(device, c));
          return [along(cb.x0), along(cb.x1)] as const;
        }), t, W);
      }
      // Each letter takes the plan's letter it overlaps most across (both are read from the same ink).
      const across = (b: PdfRect) => (sideways(pw.word.angle) ? [b.y, b.y + b.height] : [b.x, b.x + b.width]);
      const letters: (Letter & { bold: boolean })[] = found.map((l) => {
        if (all) return { ...l, bold: true };
        const [ax, ay] = toPage(f, inverse, r.x0 + l.u0, r.y0 + l.v0);
        const [bx, by] = toPage(f, inverse, r.x0 + l.u1 + 1, r.y0 + l.v1 + 1);
        const [a0, a1] = across({ x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) });
        let best = 0;
        let bold = false;
        for (const pl of pw.letters) {
          const [b0, b1] = across(pl.box);
          const o = Math.min(a1, b1) - Math.max(a0, b0);
          if (o > best) {
            best = o;
            bold = pl.bold;
          }
        }
        return { ...l, bold };
      });
      if (!letters.some((l) => l.bold)) continue;
      letters.sort((a, b) => a.u0 - b.u0);
      // Each letter's pixels: its ink, and the soft edge just round it (given to the first letter that touches it).
      const owner = new Int32Array(W * H).fill(-1);
      for (let n = 0; n < letters.length; n++) for (const p of letters[n].pieces) for (const i of p.px) owner[i] = n;
      ringOwners(owner, label, t, W, H);
      const growth = GROW_SHARE * pw.stroke * k * look.gain;
      if (growth <= 0) continue;
      const out = outOf(pw.light ? 'light' : 'dark');
      const { cov, rgba } = out;
      const sign = pw.light ? -1 : 1;
      // The word's paper to ink, summed over the channels.
      const span = Math.max(1, sign * (pw.ground[0] - pw.ink[0]) + sign * (pw.ground[1] - pw.ink[1]) + sign * (pw.ground[2] - pw.ink[2]));
      const at: PxAt = { data: f.data, p0: f.p0, su: f.su, sv: f.sv, rx: r.x0, ry: r.y0 };
      // R90c: each side only as far as leaves its neighbour at least KEEP_GAP_PX and KEEP_GAP_SHARE of the gap; a gap
      // to a bold neighbour is shared, as both grow into it.
      const room = (gap: number, shared: boolean, keep = KEEP_GAP_SHARE) => (Number.isFinite(gap) ? Math.max(0, gap - Math.max(KEEP_GAP_PX, keep * gap)) / (shared ? 2 : 1) : Infinity);
      for (let n = 0; n < letters.length; n++) {
        const l = letters[n];
        if (!l.bold) continue;
        const prev = letters[n - 1];
        const next = letters[n + 1];
        // The first and last letters face the words either side: that space is shared, and keeps KEEP_SPACE_SHARE.
        const space = (dir: -1 | 1) => room(spaceGap(f, r, l, n, owner, label, t, W, pw, dir, SPACE_SEEN * lh), true, KEEP_SPACE_SHARE);
        const roomL = prev ? room(gapBetween(prev, l, n - 1, n, owner, label, t, W), prev.bold) : space(-1);
        const roomR = next ? room(gapBetween(l, next, n, n + 1, owner, label, t, W), next.bold) : space(1);
        // Half the growth each side; where one side has no room, the other takes what it can of the rest, so the
        // letter's stems still gain their weight (it moves by a fraction of a px).
        let right = Math.min(roomR, growth / 2);
        let left = Math.min(roomL, growth - right);
        right = Math.min(roomR, growth - left);
        // Up: the face's own rise, and half of what could not grow across (its arches and bars take the weight its
        // stems could not; the baseline stays).
        let up = UP_SHARE * growth + 0.5 * Math.max(0, growth - left - right);
        // Counters keep COUNTER_KEEP of their size and at least MIN_COUNTER_PX.
        for (const h of holesOf(l, n, owner, label, W)) {
          const across = Math.max(0, Math.min((1 - COUNTER_KEEP) * h.w, h.w - MIN_COUNTER_PX));
          if (left + right > across) {
            const sc = across / (left + right);
            left *= sc;
            right *= sc;
          }
          up = Math.min(up, Math.max(0, Math.min((1 - COUNTER_KEEP) * h.h, h.h - MIN_COUNTER_PX)));
        }
        const tightL = roomL < growth / 2;
        const tightR = roomR < growth / 2;
        // What the gaps and counters did not let it grow across is made up by darkening its own edges (which moves no
        // outline), as small text is made heavier (R90c): so a letter between tight neighbours still reads as bold.
        const lost = Math.max(0, 1 - (left + right) / growth);
        const darken = Math.max(boost, Math.min(3, LOST_BOOST * lost));
        // The letter's own pixels, with room round it to grow into.
        const m = Math.ceil(Math.max(left, right, up)) + 1;
        const u0 = Math.max(0, l.u0 - m);
        const u1 = Math.min(W - 1, l.u1 + m);
        const v0 = Math.max(0, l.v0 - m);
        const v1 = Math.min(H - 1, l.v1 + 1);
        const bw = u1 - u0 + 1;
        const bh = v1 - v0 + 1;
        const { dark, rowL, rowR } = letterSource(owner, label, n, W, u0, v0, bw, bh, at, pw.ground, sign);
        // The letter's own px move outward: its edge keeps its softness, its core its darkness.
        const g = grow(dark, bw, bh, left, right, up, 6);
        const spot = { u0, v0, bw, bh, rx: r.x0, ry: r.y0, W, U: f.U, p0, su, sv };
        if (writeGrown(g, rowL, rowR, tightL, tightR, darken, spot, at, cov, rgba, pw.ground, pw.ink, sign, span)) grown++;
      }
    }
    for (const tone of ['dark', 'light'] as const) {
      const o = outs[tone];
      if (o) patches.push({ x: f.x, y: f.y, w: f.w, h: f.h, rgba: o.rgba, tone });
    }
  }
  return { patches, letters: grown };
}

// ---- warming up ----

let warmed = false;

/**
 * Runs planInk and paintInk a few times on a small made-up line of letters, once a tab, when the browser is idle: the
 * first bold on a scan then takes a few ms instead of the hundred or more that code run for the first time costs.
 * Called when a page's recognised text arrives. Touches nothing on screen.
 */
export function warmInkSoon(): void {
  if (warmed) return;
  warmed = true;
  // A line of made-up letters (stems and rings with soft edges) on cream paper, at a fractional scale with fractional
  // boxes: the same kinds of numbers as a real page, so the code is warmed up for them. `m`: how large (1 and 2: a page
  // at about 100% and 200% on a 2× screen).
  const line = (m: number) => {
    const k = 2.6667 * m;
    const W = 420 * m;
    const H = 60 * m;
    const paper = [238, 230, 205] as const;
    const px = new Uint8ClampedArray(4 * W * H);
    for (let i = 0; i < W * H; i++) px.set([...paper, 255], 4 * i);
    const ink = (x: number, y: number, c: number) => {
      const p = 4 * (y * W + x);
      for (let ch = 0; ch < 3; ch++) px[p + ch] = Math.min(px[p + ch], paper[ch] - c * (paper[ch] - [40, 32, 28][ch]));
    };
    for (let n = 0; n < 16; n++) {
      const x0 = m * (14 + n * 24.5);
      for (let y = 14 * m; y < 46 * m; y++) for (let x = Math.floor(x0); x < x0 + 4 * m; x++) ink(x, y, x === Math.floor(x0) ? 0.45 : x >= x0 + 4 * m - 1 ? 0.6 : 1);
      for (let y = 26 * m; y < 48 * m; y++)
        for (let x = Math.floor(x0 + 6 * m); x < x0 + 22 * m; x++) {
          const d = Math.abs(Math.hypot(x - x0 - 13.5 * m, y - 37 * m) - 7.5 * m);
          if (d < 2.2 * m) ink(x, y, Math.min(1, 2.2 * m - d));
        }
    }
    const src: InkSource = { read: (x, y, w, h) => copyBlock(px, W, H, x, y, w, h) };
    const chars = Array.from({ length: 16 }, (_, n) => ({ x: (12.3 + n * 24.5) / 2.6667, y: 9.7 / 2.6667, width: 24.5 / 2.6667, height: 42.1 / 2.6667 }));
    const words: InkWord[] = [
      { chars: chars.slice(0, 8), from: 2, to: 8, angle: 0 },
      { chars: chars.slice(8), from: 0, to: 8, angle: 0 },
    ];
    return { src, device: [k, 0, 0, k, 0.25, 0.25] as TurnMatrix, words };
  };
  const run = () => {
    for (const m of [1, 2]) {
      const { src, device, words } = line(m);
      for (let n = 0; n < 4; n++) {
        const plan = planInk(src, device, words, true);
        paintInk(src, device, plan, { gain: 1, boost: 0.8 }, undefined, true);
        paintInk(src, device, plan, { gain: 1.4, boost: 0 });
      }
    }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 50);
}

/** Px [x, x + w) × [y, y + h) of an RGBA picture `W` × `H` (row by row) as a block of their own; px off it are alpha 0. */
export function copyBlock(px: Uint8ClampedArray, W: number, H: number, x: number, y: number, w: number, h: number): InkBlock {
  const data = new Uint8ClampedArray(4 * w * h);
  const x0 = Math.max(0, x);
  const x1 = Math.min(W, x + w);
  if (x1 > x0)
    for (let r = Math.max(0, y); r < Math.min(H, y + h); r++) data.set(px.subarray(4 * (r * W + x0), 4 * (r * W + x1)), 4 * ((r - y) * w + (x0 - x)));
  return { data, x, y, width: w };
}
