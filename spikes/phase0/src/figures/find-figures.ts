// Figure finding from PDFium page objects, text runs and the structure tree, with no model: research 06 §3.2 steps
// 1–4 (tagged figures, object candidates, captions, confidence), pdffigures2-style caption pairing. Pure: the engine
// worker calls it (SpikeNative.detectFigures) with getPageObjects, getPageTextRuns and getStructTree of one page.
// Every rect is in points, unrotated page space, top-left origin of the crop box.
import type { DetectedFigure, PageObjectInfo, Rect, StructElement, TextRun } from '../engine/spike-native';

export interface FigureInput {
  /** The crop box's size, unrotated. */
  page: { width: number; height: number };
  objects: PageObjectInfo[];
  /** The object list stopped at its cap: only caption-linked figures are kept (06 §3.2). */
  truncated: boolean;
  runs: TextRun[];
  struct: StructElement[];
}

/** The values of 06 §3.2, plus the ones it leaves open (marked "ours"). */
export const RULES = {
  /** An image or form XObject is a candidate at ≥ 2% of the page with both sides ≥ 36 pt. */
  minAreaShare: 0.02,
  minSide: 36,
  /** One image over ≥ 85% of the page is a scan page: no candidates (06 §3.5). */
  scanAreaShare: 0.85,
  /** Ours: a form XObject over ≥ 85% of the page, or with no graphics in it, wraps content: its objects count as the page's. */
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
  /** Ours: a caption pairs with a candidate at most 72 pt away; more candidates join a captioned figure within 24 pt. */
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
} as const;

/** 06 §3.3: at the start of a line that starts a block, case-insensitive. */
export const CAPTION_PATTERN =
  /^(figure|fig\.?|table|tab\.?|chart|plate|scheme|exhibit|abbildung|abb\.?|tabelle|figura|tableau|tabla)\s*((?:[A-Z]{1,2}\.?)?\d+(?:[.\-]\d+)*[a-z]?|[IVXLC]+)\s*(?:[:.—–\-|]|\s{2,}|$)/i;
const TABLE_WORD = /^(table|tab\.?|tabelle|tableau|tabla)$/i;
const LABEL_WORDS: Record<string, string> = { fig: 'Figure', 'fig.': 'Figure', tab: 'Table', 'tab.': 'Table', abb: 'Abbildung', 'abb.': 'Abbildung' };

interface Line {
  rect: Rect;
  size: number;
  text: string;
  /** Chars that are not whitespace. */
  chars: number;
  body: boolean;
  caption: boolean;
}
interface Caption {
  label: string;
  table: boolean;
  /** The caption's first line. */
  first: Line;
  /** Its whole block. */
  rect: Rect;
}
interface Candidate {
  rect: Rect;
  images: number;
  paths: number;
  source: 'image' | 'form' | 'cluster' | 'tagged';
  table: boolean;
  claimed: boolean;
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

/** What analysePage found on the page; findFigures returns only `figures`. */
export interface PageAnalysis {
  figures: DetectedFigure[];
  /** Diagnostics. */
  bodySize: number;
  columnWidth: number;
  lines: { text: string; rect: Rect; size: number; body: boolean; caption: boolean }[];
  captions: { label: string; rect: Rect }[];
  candidates: { rect: Rect; source: Candidate['source']; images: number; paths: number; claimed: boolean }[];
}

export function findFigures(input: FigureInput): DetectedFigure[] {
  return analysePage(input).figures;
}

export function analysePage(input: FigureInput): PageAnalysis {
  const { page } = input;
  const pageArea = page.width * page.height;
  const lines = buildLines(input.runs);
  const { bodySize, column } = classifyBody(lines);
  const captions = findCaptions(lines, column, bodySize);
  const graphics = graphicCandidates(input, pageArea, captions, gutters(lines, column));
  const out = (figures: DetectedFigure[], candidates: Candidate[] = []): PageAnalysis => ({
    figures,
    bodySize,
    columnWidth: column,
    lines: lines.map(({ text, rect, size, body, caption }) => ({ text, rect, size, body, caption })),
    captions: captions.map(({ label, rect }) => ({ label, rect })),
    candidates: candidates.map(({ rect, source, images, paths, claimed }) => ({ rect, source, images, paths, claimed })),
  });
  if (graphics === 'scan') return out([]);
  const { small } = graphics;

  // 1. Tagged: each Figure or Table element's marked-content ids give its objects, and so an exact box.
  const tagged = taggedCandidates(input);
  const all = tagged.length ? [...tagged, ...graphics.candidates.filter((c) => !tagged.some((t) => intersects(t.rect, c.rect)))] : graphics.candidates;
  for (const c of all) absorb(c, lines, small);
  const candidates = mergeOverlapping(all);

  // 3. Captions pair with a candidate in their column with no body text in between: figures above the caption and
  //    tables below it, or the other side at a 4 pt handicap (a CVPR table has its caption below). One candidate per
  //    caption, as many pairs as possible at the least total distance (a caption between two tables takes its own).
  const figures: DetectedFigure[] = [];
  const bodyLines = lines.filter((l) => l.body && !l.caption);
  const distances = captions.map((caption) => candidates.map((c) => captionDistance(caption, c, bodyLines) ?? NO_PAIR));
  const paired = new Map<Caption, Candidate[]>();
  assign(distances).forEach((k, i) => {
    if (k < 0 || distances[i]![k]! >= NO_PAIR) return;
    candidates[k]!.claimed = true;
    paired.set(captions[i]!, [candidates[k]!]);
  });
  const usedSmall = new Set<Graphic>();
  for (const [caption, parts] of paired) {
    growFigure(caption, parts, candidates, small, usedSmall, bodyLines, captions);
    const images = parts.reduce((n, p) => n + p.images, 0);
    const paths = parts.reduce((n, p) => n + p.paths, 0);
    figures.push({
      kind: caption.table || parts.some((p) => p.table) ? 'table' : kindOf(images, paths),
      rect: absorbLines(parts.map((p) => p.rect).reduce(union), lines),
      label: caption.label,
      captionRect: caption.rect,
      confidence: 'high',
    });
  }
  // A caption with no graphic candidate (a table drawn only with text): the region between it and the nearest body text.
  for (const caption of captions) {
    if (paired.has(caption)) continue;
    const region = captionRegion(caption, lines, small, candidates, page);
    if (!region || figures.some((f) => intersects(f.rect, region.rect))) continue;
    figures.push({ kind: caption.table ? 'table' : kindOf(region.images, region.paths), rect: region.rect, label: caption.label, captionRect: caption.rect, confidence: 'high' });
  }

  // 4. Uncaptioned candidates: high for a tagged one or a single image or form XObject, medium for a vector cluster.
  //    Dropped when the object list was cut short (only caption-linked figures are kept then).
  if (!input.truncated) {
    for (const c of candidates) {
      if (c.claimed || figures.some((f) => intersects(f.rect, c.rect))) continue;
      figures.push({ kind: c.table ? 'table' : kindOf(c.images, c.paths), rect: c.rect, label: null, captionRect: null, confidence: c.source === 'cluster' ? 'medium' : 'high' });
    }
  }
  figures.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return out(figures, candidates);
}

const kindOf = (images: number, paths: number): DetectedFigure['kind'] => (images && paths ? 'mixed' : images ? 'image' : paths ? 'vector' : 'unknown');

// ---- text ---------------------------------------------------------------------------------------------------------

/** Lines: runs on one baseline band, joined left to right while the gap between them is under 0.8 × the font size. */
function buildLines(runs: TextRun[]): Line[] {
  const pieces = runs
    .map((r) => ({ rect: r.rect, size: r.fontSize, text: r.text.replace(/[\u0000-\u001f￾￿]/g, ''), cy: r.rect.y + r.rect.height / 2 }))
    .filter((p) => p.text.trim() !== '' && p.rect.width > 0 && p.rect.height > 0)
    .sort((a, b) => a.cy - b.cy);
  const lines: Line[] = [];
  let row: typeof pieces = [];
  const flush = () => {
    row.sort((a, b) => a.rect.x - b.rect.x);
    let current: typeof pieces = [];
    const emit = () => {
      if (current.length === 0) return;
      let text = '';
      let rect = current[0]!.rect;
      let best = current[0]!;
      for (const [k, p] of current.entries()) {
        if (k > 0) text += p.rect.x - right(current[k - 1]!.rect) > 0.15 * p.size ? ' ' : '';
        text += p.text;
        rect = union(rect, p.rect);
        if (p.text.length > best.text.length) best = p;
      }
      lines.push({ rect, size: best.size, text: text.trim(), chars: text.replace(/\s/g, '').length, body: false, caption: false });
      current = [];
    };
    for (const p of row) {
      const last = current.at(-1);
      if (last && p.rect.x - right(last.rect) > 0.8 * Math.max(p.size, last.size)) emit();
      current.push(p);
    }
    emit();
    row = [];
  };
  for (const p of pieces) {
    const anchor = row[0];
    if (anchor && Math.abs(p.cy - anchor.cy) > 0.35 * Math.min(p.rect.height, anchor.rect.height)) flush();
    row.push(p);
  }
  flush();
  return lines.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/**
 * Body text: the font size most chars have, and the column width (the 80th-percentile width of lines of at least
 * 10 chars in that size). A body line is at least 60% of the column wide, not smaller than the body font, and has
 * such a line right above or below it (ours: a lone wide line is a subcaption, a heading or a table's header row); a
 * line in the body size on a body line's row, ending within 2 em before it, is body text too (a run-in heading).
 */
function classifyBody(lines: Line[]): { bodySize: number; column: number } {
  const bySize = new Map<number, number>();
  for (const l of lines) bySize.set(Math.round(l.size * 2) / 2, (bySize.get(Math.round(l.size * 2) / 2) ?? 0) + l.chars);
  let bodySize = 0;
  let most = -1;
  for (const [size, chars] of bySize) if (chars > most) [bodySize, most] = [size, chars];
  const widths = lines
    .filter((l) => Math.abs(l.size - bodySize) <= RULES.bodySizeTolerance && l.chars >= 10)
    .map((l) => l.rect.width)
    .sort((a, b) => a - b);
  const column = widths[Math.min(widths.length - 1, Math.floor(0.8 * widths.length))] ?? 0;
  for (const l of lines) l.body = column > 0 && l.rect.width >= RULES.bodyWidthShare * column && l.size >= bodySize - RULES.bodySizeTolerance;
  // A body line alone in its block (no body-wide line of its size within 0.6 em above or below, captions aside) is a
  // subcaption, a heading or a table's header row.
  // `lines` is sorted by top, so the lines within reach of line i are near index i.
  const neighbour = (i: number) => {
    const l = lines[i]!;
    const near = (o: Line) => {
      const g = Math.max(o.rect.y - bottom(l.rect), l.rect.y - bottom(o.rect));
      return o.body && g <= RULES.blockGapEm * l.size && g > -0.5 * l.size && xOverlap(o.rect, l.rect) > 0 && Math.abs(o.size - l.size) <= RULES.bodySizeTolerance && !CAPTION_PATTERN.test(o.text);
    };
    for (let j = i - 1; j >= 0 && lines[j]!.rect.y >= l.rect.y - 4 * l.size; j--) if (near(lines[j]!)) return true;
    for (let j = i + 1; j < lines.length && lines[j]!.rect.y <= bottom(l.rect) + RULES.blockGapEm * l.size; j++) if (near(lines[j]!)) return true;
    return false;
  };
  const isolated = lines.filter((l, i) => l.body && !neighbour(i));
  for (const l of isolated) l.body = false;
  // A run-in heading ("Residual Dropout We apply…") is a short line on a body line's row, ending within 2 em before it.
  for (const l of lines) {
    if (l.body) continue;
    l.body = lines.some(
      (o) =>
        o.body &&
        right(l.rect) <= o.rect.x + 1 &&
        o.rect.x - right(l.rect) <= 2 * o.size &&
        yOverlap(o.rect, l.rect) >= 0.5 * Math.min(o.rect.height, l.rect.height) &&
        Math.abs(o.size - l.size) <= RULES.bodySizeTolerance,
    );
  }
  return { bodySize, column };
}

/**
 * Lines matching the caption pattern that start a block. A line continues a paragraph (06 §3.3's main false positive,
 * "…as shown in⏎Figure 3. The…") when the line just above it, overlapping it and closer than 0.6 × the font size, is a
 * full line of body text in the same size: at least 90% of the column wide (ours). One caption per label (the first).
 * Each caption takes the lines of its block below it, and of its second part when it is set across two columns.
 */
function findCaptions(lines: Line[], column: number, bodySize: number): Caption[] {
  const captions: Caption[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.caption) continue;
    const m = CAPTION_PATTERN.exec(line.text);
    if (!m) continue;
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
    const word = m[1]!.toLowerCase();
    const number = /^[ivxlc]+$/i.test(m[2]!) ? m[2]!.toUpperCase() : m[2]!;
    const label = `${LABEL_WORDS[word] ?? word[0]!.toUpperCase() + word.slice(1)} ${number}`;
    if (seen.has(label)) continue;
    seen.add(label);
    let rect = line.rect;
    const starts = [line];
    // A caption in a smaller size than the body set across two columns (Nature): its second part starts on the first
    // line's row, in the same size, within 4 em to the right.
    const sibling =
      line.size < bodySize - RULES.bodySizeTolerance &&
      lines.find((l) => l !== line && !l.caption && Math.abs(l.size - line.size) <= 0.3 && yOverlap(l.rect, line.rect) >= 0.5 * line.rect.height && l.rect.x >= right(line.rect) && l.rect.x - right(line.rect) <= 4 * line.size);
    if (sibling) starts.push(sibling);
    for (const start of starts) {
      let block = start.rect;
      start.caption = true;
      for (let next = nextInBlock(lines, start, block, column); next; next = nextInBlock(lines, next, block, column)) {
        next.caption = true;
        block = union(block, next.rect);
      }
      rect = union(rect, block);
    }
    captions.push({ label, table: TABLE_WORD.test(word), first: line, rect });
  }
  return captions;
}

/**
 * The next line of a caption's block, or null: only after a full line (at least 85% of the column, or of the block when
 * it is wider: a short line ends the caption's paragraph), the line right below in the same size, under 0.6 em away,
 * starting or centred within 1.5 em of the block, alone on its row within the block, and not a caption itself. Table
 * rows under a one-line caption stay out.
 */
function nextInBlock(lines: Line[], line: Line, block: Rect, column: number): Line | null {
  if (line.rect.width < RULES.captionFullLineShare * Math.max(column, block.width)) return null;
  const centre = (r: Rect) => r.x + r.width / 2;
  let best: Line | null = null;
  for (const l of lines) {
    if (l === line || l.caption || xOverlap(l.rect, block) <= 0 || Math.abs(l.size - line.size) > RULES.bodySizeTolerance) continue;
    const g = l.rect.y - bottom(line.rect);
    if (g < -0.3 * line.size || g > RULES.blockGapEm * line.size) continue;
    const aligned = Math.abs(l.rect.x - block.x) <= 1.5 * line.size || Math.abs(centre(l.rect) - centre(block)) <= 1.5 * line.size;
    if (!aligned || CAPTION_PATTERN.test(l.text)) continue;
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
  return merged.slice(1).map((s, k) => ({ from: merged[k]!.to, to: s.from }));
}

// ---- graphics -----------------------------------------------------------------------------------------------------

/** A graphic that is not a candidate by itself: a path, shading, small image or small form XObject, or a small cluster. */
interface Graphic {
  rect: Rect;
  images: number;
  paths: number;
}

/**
 * 06 §3.2 step 2. Images and form XObjects of at least 2% of the page with both sides ≥ 36 pt are candidates. A form
 * that wraps content is looked through, its objects counting as the page's (ours): one over ≥ 85% of the page, or one
 * holding no image and fewer than 3 paths (a page frame, column rules, a text block). Every other graphic is clustered:
 * boxes within 6 pt join, and a cluster with ≥ 8 graphics, or ≥ 3% of the page and not only rules, is a candidate.
 * Page borders, running-head and footer rules, page-high rules and graphics inside a caption are dropped. The rest (`small`) may still
 * be absorbed by a candidate.
 * When the object list was cut short, only images and forms are looked at (the list is a prefix, and clustering it is
 * the cost).
 */
function graphicCandidates(input: FigureInput, pageArea: number, captions: Caption[], gaps: { from: number; to: number }[]): { candidates: Candidate[]; small: Graphic[] } | 'scan' {
  const { objects, page } = input;
  // The form each object is inside, and what each form holds.
  const parent = new Int32Array(objects.length).fill(-1);
  const stack: number[] = [];
  const holds = new Map<number, { images: number; paths: number }>();
  objects.forEach((o, i) => {
    stack.length = o.formDepth;
    if (o.formDepth > 0) parent[i] = stack[o.formDepth - 1] ?? -1;
    if (o.type === 'form') {
      stack[o.formDepth] = i;
      holds.set(i, { images: 0, paths: 0 });
    }
    for (let p = parent[i]!; p >= 0; p = parent[p]!) {
      const h = holds.get(p)!;
      if (o.type === 'image') h.images++;
      else if (o.type === 'path' || o.type === 'shading') h.paths++;
    }
  });
  const wrapper = (i: number) => {
    const h = holds.get(i)!;
    return area(objects[i]!.bounds) >= RULES.wrapperAreaShare * pageArea || (h.images === 0 && h.paths < 3);
  };
  const lookedThrough = (i: number) => {
    for (let p = parent[i]!; p >= 0; p = parent[p]!) if (!wrapper(p)) return false;
    return true;
  };
  const bigEnough = (r: Rect) => area(r) >= RULES.minAreaShare * pageArea && r.width >= RULES.minSide && r.height >= RULES.minSide;
  const band = RULES.marginBandShare * page.height;
  const inMarginBand = (r: Rect) => bottom(r) <= band || r.y >= page.height - band;
  const pageBorder = (r: Rect) => r.width >= RULES.pageBorderShare * page.width && r.height >= RULES.pageBorderShare * page.height;

  const candidates: Candidate[] = [];
  const items: (Graphic & { rule: boolean })[] = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    if (o.type === 'text' || (input.truncated && o.type !== 'image' && o.type !== 'form') || !lookedThrough(i)) continue;
    if (o.type === 'form' && wrapper(i)) continue;
    const r = o.bounds;
    if (o.type === 'image' && area(r) >= RULES.scanAreaShare * pageArea) return 'scan';
    if (r.width <= 0 && r.height <= 0) continue;
    if (pageBorder(r)) continue;
    const h = holds.get(i);
    const images = o.type === 'image' ? 1 : (h?.images ?? 0);
    const paths = o.type === 'image' ? 0 : (h?.paths ?? 1);
    if ((o.type === 'image' || o.type === 'form') && bigEnough(r)) {
      candidates.push({ rect: r, images, paths, source: o.type, table: false, claimed: false });
      continue;
    }
    const rule = Math.min(r.width, r.height) < RULES.ruleThickness;
    if (rule && inMarginBand(r)) continue; // running-head and footer lines
    if (rule && (r.height >= RULES.furnitureRuleShare * page.height || r.width >= RULES.pageBorderShare * page.width)) continue; // page furniture
    if (captions.some((k) => inside(r, grow(k.rect, 1)))) continue; // part of a caption (the bar in Nature's "Fig. 1 |")
    items.push({ rect: r, images, paths, rule });
  }
  if (input.truncated) return { candidates, small: [] };

  const small: Graphic[] = [];
  for (const cluster of clusterItems(items, page, gaps)) {
    const rect = cluster.map((k) => items[k]!.rect).reduce(union);
    const images = cluster.reduce((n, k) => n + items[k]!.images, 0);
    const paths = cluster.reduce((n, k) => n + items[k]!.paths, 0);
    const big = area(rect) >= RULES.clusterMinAreaShare * pageArea && !cluster.every((k) => items[k]!.rule);
    if ((cluster.length >= RULES.clusterMinPaths || big) && !pageBorder(rect) && !inMarginBand(rect)) {
      candidates.push({ rect, images, paths, source: 'cluster', table: false, claimed: false });
    } else small.push({ rect, images, paths });
  }
  return { candidates, small };
}

/**
 * Groups of items whose boxes lie within RULES.clusterGap of each other (union-find). Each box, grown by half the gap,
 * is entered in the cells of a grid as wide as the gap; two items are compared only when they share a cell, and only
 * when they are not already in one group, so a dense scatter plot costs about the cells it covers. Items side by side
 * across a column gutter are not joined (two tables in neighbouring columns can be under 6 pt apart).
 */
function clusterItems(items: { rect: Rect }[], page: { width: number; height: number }, gaps: { from: number; to: number }[]): number[][] {
  if (items.length === 0) return [];
  const CELL = RULES.clusterGap;
  const half = RULES.clusterGap / 2;
  const cols = Math.ceil(page.width / CELL) + 1;
  const rows = Math.ceil(page.height / CELL) + 1;
  const cells: (number[] | undefined)[] = new Array(cols * rows);
  const parent = Array.from(items, (_, k) => k);
  const find = (k: number): number => {
    while (parent[k] !== k) k = parent[k] = parent[parent[k]!]!;
    return k;
  };
  const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, v));
  items.forEach((item, k) => {
    const x0 = clamp(Math.floor((item.rect.x - half) / CELL), cols);
    const x1 = clamp(Math.floor((right(item.rect) + half) / CELL), cols);
    const y0 = clamp(Math.floor((item.rect.y - half) / CELL), rows);
    const y1 = clamp(Math.floor((bottom(item.rect) + half) / CELL), rows);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const cell = (cells[y * cols + x] ??= []);
        for (const other of cell) {
          const [a, b] = [find(k), find(other)];
          if (a !== b && gapXY(item.rect, items[other]!.rect) <= RULES.clusterGap && !acrossGutter(item.rect, items[other]!.rect, gaps)) parent[a] = b;
        }
        cell.push(k);
      }
    }
  });
  const groups = new Map<number, number[]>();
  items.forEach((_, k) => {
    const root = find(k);
    const group = groups.get(root);
    if (group) group.push(k);
    else groups.set(root, [k]);
  });
  return [...groups.values()];
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
function taggedCandidates(input: FigureInput): Candidate[] {
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
      const objects = input.objects.filter((o) => o.markedContentId >= 0 && ids.has(o.markedContentId) && area(o.bounds) > 0);
      if (objects.length) {
        out.push({
          rect: objects.map((o) => o.bounds).reduce(union),
          images: objects.filter((o) => o.type === 'image').length,
          paths: objects.filter((o) => o.type === 'path' || o.type === 'shading' || o.type === 'form').length,
          source: 'tagged',
          table: el.type === 'Table',
          claimed: false,
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
function absorb(c: Candidate, lines: Line[], small: Graphic[]): void {
  const reach = grow(c.rect, RULES.absorbMargin);
  let rect = c.rect;
  for (const l of lines) if (!l.body && !l.caption && mostlyInside(l.rect, reach)) rect = union(rect, l.rect);
  for (const s of small) {
    if (!inside(s.rect, reach)) continue;
    rect = union(rect, s.rect);
    c.images += s.images;
    c.paths += s.paths;
  }
  c.rect = rect;
}

/** Candidates whose boxes overlap are one figure (a raster plot under its vector axes, say). */
function mergeOverlapping(candidates: Candidate[]): Candidate[] {
  const out = candidates.map((c) => ({ ...c }));
  for (let changed = true; changed; ) {
    changed = false;
    for (let a = 0; a < out.length && !changed; a++) {
      for (let b = a + 1; b < out.length; b++) {
        if (!intersects(out[a]!.rect, out[b]!.rect)) continue;
        const [p, q] = [out[a]!, out[b]!];
        out[a] = {
          rect: union(p.rect, q.rect),
          images: p.images + q.images,
          paths: p.paths + q.paths,
          source: p.source === q.source ? p.source : p.source === 'tagged' || q.source === 'tagged' ? 'tagged' : 'form',
          table: p.table || q.table,
          claimed: false,
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
 * between them. The caption's usual side (a figure above it, a
 * table below it) counts as is; the other side at a 4 pt handicap.
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
  const usual = caption.table ? 'below' : 'above';
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
  const m = Math.max(n, cost[0]!.length);
  const at = (i: number, j: number) => cost[i - 1]![j - 1] ?? NO_PAIR;
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
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = at(i0, j) - u[i0]! - v[j]!;
        if (cur < minv[j]!) [minv[j], way[j]] = [cur, j0];
        if (minv[j]! < delta) [delta, j1] = [minv[j]!, j];
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else minv[j] = minv[j]! - delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0);
  }
  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]! > 0 && j <= cost[0]!.length) out[p[j]! - 1] = j - 1;
  return out;
}

/**
 * A captioned figure grows by the free candidates within 24 pt of it, and by free candidates and small graphics in its
 * band (overlapping it vertically) that overlap the caption horizontally (subfigures side by side: pdffigures2's
 * region next to the caption), on its side of the caption, while the union holds no body text or other caption.
 */
function growFigure(caption: Caption, parts: Candidate[], candidates: Candidate[], small: Graphic[], usedSmall: Set<Graphic>, bodyLines: Line[], captions: Caption[]): void {
  const slack = captionSlack(caption);
  const above = bottom(parts[0]!.rect) <= caption.rect.y + slack;
  type Piece = { candidate: Candidate; graphic?: undefined } | { candidate?: undefined; graphic: Graphic };
  const pieces: Piece[] = [...candidates.map((candidate) => ({ candidate })), ...small.map((graphic) => ({ graphic }))];
  for (let changed = true; changed; ) {
    changed = false;
    const rect = parts.map((p) => p.rect).reduce(union);
    for (const { candidate, graphic } of pieces) {
      if (candidate ? candidate.claimed : usedSmall.has(graphic!)) continue;
      const r = (candidate ?? graphic!).rect;
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
        usedSmall.add(graphic!);
        parts.push({ rect: r, images: graphic!.images, paths: graphic!.paths, source: 'cluster', table: false, claimed: true });
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

/**
 * The region between a caption with no graphic candidate and the nearest body text, below a table caption and above a
 * figure caption: the non-body lines and small graphics in the caption's column, each within 24 pt of the last (and,
 * once two row gaps are known, within twice their median), up to body text, another caption, a candidate or the
 * page's margin band. Null with fewer than two such pieces.
 */
function captionRegion(caption: Caption, lines: Line[], small: Graphic[], candidates: Candidate[], page: { width: number; height: number }): Graphic | null {
  const down = caption.table;
  const column = columnOf(caption.rect, lines);
  const band = RULES.marginBandShare * page.height;
  const pieces = [
    ...lines.map((l) => ({ rect: l.rect, images: 0, paths: 0, stop: l.body || l.caption })),
    ...small.map((g) => ({ ...g, stop: false })),
    ...candidates.map((c) => ({ rect: c.rect, images: 0, paths: 0, stop: true })),
  ].filter((p) => !inside(p.rect, caption.rect) && xOverlap(p.rect, column) > 0 && (down ? p.rect.y >= bottom(caption.rect) - 1 : bottom(p.rect) <= caption.rect.y + 1));
  pieces.sort((a, b) => (down ? a.rect.y - b.rect.y : bottom(b.rect) - bottom(a.rect)));
  let frontier = down ? bottom(caption.rect) : caption.rect.y;
  let region: Graphic | null = null;
  let count = 0;
  const gaps: number[] = []; // between the region's rows
  let last: Rect | null = null;
  for (const p of pieces) {
    const distance = down ? p.rect.y - frontier : frontier - bottom(p.rect);
    const newRow = !last || yOverlap(p.rect, last) < 0.5 * Math.min(p.rect.height, last.height);
    // Once two row gaps are known, a gap over twice their median (and over 8 pt) ends the region: the space after a
    // float before the next heading or paragraph.
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 0;
    const limit = gaps.length >= 2 ? Math.min(RULES.growGap, Math.max(8, 2 * median)) : RULES.growGap;
    if (p.stop || distance > limit) break;
    if (region && newRow) gaps.push(Math.max(0, distance)); // rows whose boxes overlap (tall maths) count as 0
    if (down ? bottom(p.rect) > page.height - band : p.rect.y < band) break;
    region = region ? { rect: union(region.rect, p.rect), images: region.images + p.images, paths: region.paths + p.paths } : { rect: p.rect, images: p.images, paths: p.paths };
    count++;
    last = p.rect;
    frontier = down ? Math.max(frontier, bottom(p.rect)) : Math.min(frontier, p.rect.y);
  }
  return count >= 2 ? region : null;
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
