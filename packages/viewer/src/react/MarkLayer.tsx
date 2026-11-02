// The marks of one page (Phase 2, S13): highlights, underlines, strikethroughs, area outlines, the dotted underline of a
// comment whose text has no style left, the bold overlay (S11's BoldLayer) and the ring round a focused mark.
//
// - One SVG per page, in CSS px of the page as displayed, mounted through PageList's renderPage slot UNDER the R44
//   selection overlay and the text layer, so a selection over a mark still shows and the text stays selectable.
// - Geometry is S7's: the 0–1 rects an anchor stores were made by markLineRects, the same rects the selection is painted
//   with (TextLayer), and are turned into CSS px by the same normToCss. So a highlight lands exactly where the
//   selection was, at any zoom and rotation.
// - One path per style and colour (S7's rule), so overlapping rects never draw darker. Highlights are opaque tokens drawn
//   with multiply (--sop-mark-blend): the page's layer slot blends with the page render (PageList.module.css), so black
//   text stays black under every colour.
// - The active comment's highlight uses the darker --sop-mark-N-active fill (Docs darkens the anchor of the open card).
//   An open comment on words with no highlight gets a neutral wash instead (--sop-thread-active): a comment never shows
//   in a mark colour (R68). A focused mark gets a 2 px ring just outside its shape.
// The layer only draws. What is on a page comes from a MarkLayerSource (the extension's annotation wiring).
import type { MarkColor, NormRect } from '@sop/core';
import { type CSSProperties, memo, useId, useLayoutEffect, useSyncExternalStore, type JSX } from 'react';
import type { PageSize, Rotation } from '../backend/types';
import type { PageBox } from '../layout/page-layout';
import { cssPerPoint } from '../layout/page-space';
import { PT_TO_CSS } from '../layout/zoom';
import { BoldLayer, type BoldLayerProps, type BoldRange } from '../marks/BoldLayer';
import { type Box, dottedUnderlinePath, highlightPath, normToCss, type PathOptions, strikePath, underlinePath } from '../marks/geometry';
import type { PageLayerContext } from './PageView';

/** 'passage': the open comment's words when no highlight is under them (a neutral wash). */
export type MarkLayerStyle = 'highlight' | 'underline' | 'strike' | 'dotted' | 'area' | 'passage';

/** One thing drawn on the page. */
export interface MarkLayerItem {
  /** The mark's (or, for a dotted underline and a passage, the thread's) id. */
  id: string;
  style: MarkLayerStyle;
  /** The colour slot (--sop-mark-1 … 5). Null for a dotted underline, a passage and an area. */
  color: MarkColor | null;
  /** On this page, 0–1 of the unrotated crop box. */
  rects: readonly NormRect[];
  /** The highlight of the comment whose card is open: drawn in the darker active fill. */
  active?: boolean;
}

/** Everything one page shows. A source hands out the same object for as long as nothing on the page changes. */
export interface MarkLayerPage {
  items: readonly MarkLayerItem[];
  /** Bold ranges on this page, PDFium char indices (`end` exclusive). */
  bold: readonly BoldRange[];
  /** The mark that has the keyboard focus, when it is on this page, and the rects its ring goes round. */
  focused: { id: string; rects: readonly NormRect[] } | null;
}

export interface MarkLayerSource {
  subscribe(this: void, onChange: () => void): () => void;
  page(this: void, pageIndex: number): MarkLayerPage;
  /** The page's marks are in the DOM after a change: 'marks' for the SVG, 'bold' once the bold glyphs are drawn too. */
  drawn?(this: void, pageIndex: number, what: 'marks' | 'bold'): void;
}

export interface MarkLayerProps {
  source: MarkLayerSource;
  box: PageBox;
  ctx: PageLayerContext;
  /** The page's unrotated size and /Rotate (OpenResult.pages[box.index]). */
  page: PageSize;
  /** What BoldLayer needs to read glyph outlines. Without it bold is not drawn. */
  bold?: Pick<BoldLayerProps, 'backend' | 'doc' | 'text'>;
}

/** Underline and strikethrough at 100% zoom, CSS px (the token --sop-mark-line-w), and the dotted underline's dots. */
const LINE_W_FALLBACK = 2;
const DOT_W_AT_100 = 1.5;

let lineWidthToken: number | null = null;

/** --sop-mark-line-w, read once from the page's tokens. */
function lineWidthAt100(): number {
  if (lineWidthToken !== null) return lineWidthToken;
  const v = typeof document === 'undefined' ? NaN : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sop-mark-line-w'));
  lineWidthToken = Number.isFinite(v) && v > 0 ? v : LINE_W_FALLBACK;
  return lineWidthToken;
}

/** One path of a page: a style and colour, with the CSS that paints it (tokens as var(--…)). */
export interface MarkPath {
  key: string;
  d: string;
  style: CSSProperties;
}

function fillOf(color: MarkColor | null, active: boolean): string {
  const slot = color ?? 1;
  return active ? `var(--sop-mark-${slot}-active)` : `var(--sop-mark-${slot})`;
}

/** The paths of a page: the open comment's passage, highlights (inactive, then active), areas, underlines, strikes, dotted underlines. */
function groupsOf(items: readonly MarkLayerItem[], toCss: (n: NormRect) => Box, o: PathOptions, line: number, dot: number): MarkPath[] {
  const buckets = new Map<string, { style: MarkLayerStyle; color: MarkColor | null; active: boolean; boxes: Box[] }>();
  for (const it of items) {
    const active = it.style === 'highlight' && it.active === true;
    const key = `${it.style}:${it.color ?? 0}:${active ? 'a' : ''}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { style: it.style, color: it.color, active, boxes: [] }));
    for (const r of it.rects) b.boxes.push(toCss(r));
  }
  const order: Record<MarkLayerStyle, number> = { passage: -1, highlight: 0, area: 2, underline: 3, strike: 4, dotted: 5 };
  return [...buckets.entries()]
    .sort(([, a], [, b]) => order[a.style] + (a.active ? 1 : 0) - (order[b.style] + (b.active ? 1 : 0)) || (a.color ?? 0) - (b.color ?? 0))
    .map(([key, b]): MarkPath => {
      switch (b.style) {
        case 'highlight':
          return { key, d: highlightPath(b.boxes, o), style: { fill: fillOf(b.color, b.active), mixBlendMode: 'var(--sop-mark-blend)' as CSSProperties['mixBlendMode'] } };
        case 'underline':
          return { key, d: underlinePath(b.boxes, { ...o, thickness: line }), style: { fill: `var(--sop-mark-${b.color ?? 1}-line)` } };
        case 'strike':
          return { key, d: strikePath(b.boxes, { ...o, thickness: line }), style: { fill: `var(--sop-mark-${b.color ?? 1}-line)` } };
        case 'passage':
          return { key, d: highlightPath(b.boxes, o), style: { fill: 'var(--sop-thread-active)', mixBlendMode: 'var(--sop-mark-blend)' as CSSProperties['mixBlendMode'] } };
        case 'dotted':
          return { key, d: dottedUnderlinePath(b.boxes, { ...o, thickness: dot }), style: { fill: 'var(--sop-thread-underline)' } };
        case 'area':
          return { key, d: highlightPath(b.boxes, o), style: { fill: 'none', stroke: 'var(--sop-area-outline)', strokeWidth: 'var(--sop-area-outline-w)' } };
      }
    });
}

/**
 * The paths a page's items make when the page is drawn at `k` CSS px a point, turned by `rotation`, on a screen of pixel
 * ratio `dpr`. The mark layer draws them as SVG; print (S17) paints the very same ones on the page's bitmap, with `k`
 * the bitmap's pixels a point and `dpr` 1, so line widths and shapes match the screen.
 */
export function markPaths(items: readonly MarkLayerItem[], o: { page: PageSize; k: number; rotation: Rotation; dpr: number }): MarkPath[] {
  const zoom = o.k / PT_TO_CSS;
  const minLine = 1 / Math.max(1, o.dpr);
  return groupsOf(
    items,
    (n) => normToCss(n, o.page, o.k, o.rotation),
    { pixelRatio: o.dpr, rotation: o.rotation },
    Math.max(minLine, lineWidthAt100() * zoom),
    Math.max(minLine, DOT_W_AT_100 * zoom),
  );
}

/** One page's marks. See the file comment. */
export const MarkLayer = memo(function MarkLayer({ source, box, ctx, page, bold }: MarkLayerProps): JSX.Element {
  const index = box.index;
  const model = useSyncExternalStore(source.subscribe, () => source.page(index));
  const maskId = `sop-mark-focus-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;

  useLayoutEffect(() => {
    source.drawn?.(index, 'marks');
  }, [source, index, model]);

  const k = cssPerPoint(box, page);
  const rotation = box.rotation;
  const toCss = (n: NormRect): Box => normToCss(n, page, k, rotation);
  const opts: PathOptions = { pixelRatio: ctx.dpr, rotation };
  const groups = markPaths(model.items, { page, k, rotation, dpr: ctx.dpr });

  // The ring: a 4 px stroke on the mark's outline, masked to what lies outside the mark, so 2 px show all round and
  // the lines between the rects of a multi-line mark do not.
  const ringD = model.focused === null ? '' : highlightPath(model.focused.rects.map(toCss), opts);

  return (
    <>
      <svg
        className="sop-marks"
        aria-hidden="true"
        data-sop-marks-page={index}
        width={box.width}
        height={box.height}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' }}
      >
        {groups.map((g) => (
          <path key={g.key} data-mark={g.key} d={g.d} style={g.style} />
        ))}
        {ringD !== '' && (
          <>
            <mask id={maskId} maskUnits="userSpaceOnUse" x={-8} y={-8} width={box.width + 16} height={box.height + 16}>
              <rect x={-8} y={-8} width={box.width + 16} height={box.height + 16} fill="white" />
              <path d={ringD} fill="black" />
            </mask>
            <path data-mark="focus" d={ringD} mask={`url(#${maskId})`} style={{ fill: 'none', stroke: 'var(--sop-mark-focus)', strokeWidth: 4, strokeLinejoin: 'round' }} />
          </>
        )}
      </svg>
      {bold && (
        <BoldLayer
          backend={bold.backend}
          doc={bold.doc}
          text={bold.text}
          pageIndex={index}
          page={page}
          viewRotation={(((rotation - page.rotation) % 360) + 360) % 360 as PageSize['rotation']}
          ranges={model.bold}
          ctx={ctx}
          onDrawn={() => source.drawn?.(index, 'bold')}
        />
      )}
    </>
  );
});
