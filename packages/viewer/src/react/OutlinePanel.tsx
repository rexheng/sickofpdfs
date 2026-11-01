// The PDF's outline (its bookmarks) in the navigation rail (Task 24): a tree, collapsed to its top level at first.
//
// It follows the ARIA tree pattern: one tab stop (the item last moved to); ArrowUp and ArrowDown move between the
// items shown; ArrowRight opens an item or moves into it; ArrowLeft closes it or moves to its parent; Home and End go
// to the first and last item; Enter or Space goes to the item's destination. A click on the arrow opens or closes an
// item; a click on its title goes there. Going there does not touch history.
import { type CSSProperties, type JSX, type KeyboardEvent, useMemo, useRef, useState } from 'react';
import type { LinkTarget, OutlineItem } from '../backend/types';
import styles from './OutlinePanel.module.css';

export interface OutlinePanelProps {
  items: OutlineItem[];
  /** The reader picked an item with a destination. */
  onSelect(this: void, t: LinkTarget): void;
}

/** One item as shown: its place in the tree is `key` ("0", "0/2", …). */
interface Row {
  key: string;
  item: OutlineItem;
  level: number;
  posInSet: number;
  setSize: number;
  parent: string | null;
}

/** The items shown when the items in `open` are opened, in order. */
function visibleRows(items: OutlineItem[], open: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (list: OutlineItem[], level: number, parent: string | null) => {
    list.forEach((item, i) => {
      const key = parent === null ? String(i) : `${parent}/${i}`;
      rows.push({ key, item, level, posInSet: i + 1, setSize: list.length, parent });
      if (item.children.length > 0 && open.has(key)) walk(item.children, level + 1, key);
    });
  };
  walk(items, 1, null);
  return rows;
}

/** Where `key` is among the rows shown; an item inside a closed one counts as that one. −1 when there is none. */
function shownIndex(rows: Row[], key: string): number {
  for (let k = key; ; k = k.slice(0, k.lastIndexOf('/'))) {
    const i = rows.findIndex((r) => r.key === k);
    if (i >= 0 || !k.includes('/')) return i;
  }
}

/** `role="tree"`: each item is a `treeitem` whose accessible name is its title. */
export function OutlinePanel({ items, onSelect }: OutlinePanelProps): JSX.Element {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState('0');
  const tree = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleRows(items, open), [items, open]);
  const at = Math.max(0, shownIndex(rows, active));
  const activeKey = rows[at]?.key ?? null;

  const toggle = (key: string, to: boolean) =>
    setOpen((was) => {
      if (was.has(key) === to) return was;
      const next = new Set(was);
      if (to) next.add(key);
      else next.delete(key);
      return next;
    });
  const focus = (key: string) => {
    setActive(key);
    tree.current?.querySelector<HTMLElement>(`[data-outline-key="${key}"]`)?.focus();
  };
  const choose = (row: Row) => {
    if (row.item.target !== null) onSelect(row.item.target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[at];
    if (!row || e.altKey || e.ctrlKey || e.metaKey) return;
    const hasChildren = row.item.children.length > 0;
    const isOpen = open.has(row.key);
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        if (at + 1 < rows.length) focus(rows[at + 1].key);
        break;
      case 'ArrowUp':
        if (at > 0) focus(rows[at - 1].key);
        break;
      case 'Home':
        focus(rows[0].key);
        break;
      case 'End':
        focus(rows[rows.length - 1].key);
        break;
      case 'ArrowRight':
        if (hasChildren && !isOpen) toggle(row.key, true);
        else if (hasChildren) focus(`${row.key}/0`);
        break;
      case 'ArrowLeft':
        if (hasChildren && isOpen) toggle(row.key, false);
        else if (row.parent !== null) focus(row.parent);
        break;
      case 'Enter':
      case ' ':
        choose(row);
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div ref={tree} role="tree" aria-label="Outline" className={styles.tree} onKeyDown={onKeyDown}>
      {rows.map((row) => {
        const hasChildren = row.item.children.length > 0;
        const isOpen = hasChildren && open.has(row.key);
        return (
          <div
            key={row.key}
            role="treeitem"
            aria-label={row.item.title}
            aria-level={row.level}
            aria-posinset={row.posInSet}
            aria-setsize={row.setSize}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-disabled={row.item.target === null ? true : undefined}
            data-outline-key={row.key}
            tabIndex={row.key === activeKey ? 0 : -1}
            className={styles.row}
            style={{ '--_level': row.level - 1 } as CSSProperties}
            onFocus={() => setActive(row.key)}
            // A click goes there without taking the focus, so the reading keys keep moving the pages.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setActive(row.key);
              choose(row);
            }}
          >
            {hasChildren ? (
              <span
                className={styles.arrow}
                data-open={isOpen ? '' : undefined}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  setActive(row.key);
                  toggle(row.key, !isOpen);
                }}
              >
                <svg viewBox="0 0 24 24" className={styles.arrowIcon}>
                  <path d="M10 17l5-5-5-5z" />
                </svg>
              </span>
            ) : (
              <span className={styles.arrow} aria-hidden="true" />
            )}
            <span className={styles.title}>{row.item.title}</span>
          </div>
        );
      })}
    </div>
  );
}
