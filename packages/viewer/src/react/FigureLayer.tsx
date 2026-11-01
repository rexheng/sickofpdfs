// The figure outlines of one page (Phase 2, S16; research 06 section 4): the faint outline of the figure under the
// pointer, the solid outline of the selected figure, the outlines of figure and area notes (a note on a figure shows an
// outline, not a highlight), and the rectangle being drawn with Alt+drag or the area tool.
//
// - One SVG per page, mounted through PageList's renderPage slot over the marks and under the selection and the text
//   layer, so text inside a figure (axis labels) stays selectable. It never takes the pointer.
// - Rects are 0–1 of the unrotated crop box (as anchors store them) and are drawn through S7's normToCss, so they follow
//   any zoom and rotation. Outlines sit a little outside their box, so they never cover the figure's own edges.
// - Pins are not drawn here: they are buttons in the page list's overlay (the extension's figures feature), because the
//   page layers are blended with multiply and lie under the text layer.
// The layer only draws. What is on a page comes from a FigureLayerSource (the extension's figures feature).
import type { NormRect } from '@sop/core';
import { memo, useLayoutEffect, useSyncExternalStore, type JSX } from 'react';
import type { PageSize } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { cssPerPoint } from '../layout/page-space';
import { type Box, normToCss } from '../marks/geometry';
import type { PageLayerContext } from './PageView';

/** A note on a figure, a part of one, or an area. */
export interface FigureLayerNote {
  /** The thread's id. */
  id: string;
  /** On this page, 0–1 of the unrotated crop box. */
  rect: NormRect;
  /** Its card is the active one: the outline is drawn heavier. */
  active: boolean;
  /** Drawn on the rect itself, as an area mark is (a rectangle someone drew), not just outside it (a figure's box). */
  onEdge?: boolean;
}

/** Everything one page shows. A source hands out the same object for as long as nothing on the page changes. */
export interface FigureLayerPage {
  /** The figure under the pointer (not the selected one). */
  hover: NormRect | null;
  /** The selected figure. */
  selected: NormRect | null;
  notes: readonly FigureLayerNote[];
  /** The rectangle being drawn (Alt+drag, the area tool). */
  drawing: NormRect | null;
}

export interface FigureLayerSource {
  subscribe(this: void, onChange: () => void): () => void;
  page(this: void, pageIndex: number): FigureLayerPage;
  /** The page's outlines are in the DOM after a change (for the `sop:figure-outline` speed mark). */
  drawn?(this: void, pageIndex: number, page: FigureLayerPage): void;
}

export interface FigureLayerProps {
  source: FigureLayerSource;
  box: PageBox;
  ctx: PageLayerContext;
  /** The page's unrotated size and /Rotate (OpenResult.pages[box.index]). */
  page: PageSize;
}

/** How far outside its box an outline is drawn, CSS px (its inner edge sits this far out). */
const OUTSET = 3;

/** Outline widths in CSS px: the tokens, read once (the fallbacks are their values). */
let widths: { hover: number; selected: number; note: number } | null = null;

function outlineWidths(): { hover: number; selected: number; note: number } {
  if (widths !== null) return widths;
  const css = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement);
  const read = (name: string, fallback: number) => {
    const v = css === null ? NaN : parseFloat(css.getPropertyValue(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  widths = { hover: read('--sop-figure-hover-outline-w', 1), selected: read('--sop-figure-selected-outline-w', 2), note: read('--sop-area-outline-w', 2) };
  return widths;
}

/** A box grown by `by` on every side and snapped to whole device pixels, so thin lines stay crisp. */
function grown(b: Box, by: number, dpr: number): Box {
  const snap = (v: number) => Math.round(v * dpr) / dpr;
  const x0 = snap(b.x - by);
  const y0 = snap(b.y - by);
  const x1 = snap(b.x + b.width + by);
  const y1 = snap(b.y + b.height + by);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** One page's figure outlines. See the file comment. */
export const FigureLayer = memo(function FigureLayer({ source, box, ctx, page }: FigureLayerProps): JSX.Element {
  const index = box.index;
  const model = useSyncExternalStore(source.subscribe, () => source.page(index));

  useLayoutEffect(() => {
    source.drawn?.(index, model);
  }, [source, index, model]);

  const k = cssPerPoint(box, page);
  const dpr = Math.max(1, ctx.dpr);
  const toCss = (n: NormRect): Box => normToCss(n, page, k, box.rotation);
  // A stroke of width w drawn on a rect grown by OUTSET + w / 2 has its inner edge OUTSET outside the box.
  const outline = (n: NormRect, w: number) => grown(toCss(n), OUTSET + w / 2, dpr);
  const { hover: hoverW, selected: selectedW, note: noteW } = outlineWidths();

  return (
    <svg
      className="sop-figures"
      aria-hidden="true"
      data-sop-figures-page={index}
      width={box.width}
      height={box.height}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
    >
      {model.notes.map((n) => {
        const w = n.active ? noteW * 2 : noteW;
        const b = n.onEdge === true ? grown(toCss(n.rect), 0, dpr) : outline(n.rect, w);
        return (
          <rect
            key={n.id}
            data-figure-note={n.id}
            data-active={n.active ? 'true' : 'false'}
            x={b.x}
            y={b.y}
            width={b.width}
            height={b.height}
            strokeWidth={w}
            style={{ fill: 'none', stroke: 'var(--sop-area-outline)' }}
          />
        );
      })}
      {model.drawing !== null &&
        (() => {
          const b = grown(toCss(model.drawing), 0, dpr);
          return (
            <rect
              data-figure-drawing=""
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              strokeWidth={noteW}
              strokeDasharray={`${noteW * 3} ${noteW * 2}`}
              style={{ fill: 'none', stroke: 'var(--sop-area-outline)' }}
            />
          );
        })()}
      {model.hover !== null &&
        (() => {
          const b = outline(model.hover, hoverW);
          return (
            <rect
              data-figure-hover=""
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              strokeWidth={hoverW}
              style={{ fill: 'none', stroke: 'var(--sop-figure-hover-outline)' }}
            />
          );
        })()}
      {model.selected !== null &&
        (() => {
          const b = outline(model.selected, selectedW);
          return (
            <rect
              data-figure-selected=""
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              strokeWidth={selectedW}
              style={{ fill: 'none', stroke: 'var(--sop-figure-selected-outline)' }}
            />
          );
        })()}
    </svg>
  );
});
