import '../tokens/tokens.css';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../components/classes';
import { type CollectionEntry, type CollectionSelection, focusKey, isMenuKey, itemsOf, menuPointFor, sectionsOf } from './collection';
import styles from './ItemGrid.module.css';

export interface GridCardParts {
  /** The file-type icon at the left of the card's header strip. */
  icon: ReactNode;
  /** The card's name (one line, cut with an ellipsis). */
  title: string;
  /** Small marks after the name (a star). */
  badges?: ReactNode;
  /** The ⋮ button at the right of the header strip. */
  more: ReactNode;
  /** What fills the white box under the header: the first page. */
  thumbnail: ReactNode;
}

export interface ItemGridProps<T> {
  label: string;
  entries: readonly CollectionEntry<T>[];
  selection: CollectionSelection;
  /** `active` is the card that holds the tab stop; only its ⋮ button should be a tab stop too. */
  renderCard(this: void, item: T, state: { active: boolean }): GridCardParts;
  onOpen(this: void, item: T): void;
  /** As ItemTable's: `keyboard` means the point is under the ⋮ button's right edge. */
  onMenu(this: void, item: T, at: { x: number; y: number }, from: 'pointer' | 'keyboard'): void;
  onCardKey?(this: void, e: KeyboardEvent<HTMLElement>, item: T): boolean;
  footer?: ReactNode;
}

/** Fallbacks for the first layout, before the card size token can be read. */
const FALLBACK_CARD = 200;
const FALLBACK_GAP = 16;

/**
 * Drive's grid view (02 section 4.7): 220 × 220 cards on #f0f4f9 with 12 px corners, a 48 px header strip (type icon,
 * name, ⋮) and the first page in a white box inset 8 px, 16 px apart. Cards stretch to fill each row. Selected cards are
 * #c2e7ff with #004a77 text. The arrow keys move by card and by row; Enter opens; the context-menu key opens the menu.
 */
export function ItemGrid<T>({ label, entries, selection, renderCard, onOpen, onMenu, onCardKey, footer }: ItemGridProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const columns = useColumns(root);
  const keys = itemsOf(entries).map((i) => i.key);
  const sections = sectionsOf(entries);

  const moveTo = (key: string | undefined) => {
    if (key === undefined) return;
    selection.select(key);
    focusKey(root.current, key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, key: string, item: T) => {
    if (e.target !== e.currentTarget) return;
    const at = keys.indexOf(key);
    if (e.key === 'ArrowRight') moveTo(keys[at + 1]);
    else if (e.key === 'ArrowLeft') moveTo(keys[at - 1]);
    else if (e.key === 'ArrowDown') moveTo(keys[Math.min(at + columns, keys.length - 1)]);
    else if (e.key === 'ArrowUp') moveTo(keys[Math.max(at - columns, 0)]);
    else if (e.key === 'Home') moveTo(keys[0]);
    else if (e.key === 'End') moveTo(keys.at(-1));
    else if (e.key === 'Enter') onOpen(item);
    else if (e.key === ' ') selection.select(key);
    else if (isMenuKey(e)) {
      selection.select(key);
      onMenu(item, menuPointFor(e.currentTarget), 'keyboard');
    } else if (!(onCardKey?.(e, item) ?? false)) return;
    e.preventDefault();
  };

  return (
    <div ref={root} className={styles.grid} role="grid" aria-label={label}>
      {sections.map((section) => (
        <div key={section.id} role="rowgroup" aria-label={section.label ?? undefined} className={styles.group}>
          {section.label !== null && (
            <div className={styles.section} aria-hidden="true">
              {section.label}
            </div>
          )}
          {chunk(section.items, columns).map((row) => (
            <div key={row[0]?.key} role="row" className={styles.row} style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
              {row.map(({ key, item }) => {
                const selected = selection.selected === key;
                const card = renderCard(item, { active: selection.active === key });
                return (
                  <div
                    key={key}
                    data-key={key}
                    role="gridcell"
                    aria-selected={selected}
                    aria-label={card.title}
                    tabIndex={selection.active === key ? 0 : -1}
                    className={cx(styles.card, selected && styles.selected)}
                    onClick={() => selection.select(key)}
                    onDoubleClick={() => onOpen(item)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      selection.select(key);
                      onMenu(item, { x: e.clientX, y: e.clientY }, 'pointer');
                    }}
                    onKeyDown={(e) => onKeyDown(e, key, item)}
                  >
                    <div className={styles.head}>
                      <span className={styles.icon}>{card.icon}</span>
                      <span className={styles.name} title={card.title}>
                        {card.title}
                      </span>
                      {card.badges}
                      <span className={styles.more} onDoubleClick={(e) => e.stopPropagation()}>
                        {card.more}
                      </span>
                    </div>
                    <div className={styles.thumb}>{card.thumbnail}</div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ))}
      {footer}
    </div>
  );
}

function chunk<V>(list: readonly V[], size: number): V[][] {
  const out: V[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** How many cards fit on a row: the card's minimum width (the token) and the gap, against the grid's width. */
function useColumns(ref: { current: HTMLElement | null }): number {
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const card = parseFloat(style.getPropertyValue('--sop-grid-card-min')) || FALLBACK_CARD;
      const gap = parseFloat(style.getPropertyValue('--space-4')) || FALLBACK_GAP;
      setColumns(Math.max(1, Math.floor((el.clientWidth + gap) / (card + gap))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}
