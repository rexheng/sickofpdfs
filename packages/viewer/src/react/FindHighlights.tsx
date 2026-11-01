// Find's hits on one page (Task 25), for PageList's `renderPage` slot. Every hit is drawn with the rects a selection of
// the same chars would be painted with (markLineRects: PDFium's line rects, one even band a line), so a hit lines up
// with the text exactly and Alt+Enter's selection covers the same band. The current hit is drawn stronger. After the
// bar closes, the hit it was on can stay for a moment in the selection colour (`linger`).
import { type JSX, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PageSize, PdfRect, SearchHit } from '../backend/types';
import type { FindController } from '../contracts';
import type { PageBox } from '../layout/page-layout';
import { cssPerPoint } from '../layout/page-space';
import { highlightPath, markLineRects, normToCss, pdfRectToNorm, type RectSource } from '../marks/geometry';
import type { PageLayerContext } from './PageView';
import './find-highlights.css';

export interface FindHighlightsProps {
  controller: FindController;
  /** Where the line rects come from: the tab's PageTextProvider, whose glyph cache the text layer fills. */
  text: RectSource;
  box: PageBox;
  ctx: PageLayerContext;
  /** The page's size (OpenResult.pages[box.index]). */
  page: PageSize;
  /** The hit the bar was on when it closed: drawn as a selection, fading out. */
  linger?: SearchHit | null;
}

const keyOf = (h: SearchHit) => `${h.start}:${h.count}`;

/** The hits on page `index`, from hits sorted by page then start. */
function hitsOnPage(hits: readonly SearchHit[], index: number): SearchHit[] {
  let lo = 0;
  let hi = hits.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (hits[mid].pageIndex < index) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < hits.length && hits[end].pageIndex === index) end++;
  return hits.slice(lo, end);
}

/**
 * The line rects of each hit, read once per hit and kept while the page is mounted. The current hit is read first. The
 * page re-renders once a frame while rects come in.
 */
function useHitRects(text: RectSource, pageIndex: number, wanted: readonly SearchHit[]): ReadonlyMap<string, PdfRect[]> {
  // A new page (or text source) starts empty.
  const { cache, asked } = useMemo(() => ({ cache: new Map<string, PdfRect[]>(), asked: new Set<string>(), for: [text, pageIndex] }), [text, pageIndex]);
  const [, redraw] = useState(0);
  const frame = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame.current);
    };
  }, []);
  useEffect(() => {
    for (const h of wanted) {
      const key = keyOf(h);
      if (asked.has(key)) continue;
      asked.add(key);
      markLineRects(text, pageIndex, h.start, h.count).then(
        (rects) => {
          cache.set(key, rects);
          if (mounted.current && frame.current === 0) {
            frame.current = requestAnimationFrame(() => {
              frame.current = 0;
              redraw((v) => v + 1);
            });
          }
        },
        () => asked.delete(key), // tried again the next time the hits change
      );
    }
  }, [wanted, text, pageIndex, cache, asked]);
  return cache;
}

export const FindHighlights = memo(function FindHighlights({ controller, text, box, ctx, page, linger = null }: FindHighlightsProps): JSX.Element | null {
  const subscribe = useCallback((cb: () => void) => controller.subscribe(cb), [controller]);
  const state = useSyncExternalStore(subscribe, () => controller.state);
  const index = box.index;
  const hits = useMemo(() => hitsOnPage(state.hits, index), [state.hits, index]);
  const current = state.current >= 0 && state.hits[state.current]?.pageIndex === index ? state.hits[state.current] : null;
  const lingerHere = linger !== null && linger.pageIndex === index ? linger : null;
  const wanted = useMemo(() => {
    const first = [current, lingerHere].filter((h): h is SearchHit => h !== null);
    return first.length === 0 ? hits : [...first, ...hits];
  }, [hits, current, lingerHere]);
  const rects = useHitRects(text, index, wanted);

  if (hits.length === 0 && lingerHere === null) return null;
  const k = cssPerPoint(box, page);
  const d = (h: SearchHit): string => {
    const rs = rects.get(keyOf(h));
    return rs ? highlightPath(rs.map((r) => normToCss(pdfRectToNorm(r, page), page, k, box.rotation)), { pixelRatio: ctx.dpr }) : '';
  };
  return (
    <svg className="sop-find" aria-hidden="true">
      {hits.map((h) => (h === current ? null : <path key={keyOf(h)} className="sop-find-hit" d={d(h)} />))}
      {current !== null && <path key="current" className="sop-find-hit sop-find-current" d={d(current)} />}
      {lingerHere !== null && <path key="linger" className="sop-find-linger" d={d(lingerHere)} />}
    </svg>
  );
});
