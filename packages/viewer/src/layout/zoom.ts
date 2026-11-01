// Zoom levels and fitting, as Chrome's PDF viewer does them (Chromium's preset factors, 25–400%).
import type { PageSize, Rotation } from '../backend/types';

/** Chromium's zoom presets, 25–400%: Ctrl+= and Ctrl+− walk these. */
export const ZOOM_STEPS = [0.25, 0.333, 0.5, 0.666, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;
/** CSS px between pages, and around them. */
export const PAGE_GAP = 16;
/** CSS px per point: a page at scale 1 shows at its printed size on a 96 dpi screen. */
export const PT_TO_CSS = 96 / 72;

/** How the page size is chosen: fit the width, fit the whole page, or a fixed scale (1 = 100%). */
export type ZoomMode = { kind: 'fit-width' } | { kind: 'fit-page' } | { kind: 'scale'; scale: number };

/** One page per row, or two side by side ((1,2), (3,4), …). */
export type Spread = 'none' | 'two-page';

/** A step smaller than this is not a step: from 1.0999 "zoom in" goes to 1.25, not to 1.1. */
const STEP_EPSILON = 1e-3;
/** Wheel lines and pages in px, for deltaMode 1 and 2 (Chromium scrolls 40 px a line). */
const LINE_PX = 40;
const PAGE_PX = 800;
/** Wheel distance for a zoom factor of e: 100 px (one mouse notch) zooms by about 28%. */
const WHEEL_PX_PER_E = 400;

export const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** The next preset above (dir 1) or below (dir −1) `scale`; at either end it stays there. */
export function stepZoom(scale: number, dir: 1 | -1): number {
  if (dir === 1) return ZOOM_STEPS.find((z) => z > scale + STEP_EPSILON) ?? MAX_SCALE;
  return [...ZOOM_STEPS].reverse().find((z) => z < scale - STEP_EPSILON) ?? MIN_SCALE;
}

/** Ctrl+wheel and pinch (Chrome sends a pinch as wheel events with ctrlKey): clamp(scale · exp(−deltaPx / 400)). */
export function wheelZoom(scale: number, deltaY: number, deltaMode: number): number {
  const px = deltaY * (deltaMode === 1 ? LINE_PX : deltaMode === 2 ? PAGE_PX : 1);
  return clampScale(scale * Math.exp(-px / WHEEL_PX_PER_E));
}

/** The page as displayed (its /Rotate plus the view rotation), in points. */
export function displayedSize(page: PageSize, viewRotation: Rotation): { width: number; height: number; rotation: Rotation } {
  const rotation = ((page.rotation + viewRotation) % 360) as Rotation;
  return rotation % 180 === 0 ? { width: page.width, height: page.height, rotation } : { width: page.height, height: page.width, rotation };
}

/**
 * A page's full render at `scale` on a `dpr` screen: the engine scale (device px per point) and the bitmap size, with
 * the same sums PdfBackend.renderTile uses (round(displayed points × scale)), so the box can be sized to the bitmap
 * exactly and one bitmap pixel lands on one screen pixel.
 */
export function pageDeviceSize(page: PageSize, viewRotation: Rotation, scale: number, dpr: number): { scale: number; width: number; height: number } {
  const d = displayedSize(page, viewRotation);
  const engineScale = scale * PT_TO_CSS * dpr;
  return { scale: engineScale, width: Math.max(1, Math.round(d.width * engineScale)), height: Math.max(1, Math.round(d.height * engineScale)) };
}

/** The rows the pages are laid out in: one page each, or pairs for two-page spreads. */
export function rowsOf(count: number, spread: Spread): number[][] {
  const rows: number[][] = [];
  const per = spread === 'two-page' ? 2 : 1;
  for (let i = 0; i < count; i += per) rows.push(Array.from({ length: Math.min(per, count - i) }, (_, k) => i + k));
  return rows;
}

/**
 * The scale for `mode`. Fit width: the widest row fills the viewport width less PAGE_GAP on each side (and between the
 * two pages of a spread). Fit page: the whole of each row fits the viewport. Pass every page for fit width and the
 * current page (or spread) for fit page. Clamped to 25–400%.
 */
export function resolveScale(
  mode: ZoomMode,
  viewport: { width: number; height: number },
  pages: PageSize[],
  o: { viewRotation: Rotation; spread: Spread },
): number {
  if (mode.kind === 'scale') return clampScale(mode.scale);
  let best = Infinity;
  for (const row of rowsOf(pages.length, o.spread)) {
    const sizes = row.map((i) => displayedSize(pages[i], o.viewRotation));
    const rowWidth = sizes.reduce((sum, s) => sum + s.width, 0) * PT_TO_CSS;
    const rowHeight = Math.max(...sizes.map((s) => s.height)) * PT_TO_CSS;
    const byWidth = (viewport.width - 2 * PAGE_GAP - (row.length - 1) * PAGE_GAP) / rowWidth;
    const fit = mode.kind === 'fit-width' ? byWidth : Math.min(byWidth, (viewport.height - 2 * PAGE_GAP) / rowHeight);
    best = Math.min(best, fit);
  }
  return Number.isFinite(best) && best > 0 ? clampScale(best) : best === Infinity ? 1 : MIN_SCALE;
}
