// Card layout: where each note card goes down the margin, like Google Docs. Pure; the caller measures the cards.
//
// Each card sits level with the top of its mark. Cards are kept in the order of their marks and never overlap: when two
// would collide, the lower one moves down. The active card stays level with its mark instead: the cards above it move
// up to make room and the ones below it move down, so that clicking a card never pushes it away from its text.

/** The gap between two cards, in CSS px (the card tokens' 10 px). */
export const CARD_GAP = 10;

export interface CardBox {
  id: string;
  /** Where the top of the card's mark is, in the margin's own coordinates (CSS px from its top). */
  anchorTop: number;
  /** The card's measured height, in CSS px. */
  height: number;
}

export interface CardPlacement {
  id: string;
  /** Where the card's top edge goes, in CSS px from the top of the margin. */
  top: number;
}

export interface LayoutOptions {
  /** The card that is open. It stays level with its mark if the others can make room for it. */
  activeId?: string | null;
  /** Space between two cards. Default CARD_GAP. */
  gap?: number;
  /** The highest a card may go. Default 0. */
  minTop?: number;
}

const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/**
 * Places the cards. The result has one entry per card, in the order the cards were given.
 *
 * - Order: by `anchorTop`, and by the order given when two are level.
 * - With no active card, each card goes at its mark's top or just under the card before it, whichever is lower.
 * - With an active card, it goes at its mark's top. Cards before it are pushed up until they clear it; cards after it are
 *   pushed down. If the cards above cannot fit above it without leaving the top of the margin, nothing moves up, and the
 *   active card is pushed down like any other: a card never overlaps another.
 */
export function layoutCards(cards: readonly CardBox[], o: LayoutOptions = {}): CardPlacement[] {
  const gap = finite(o.gap ?? CARD_GAP);
  const minTop = finite(o.minTop ?? 0);
  const order = cards.map((_, i) => i).sort((a, b) => finite(cards[a].anchorTop) - finite(cards[b].anchorTop) || a - b);
  const heightOf = (i: number) => Math.max(0, finite(cards[i].height));
  const tops = new Array<number>(cards.length).fill(0);
  const active = o.activeId == null ? -1 : order.findIndex((i) => cards[i].id === o.activeId);

  const pushDown = (from: number, to: number, prevBottom: number) => {
    let bottom = prevBottom;
    for (let k = from; k < to; k++) {
      const i = order[k];
      tops[i] = Math.max(finite(cards[i].anchorTop), minTop, bottom);
      bottom = tops[i] + heightOf(i) + gap;
    }
    return bottom;
  };

  if (active >= 0) {
    const a = order[active];
    tops[a] = Math.max(finite(cards[a].anchorTop), minTop);
    // Before it: push up, last card first.
    let limit = tops[a] - gap; // the bottom edge the card before may reach
    let fits = true;
    for (let k = active - 1; k >= 0; k--) {
      const i = order[k];
      tops[i] = Math.min(finite(cards[i].anchorTop), limit - heightOf(i));
      if (tops[i] < minTop) fits = false;
      limit = tops[i] - gap;
    }
    if (fits) {
      pushDown(active + 1, order.length, tops[a] + heightOf(a) + gap);
      return cards.map((c, i) => ({ id: c.id, top: tops[i] }));
    }
  }

  pushDown(0, order.length, minTop);
  return cards.map((c, i) => ({ id: c.id, top: tops[i] }));
}
