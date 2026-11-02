// The notes margin: where a note sits beside its page, and how much room the margin takes. Pure; no DOM.
//
// Coordinates are the page list's content px (PageListApi.pageBoxes): CSS px from the top-left of the scroll area. The
// margin column scrolls with the pages (it draws into the page list's overlay), so a card placed at a content y stays
// level with its line however far you scroll.
import type { Anchor, NormRect } from '@sop/core';
import { type Box, normToCss, type PageBox, PAGE_GAP, type Rotation } from '@sop/viewer';
import type { Resolution } from '../annotations/boundary';
import { regionNoteHit } from '../figures/anchors';

/** Docs' margin card (02 section 4.11; the card tokens). */
export const CARD_WIDTH = 282;
/** From the page's right edge to an inactive card. The active card moves 12 px left, so it sits 20 px from the page. */
export const CARD_OFFSET = 32;
/** Space after the cards, before the scroll bar (which adds its own width beside them). */
export const MARGIN_END = 8;
/**
 * The width the page list keeps free at the right of the pages for the margin (PageListApi.setReserveRight), beyond the
 * PAGE_GAP it always keeps there: the cards then end MARGIN_END from the scroll bar. It never changes the zoom (ruling
 * R69): when the pages do not fit beside it at their size, the cards fold into numbered markers (R98).
 */
export const MARGIN_RESERVE = CARD_OFFSET - PAGE_GAP + CARD_WIDTH + MARGIN_END;
/**
 * R98: the first note moves the pages no further than this to make room for the margin. When the room needs more, the
 * pages stay where they are and the notes show as numbered markers on the pages instead (the notes panel opens on a
 * click). The thumbnail rail is never closed for the margin.
 */
export const MARGIN_MAX_SHIFT = 120;

/** The notes panel (S15): 320 px wide, 16 px in from the window's right edge. */
const PANEL_WIDTH = 320;
const PANEL_INSET = 16;
/**
 * The width the page list keeps free at the right while the notes panel is open: the panel and its inset, so a page
 * that fits beside it ends PAGE_GAP before it. When the page does not fit, it stays where it is and the panel lies over
 * its right side; the page can then be scrolled sideways out from under it.
 */
export const PANEL_RESERVE = PANEL_WIDTH + PANEL_INSET;

/** A 0–1 rect of a page (unrotated, as stored) → the box it covers on screen, in content px. */
export function rectInContent(n: NormRect, box: PageBox): Box {
  const sideways = box.rotation % 180 !== 0;
  // normToCss in CSS px: the unrotated page measured in CSS px, at scale 1.
  const unrotated = { width: sideways ? box.height : box.width, height: sideways ? box.width : box.height };
  const b = normToCss(n, unrotated, 1, box.rotation);
  return { x: box.left + b.x, y: box.top + b.y, width: b.width, height: b.height };
}

/** A 0–1 point of a page → content px. */
export function pointInContent(p: readonly [number, number], box: PageBox): { x: number; y: number } {
  const b = rectInContent([p[0], p[1], p[0], p[1]], box);
  return { x: b.x, y: b.y };
}

/** The anchor as it sits in this copy of the PDF: the placed one when there is a placement, else the stored one. */
export function shownAnchor(stored: Anchor, r: Resolution | undefined): Anchor | null {
  if (r === undefined) return stored;
  return r.placed ? r.anchor : null;
}

/**
 * Where a note's card lines up: the top of its first line, area or point; the top of its page for a page note; the
 * top of the first page for a document note. Null when its page has no box (a page index past the end). While the view
 * is turned (`viewRotation`, R81) a passage's lines no longer run down the page, so its card lines up with the
 * passage's top on screen: the highest of its lines on that page.
 */
export function anchorTop(a: Anchor, boxes: readonly PageBox[], viewRotation: Rotation = 0): number | null {
  switch (a.kind) {
    case 'text': {
      const box = boxes[a.start.page];
      if (!box) return null;
      const on = a.rects.find((r) => r.page === a.start.page) ?? a.rects[0];
      const first = on?.rects[0];
      const at = on && first ? boxes[on.page] : undefined;
      // An anchor stored with no rects (made in claude.ai) lines up with its page until the mark layer has its rects.
      if (!at || !first) return box.top;
      if (viewRotation === 0) return rectInContent(first, at).y;
      return Math.min(...on.rects.map((r) => rectInContent(r, at).y));
    }
    case 'area':
    case 'figure': {
      const box = boxes[a.page];
      return box ? rectInContent(a.rect, box).y : null;
    }
    case 'point': {
      const box = boxes[a.page];
      return box ? pinAt(a.point, box).y : null;
    }
    case 'page':
      return boxes[a.page]?.top ?? null;
    case 'document':
      return boxes[0]?.top ?? null;
  }
}

/** The left edge of the margin column: the right edge of the widest page, then CARD_OFFSET. */
export function columnLeft(boxes: readonly PageBox[]): number {
  let right = 0;
  for (const b of boxes) right = Math.max(right, b.left + b.width);
  return right + CARD_OFFSET;
}

/** The round marker of a point note: small, so it never hides a word (TB2 critics). */
export const PIN_SIZE = 20;

/**
 * Where a point note's pin is drawn (its top-left, content px): level with the point, on the page's right edge, half on
 * the page's blank margin and half beside it, the way Docs marks a comment beside its line. So it never sits on the
 * words the note is about, and it points at the card beside it.
 */
export function pinAt(point: readonly [number, number], box: PageBox): { x: number; y: number } {
  const p = pointInContent(point, box);
  return { x: box.left + box.width - PIN_SIZE / 2, y: p.y - PIN_SIZE / 2 };
}

/** Whether a 0–1 point of page `page` falls on one of a text anchor's rects there (a few px of slack at 100%). */
export function anchorHit(a: Anchor, page: number, u: number, v: number, slack = 0.002): boolean {
  if (a.kind === 'area' || a.kind === 'figure') return regionNoteHit(a, page, u, v, slack); // S16: a click opens its card
  if (a.kind !== 'text') return false;
  for (const g of a.rects) {
    if (g.page !== page) continue;
    for (const r of g.rects) if (u >= r[0] - slack && u <= r[2] + slack && v >= r[1] - slack && v <= r[3] + slack) return true;
  }
  return false;
}

/** What the card says the note is on, when it is not a passage. */
export function anchorLabel(a: Anchor): string | null {
  switch (a.kind) {
    case 'page':
    case 'point':
      return `Page ${a.page + 1}`;
    case 'document':
      return 'Whole document';
    default:
      return null;
  }
}

/** A numbered note marker (R98): Docs' collapsed comment, a small bubble in the page's right margin. */
export const MARKER_SIZE = 24;
/** Markers on one page never touch: the next one starts this far below the last. */
const MARKER_GAP = 4;
/** How far a marker stays from the page's right edge, or from the view's right edge when the page runs past it. */
const MARKER_INSET = 8;

export interface MarkerPlace {
  id: string;
  /** Its number: the note's place in reading order, as the notes panel counts them ("Note 3 of 7"). */
  n: number;
  /** Its top-left, content px. */
  x: number;
  y: number;
}

/**
 * Where each note's numbered marker goes while the cards are folded (R98): in the page's right margin, level with the
 * note's line (centred on its top), just inside the page's right edge; when the page runs past the right of the view,
 * just inside the view's edge, so a marker is always in sight beside its line. Markers that would touch on one page
 * move down, in order, so each one can be read and clicked. `viewRight` is the right edge of the view in content px.
 */
export function placeMarkers(notes: readonly { id: string; n: number; page: number; top: number }[], boxes: readonly PageBox[], viewRight: number): MarkerPlace[] {
  const out: MarkerPlace[] = [];
  const sorted = [...notes].sort((a, b) => a.page - b.page || a.top - b.top || a.n - b.n);
  let lastPage = -1;
  let lastBottom = -Infinity;
  let lastX = NaN;
  for (const m of sorted) {
    const box = boxes[m.page];
    if (!box) continue;
    const right = Math.min(box.left + box.width, viewRight);
    const x = Math.max(box.left, right - MARKER_INSET - MARKER_SIZE);
    let y = Math.max(box.top, m.top - MARKER_SIZE / 2);
    if (m.page === lastPage && x === lastX) y = Math.max(y, lastBottom + MARKER_GAP);
    out.push({ id: m.id, n: m.n, x, y });
    lastPage = m.page;
    lastBottom = y + MARKER_SIZE;
    lastX = x;
  }
  return out;
}
