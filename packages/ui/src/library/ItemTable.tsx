import '../tokens/tokens.css';
import { type KeyboardEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../components/classes';
import { Icon } from '../icons/Icon';
import { clickSelect, type CollectionEntry, type CollectionSelection, focusKey, isMenuKey, itemsOf, menuPointFor, sectionsOf } from './collection';
import { SectionHeading } from './SectionHeading';
import styles from './ItemTable.module.css';

export interface TableColumn<T> {
  id: string;
  /** The header text. */
  label: string;
  /** The column's width as a token (`var(--sop-col-date)`). Leave it out for the name column, which takes the rest. */
  width?: string;
  /** The column shows only while the table is at least this many px wide (narrow windows drop the extra columns). */
  minTableWidth?: number;
  /** Set it to make the header sort the table by this key. */
  sortKey?: string;
  /** The name column: Google Sans Text 500 in on-surface; the others are 400 in on-surface-variant. */
  primary?: boolean;
  render(item: T): ReactNode;
}

export interface TableSort {
  key: string;
  dir: 'asc' | 'desc';
}

export interface ItemTableProps<T> {
  /** The table's accessible name ("My library"). */
  label: string;
  columns: readonly TableColumn<T>[];
  entries: readonly CollectionEntry<T>[];
  selection: CollectionSelection;
  sort?: TableSort | null;
  /** A sortable header was clicked. */
  onSort?(this: void, key: string): void;
  /** At the right end of the header row, above the actions (Drive's "Sort" button). */
  headerEnd?: ReactNode;
  /**
   * The last cell of a row: its actions. Wrap the ones that show only on hover in <RowActions>. `active` is the row
   * that holds the tab stop: only its buttons should be tab stops too (tabIndex -1 on the others).
   */
  renderActions(this: void, item: T, state: { active: boolean }): ReactNode;
  /** Double-click or Enter. */
  onOpen(this: void, item: T): void;
  /**
   * Right-click (`pointer`: at the pointer), the context-menu key or Shift+F10 (`keyboard`: under the ⋮ button's right
   * edge, so the menu should open leftwards): open the item's menu at this point (viewport px).
   */
  onMenu(this: void, item: T, at: { x: number; y: number }, from: 'pointer' | 'keyboard'): void;
  /** Other keys on a row (Delete moves to Trash). Return true when the key was used. */
  onRowKey?(this: void, e: KeyboardEvent<HTMLElement>, item: T): boolean;
  /** After the last row: the "loading more" sentinel. */
  footer?: ReactNode;
  /** Makes each group's heading a button that folds the group away and back (My library's groups). */
  onToggleSection?(this: void, id: string): void;
}

/**
 * Drive's list view (02 section 4.6) as an ARIA grid of rows. Rows are 48 px with a 1 px #c4c7c5 divider; hover is
 * #ededed, selected #c2e7ff with #004a77 text (#b2daf4 when hovered), and the keyboard's row has Drive's double focus
 * ring. The header row sorts: the sorted column's label is on-surface with the arrow in a 24 px #c2e7ff circle.
 *
 * Keyboard: Up and Down (and Home, End) move the selection; Enter opens; the context-menu key or Shift+F10 opens the
 * row's menu. One row holds the tab stop.
 */
export function ItemTable<T>(props: ItemTableProps<T>) {
  const { label, columns, entries, selection, sort, onSort, headerEnd, renderActions, onOpen, onMenu, onRowKey, footer, onToggleSection } = props;
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const shown = columns.filter((c) => c.minTableWidth === undefined || width === 0 || width >= c.minTableWidth);
  const template = [...shown.map((c) => c.width ?? 'minmax(0, 1fr)'), 'var(--sop-col-actions)'].join(' ');
  const items = itemsOf(entries);
  const keys = items.map((i) => i.key);

  /** Shift with an arrow key selects the run as it goes, as Drive's list does. */
  const moveTo = (key: string | undefined, extend = false) => {
    if (key === undefined) return;
    if (extend) selection.extendTo(key);
    else selection.select(key);
    focusKey(root.current, key);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>, key: string, item: T) => {
    if (e.target !== e.currentTarget) return; // a key on a row's own button is that button's
    const at = keys.indexOf(key);
    if (e.key === 'ArrowDown') moveTo(keys[at + 1], e.shiftKey);
    else if (e.key === 'ArrowUp') moveTo(keys[at - 1], e.shiftKey);
    else if (e.key === 'Home') moveTo(keys[0], e.shiftKey);
    else if (e.key === 'End') moveTo(keys.at(-1), e.shiftKey);
    else if (e.key === 'Enter') onOpen(item);
    else if (e.key === ' ') {
      if (e.ctrlKey || e.metaKey) selection.toggle(key);
      else selection.select(key);
    } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') selection.selectAll();
    else if (isMenuKey(e)) {
      if (!selection.isSelected(key)) selection.select(key);
      onMenu(item, menuPointFor(e.currentTarget), 'keyboard');
    } else if (!(onRowKey?.(e, item) ?? false)) return;
    e.preventDefault();
  };

  return (
    <div ref={root} className={styles.table} role="grid" aria-label={label} aria-multiselectable="true" style={{ gridTemplateColumns: template }}>
      <div className={cx(styles.row, styles.header)} role="row">
        {shown.map((c) => {
          const sorted = sort !== null && sort !== undefined && c.sortKey !== undefined && sort.key === c.sortKey;
          const ariaSort = sorted ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
          return (
            <div key={c.id} className={cx(styles.headCell, c.primary === true && styles.primaryHead)} role="columnheader" aria-sort={ariaSort}>
              {c.sortKey !== undefined && onSort !== undefined ? (
                <button type="button" className={cx(styles.sortButton, sorted && styles.sorted)} onClick={() => onSort(c.sortKey ?? c.id)}>
                  <span>{c.label}</span>
                  {sorted && (
                    <span className={styles.sortChip}>
                      <Icon name={sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={20} />
                    </span>
                  )}
                </button>
              ) : (
                <span className={styles.headLabel}>{c.label}</span>
              )}
            </div>
          );
        })}
        <div className={cx(styles.headCell, styles.headEnd)} role="columnheader">
          {headerEnd}
        </div>
      </div>
      {sectionsOf(entries).map((section) => (
        <div key={section.id} role="rowgroup" aria-label={section.label ?? undefined} className={styles.group}>
          {section.label !== null &&
            (onToggleSection === undefined ? (
              <div className={styles.section} aria-hidden="true">
                {section.label}
              </div>
            ) : (
              <SectionHeading className={styles.section} label={section.label} count={section.count} collapsed={section.collapsed} onToggle={() => onToggleSection(section.id)} />
            ))}
          {section.items.map(({ key, item }) => {
            const selected = selection.isSelected(key);
            return (
              <div
                key={key}
                data-key={key}
                role="row"
                aria-selected={selected}
                tabIndex={selection.active === key ? 0 : -1}
                className={cx(styles.row, styles.item, selected && styles.selected)}
                onClick={(e) => clickSelect(selection, key, e)}
                onDoubleClick={() => onOpen(item)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selection.isSelected(key)) selection.select(key);
                  onMenu(item, { x: e.clientX, y: e.clientY }, 'pointer');
                }}
                onKeyDown={(e) => onKeyDown(e, key, item)}
              >
                {shown.map((c) => (
                  <div key={c.id} role="gridcell" className={cx(styles.cell, c.primary === true && styles.primaryCell)}>
                    {c.render(item)}
                  </div>
                ))}
                <div role="gridcell" className={cx(styles.cell, styles.actionsCell)} onDoubleClick={(e) => e.stopPropagation()}>
                  {renderActions(item, { active: selection.active === key })}
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {footer}
    </div>
  );
}

/** Actions that show while the row is hovered, selected or holds the focus (Drive's inline row actions). */
export function RowActions({ children }: { children: ReactNode }) {
  return <span className={styles.hoverActions}>{children}</span>;
}

/** One line of text in a cell, cut with an ellipsis when it does not fit. `title` shows the whole text on hover. */
export function CellText({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className={styles.text} title={title}>
      {children}
    </span>
  );
}

/** The element's width in px, kept up to date; 0 until it is laid out. */
function useWidth(ref: { current: HTMLElement | null }): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
