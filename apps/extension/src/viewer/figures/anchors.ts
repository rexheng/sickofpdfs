// Figures, areas and pins as places on a page, and as the anchors their notes keep (Phase 2, S16).
//
// - Every rect here is 0–1 of the page's unrotated crop box, origin top-left (NormRect), as anchors store it. The
//   detector's figures are in points; `figureRect` turns one into a NormRect.
// - A note on a whole figure is a `figure` anchor with the figure's fingerprint (contracts section 2, research 06
//   section 5): its caption label and quote, the SHA-256 of its largest image, the dHash of how it looks, and the
//   detector that found it. A pin is the same anchor with `sub.point`, and a part of a figure with `sub.rect`, both 0–1
//   of the figure's box, so they stay on the figure if it is found a little elsewhere.
// - An area outside any figure is an `area` anchor: its page, its rect and its dHash.
import { type Anchor, buildTextAnchor, type NormRect, type PageFigure, type Resolution, type ThreadId, type ThreadRow } from '@sop/core';
import { DETECTOR_VERSION, isOutlined, type PageSize, pdfRectToNorm } from '@sop/viewer';

export type FigureAnchor = Extract<Anchor, { kind: 'figure' }>;
export type AreaAnchor = Extract<Anchor, { kind: 'area' }>;

/** A figure the detector found, where it is. */
export interface FoundFigure {
  page: number;
  figure: PageFigure;
  /** The figure's box, 0–1 of the page. */
  rect: NormRect;
}

/** The figure's box, 0–1 of the page. */
export function figureRect(f: PageFigure, size: Pick<PageSize, 'width' | 'height'>): NormRect {
  return pdfRectToNorm(f.rect, size);
}

/** The same figure: on the same page, with the same detector index and box. */
export function sameFigure(a: FoundFigure | null, b: FoundFigure | null): boolean {
  if (a === null || b === null) return a === b;
  return a.page === b.page && a.figure.index === b.figure.index && sameRect(a.rect, b.rect, 0.999);
}

/** A rect with its corners in order (x0 ≤ x1, y0 ≤ y1), clipped to the page. */
export function ordered(r: NormRect): NormRect {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(Math.min(r[0], r[2])), c(Math.min(r[1], r[3])), c(Math.max(r[0], r[2])), c(Math.max(r[1], r[3]))];
}

export function contains(r: NormRect, u: number, v: number, pad = 0): boolean {
  return u >= r[0] - pad && u <= r[2] + pad && v >= r[1] - pad && v <= r[3] + pad;
}

function areaOf(r: NormRect): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

function overlap(a: NormRect, b: NormRect): number {
  return areaOf([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
}

/** Two rects are one place when they overlap by at least `min` of their union (IoU). */
export function sameRect(a: NormRect, b: NormRect, min = 0.9): boolean {
  const i = overlap(a, b);
  const u = areaOf(a) + areaOf(b) - i;
  return u > 0 ? i / u >= min : a.every((v, k) => Math.abs(v - (b[k] ?? NaN)) < 1e-9);
}

/** `inner` as 0–1 of `outer`'s box (both 0–1 of the page). */
export function relativeRect(outer: NormRect, inner: NormRect): NormRect {
  const w = outer[2] - outer[0] || 1;
  const h = outer[3] - outer[1] || 1;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c((inner[0] - outer[0]) / w), c((inner[1] - outer[1]) / h), c((inner[2] - outer[0]) / w), c((inner[3] - outer[1]) / h)];
}

/** A page point (0–1) as 0–1 of `outer`'s box. */
export function relativePoint(outer: NormRect, u: number, v: number): [number, number] {
  const w = outer[2] - outer[0] || 1;
  const h = outer[3] - outer[1] || 1;
  const c = (x: number) => Math.min(1, Math.max(0, x));
  return [c((u - outer[0]) / w), c((v - outer[1]) / h)];
}

/** A rect given as 0–1 of `outer`'s box, back on the page. */
export function absoluteRect(outer: NormRect, sub: NormRect): NormRect {
  const w = outer[2] - outer[0];
  const h = outer[3] - outer[1];
  return [outer[0] + sub[0] * w, outer[1] + sub[1] * h, outer[0] + sub[2] * w, outer[1] + sub[3] * h];
}

/** A point given as 0–1 of `outer`'s box, back on the page. */
export function absolutePoint(outer: NormRect, p: readonly [number, number]): [number, number] {
  return [outer[0] + p[0] * (outer[2] - outer[0]), outer[1] + p[1] * (outer[3] - outer[1])];
}

/**
 * The figure under a 0–1 point of the page: the smallest whose box holds it. Only the figures that get an outline
 * (OUTLINE_RULE), unless `all` (Alt is held: medium-confidence figures show then too, research 06 section 3.2).
 */
export function figureAt(figs: readonly PageFigure[] | undefined, page: number, size: PageSize | undefined, u: number, v: number, all = false): FoundFigure | null {
  if (!figs || !size) return null;
  let best: FoundFigure | null = null;
  let bestArea = Infinity;
  for (const figure of figs) {
    if (!all && !isOutlined(figure)) continue;
    const rect = figureRect(figure, size);
    const a = areaOf(rect);
    if (contains(rect, u, v) && a < bestArea) [best, bestArea] = [{ page, figure, rect }, a];
  }
  return best;
}

/** The figure an area lies in: one that holds at least 90% of it (the smallest, if several do). */
export function figureAround(figs: readonly PageFigure[] | undefined, page: number, size: PageSize | undefined, rect: NormRect): FoundFigure | null {
  if (!figs || !size) return null;
  const a = areaOf(rect);
  let best: FoundFigure | null = null;
  let bestArea = Infinity;
  for (const figure of figs) {
    const r = figureRect(figure, size);
    const ar = areaOf(r);
    if (a > 0 && overlap(r, rect) / a >= 0.9 && ar < bestArea) [best, bestArea] = [{ page, figure, rect: r }, ar];
  }
  return best;
}

/** A caption quote longer than this is cut: the first lines name the figure well enough, and long quotes match slowly. */
export const CAPTION_QUOTE_MAX = 200;

export interface FigureAnchorDeps {
  /** The region's dHash (FigureService.dHash). */
  dHash(pageIndex: number, rect: NormRect): Promise<string>;
  /** The page's chars as PDFium has them (PageTextProvider.rawText): caption positions are char indices into it. */
  rawText(pageIndex: number): Promise<string>;
}

/** The anchor of a note on figure `f`: its box and fingerprint, plus a pin or a part of it when given (0–1 of its box). */
export async function figureAnchor(f: FoundFigure, d: FigureAnchorDeps, sub?: { rect?: NormRect; point?: [number, number] }): Promise<FigureAnchor> {
  const { page, figure, rect } = f;
  const caption = figure.caption;
  const [dHash, raw] = await Promise.all([d.dHash(page, rect).catch(() => ''), caption ? d.rawText(page).catch(() => null) : Promise.resolve(null)]);
  let captionQuote: FigureAnchor['figure']['captionQuote'] = null;
  if (caption && raw !== null && caption.end > caption.start) {
    const quoted = buildTextAnchor({
      text: () => raw,
      start: { page, index: caption.start },
      end: { page, index: Math.min(caption.end, caption.start + CAPTION_QUOTE_MAX) },
      rects: [],
    });
    if (quoted.quote.quote.trim() !== '') captionQuote = { ...quoted.quote, position: { ...quoted.start } };
  }
  const anchor: FigureAnchor = {
    kind: 'figure',
    page,
    rect: [...rect],
    figure: {
      label: figure.label,
      captionQuote,
      imageSha256: figure.imageSha256,
      dHash,
      // A figure found from its caption alone has no objects of its own.
      detector: figure.objectIndices.length === 0 ? 'caption' : 'objects',
      detectorVersion: DETECTOR_VERSION,
      objectIndices: [...figure.objectIndices],
    },
  };
  if (sub?.point) anchor.sub = { point: sub.point };
  else if (sub?.rect) anchor.sub = { rect: sub.rect };
  return anchor;
}

/** The anchor as it sits in this copy of the PDF: the placed one when there is a placement, else the stored one. */
export function placedAnchor(t: Pick<ThreadRow, 'anchor'>, r: Resolution | undefined): Anchor | null {
  if (r === undefined) return t.anchor;
  return r.placed ? r.anchor : null;
}

/** Where a figure or area note is on its page: its whole box, a part of a figure, or a pin. Null for other notes. */
export function notePlace(a: Anchor | null): { page: number; rect: NormRect; pin: [number, number] | null; figure: NormRect | null } | null {
  if (a === null) return null;
  if (a.kind === 'area') return { page: a.page, rect: a.rect, pin: null, figure: null };
  if (a.kind !== 'figure') return null;
  if (a.sub?.point) return { page: a.page, rect: a.rect, pin: absolutePoint(a.rect, a.sub.point), figure: a.rect };
  if (a.sub?.rect) return { page: a.page, rect: absoluteRect(a.rect, a.sub.rect), pin: null, figure: a.rect };
  return { page: a.page, rect: a.rect, pin: null, figure: a.rect };
}

/**
 * The most recent note already on this place (a whole figure, a part of one, or an area), so a second Ctrl+Alt+M on it
 * opens that note instead of stacking another. Pins never match: each pin is its own note.
 */
export function noteOnPlace(
  threads: readonly ThreadRow[],
  placement: ReadonlyMap<string, Resolution>,
  page: number,
  rect: NormRect,
): ThreadId | null {
  let best: ThreadRow | null = null;
  for (const t of threads) {
    const p = notePlace(placedAnchor(t, placement.get(t.id)));
    if (p === null || p.pin !== null || p.page !== page || !sameRect(p.rect, rect)) continue;
    if (best === null || t.createdAt >= best.createdAt) best = t;
  }
  return best?.id ?? null;
}

/** Numbers each figure's pins 1, 2, 3 … in the order they were made. Keyed by thread id. */
export function pinNumbers(threads: readonly ThreadRow[], placement: ReadonlyMap<string, Resolution>): Map<string, number> {
  const byFigure = new Map<string, ThreadRow[]>();
  for (const t of threads) {
    const a = placedAnchor(t, placement.get(t.id));
    if (a?.kind !== 'figure' || !a.sub?.point) continue;
    const key = `${a.page}|${a.rect.map((v) => v.toFixed(3)).join(',')}`;
    let list = byFigure.get(key);
    if (!list) byFigure.set(key, (list = []));
    list.push(t);
  }
  const out = new Map<string, number>();
  for (const list of byFigure.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    list.forEach((t, i) => out.set(t.id, i + 1));
  }
  return out;
}

/** What a figure note's card and the Figures tab call a figure: its caption label, or "Figure" (or "Table"). */
export function figureName(label: string | null, kind?: PageFigure['kind']): string {
  return label ?? (kind === 'table' ? 'Table' : 'Figure');
}

/**
 * Whether a 0–1 point of page `page` is on a figure or area note: inside its box (a part of a figure: inside the part).
 * A pin is never hit here: its own button takes the click.
 */
export function regionNoteHit(a: AreaAnchor | FigureAnchor, page: number, u: number, v: number, slack = 0): boolean {
  const place = notePlace(a);
  return place !== null && place.pin === null && place.page === page && contains(place.rect, u, v, slack);
}
