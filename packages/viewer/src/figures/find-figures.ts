// Figure finding from PDFium page objects, text runs and the structure tree, with no model (FIGURES = objects+captions):
// research 06 §3.2 steps 1–4 (tagged figures, object candidates, captions, confidence), pdffigures2-style caption
// pairing. Ported from the Phase 0 spike (spikes/phase0/src/figures/find-figures.ts, P0-10), whose rules and values are
// kept as they were tuned. Added for production (Phase 2 S12):
// - the PageFigure output (contracts §2): each figure's object indices, its caption's char range and text;
// - "Algorithm" captions, whose content is below them, as a table's, boxed between their rules when they have them;
// - pages with /Rotate: the page is read in the orientation where its text lines run across (readingRotation);
// - a time budget (20 ms by default) with every quadratic pass checking the clock, and the run-in heading pass done
//   over a row window instead of every line pair (dense table pages have thousands of lines);
// - truncated inputs (an object list or text runs cut short by their budgets) mark the result incomplete, and cut-short
//   text runs make every figure medium confidence (body text may be missing, so pairing is unsure).
//
// Pure: FigureService (figure-service.ts) feeds it listPageObjects({ recurseForms: true }), getTextRuns with a budget and
// getStructTree of one page. Every rect in and out is in points, unrotated page space, top-left origin of the crop box.
import type { PageFigure } from '@sop/core';
import type { PageObjectInfo, PdfRect as Rect, Rotation, StructElement, TextRun } from '../backend/types';

/** Stored with page_figures rows and figure anchors; a new value makes cached results stale. */
export const DETECTOR_VERSION = 'objects+captions@1';
/** findFigures' default time budget, in ms. Typical paper pages take 0.5–6 ms (P0-10). */
export const FIND_FIGURES_BUDGET_MS = 20;

export interface FigureInput {
  /** The crop box's size, unrotated, and the page's /Rotate (OpenResult.pages[pageIndex]). */
  page: { width: number; height: number; rotation?: Rotation };
  /** listPageObjects(doc, pageIndex, { recurseForms: true }).objects: `objectIndices` index into this list. */
  objects: PageObjectInfo[];
  /** The object list stopped at its cap or budget: only caption-linked figures are kept (06 §3.2). */
  truncated: boolean;
  runs: TextRun[];
  /** The text runs stopped at their budget: every figure is then medium confidence. */
  runsTruncated?: boolean;
  struct: StructElement[];
}

export interface FindFiguresOptions {
  /** Default FIND_FIGURES_BUDGET_MS. Past it, the page gives no figures and `complete` is false. */
  budgetMs?: number;
  /** The clock (default performance.now). */
  now?: () => number;
}

/** The values of 06 §3.2, plus the ones it leaves open (marked "ours"). */
export const RULES = {
  /** An image or form XObject is a candidate at ≥ 2% of the page with both sides ≥ 36 pt. */
  minAreaShare: 0.02,
  minSide: 36,
  /** One image over ≥ 85% of the page is a scan page: no candidates (06 §3.5). */
  scanAreaShare: 0.85,
  /** Ours: a form XObject over ≥ 85% of the page (or with no image and under 3 paths) wraps content: its objects are the page's. */
  wrapperAreaShare: 0.85,
  /** Paths whose boxes lie within 6 pt of each other form a cluster, kept with ≥ 8 paths or ≥ 3% of the page. */
  clusterGap: 6,
  clusterMinPaths: 8,
  clusterMinAreaShare: 0.03,
  /** A rule is a path under 2 pt thick; a cluster of rules alone is kept only by the 8-path test (a table grid). */
  ruleThickness: 2,
  /** Ours: page borders (≥ 90% of both sides) and graphics within the top or bottom 6% (running heads, footers) are dropped. */
  pageBorderShare: 0.9,
  marginBandShare: 0.06,
  /** Ours: a rule at least 75% of the page high (or 90% wide) is page furniture (a frame or column rule), not a figure's. */
  furnitureRuleShare: 0.75,
  /** Non-body text and small graphics inside a candidate's box grown by 12 pt are absorbed (axis labels, legends). */
  absorbMargin: 12,
  /** A body-text line is at least 60% of the column wide and not smaller than the body font (0.6 pt tolerance, ours). */
  bodyWidthShare: 0.6,
  bodySizeTolerance: 0.6,
  /** Ours: a caption pairs with a candidate at most 72 pt away; more join a captioned figure within 24 pt (or in its band). */
  captionReach: 72,
  growGap: 24,
  /** Ours: lines whose gap is under 0.6 × the font size are in one block (one paragraph, one caption). */
  blockGapEm: 0.6,
  /** Ours: a full line of a paragraph is at least 90% of the column wide (the lines before a paragraph's last). */
  fullLineShare: 0.9,
  /** Ours: a caption's block goes on after a line at least 85% of the column wide (captions are often ragged-right). */
  captionFullLineShare: 0.85,
  /** Ours: a candidate may overlap its caption by this share of the caption's first line box (loose boxes overhang). */
  captionOverlapShare: 0.4,
  /** Ours: a caption pairs on its unusual side (a figure below it, a table above it) at this handicap, in points. */
  otherSideHandicap: 4,
  /**
   * Ours: a line wider than this many em per char (spaces and dropped chars counted) has its words spread apart: a table
   * row. Typeset prose, justified or not, stays near 0.5 em per char (all-caps titles and loose justified lines reach
   * about 0.65); a column gap is several em reported as one space.
   */
  sparseEmPerChar: 0.7,
  /** Ours: a sub- or superscript is set at most this share of its line's font size (it then joins the line's row). */
  scriptSizeShare: 0.85,
} as const;

/**
 * 06 §3.3: at the start of a line that starts a block, case-insensitive. Two changes (ours): `(?![.-]?\d)` after the
 * number (without it the pattern backtracks into a dotted number and takes "Figure 3.1 shows…" as "Figure 3", found on
 * a held-out thesis page), and "Algorithm" (Phase 2 plan, S12).
 */
export const CAPTION_PATTERN =
  /^(figure|fig\.?|table|tab\.?|chart|plate|scheme|exhibit|algorithm|abbildung|abb\.?|tabelle|figura|tableau|tabla)\s*((?:[A-Z]{1,2}\.?)?\d+(?:[.-]\d+)*(?![.-]?\d)[a-z]?|[IVXLC]+)\s*(?:[:.—–\-|]|\s{2,}|$)/i;
const TABLE_WORD = /^(table|tab\.?|tabelle|tableau|tabla)$/i;
/**
 * The label alone, as CAPTION_PATTERN has it, and the caption written with one space and no punctuation after it
 * ("Table 1 Evolution of WH, TE and PE"), which §3.3's ending (a mark, two spaces or the end of the line) misses. Word
 * exports of papers caption this way. Only a capital letter may follow the single space: a sentence goes on in lower
 * case ("Table 2 presents …", "Table 4 the countries …"), and the pattern is case-insensitive, so the capital is checked
 * in captionMatch. A roman number must be a real one, in capitals ("Figure Civic Duty" and "TABLE CIVIL RIGHTS" are not
 * captions).
 */
const BARE_CAPTION_PATTERN = new RegExp(`${CAPTION_PATTERN.source.slice(0, CAPTION_PATTERN.source.lastIndexOf('\\s*(?:'))}\\s(?=\\S)`, 'i');

/** The caption label at the start of a line (match[1] the word, match[2] the number): CAPTION_PATTERN, or its bare form. */
function captionMatch(text: string): RegExpExecArray | null {
  const m = CAPTION_PATTERN.exec(text);
  if (m) return m;
  const bare = BARE_CAPTION_PATTERN.exec(text);
  if (!bare) return null;
  const next = text.charAt(bare[0].length);
  const number = nth(bare, 2);
  const capital = next !== '' && next !== next.toLowerCase();
  return capital && (/\d/.test(number) || ROMAN_CAPITALS.test(number)) ? bare : null;
}
/** Roman numerals up to CXCIX, in capitals. */
const ROMAN_CAPITALS = /^(?=[IVXLC])C?(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
/** Captions whose content is below them: tables, and algorithms (a ruled algorithm box puts its caption on top). */
const CONTENT_BELOW_WORD = /^(table|tab\.?|tabelle|tableau|tabla|algorithm)$/i;
const LABEL_WORDS: Record<string, string> = { fig: 'Figure', 'fig.': 'Figure', tab: 'Table', 'tab.': 'Table', abb: 'Abbildung', 'abb.': 'Abbildung' };

interface Line {
  rect: Rect;
  size: number;
  text: string;
  /** Chars that are not whitespace. */
  chars: number;
  /**
   * Its words are spread far apart: over RULES.sparseEmPerChar em of width per char, spaces and dropped chars counted.
   * Prose stays near half an em per char; a table row's cells are separated by column gaps that PDFium reports as one
   * space each. A sparse line is never body text.
   */
  sparse: boolean;
  body: boolean;
  caption: boolean;
  /** The PDFium char range of the line's runs (start inclusive, end exclusive). */
  start: number;
  end: number;
  /** The line ends in PDFium's joined line-end hyphen (U+FFFE): its last word goes on in the next line. */
  joinsNext: boolean;
}
interface Caption {
  label: string;
  table: boolean;
  /** The content is below the caption (tables, algorithms); above it for figures. */
  below: boolean;
  /** An "Algorithm" caption. */
  algorithm: boolean;
  /** The caption's first line. */
  first: Line;
  /** Its whole block. */
  rect: Rect;
  lines: Line[];
}
interface Candidate {
  rect: Rect;
  images: number;
  paths: number;
  source: 'image' | 'form' | 'cluster' | 'tagged';
  table: boolean;
  claimed: boolean;
  /** Indices into FigureInput.objects. */
  objects: number[];
}

// ---- rects --------------------------------------------------------------------------------------------------------
const right = (r: Rect) => r.x + r.width;
const bottom = (r: Rect) => r.y + r.height;
const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y };
};
const grow = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m });
const xOverlap = (a: Rect, b: Rect) => Math.min(right(a), right(b)) - Math.max(a.x, b.x);
const yOverlap = (a: Rect, b: Rect) => Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
const intersects = (a: Rect, b: Rect) => xOverlap(a, b) > 0 && yOverlap(a, b) > 0;
const inside = (inner: Rect, outer: Rect) => inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
/** The distance between two boxes (0 when they touch or overlap). */
const gap = (a: Rect, b: Rect) => Math.hypot(Math.max(0, a.x - right(b), b.x - right(a)), Math.max(0, a.y - bottom(b), b.y - bottom(a)));
const sortedUnique = (indices: number[]) => [...new Set(indices)].sort((a, b) => a - b);

/** a[i] at an index the code has already bounded; it throws if the index is out of range. */
function nth<T>(a: ArrayLike<T>, i: number): T {
  const v = a[i];
  if (v === undefined) throw new RangeError(`find-figures: index ${i} is out of range (${a.length})`);
  return v;
}

/**
 * `r`, in the space of a `width` × `height` page, turned clockwise by `rotation`: the page as displayed. A turn is undone
 * by a turn of 360 − rotation in the turned space (whose sides are swapped for 90 and 270).
 */
function turn(r: Rect, width: number, height: number, rotation: Rotation): Rect {
  switch (rotation) {
    case 90:
      return { x: height - r.y - r.height, y: r.x, width: r.height, height: r.width };
    case 180:
      return { x: width - r.x - r.width, y: height - r.y - r.height, width: r.width, height: r.height };
    case 270:
      return { x: r.y, y: width - r.x - r.width, width: r.height, height: r.width };
    default:
      return r;
  }
}

/**
 * The turn that makes the page's text lines run across, so captions sit above and below their figures. A page with
 * /Rotate 90 or 270 is read as displayed when its text runs down the unrotated page (a LaTeX landscape page, a scan
 * stored sideways), and unrotated when its text already runs across there (a page someone turned). /Rotate 180 is read
 * as displayed. Text runs of 3 or more chars vote by their chars, a run counting as across or down when one side is
 * 1.5 times the other.
 */
function readingRotation(rotation: Rotation, runs: TextRun[]): Rotation {
  if (rotation !== 90 && rotation !== 270) return rotation;
  let across = 0;
  let down = 0;
  for (const r of runs) {
    if (r.charCount < 3) continue;
    if (r.rect.width > 1.5 * r.rect.height) across += r.charCount;
    else if (r.rect.height > 1.5 * r.rect.width) down += r.charCount;
  }
  return down > across ? rotation : 0;
}

/** Thrown by the clock when the budget is used up. */
class OutOfTime extends Error {}

/** A tick that reads the clock every 64 calls and throws OutOfTime past the deadline. */
function clock(budgetMs: number, now: () => number): () => void {
  const deadline = now() + budgetMs;
  let ticks = 0;
  return () => {
    if ((++ticks & 63) === 0 && now() > deadline) throw new OutOfTime();
  };
}

/** What analysePage found on the page; findFigures returns only `figures`. */
export interface PageAnalysis {
  figures: PageFigure[];
  /**
   * False when the budget ran out (then `figures` is empty) or an input was truncated. Only complete results are worth
   * keeping beyond this session: the others depend on how fast the machine was at the time.
   */
  complete: boolean;
  /** The budget ran out. */
  timedOut: boolean;
  elapsedMs: number;
  /** Diagnostics (rects in unrotated page space). */
  bodySize: number;
  columnWidth: number;
  lines: { text: string; rect: Rect; size: number; body: boolean; caption: boolean }[];
  captions: { label: string; rect: Rect }[];
  candidates: { rect: Rect; source: Candidate['source']; images: number; paths: number; claimed: boolean }[];
}
type Analysis = Omit<PageAnalysis, 'complete' | 'timedOut' | 'elapsedMs'>;

/** The page's figures and tables, in reading order (top, then left); imageSha256 is null (FigureService fills it in). */
export function findFigures(input: FigureInput, opts: FindFiguresOptions = {}): PageFigure[] {
  return analysePage(input, opts).figures;
}

export function analysePage(input: FigureInput, opts: FindFiguresOptions = {}): PageAnalysis {
  const now = opts.now ?? (() => performance.now());
  const started = now();
  const tick = clock(opts.budgetMs ?? FIND_FIGURES_BUDGET_MS, now);
  const rotation = readingRotation(input.page.rotation ?? 0, input.runs);
  const { width, height } = input.page;
  // Work on the page as displayed; turn every rect back on the way out.
  const shownSize = rotation % 180 === 0 ? { width, height } : { width: height, height: width };
  const toShown = (r: Rect) => turn(r, width, height, rotation);
  const fromShown = (r: Rect) => turn(r, shownSize.width, shownSize.height, ((360 - rotation) % 360) as Rotation);
  const shown: FigureInput =
    rotation === 0
      ? input
      : { ...input, page: shownSize, objects: input.objects.map((o) => ({ ...o, bounds: toShown(o.bounds) })), runs: input.runs.map((r) => ({ ...r, rect: toShown(r.rect) })) };
  let result: Analysis;
  try {
    result = analyseShown(shown, tick);
  } catch (err) {
    if (!(err instanceof OutOfTime)) throw err;
    return { figures: [], complete: false, timedOut: true, elapsedMs: now() - started, bodySize: 0, columnWidth: 0, lines: [], captions: [], candidates: [] };
  }
  const back = <T extends { rect: Rect }>(x: T): T => (rotation === 0 ? x : { ...x, rect: fromShown(x.rect) });
  return {
    bodySize: result.bodySize,
    columnWidth: result.columnWidth,
    figures: result.figures.map((f) => ({
      ...back(f),
      captionRect: f.captionRect && rotation !== 0 ? fromShown(f.captionRect) : f.captionRect,
      confidence: input.runsTruncated ? 'medium' : f.confidence,
    })),
    complete: !input.truncated && input.runsTruncated !== true,
    timedOut: false,
    elapsedMs: now() - started,
    lines: result.lines.map(back),
    captions: result.captions.map(back),
    candidates: result.candidates.map(back),
  };
}

function analyseShown(input: FigureInput, tick: () => void): Analysis {
  const { page } = input;
  const pageArea = page.width * page.height;
  const lines = buildLines(input.runs);
  const { bodySize, column } = classifyBody(lines, tick);
  const captions = findCaptions(lines, column, bodySize, tick);
  const graphics = graphicCandidates(input, pageArea, captions, gutters(lines, column), tick);
  const out = (figures: PageFigure[], candidates: Candidate[] = []): Analysis => ({
    figures,
    bodySize,
    columnWidth: column,
    lines: lines.map(({ text, rect, size, body, caption }) => ({ text, rect, size, body, caption })),
    captions: captions.map(({ label, rect }) => ({ label, rect })),
    candidates: candidates.map(({ rect, source, images, paths, claimed }) => ({ rect, source, images, paths, claimed })),
  });
  if (graphics === 'scan') return out([]);
  const { small } = graphics;
  tick();

  // 2. (graphicCandidates) Images, form XObjects and path clusters. 1. Tagged: each Figure or Table element's
  //    marked-content ids give its objects, and so an exact box; object candidates it overlaps are dropped.
  const tagged = taggedCandidates(input, tick);
  const all = tagged.length ? [...tagged, ...graphics.candidates.filter((c) => !tagged.some((t) => intersects(t.rect, c.rect)))] : graphics.candidates;
  for (const c of all) absorb(c, lines, small, tick);
  const candidates = mergeOverlapping(all, tick);

  // 3. Captions pair with a candidate in their column with no body text in between: figures above the caption and
  //    tables below it, or the other side at a 4 pt handicap (a CVPR table has its caption below). One candidate per
  //    caption, as many pairs as possible at the least total distance (a caption between two tables takes its own).
  const found: Omit<PageFigure, 'index'>[] = [];
  const bodyLines = lines.filter((l) => l.body && !l.caption);
  const distances = captions.map((caption) =>
    candidates.map((c) => {
      tick();
      return captionDistance(caption, c, bodyLines) ?? NO_PAIR;
    }),
  );
  const paired = new Map<Caption, Candidate[]>();
  assign(distances).forEach((k, i) => {
    if (k < 0 || nth(nth(distances, i), k) >= NO_PAIR) return;
    nth(candidates, k).claimed = true;
    paired.set(nth(captions, i), [nth(candidates, k)]);
  });
  const usedSmall = new Set<Graphic>();
  for (const [caption, parts] of paired) {
    growFigure(caption, parts, candidates, small, usedSmall, bodyLines, captions, tick);
    let rect = absorbLines(parts.map((p) => p.rect).reduce(union), lines);
    const objects = parts.flatMap((p) => p.objects);
    const table = caption.table || parts.some((p) => p.table);
    if (caption.table) {
      // A table goes on over its text rows past its rules (a booktabs header is the only cluster): the walk goes on
      // from the box's far side, away from the caption.
      const grown = captionRegion(caption, lines, small, candidates, page, rect.y >= caption.rect.y, rect);
      if (grown) {
        rect = grown.rect;
        objects.push(...grown.objects);
      }
    }
    const images = parts.reduce((n, p) => n + p.images, 0);
    const paths = parts.reduce((n, p) => n + p.paths, 0);
    found.push({
      kind: table ? 'table' : kindOf(images, paths),
      rect,
      label: caption.label,
      captionRect: caption.rect,
      confidence: 'high',
      objectIndices: sortedUnique(objects),
      caption: captionText(caption),
      imageSha256: null,
    });
  }
  // A caption with no graphic candidate (a table drawn only with text): the region between it and the nearest body text,
  // on the caption's usual side, else on its other side (a table captioned below, with body text under the caption).
  for (const caption of captions) {
    if (paired.has(caption)) continue;
    tick();
    const ruled = caption.algorithm ? ruledRegion(caption, small, lines, captions) : null;
    const text = ruled ? null : (captionRegion(caption, lines, small, candidates, page, caption.below) ?? captionRegion(caption, lines, small, candidates, page, !caption.below));
    const region = ruled ?? text;
    if (!region || found.some((f) => intersects(f.rect, region.rect))) continue;
    // A figure caption's text region that a graphic ended, or that holds no graphic and under three rows of text, is the
    // strip of axis labels between the caption and a figure it did not pair with: never outlined (ours).
    const strip = !!text && !caption.table && !caption.algorithm && (text.byCandidate || (text.images + text.paths === 0 && text.rows < 3));
    found.push({
      kind: caption.table ? 'table' : kindOf(region.images, region.paths),
      rect: region.rect,
      label: caption.label,
      captionRect: caption.rect,
      confidence: strip ? 'medium' : 'high',
      objectIndices: sortedUnique(region.objects),
      caption: captionText(caption),
      imageSha256: null,
    });
  }

  // 4. Uncaptioned candidates: high for a tagged one or a single image or form XObject, medium for a vector cluster.
  //    Dropped when the object list was cut short (only caption-linked figures are kept then).
  if (!input.truncated) {
    for (const c of candidates) {
      if (c.claimed || found.some((f) => intersects(f.rect, c.rect))) continue;
      found.push({
        kind: c.table ? 'table' : kindOf(c.images, c.paths),
        rect: c.rect,
        label: null,
        captionRect: null,
        confidence: c.source === 'cluster' ? 'medium' : 'high',
        objectIndices: sortedUnique(c.objects),
        caption: null,
        imageSha256: null,
      });
    }
  }
  found.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return out(
    found.map((f, index) => ({ index, ...f })),
    candidates,
  );
}

const kindOf = (images: number, paths: number): PageFigure['kind'] => (images && paths ? 'mixed' : images ? 'image' : paths ? 'vector' : 'unknown');

/** The caption's char range (from the first to the last of its lines' chars) and its text, its lines in char order. */
function captionText(caption: Caption): PageFigure['caption'] {
  const lines = [...caption.lines].sort((a, b) => a.start - b.start);
  let text = '';
  lines.forEach((l, k) => {
    text += k === 0 || nth(lines, k - 1).joinsNext ? l.text : ` ${l.text}`;
  });
  return { start: Math.min(...lines.map((l) => l.start)), end: Math.max(...lines.map((l) => l.end)), text };
}

// ---- text ---------------------------------------------------------------------------------------------------------

/**
 * Lines: runs on one baseline band, joined left to right while the gap between them is under 0.8 × the font size. A
 * run is on a row when its centre is within 0.35 × the smaller height of the centre of the row's largest run, or when it
 * is a sub- or superscript of that run (ours: set in a smaller size, its centre inside the run's box). Without the
 * second rule a raised "+" in "N₂H⁺ (1–0)" sits on a row of its own and leaves a gap that splits a caption's first line.
 */
function buildLines(runs: TextRun[]): Line[] {
  const pieces = runs
    .map((r) => {
      const visible = r.text.replace(/\p{Cc}/gu, ''); // control chars (PDFium's \r\n)
      return {
        rect: r.rect,
        size: r.fontSize,
        text: visible.replace(/[￾￿]/gu, ''), // and U+FFFE and U+FFFF
        units: visible.length, // every char drawn, dropped ones (U+FFFF) too: for the width per char
        cy: r.rect.y + r.rect.height / 2,
        start: r.charStart,
        end: r.charStart + r.charCount,
        joinsNext: r.text.endsWith('￾'),
      };
    })
    .filter((p) => p.text.trim() !== '' && p.rect.width > 0 && p.rect.height > 0)
    .sort((a, b) => a.cy - b.cy);
  type Piece = (typeof pieces)[number];
  const lines: Line[] = [];
  let row: Piece[] = [];
  let main: Piece | null = null; // the row's largest run
  const flush = () => {
    row.sort((a, b) => a.rect.x - b.rect.x);
    let current: Piece[] = [];
    const emit = () => {
      if (current.length === 0) return;
      let text = '';
      let units = 0;
      let rect = nth(current, 0).rect;
      let best = nth(current, 0);
      for (const [k, p] of current.entries()) {
        if (k > 0 && p.rect.x - right(nth(current, k - 1).rect) > 0.15 * p.size) {
          text += ' ';
          units++;
        }
        text += p.text;
        units += p.units;
        rect = union(rect, p.rect);
        if (p.text.length > best.text.length) best = p;
      }
      lines.push({
        rect,
        size: best.size,
        text: text.trim(),
        chars: text.replace(/\s/g, '').length,
        sparse: rect.width > RULES.sparseEmPerChar * best.size * Math.max(1, units),
        body: false,
        caption: false,
        start: Math.min(...current.map((p) => p.start)),
        end: Math.max(...current.map((p) => p.end)),
        joinsNext: current.at(-1)!.joinsNext,
      });
      current = [];
    };
    for (const p of row) {
      const last = current.at(-1);
      if (last && p.rect.x - right(last.rect) > 0.8 * Math.max(p.size, last.size)) emit();
      current.push(p);
    }
    emit();
    row = [];
    main = null;
  };
  const centreIn = (p: Piece, r: Rect) => p.cy >= r.y && p.cy <= bottom(r);
  const script = (small: Piece, big: Piece) => small.size <= RULES.scriptSizeShare * big.size && centreIn(small, big.rect);
  for (const p of pieces) {
    if (main) {
      const m: Piece = main;
      const same =
        Math.abs(p.cy - m.cy) <= 0.35 * Math.min(p.rect.height, m.rect.height) ||
        script(p, m) ||
        // The row so far holds only this run's raised scripts (they sort before it).
        row.every((q) => script(q, p));
      if (!same) flush();
    }
    row.push(p);
    if (!main || p.size > main.size) main = p;
  }
  flush();
  return lines.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/**
 * Body text: the font size most chars have, and the column width (the 80th-percentile width of lines of at least
 * 10 chars in that size). A body line is at least 60% of the column wide, not smaller than the body font, and has
 * such a line right above or below it (ours: a lone wide line is a subcaption, a heading or a table's header row); a
 * line in the body size on a body line's row, ending within 2 em before it, is body text too (a run-in heading).
 * `lines` is sorted by top, so the lines within reach of a line are near it in the list.
 */
function classifyBody(lines: Line[], tick: () => void): { bodySize: number; column: number } {
  // Sparse lines (table rows) are left out of the body size and the column: on a page that is mostly table, the
  // table's rows would otherwise set both.
  const bySize = new Map<number, number>();
  for (const l of lines) if (!l.sparse) bySize.set(Math.round(l.size * 2) / 2, (bySize.get(Math.round(l.size * 2) / 2) ?? 0) + l.chars);
  let bodySize = 0;
  let most = -1;
  for (const [size, chars] of bySize) if (chars > most) [bodySize, most] = [size, chars];
  const widths = lines
    .filter((l) => !l.sparse && Math.abs(l.size - bodySize) <= RULES.bodySizeTolerance && l.chars >= 10)
    .map((l) => l.rect.width)
    .sort((a, b) => a - b);
  const column = widths[Math.min(widths.length - 1, Math.floor(0.8 * widths.length))] ?? 0;
  for (const l of lines) l.body = column > 0 && !l.sparse && l.rect.width >= RULES.bodyWidthShare * column && l.size >= bodySize - RULES.bodySizeTolerance;
  // A body line alone in its block (no body-wide line of its size within 0.6 em above or below, captions aside) is a
  // subcaption, a heading or a table's header row.
  const neighbour = (i: number) => {
    const l = nth(lines, i);
    const near = (o: Line) => {
      const g = Math.max(o.rect.y - bottom(l.rect), l.rect.y - bottom(o.rect));
      return o.body && g <= RULES.blockGapEm * l.size && g > -0.5 * l.size && xOverlap(o.rect, l.rect) > 0 && Math.abs(o.size - l.size) <= RULES.bodySizeTolerance && !captionMatch(o.text);
    };
    for (let j = i - 1; j >= 0 && nth(lines, j).rect.y >= l.rect.y - 4 * l.size; j--) {
      tick();
      if (near(nth(lines, j))) return true;
    }
    for (let j = i + 1; j < lines.length && nth(lines, j).rect.y <= bottom(l.rect) + RULES.blockGapEm * l.size; j++) {
      tick();
      if (near(nth(lines, j))) return true;
    }
    return false;
  };
  const isolated = lines.filter((l, i) => l.body && !neighbour(i));
  for (const l of isolated) l.body = false;
  // A run-in heading ("Residual Dropout We apply…") is a short line on a body line's row, ending within 2 em before it.
  // A line on l's row overlaps it vertically, so its top lies within (l.top − the tallest line's height, l.bottom): a
  // window of the list, found by binary search, instead of every line. The lines are visited in order and marked as
  // they are found, as the spike's pass over every line did.
  const tallest = lines.reduce((m, l) => Math.max(m, l.rect.height), 0);
  const firstFrom = (y: number) => {
    let lo = 0;
    let hi = lines.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nth(lines, mid).rect.y < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const l of lines) {
    if (l.body || l.sparse) continue;
    for (let j = firstFrom(l.rect.y - tallest); j < lines.length && nth(lines, j).rect.y < bottom(l.rect); j++) {
      tick();
      const o = nth(lines, j);
      if (
        o.body &&
        right(l.rect) <= o.rect.x + 1 &&
        o.rect.x - right(l.rect) <= 2 * o.size &&
        yOverlap(o.rect, l.rect) >= 0.5 * Math.min(o.rect.height, l.rect.height) &&
        Math.abs(o.size - l.size) <= RULES.bodySizeTolerance
      ) {
        l.body = true;
        break;
      }
    }
  }
  return { bodySize, column };
}

/**
 * Lines matching the caption pattern that start a block. A line continues a paragraph (06 §3.3's main false positive,
 * "…as shown in⏎Figure 3. The…") when the line just above it, overlapping it and closer than 0.6 × the font size, is a
 * full line of body text in the same size: at least 90% of the column wide (ours). One caption per label (the first).
 * Each caption takes the lines of its block below it, and of its second part when it is set across two columns.
 */
function findCaptions(lines: Line[], column: number, bodySize: number, tick: () => void): Caption[] {
  const captions: Caption[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.caption) continue;
    const m = captionMatch(line.text);
    if (!m) continue;
    tick();
    const above = lines
      .filter((l) => l !== line && xOverlap(l.rect, line.rect) > 0 && bottom(l.rect) <= line.rect.y + 0.5 * line.size)
      .reduce<Line | null>((best, l) => (!best || bottom(l.rect) > bottom(best.rect) ? l : best), null);
    const continues =
      above &&
      above.body &&
      above.rect.width >= RULES.fullLineShare * column &&
      Math.abs(above.size - line.size) <= RULES.bodySizeTolerance &&
      line.rect.y - bottom(above.rect) <= RULES.blockGapEm * line.size;
    if (continues) continue;
    const word = nth(m, 1).toLowerCase();
    const number = /^[ivxlc]+$/i.test(nth(m, 2)) ? nth(m, 2).toUpperCase() : nth(m, 2);
    const label = `${LABEL_WORDS[word] ?? nth(word, 0).toUpperCase() + word.slice(1)} ${number}`;
    if (seen.has(label)) continue;
    seen.add(label);
    let rect = line.rect;
    const starts = [line];
    const members: Line[] = [];
    // A caption in a smaller size than the body set across two columns (Nature): its second part starts on the first
    // line's row, in the same size, within 4 em to the right.
    const sibling =
      line.size < bodySize - RULES.bodySizeTolerance &&
      lines.find((l) => l !== line && !l.caption && Math.abs(l.size - line.size) <= 0.3 && yOverlap(l.rect, line.rect) >= 0.5 * line.rect.height && l.rect.x >= right(line.rect) && l.rect.x - right(line.rect) <= 4 * line.size);
    if (sibling) starts.push(sibling);
    for (const start of starts) {
      let block = start.rect;
      start.caption = true;
      members.push(start);
      for (let next = nextInBlock(lines, start, block, column, tick); next; next = nextInBlock(lines, next, block, column, tick)) {
        next.caption = true;
        members.push(next);
        block = union(block, next.rect);
      }
      rect = union(rect, block);
    }
    captions.push({ label, table: TABLE_WORD.test(word), below: CONTENT_BELOW_WORD.test(word), algorithm: word === 'algorithm', first: line, rect, lines: members });
  }
  return captions;
}

/**
 * The next line of a caption's block, or null: only after a full line (at least 85% of the column, or of the block when
 * it is wider: a short line ends the caption's paragraph), the line right below in the same size, under 0.6 em away,
 * starting or centred within 1.5 em of the block, alone on its row within the block, and not a caption itself. Table
 * rows under a one-line caption stay out.
 */
function nextInBlock(lines: Line[], line: Line, block: Rect, column: number, tick: () => void): Line | null {
  if (line.rect.width < RULES.captionFullLineShare * Math.max(column, block.width)) return null;
  const centre = (r: Rect) => r.x + r.width / 2;
  let best: Line | null = null;
  for (const l of lines) {
    tick();
    if (l === line || l.caption || xOverlap(l.rect, block) <= 0 || Math.abs(l.size - line.size) > RULES.bodySizeTolerance) continue;
    const g = l.rect.y - bottom(line.rect);
    if (g < -0.3 * line.size || g > RULES.blockGapEm * line.size) continue;
    const aligned = Math.abs(l.rect.x - block.x) <= 1.5 * line.size || Math.abs(centre(l.rect) - centre(block)) <= 1.5 * line.size;
    if (!aligned || captionMatch(l.text)) continue;
    // A table's header cell shares its row with other cells; a caption's line is alone on its row within the block.
    if (lines.some((o) => o !== l && xOverlap(o.rect, block) > 0 && yOverlap(o.rect, l.rect) >= 0.5 * Math.min(o.rect.height, l.rect.height))) continue;
    if (!best || l.rect.y < best.rect.y) best = l;
  }
  return best;
}

/**
 * The gutters between text columns: the gaps between the horizontal spans of body lines no wider than 1.3 columns
 * (wider ones span columns), merged where they overlap. Graphics on either side of a gutter do not cluster across it.
 */
function gutters(lines: Line[], column: number): { from: number; to: number }[] {
  const spans = lines
    .filter((l) => l.body && !l.caption && l.rect.width <= 1.3 * column)
    .map((l) => ({ from: l.rect.x, to: right(l.rect) }))
    .sort((a, b) => a.from - b.from);
  const merged: { from: number; to: number }[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last && s.from <= last.to) last.to = Math.max(last.to, s.to);
    else merged.push({ ...s });
  }
  return merged.slice(1).map((s, k) => ({ from: nth(merged, k).to, to: s.from }));
}

// ---- graphics -----------------------------------------------------------------------------------------------------

/** A graphic that is not a candidate by itself: a path, shading, small image or small form XObject, or a small cluster. */
interface Graphic {
  rect: Rect;
  images: number;
  paths: number;
  objects: number[];
  /** A single rule (a path under 2 pt thick), or rules only. */
  rule?: boolean;
}

/**
 * 06 §3.2 step 2. Images and form XObjects of at least 2% of the page with both sides ≥ 36 pt are candidates. A form
 * that wraps content is looked through, its objects counting as the page's (ours): one over ≥ 85% of the page, or one
 * holding no image and fewer than 3 paths (a page frame, column rules, a text block). Every other graphic is clustered:
 * boxes within 6 pt join, and a cluster with ≥ 8 graphics, or ≥ 3% of the page and not only rules, is a candidate.
 * Page borders, running-head and footer rules, page-high rules and graphics inside a caption are dropped. The rest
 * (`small`) may still be absorbed by a candidate. A form's objects are the form and everything inside it.
 * When the object list was cut short, only images and forms are looked at (the list is a prefix, and clustering it is
 * the cost).
 */
function graphicCandidates(input: FigureInput, pageArea: number, captions: Caption[], gaps: { from: number; to: number }[], tick: () => void): { candidates: Candidate[]; small: Graphic[] } | 'scan' {
  const { objects, page } = input;
  // The form each object is inside, and what each form holds.
  const parent = new Int32Array(objects.length).fill(-1);
  const stack: number[] = [];
  const holds = new Map<number, { images: number; paths: number; inside: number[] }>();
  objects.forEach((o, i) => {
    stack.length = o.formDepth;
    if (o.formDepth > 0) parent[i] = stack[o.formDepth - 1] ?? -1;
    if (o.type === 'form') {
      stack[o.formDepth] = i;
      holds.set(i, { images: 0, paths: 0, inside: [] });
    }
    for (let p = nth(parent, i); p >= 0; p = nth(parent, p)) {
      const h = holds.get(p)!;
      h.inside.push(i);
      if (o.type === 'image') h.images++;
      else if (o.type === 'path' || o.type === 'shading') h.paths++;
    }
  });
  const wrapper = (i: number) => {
    const h = holds.get(i)!;
    return area(nth(objects, i).bounds) >= RULES.wrapperAreaShare * pageArea || (h.images === 0 && h.paths < 3);
  };
  const lookedThrough = (i: number) => {
    for (let p = nth(parent, i); p >= 0; p = nth(parent, p)) if (!wrapper(p)) return false;
    return true;
  };
  const bigEnough = (r: Rect) => area(r) >= RULES.minAreaShare * pageArea && r.width >= RULES.minSide && r.height >= RULES.minSide;
  const band = RULES.marginBandShare * page.height;
  const inMarginBand = (r: Rect) => bottom(r) <= band || r.y >= page.height - band;
  const pageBorder = (r: Rect) => r.width >= RULES.pageBorderShare * page.width && r.height >= RULES.pageBorderShare * page.height;

  const candidates: Candidate[] = [];
  const items: (Graphic & { rule: boolean })[] = [];
  for (let i = 0; i < objects.length; i++) {
    tick();
    const o = nth(objects, i);
    if (o.type === 'text' || (input.truncated && o.type !== 'image' && o.type !== 'form') || !lookedThrough(i)) continue;
    if (o.type === 'form' && wrapper(i)) continue;
    const r = o.bounds;
    if (o.type === 'image' && area(r) >= RULES.scanAreaShare * pageArea) return 'scan';
    if (r.width <= 0 && r.height <= 0) continue;
    if (pageBorder(r)) continue;
    const h = holds.get(i);
    const images = o.type === 'image' ? 1 : (h?.images ?? 0);
    const paths = o.type === 'image' ? 0 : (h?.paths ?? 1);
    const members = h ? [i, ...h.inside] : [i];
    if ((o.type === 'image' || o.type === 'form') && bigEnough(r)) {
      candidates.push({ rect: r, images, paths, source: o.type, table: false, claimed: false, objects: members });
      continue;
    }
    const rule = Math.min(r.width, r.height) < RULES.ruleThickness;
    if (rule && inMarginBand(r)) continue; // running-head and footer lines
    if (rule && (r.height >= RULES.furnitureRuleShare * page.height || r.width >= RULES.pageBorderShare * page.width)) continue; // page furniture
    if (captions.some((k) => inside(r, grow(k.rect, 1)))) continue; // part of a caption (the bar in Nature's "Fig. 1 |")
    items.push({ rect: r, images, paths, rule, objects: members });
  }
  if (input.truncated) return { candidates, small: [] };

  const small: Graphic[] = [];
  for (const cluster of clusterItems(items, page, gaps, tick)) {
    const rect = cluster.map((k) => nth(items, k).rect).reduce(union);
    const images = cluster.reduce((n, k) => n + nth(items, k).images, 0);
    const paths = cluster.reduce((n, k) => n + nth(items, k).paths, 0);
    const members = cluster.flatMap((k) => nth(items, k).objects);
    const big = area(rect) >= RULES.clusterMinAreaShare * pageArea && !cluster.every((k) => nth(items, k).rule);
    if ((cluster.length >= RULES.clusterMinPaths || big) && !pageBorder(rect) && !inMarginBand(rect)) {
      candidates.push({ rect, images, paths, source: 'cluster', table: false, claimed: false, objects: members });
    } else small.push({ rect, images, paths, objects: members, rule: cluster.every((k) => nth(items, k).rule) });
  }
  return { candidates, small };
}

/**
 * Groups of items whose boxes lie within RULES.clusterGap of each other (union-find). Each box, grown by half the gap,
 * is entered in the cells of a grid as wide as the gap; two items are compared only when they share a cell, and only
 * when they are not already in one group, so a dense scatter plot costs about the cells it covers. Items side by side
 * across a column gutter are not joined (two tables in neighbouring columns can be under 6 pt apart).
 * A box over more than BIG_ITEM_CELLS cells (a contour line or a filled area across a whole plot) stays out of the grid:
 * entered in it, a few hundred of them cost every pair once per shared cell (120 ms on a page of Boyd's Convex
 * Optimization). Once the grid's items are grouped, each big item is compared with the groups instead: a group whose box
 * is out of reach, or that the item has already joined, is skipped whole, and in a group within reach its items are
 * compared until one is near. The groups come out the same as comparing every pair.
 */
const BIG_ITEM_CELLS = 64;
function clusterItems(items: { rect: Rect }[], page: { width: number; height: number }, gaps: { from: number; to: number }[], tick: () => void): number[][] {
  if (items.length === 0) return [];
  const CELL = RULES.clusterGap;
  const half = RULES.clusterGap / 2;
  const cols = Math.ceil(page.width / CELL) + 1;
  const rows = Math.ceil(page.height / CELL) + 1;
  const cells = new Array<number[] | undefined>(cols * rows);
  const parent = Array.from(items, (_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) k = parent[k] = nth(parent, nth(parent, k));
    return k;
  };
  const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, v));
  const join = (k: number, other: number) => {
    tick();
    const [a, b] = [find(k), find(other)];
    const r = nth(items, k).rect;
    if (a !== b && gapXY(r, nth(items, other).rect) <= RULES.clusterGap && !acrossGutter(r, nth(items, other).rect, gaps)) parent[a] = b;
  };
  const big: number[] = [];
  items.forEach((item, k) => {
    const x0 = clamp(Math.floor((item.rect.x - half) / CELL), cols);
    const x1 = clamp(Math.floor((right(item.rect) + half) / CELL), cols);
    const y0 = clamp(Math.floor((item.rect.y - half) / CELL), rows);
    const y1 = clamp(Math.floor((bottom(item.rect) + half) / CELL), rows);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG_ITEM_CELLS) {
      big.push(k);
      return;
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cell = (cells[y * cols + x] ??= []);
        for (const other of cell) join(k, other);
        cell.push(k);
      }
    }
  });
  // The groups so far, by root, with their boxes; the big items start as groups of their own.
  const groups = new Map<number, { rect: Rect; members: number[] }>();
  items.forEach((item, k) => {
    const root = find(k);
    const group = groups.get(root);
    if (group) {
      group.members.push(k);
      group.rect = union(group.rect, item.rect);
    } else groups.set(root, { rect: item.rect, members: [k] });
  });
  for (const k of big) {
    const r = nth(items, k).rect;
    for (const root of [...groups.keys()]) {
      tick();
      const own = find(k);
      const group = groups.get(root);
      if (!group || root === own || gapXY(r, group.rect) > RULES.clusterGap) continue;
      const near = group.members.some((m) => {
        tick();
        const mr = nth(items, m).rect;
        return gapXY(r, mr) <= RULES.clusterGap && !acrossGutter(r, mr, gaps);
      });
      if (!near) continue;
      const mine = groups.get(own);
      if (!mine) continue;
      parent[root] = own;
      mine.members = mine.members.concat(group.members);
      mine.rect = union(mine.rect, group.rect);
      groups.delete(root);
    }
  }
  return [...groups.values()].map((g) => g.members);
}

/** Two boxes side by side with the white space between them inside a column gutter. */
function acrossGutter(a: Rect, b: Rect, gaps: { from: number; to: number }[]): boolean {
  const [l, r] = a.x <= b.x ? [a, b] : [b, a];
  const from = right(l);
  const to = r.x;
  return to > from && gaps.some((g) => from >= g.from - 1 && to <= g.to + 1);
}

/** The larger of the horizontal and vertical gaps between two boxes (0 when they overlap): "within 6 pt" on both axes. */
const gapXY = (a: Rect, b: Rect) => Math.max(0, a.x - right(b), b.x - right(a), a.y - bottom(b), b.y - bottom(a));

/**
 * 06 §3.2 step 1: each Figure or Table element of the structure tree (the outermost, when they nest), boxed by the
 * objects carrying its marked-content ids, its Caption children left out.
 */
function taggedCandidates(input: FigureInput, tick: () => void): Candidate[] {
  const out: Candidate[] = [];
  const visit = (el: StructElement) => {
    if (el.type === 'Figure' || el.type === 'Table') {
      const ids = new Set<number>();
      const collect = (e: StructElement) => {
        if (e.type === 'Caption') return; // the caption is not the figure's box (Chromium tags <figcaption> inside <figure>)
        for (const id of e.markedContentIds) ids.add(id);
        e.children.forEach(collect);
      };
      collect(el);
      tick();
      const members: number[] = [];
      input.objects.forEach((o, i) => {
        if (o.markedContentId >= 0 && ids.has(o.markedContentId) && area(o.bounds) > 0) members.push(i);
      });
      if (members.length) {
        const objects = members.map((i) => nth(input.objects, i));
        out.push({
          rect: objects.map((o) => o.bounds).reduce(union),
          images: objects.filter((o) => o.type === 'image').length,
          paths: objects.filter((o) => o.type === 'path' || o.type === 'shading' || o.type === 'form').length,
          source: 'tagged',
          table: el.type === 'Table',
          claimed: false,
          objects: members,
        });
        return;
      }
    }
    el.children.forEach(visit);
  };
  input.struct.forEach(visit);
  return out;
}

/**
 * Text that is not body text or a caption, and small graphics, inside the candidate's box grown by 12 pt join it. A
 * line counts as inside when at least half of it is (ours: a subcaption under a panel often pokes out a point).
 */
function absorb(c: Candidate, lines: Line[], small: Graphic[], tick: () => void): void {
  const reach = grow(c.rect, RULES.absorbMargin);
  let rect = c.rect;
  for (const l of lines) if (!l.body && !l.caption && mostlyInside(l.rect, reach)) rect = union(rect, l.rect);
  for (const s of small) {
    tick();
    if (!inside(s.rect, reach)) continue;
    rect = union(rect, s.rect);
    c.images += s.images;
    c.paths += s.paths;
    c.objects = c.objects.concat(s.objects);
  }
  c.rect = rect;
}

/** Candidates whose boxes overlap are one figure (a raster plot under its vector axes, say). */
function mergeOverlapping(candidates: Candidate[], tick: () => void): Candidate[] {
  const out = candidates.map((c) => ({ ...c }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let a = 0; a < out.length && !changed; a++) {
      for (let b = a + 1; b < out.length; b++) {
        tick();
        if (!intersects(nth(out, a).rect, nth(out, b).rect)) continue;
        const [p, q] = [nth(out, a), nth(out, b)];
        out[a] = {
          rect: union(p.rect, q.rect),
          images: p.images + q.images,
          paths: p.paths + q.paths,
          // Tagged wins; any cluster keeps the merge a cluster (medium when uncaptioned): it is no longer a single object.
          source: p.source === 'tagged' || q.source === 'tagged' ? 'tagged' : p.source === 'cluster' || q.source === 'cluster' ? 'cluster' : 'form',
          table: p.table || q.table,
          claimed: false,
          objects: p.objects.concat(q.objects),
        };
        out.splice(b, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

// ---- pairing ------------------------------------------------------------------------------------------------------

/**
 * How far candidate `c` is from the caption, or null when they cannot pair: `c` must overlap the caption horizontally,
 * lie within 72 pt above or below it (overlapping it by at most 40% of its first line's height), with no body text
 * between them. The caption's usual side (a figure above it, a table or an algorithm below it) counts as is; the other
 * side at a 4 pt handicap.
 */
function captionDistance(caption: Caption, c: Candidate, bodyLines: Line[]): number | null {
  if (xOverlap(c.rect, caption.rect) <= 0) return null;
  const above = caption.rect.y - bottom(c.rect);
  const below = c.rect.y - bottom(caption.rect);
  const overlap = -captionSlack(caption);
  const side = above >= overlap ? 'above' : below >= overlap ? 'below' : null;
  if (!side) return null;
  const d = Math.max(0, side === 'above' ? above : below);
  if (d > RULES.captionReach) return null;
  const [from, to] = side === 'above' ? [bottom(c.rect), caption.rect.y] : [bottom(caption.rect), c.rect.y];
  if (bodyLines.some((l) => xOverlap(l.rect, caption.rect) > 0 && l.rect.y >= from - 1 && bottom(l.rect) <= to + 1)) return null;
  const usual = caption.below ? 'below' : 'above';
  return side === usual ? d : d + RULES.otherSideHandicap;
}

/** Loose char boxes overhang the glyphs: an axis label's box may overlap the caption's first line by a few points. */
const captionSlack = (caption: Caption) => Math.max(2, RULES.captionOverlapShare * caption.first.rect.height);

const NO_PAIR = 1e6;

/**
 * The column for each row of `cost` (−1 for none) with the least total cost, rows and columns used once each: the
 * Hungarian algorithm (Kuhn–Munkres, O(n²m)); missing columns are padded at NO_PAIR. Pages have a few captions.
 */
function assign(cost: number[][]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = Math.max(n, nth(cost, 0).length);
  const at = (i: number, j: number) => nth(cost, i - 1)[j - 1] ?? NO_PAIR;
  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);
  const p = new Int32Array(m + 1); // p[j]: the row on column j
  const way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(m + 1).fill(Infinity);
    const used = new Uint8Array(m + 1);
    do {
      used[j0] = 1;
      const i0 = nth(p, j0);
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = at(i0, j) - nth(u, i0) - nth(v, j);
        if (cur < nth(minv, j)) [minv[j], way[j]] = [cur, j0];
        if (nth(minv, j) < delta) [delta, j1] = [nth(minv, j), j];
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[nth(p, j)] = nth(u, nth(p, j)) + delta;
          v[j] = nth(v, j) - delta;
        } else minv[j] = nth(minv, j) - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = nth(way, j0);
      p[j0] = nth(p, j1);
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (nth(p, j) > 0 && j <= nth(cost, 0).length) out[nth(p, j) - 1] = j - 1;
  return out;
}

/**
 * A captioned figure grows by the free candidates within 24 pt of it, and by free candidates and small graphics in its
 * band (overlapping it vertically) that overlap the caption horizontally (subfigures side by side: pdffigures2's
 * region next to the caption), on its side of the caption, while the union holds no body text or other caption.
 */
function growFigure(caption: Caption, parts: Candidate[], candidates: Candidate[], small: Graphic[], usedSmall: Set<Graphic>, bodyLines: Line[], captions: Caption[], tick: () => void): void {
  const slack = captionSlack(caption);
  const above = bottom(nth(parts, 0).rect) <= caption.rect.y + slack;
  type Piece = { candidate: Candidate; graphic?: undefined } | { candidate?: undefined; graphic: Graphic };
  const pieces: Piece[] = [...candidates.map((candidate) => ({ candidate })), ...small.map((graphic) => ({ graphic }))];
  for (let changed = true; changed; ) {
    changed = false;
    const rect = parts.map((p) => p.rect).reduce(union);
    for (const { candidate, graphic } of pieces) {
      tick();
      if (candidate ? candidate.claimed : usedSmall.has(graphic)) continue;
      const r = (candidate ?? graphic).rect;
      const near = !!candidate && gap(r, rect) <= RULES.growGap;
      const inBand = yOverlap(r, rect) > 0 && xOverlap(r, caption.rect) > 0;
      if (!near && !inBand) continue;
      if (above ? bottom(r) > caption.rect.y + slack : r.y < bottom(caption.rect) - slack) continue;
      const span = union(rect, r);
      if (bodyLines.some((l) => intersects(l.rect, span)) || captions.some((k) => k !== caption && intersects(k.rect, span))) continue;
      if (candidate) {
        candidate.claimed = true;
        parts.push(candidate);
      } else {
        usedSmall.add(graphic);
        parts.push({ rect: r, images: graphic.images, paths: graphic.paths, source: 'cluster', table: false, claimed: true, objects: graphic.objects });
      }
      changed = true;
    }
  }
}

/** The figure's box grown by the text that is not body text or a caption and lies mostly within 12 pt of it. */
function absorbLines(rect: Rect, lines: Line[]): Rect {
  const reach = grow(rect, RULES.absorbMargin);
  let out = rect;
  for (const l of lines) if (!l.body && !l.caption && mostlyInside(l.rect, reach)) out = union(out, l.rect);
  return out;
}

/** At least half of `r` lies inside `outer` (ours: a subcaption under a panel often pokes out a point). */
const mostlyInside = (r: Rect, outer: Rect) => Math.max(0, xOverlap(r, outer)) * Math.max(0, yOverlap(r, outer)) >= 0.5 * area(r) && area(r) > 0;

/** Half or more of the line's visible chars are letters: words, not a row of numbers. */
const wordy = (l: Line) => {
  const visible = l.text.replace(/\s/g, '');
  return (visible.match(/\p{L}/gu)?.length ?? 0) >= 0.5 * visible.length;
};

/** A caption's text region (captionRegion): the pieces it took, how many rows, and whether a graphic candidate ended it. */
interface Region extends Graphic {
  rows: number;
  /** The walk stopped at a graphic candidate within reach: the region is the strip between the caption and a graphic. */
  byCandidate: boolean;
}

/**
 * The region between a caption and the nearest body text, on the given side (`down`: below the caption): the non-body
 * lines and small graphics in the caption's column, each within 24 pt of the last, up to body text, another caption, a
 * candidate or the page's margin band. For a figure caption, once two row gaps are known, a gap over twice their median
 * (and over 8 pt) also ends it: the space after a float before the next heading or paragraph. A table's rows are often
 * set in groups with blank rows between them, so a table region goes on over such gaps (ours) and ends at body text.
 * With a `seed` (a table's paired box), the walk starts at the seed's far edge and the region holds the seed, up to the
 * last closing rule passed (a rule under the seed, at least 90% as wide): a booktabs table whose rule cluster covers
 * only its header grows over its text rows to its bottom rule (ours). Null when there is no such rule (seeded), or with
 * fewer than two pieces (unseeded).
 */
function captionRegion(caption: Caption, lines: Line[], small: Graphic[], candidates: Candidate[], page: { width: number; height: number }, down: boolean, seed: Rect | null = null): Region | null {
  const column = columnOf(seed ? union(caption.rect, seed) : caption.rect, lines);
  const band = RULES.marginBandShare * page.height;
  const none: number[] = [];
  const start = seed ? (down ? bottom(seed) : seed.y) : down ? bottom(caption.rect) : caption.rect.y;
  const within = seed ? grow(seed, 1) : null;
  // With a seed, the region ends at the table's closing rule: a rule at least 90% as wide as the seed, under it.
  const closing = (g: Graphic) => !!seed && g.rule === true && g.rect.height < RULES.ruleThickness && xOverlap(g.rect, seed) >= 0.9 * seed.width;
  // A table's walk ends at prose, not at a body-wide line of numbers: that is one of its rows (ours).
  const ends = (l: Line) => l.caption || (l.body && (!caption.table || wordy(l)));
  const pieces = [
    ...lines.map((l) => ({ rect: l.rect, images: 0, paths: 0, objects: none, stop: ends(l), candidate: false, closing: false, line: l })),
    // A graphic that overlaps a candidate (the frame drawn around a figure) is the figure's, not this region's.
    ...small.map((g) => ({ ...g, stop: candidates.some((c) => intersects(c.rect, g.rect)), candidate: false, closing: closing(g), line: null })),
    ...candidates.map((c) => ({ rect: c.rect, images: 0, paths: 0, objects: none, stop: true, candidate: true, closing: false, line: null })),
  ].filter((p) => !inside(p.rect, caption.rect) && !(within && inside(p.rect, within)) && xOverlap(p.rect, column) > 0 && (down ? p.rect.y >= start - 1 : bottom(p.rect) <= start + 1));
  pieces.sort((a, b) => (down ? a.rect.y - b.rect.y : bottom(b.rect) - bottom(a.rect)));
  let frontier = start;
  let region: Region | null = seed ? { rect: seed, images: 0, paths: 0, objects: [], rows: 1, byCandidate: false } : null;
  let count = seed ? 2 : 0;
  let closed: Region | null = null; // the region up to the last closing rule passed (seeded walks)
  const gaps: number[] = []; // between the region's rows
  let last: Rect | null = null;
  let firstLine = true;
  for (const p of pieces) {
    const distance = down ? p.rect.y - frontier : frontier - bottom(p.rect);
    // A seed goes on only into a table row: its first line past the seed is sparse, numbers, or one cell of several
    // on its row. A table note or a heading under a whole table is not (ours).
    if (seed && p.line && firstLine) {
      firstLine = false;
      const l = p.line;
      if (!(l.sparse || !wordy(l) || lines.some((o) => o !== l && xOverlap(o.rect, column) > 0 && yOverlap(o.rect, l.rect) >= 0.5 * Math.min(o.rect.height, l.rect.height)))) return null;
    }
    const newRow = !last || yOverlap(p.rect, last) < 0.5 * Math.min(p.rect.height, last.height);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
    const limit = gaps.length >= 2 && !caption.table ? Math.min(RULES.growGap, Math.max(8, 2 * median)) : RULES.growGap;
    if (distance > limit) break;
    if (p.stop) {
      if (region && p.candidate) region.byCandidate = true;
      break;
    }
    if (region && newRow) gaps.push(Math.max(0, distance)); // rows whose boxes overlap (tall maths) count as 0
    if (down ? bottom(p.rect) > page.height - band : p.rect.y < band) break;
    region = region
      ? { ...region, rect: union(region.rect, p.rect), images: region.images + p.images, paths: region.paths + p.paths, objects: region.objects.concat(p.objects), rows: region.rows + (newRow ? 1 : 0) }
      : { rect: p.rect, images: p.images, paths: p.paths, objects: p.objects, rows: 1, byCandidate: false };
    count++;
    last = p.rect;
    frontier = down ? Math.max(frontier, bottom(p.rect)) : Math.min(frontier, p.rect.y);
    if (p.closing) closed = region;
  }
  if (seed) return closed;
  return count >= 2 ? region : null;
}

/**
 * A ruled algorithm float (algorithm2e's and the algorithm package's "ruled" styles): a rule above the caption, one
 * right under it, and one closing the algorithm. The algorithm is everything between the rule under the caption (or the
 * caption, when there is none) and the closing rule, as wide as the rules: its lines are often as wide as body text, so
 * captionRegion would stop at the first of them. A rule is a thin graphic at least half the column wide that overlaps
 * the caption horizontally; the rule under the caption lies within one line of it. Null when there is no closing rule,
 * or another caption in the column comes before it.
 */
function ruledRegion(caption: Caption, small: Graphic[], lines: Line[], captions: Caption[]): Graphic | null {
  const column = columnOf(caption.rect, lines);
  const below = bottom(caption.rect);
  const rules = small
    .filter((g) => g.rule === true && g.rect.height < RULES.ruleThickness && g.rect.width >= 0.5 * column.width && xOverlap(g.rect, caption.rect) > 0 && g.rect.y >= below - 1)
    .sort((a, b) => a.rect.y - b.rect.y);
  const under = rules[0] && rules[0].rect.y - below <= caption.first.size ? rules[0] : null;
  const closing = under ? rules[1] : rules[0];
  if (!closing) return null;
  const top = under ? bottom(under.rect) : below;
  const x0 = Math.min(closing.rect.x, under?.rect.x ?? closing.rect.x);
  const x1 = Math.max(right(closing.rect), under ? right(under.rect) : right(closing.rect));
  const rect: Rect = { x: x0, y: top, width: x1 - x0, height: bottom(closing.rect) - top };
  if (captions.some((k) => k !== caption && xOverlap(k.rect, rect) > 0 && k.rect.y >= top && k.rect.y < closing.rect.y)) return null;
  const inner = small.filter((g) => g !== under && inside(g.rect, grow(rect, 1)));
  return {
    rect,
    images: inner.reduce((n, g) => n + g.images, 0),
    paths: inner.reduce((n, g) => n + g.paths, 0),
    objects: inner.flatMap((g) => g.objects),
  };
}

/** The text column holding `r`: the horizontal span of the body lines that overlap it, and of `r`. */
function columnOf(r: Rect, lines: Line[]): Rect {
  let [x0, x1] = [r.x, right(r)];
  for (const l of lines) {
    if (!l.body || l.caption || xOverlap(l.rect, r) <= 0) continue;
    x0 = Math.min(x0, l.rect.x);
    x1 = Math.max(x1, right(l.rect));
  }
  return { x: x0, y: r.y, width: x1 - x0, height: r.height };
}
