// The notes margin: where a note sits beside its page, and how much room the margin takes. Pure; no DOM.
//
// Coordinates are the page list's content px (PageListApi.pageBoxes): CSS px from the top-left of the scroll area. The
// margin column scrolls with the pages (it draws into the page list's overlay), so a card placed at a content y stays
// level with its line however far you scroll.
import type { Anchor, NormRect } from '@sop/core';
import { type Box, normToCss, type PageBox, PAGE_GAP } from '@sop/viewer';
import type { Resolution } from '../annotations/boundary';

/** Docs' margin card (02 section 4.11; the card tokens). */
export const CARD_WIDTH = 282;
/** From the page's right edge to an inactive card. The active card moves 12 px left, so it sits 24 px from the page. */
export const CARD_OFFSET = 36;
/** Space after the cards at the right edge of the window. */
export const MARGIN_END = 16;
/**
 * The width the page list keeps free at its right while the margin is shown (PageListApi.setReserveRight). The page
 * area already keeps PAGE_GAP after the pages, so at fit width the cards end MARGIN_END from the window's edge.
 */
export const MARGIN_RESERVE = CARD_OFFSET - PAGE_GAP + CARD_WIDTH + MARGIN_END;

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
 * top of the first page for a document note. Null when its page has no box (a page index past the end).
 */
export function anchorTop(a: Anchor, boxes: readonly PageBox[]): number | null {
  switch (a.kind) {
    case 'text': {
      const box = boxes[a.start.page];
      if (!box) return null;
      const on = a.rects.find((r) => r.page === a.start.page) ?? a.rects[0];
      const first = on?.rects[0];
      const at = on && first ? boxes[on.page] : undefined;
      // An anchor stored with no rects (made in claude.ai) lines up with its page until the mark layer has its rects.
      return at && first ? rectInContent(first, at).y : box.top;
    }
    case 'area':
    case 'figure': {
      const box = boxes[a.page];
      return box ? rectInContent(a.rect, box).y : null;
    }
    case 'point': {
      const box = boxes[a.page];
      return box ? pointInContent(a.point, box).y - PIN_SIZE / 2 : null;
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

/** The round marker of a point note on its page. */
export const PIN_SIZE = 28;

/** Whether a 0–1 point of page `page` falls on one of a text anchor's rects there (a few px of slack at 100%). */
export function anchorHit(a: Anchor, page: number, u: number, v: number, slack = 0.002): boolean {
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
