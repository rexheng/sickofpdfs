// The owner's bold marks (BOLD = glyph-outline; P0-5, rulings R29 and R90b). Each covered glyph's own outline, read
// from PDFium by PdfBackend.getGlyphShapes, is emboldened as font engines make a bold (synthetic bold: pushed outward
// along its edges by its face's own regular-to-bold gain, marks/synthetic-bold.ts) and filled in the glyph's own colour
// on exactly the page picture's pixel grid, in the page's darken underlay (react/BoldCanvas.ts). Bold word starts (R90)
// draw the same way, so there is one bold look. Nothing is re-rendered by PDFium.
//
// Where a visible char has no outline to redraw (invisible text such as a scan's OCR layer, a Type3 glyph), bold falls
// back to the "strong" style on that char's line rects: a heavier tint with a dark underline, in an <svg> over the page
// box in the page's displayed orientation (user units: points, turned by the page's /Rotate plus the view's rotation).
// S13 mounts BoldLayer in the page's mark layer; S17 (print) reads the same glyphs with drawBoldRange and paints them
// on the page's picture with paintBold.
import { useLayoutEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { DocHandle, Glyph, PageGlyphs, PageSize, PdfBackend, PdfRect, Rotation } from '../backend/types';
import { useBoldCanvas } from '../react/BoldCanvas';
import type { PageLayerContext } from '../react/PageView';
import { pageTransform, totalRotation } from '../view/page-transform';
import { type BoldGlyph, boldGlyphs, type BoldRange, prepareGlyphs } from './bold-painter';

export type { BoldRange } from './bold-painter';

/** The strong style's underline, in ems of the line's height. */
export const STRONG_UNDERLINE_EM = 0.08;


/** What BoldLayer reads of the page's text. S7's PageTextProvider has both, cached per page. */
export interface BoldTextSource {
  glyphs(pageIndex: number): Promise<PageGlyphs>;
  /** Merged line rects of chars [start, start + count) (R44). */
  rects(pageIndex: number, start: number, count: number): Promise<PdfRect[]>;
}

export interface BoldLayerProps {
  backend: Pick<PdfBackend, 'getGlyphShapes'>;
  doc: DocHandle;
  pageIndex: number;
  /** The page's unrotated size and /Rotate (OpenResult.pages[pageIndex]). */
  page: PageSize;
  /** The viewer's own rotation, added to the page's /Rotate. */
  viewRotation: Rotation;
  /** The bold ranges on this page. */
  ranges: readonly BoldRange[];
  text: BoldTextSource;
  /** The page's layer context: the bold is drawn on its pictures' pixel grid, in its underlay. */
  ctx: PageLayerContext;
  /** Runs once the bold for the current `ranges` is drawn (S13 records its perf mark here). */
  onDrawn?: () => void;
}

/** One range, read: its glyphs to embolden, and its strong-style line rects (chars with no outline). */
export interface DrawnRange {
  glyphs: BoldGlyph[];
  strong: PdfRect[];
}

const rangeKey = (r: BoldRange) => `${r.start}:${r.end}`;
const NOTHING_DRAWN: ReadonlyMap<string, DrawnRange> = new Map();

/**
 * The turn from unrotated page space (points, top-left origin) to the page as displayed, as the six numbers of an SVG
 * or canvas matrix (a b c d e f), or null for no turn. `width` and `height` are the displayed page, in points. The
 * page's one turn (view/page-transform.ts), as every other layer has it.
 */
export function displayMatrix(page: PageSize, viewRotation: Rotation): { matrix: [number, number, number, number, number, number] | null; width: number; height: number } {
  const t = pageTransform(page, totalRotation(page.rotation, viewRotation));
  return { matrix: t.matrix, width: t.width, height: t.height };
}

/** The <g> transform from unrotated page space to the page as displayed (displayMatrix, as SVG text). */
export function displayTransform(page: PageSize, viewRotation: Rotation): { transform: string; width: number; height: number } {
  const { matrix, width, height } = displayMatrix(page, viewRotation);
  return { transform: matrix === null ? '' : `matrix(${matrix.join(' ')})`, width, height };
}

/**
 * The chars of [start, end) that bold cannot redraw: visible text (not generated, not whitespace) with no glyph drawn
 * (`drawn`: the glyphs getGlyphShapes gave, by char). A char whose loose box is the previous char's is part of the same
 * glyph (the "i" of an "fi" ligature, the low half of a surrogate pair) and is drawn when that char is. Returned as runs,
 * `end` exclusive: a run goes on over spaces and line breaks (so a line of OCR text is one stretch, not one box a word)
 * and stops at a char that is drawn.
 */
export function undrawnRuns(glyphs: readonly Glyph[], start: number, end: number, drawn: readonly { charIndex: number }[]): BoldRange[] {
  const drawnChars = new Set(drawn.map((o) => o.charIndex));
  const sameBox = (a: Glyph, b: Glyph) => a.box.x === b.box.x && a.box.y === b.box.y && a.box.width === b.box.width && a.box.height === b.box.height;
  const runs: BoldRange[] = [];
  let open: BoldRange | null = null;
  let covered = false;
  let prev: Glyph | undefined = glyphs[Math.max(0, start) - 1];
  for (let i = Math.max(0, start); i < Math.min(end, glyphs.length); i++) {
    const g = glyphs[i];
    if (!g) break;
    covered = drawnChars.has(i) || (covered && prev !== undefined && sameBox(prev, g));
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

/** Reads one bold range's glyphs and strong-style rects. BoldLayer draws them on screen; print paints them with paintBold. */
export async function drawBoldRange(p: { backend: Pick<PdfBackend, 'getGlyphShapes'>; doc: DocHandle; pageIndex: number; text: BoldTextSource }, r: BoldRange): Promise<DrawnRange> {
  const count = Math.max(0, r.end - r.start);
  const [set, page] = await Promise.all([p.backend.getGlyphShapes(p.doc, p.pageIndex, r.start, count), p.text.glyphs(p.pageIndex)]);
  const strong = (await Promise.all(undrawnRuns(page.glyphs, r.start, r.end, set.glyphs).map((u) => p.text.rects(p.pageIndex, u.start, u.end - u.start)))).flat();
  const glyphs = boldGlyphs(set);
  await prepareGlyphs(glyphs);
  return { glyphs, strong };
}

/** The bold marks of one page. See the file comment. */
export function BoldLayer(props: BoldLayerProps): JSX.Element {
  const { backend, doc, pageIndex, page, viewRotation, ranges, text, ctx, onDrawn } = props;
  // What is shown, for this document and page only.
  const [state, setState] = useState<{ doc: DocHandle; pageIndex: number; drawn: ReadonlyMap<string, DrawnRange> }>(() => ({ doc, pageIndex, drawn: new Map() }));
  const drawn = state.doc === doc && state.pageIndex === pageIndex ? state.drawn : NOTHING_DRAWN;
  // Every range read on this page by "start:end", so that toggling bold back on is instant.
  const memo = useRef({ doc, pageIndex, ranges: new Map<string, DrawnRange>() });
  // A new array holding the same ranges must not refetch: `keys` changes only when the set of ranges does.
  const keyList = useMemo(() => [...new Set(ranges.map(rangeKey))].sort().join(','), [ranges]);
  const keys = useMemo(() => (keyList ? keyList.split(',') : []), [keyList]);
  const drawnCallback = useRef(onDrawn);
  const svg = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    drawnCallback.current = onDrawn;
  });

  // A layout effect, not a passive one: the request leaves before the browser paints, instead of a frame later (bold
  // has 50 ms from the key press to the screen), and ranges read before show in the same frame.
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

  // All ranges' glyphs, one canvas: where two marks cover a glyph it is drawn once.
  const glyphs = useMemo(() => keys.flatMap((k) => drawn.get(k)?.glyphs ?? []), [keys, drawn]);
  // The svg says when the canvas was drawn (data-sop-bold-drawn), so the bold shows as a change of the mark layer too.
  useBoldCanvas(ctx, page, glyphs.length > 0 ? glyphs : null, 'sop-bold-canvas', (n) => svg.current?.setAttribute('data-sop-bold-drawn', String(n)));

  const complete = keys.every((k) => drawn.has(k));
  useLayoutEffect(() => {
    if (complete) drawnCallback.current?.();
  }, [complete, drawn]);

  const view = displayTransform(page, viewRotation);
  return (
    <svg
      ref={svg}
      aria-hidden="true"
      data-sop-bold-page={pageIndex}
      viewBox={`0 0 ${view.width} ${view.height}`}
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
    >
      <g transform={view.transform || undefined}>
        {keys.map((k) => {
          const r = drawn.get(k);
          if (!r || r.strong.length === 0) return null;
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
            </g>
          );
        })}
      </g>
    </svg>
  );
}
