// The margin column: one Docs-style card per note, level with its line (02 section 4.11, live-19 and live-20).
//
// Each card sits at the top of its passage. Cards never overlap: when two would, the lower one moves down; the active
// card stays level with its passage and the others make room above and below it (S7's layoutCards). Cards are measured
// as they render, so a card that grows (a reply, a longer note) pushes the ones below it at once.
import { ThreadCard, type ThreadCardProps } from '@sop/ui';
import { CARD_GAP, layoutCards } from '@sop/viewer';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import styles from './CardColumn.module.css';

export interface ColumnCard {
  id: string;
  /** Where the top of its passage is, in content px. */
  anchorTop: number;
  card: Omit<ThreadCardProps, 'style' | 'ref' | 'className' | 'active'>;
}

export interface CardColumnProps {
  cards: readonly ColumnCard[];
  /** The column's left edge, in content px. */
  left: number;
  activeId: string | null;
  /** Off while the pages are laid out again (zoom, rotation, a resize): the cards then move with the pages at once. */
  animate: boolean;
}

/** A card's height before it has been measured: one comment, one line. */
const ESTIMATE = 96;

/** Each card's element id is this and its note's thread id (the click-away test and the tests find cards by it). */
export const CARD_ID_PREFIX = 'note-card-';

export function CardColumn({ cards, left, activeId, animate }: CardColumnProps) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);

  // One observer for every card. It reports border-box heights; a change re-runs the layout.
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      setHeights((prev) => {
        let next: Map<string, number> | null = null;
        for (const e of entries) {
          const el = e.target as HTMLElement;
          const id = el.id.startsWith(CARD_ID_PREFIX) ? el.id.slice(CARD_ID_PREFIX.length) : null;
          const h = e.borderBoxSize[0]?.blockSize ?? el.offsetHeight;
          if (id === null || prev.get(id) === h) continue;
          next ??= new Map(prev);
          next.set(id, h);
        }
        return next ?? prev;
      });
    });
    observer.current = ro;
    for (const el of elements.current.values()) ro.observe(el);
    return () => {
      ro.disconnect();
      observer.current = null;
    };
  }, []);

  const refFor = useCallback((id: string) => {
    return (el: HTMLElement | null) => {
      const had = elements.current.get(id);
      if (had && had !== el) {
        observer.current?.unobserve(had);
        elements.current.delete(id);
      }
      if (el) {
        elements.current.set(id, el);
        observer.current?.observe(el);
      }
    };
  }, []);
  // A stable ref callback per card, so React does not detach and re-attach it on every render.
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const stableRef = (id: string) => {
    let r = refs.current.get(id);
    if (!r) {
      r = refFor(id);
      refs.current.set(id, r);
    }
    return r;
  };

  // After every render, before the browser paints: measure the cards whose height changed (a new card, a card that
  // turned active and shows its replies), so no frame ever shows a card at a guessed place.
  useLayoutEffect(() => {
    let next: Map<string, number> | null = null;
    for (const [id, el] of elements.current) {
      const h = el.offsetHeight;
      if (heights.get(id) === h) continue;
      next ??= new Map(heights);
      next.set(id, h);
    }
    if (next) setHeights(next);
    const live = new Set(cards.map((c) => c.id));
    for (const id of refs.current.keys()) if (!live.has(id)) refs.current.delete(id);
  }, [cards, heights]);

  const tops = useMemo(() => {
    const placed = layoutCards(
      cards.map((c) => ({ id: c.id, anchorTop: c.anchorTop, height: heights.get(c.id) ?? ESTIMATE })),
      { activeId, gap: CARD_GAP },
    );
    return new Map(placed.map((p) => [p.id, p.top]));
  }, [cards, heights, activeId]);

  return (
    <div className={styles.column} data-animate={animate ? 'true' : 'false'}>
      {cards.map((c) => (
        <ThreadCard
          key={c.id}
          {...c.card}
          ref={stableRef(c.id)}
          id={`${CARD_ID_PREFIX}${c.id}`}
          active={c.id === activeId}
          className={styles.card}
          style={{ top: tops.get(c.id) ?? c.anchorTop, left }}
        />
      ))}
    </div>
  );
}
