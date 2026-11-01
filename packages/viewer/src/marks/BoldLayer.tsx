// Bold as a glyph-outline overlay (BOLD = glyph-outline; P0-5, ruling R29). Each covered glyph's own outline, read from
// PDFium by PdfBackend.getGlyphOutlines, is drawn again over the page's render: filled in the glyph's own colour and
// stroked 0.03 em in it, so the glyph comes out slightly heavier, crisp at any zoom. Nothing is re-rendered by PDFium.
//
// Where a visible char has no outline to redraw (invisible text such as a scan's OCR layer, a Type3 glyph), bold falls
// back to the "strong" style on that char's line rects: a heavier tint with a dark underline.
//
// One <svg> per page, absolutely placed over the page box (its parent), in the page's displayed orientation. Its user
// units are points: outlines are in unrotated page space and a <g> turns them by the page's /Rotate plus the view's
// rotation. Glyphs that share a paint share one <path>. S13 mounts it in the page's mark layer; S17 (print) reads the same
// outlines with drawBoldRange and paints them on the page's bitmap.
import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { DocHandle, Glyph, GlyphOutline, PageGlyphs, PageSize, PdfBackend, PdfColor, PdfRect, Rotation } from '../backend/types';

/** The bold stroke, in ems of the glyph's effective font size, as a unitless number of points (P0-5). */
export const BOLD_STROKE_EM = 0.03;
/** The strong style's underline, in ems of the line's height. */
export const STRONG_UNDERLINE_EM = 0.08;

/** A bold range on the page: PDFium char indices, `end` exclusive. */
export interface BoldRange {
  start: number;
  end: number;
}

/** What BoldLayer reads of the page's text. S7's PageTextProvider has both, cached per page. */
export interface BoldTextSource {
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  /** Merged line rects of chars [start, start + count) (R44). */
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
}

export interface BoldLayerProps {
  backend: Pick<PdfBackend, 'getGlyphOutlines'>;
  doc: DocHandle;
  pageIndex: number;
  /** The page's unrotated size and /Rotate (OpenResult.pages[pageIndex]). */
  page: PageSize;
  /** The viewer's own rotation, added to the page's /Rotate. */
  viewRotation: Rotation;
  /** The bold ranges on this page. */
  ranges: readonly BoldRange[];
  text: BoldTextSource;
  /** Runs once the bold for the current `ranges` is in the DOM (S13 records its perf mark here). */
  onDrawn?: () => void;
}

/**
 * One range, drawn: its glyphs as one <path> per paint (fill, stroke colour and stroke width), and its strong-style line
 * rects. A passage in one colour and size is one path: a whole page in bold is a few DOM nodes, not thousands, and
 * where translucent glyphs overlap they are painted once.
 */
export interface DrawnRange {
  glyphs: { d: string; fill: string; stroke: string; width: number }[];
  strong: PdfRect[];
}

const rangeKey = (r: BoldRange) => `${r.start}:${r.end}`;
const NOTHING_DRAWN: ReadonlyMap<string, DrawnRange> = new Map();

const css = ([r, g, b, a]: PdfColor) => (a >= 255 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.round((a / 255) * 1000) / 1000})`);

/**
 * The turn from unrotated page space (points, top-left origin) to the page as displayed, as the six numbers of an SVG
 * or canvas matrix (a b c d e f), or null for no turn. `width` and `height` are the displayed page, in points.
 */
export function displayMatrix(page: PageSize, viewRotation: Rotation): { matrix: [number, number, number, number, number, number] | null; width: number; height: number } {
  const { width: w, height: h } = page;
  switch (((page.rotation + viewRotation) % 360) as Rotation) {
    case 90:
      return { matrix: [0, 1, -1, 0, h, 0], width: h, height: w };
    case 180:
      return { matrix: [-1, 0, 0, -1, w, h], width: w, height: h };
    case 270:
      return { matrix: [0, -1, 1, 0, 0, w], width: h, height: w };
    default:
      return { matrix: null, width: w, height: h };
  }
}

/** The <g> transform from unrotated page space to the page as displayed (displayMatrix, as SVG text). */
export function displayTransform(page: PageSize, viewRotation: Rotation): { transform: string; width: number; height: number } {
  const { matrix, width, height } = displayMatrix(page, viewRotation);
  return { transform: matrix === null ? '' : `matrix(${matrix.join(' ')})`, width, height };
}

/**
 * The chars of [start, end) that bold cannot redraw: visible text (not generated, not whitespace) with no outline. A
 * char whose loose box is the previous char's is part of the same glyph (the "i" of an "fi" ligature, the low half of
 * a surrogate pair) and is drawn when that char is. Returned as runs, `end` exclusive: a run goes on over spaces and
 * line breaks (so a line of OCR text is one stretch, not one box a word) and stops at a char that is drawn.
 */
export function undrawnRuns(glyphs: readonly Glyph[], start: number, end: number, outlines: readonly GlyphOutline[]): BoldRange[] {
  const drawn = new Set(outlines.map((o) => o.charIndex));
  const sameBox = (a: Glyph, b: Glyph) => a.box.x === b.box.x && a.box.y === b.box.y && a.box.width === b.box.width && a.box.height === b.box.height;
  const runs: BoldRange[] = [];
  let open: BoldRange | null = null;
  let covered = false;
  let prev: Glyph | undefined = glyphs[Math.max(0, start) - 1];
  for (let i = Math.max(0, start); i < Math.min(end, glyphs.length); i++) {
    const g = glyphs[i];
    if (!g) break;
    covered = drawn.has(i) || (covered && prev !== undefined && sameBox(prev, g));
    prev = g;
    if (covered) {
      open = null;
      continue;
    }
    if (g.generated || g.text.trim() === '' || g.box.width <= 0) continue; // a space or a line break: the run may go on
    if (open) open.end = i + 1;
    else runs.push((open = { start: i, end: i + 1 }));
  }
  return runs;
}

/** Reads one bold range's outlines and strong-style rects. BoldLayer draws them as SVG; print paints the same ones on a canvas. */
export async function drawBoldRange(p: Pick<BoldLayerProps, 'backend' | 'doc' | 'pageIndex' | 'text'>, r: BoldRange): Promise<DrawnRange> {
  const count = Math.max(0, r.end - r.start);
  const [outlines, page] = await Promise.all([p.backend.getGlyphOutlines(p.doc, p.pageIndex, r.start, count), p.text.glyphs(p.pageIndex)]);
  const byPaint = new Map<string, DrawnRange['glyphs'][number]>();
  for (const o of outlines) {
    const paint = o.fill ?? o.stroke;
    if (!paint) continue;
    const fill = o.fill ? css(o.fill) : 'none';
    // Filled text widens in its fill colour; stroked text in its stroke colour.
    const stroke = css(o.stroke ?? paint);
    const width = Math.round(BOLD_STROKE_EM * (page.glyphs[o.charIndex]?.fontSize ?? 0) * 1000) / 1000;
    const key = `${fill} ${stroke} ${width}`;
    const group = byPaint.get(key);
    if (group) group.d += o.d;
    else byPaint.set(key, { d: o.d, fill, stroke, width });
  }
  const glyphs = [...byPaint.values()];
  const strong = (await Promise.all(undrawnRuns(page.glyphs, r.start, r.end, outlines).map((u) => p.text.rects(p.pageIndex, u.start, u.end - u.start)))).flat();
  return { glyphs, strong };
}

/** The bold marks of one page. See the file comment. */
export function BoldLayer(props: BoldLayerProps): JSX.Element {
  const { backend, doc, pageIndex, page, viewRotation, ranges, text, onDrawn } = props;
  // What is on screen, for this document and page only.
  const [state, setState] = useState<{ doc: DocHandle; pageIndex: number; drawn: ReadonlyMap<string, DrawnRange> }>(() => ({ doc, pageIndex, drawn: new Map() }));
  const drawn = state.doc === doc && state.pageIndex === pageIndex ? state.drawn : NOTHING_DRAWN;
  // Every range drawn on this page by "start:end", so that toggling bold back on is instant.
  const memo = useRef({ doc, pageIndex, ranges: new Map<string, DrawnRange>() });
  // A new array holding the same ranges must not refetch: `keys` changes only when the set of ranges does.
  const keyList = useMemo(() => [...new Set(ranges.map(rangeKey))].sort().join(','), [ranges]);
  const keys = useMemo(() => (keyList ? keyList.split(',') : []), [keyList]);
  const drawnCallback = useRef(onDrawn);
  useLayoutEffect(() => {
    drawnCallback.current = onDrawn;
  });

  // A layout effect, not a passive one: the outline request leaves before the browser paints, instead of a frame later
  // (bold has 50 ms from the key press to the screen), and ranges drawn before show in the same frame.
  useLayoutEffect(() => {
    let live = true;
    if (memo.current.doc !== doc || memo.current.pageIndex !== pageIndex) memo.current = { doc, pageIndex, ranges: new Map() };
    const cache = memo.current.ranges;
    const missing = keys.filter((k) => !cache.has(k));
    const show = () =>
      setState((now) => {
        const next = new Map(keys.flatMap((k) => (cache.has(k) ? [[k, cache.get(k)!] as const] : [])));
        const same = now.doc === doc && now.pageIndex === pageIndex && now.drawn.size === next.size && [...next].every(([k, v]) => now.drawn.get(k) === v);
        return same ? now : { doc, pageIndex, drawn: next };
      });
    if (missing.length === 0) {
      show();
      return;
    }
    void Promise.all(
      missing.map(async (k) => {
        const [start, end] = k.split(':').map(Number) as [number, number];
        cache.set(k, await drawBoldRange({ backend, doc, pageIndex, text }, { start, end }));
      }),
    ).then(
      () => live && show(),
      () => live && show(), // an engine error leaves those ranges undrawn; the rest still show
    );
    return () => {
      live = false;
    };
  }, [keys, backend, doc, pageIndex, text]);

  const complete = keys.every((k) => drawn.has(k));
  useLayoutEffect(() => {
    if (complete) drawnCallback.current?.();
  }, [complete, drawn]);

  const view = displayTransform(page, viewRotation);
  return (
    <svg
      aria-hidden="true"
      data-sop-bold-page={pageIndex}
      viewBox={`0 0 ${view.width} ${view.height}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={view.transform || undefined}>
        {keys.map((k) => {
          const r = drawn.get(k);
          if (!r) return null;
          return (
            <g key={k}>
              {r.strong.map((rect, n) => (
                <g key={`s${n}`}>
                  <rect x={rect.x} y={rect.y} width={rect.width} height={rect.height} style={{ fill: 'var(--gm3-sys-color-surface-container-highest)', mixBlendMode: 'multiply' }} />
                  <rect
                    x={rect.x}
                    y={rect.y + rect.height * (1 - STRONG_UNDERLINE_EM)}
                    width={rect.width}
                    height={rect.height * STRONG_UNDERLINE_EM}
                    style={{ fill: 'var(--gm3-sys-color-on-surface)' }}
                  />
                </g>
              ))}
              {r.glyphs.map((g, n) => (
                <path key={`g${n}`} d={g.d} fill={g.fill} stroke={g.stroke} strokeWidth={g.width} strokeLinejoin="round" />
              ))}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
