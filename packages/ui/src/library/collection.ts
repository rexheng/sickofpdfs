import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * One line of a list or grid: an item, or the heading of a group of items (Recent's "Today", "Earlier this week"; My
 * library's groups by topic or course). A heading with `count` shows how many items it holds; with `collapsed` its items
 * are left out by the caller and the heading shows it is folded (the list's `onToggleSection` makes it a button).
 */
export type CollectionEntry<T> =
  | { kind: 'section'; id: string; label: string; count?: number; collapsed?: boolean }
  | { kind: 'item'; key: string; item: T };

/** The items of `entries`, in order, without the headings. */
export function itemsOf<T>(entries: readonly CollectionEntry<T>[]): { key: string; item: T }[] {
  return entries.flatMap((e) => (e.kind === 'item' ? [{ key: e.key, item: e.item }] : []));
}

/** The entries split at each heading: the items before the first heading form a group with no heading. */
export interface CollectionSection<T> {
  id: string;
  label: string | null;
  count: number | null;
  collapsed: boolean;
  items: { key: string; item: T }[];
}

export function sectionsOf<T>(entries: readonly CollectionEntry<T>[]): CollectionSection<T>[] {
  const out: CollectionSection<T>[] = [];
  for (const e of entries) {
    if (e.kind === 'section') out.push({ id: e.id, label: e.label, count: e.count ?? null, collapsed: e.collapsed === true, items: [] });
    else {
      if (out.length === 0) out.push({ id: '', label: null, count: null, collapsed: false, items: [] });
      out.at(-1)?.items.push({ key: e.key, item: e.item });
    }
  }
  return out;
}

/**
 * Which items are selected and which one the keyboard is on, for a list or a grid. Drive moves both together: the arrow
 * keys select as they go. A click selects one item; Ctrl+click adds or takes away one, Shift+click selects the run from
 * the last item clicked. A key that is no longer among `keys` (the item left the view) counts as not selected.
 */
export interface CollectionSelection {
  /** The item clicked last, when it is selected: the one the details and the row menu are about. */
  selected: string | null;
  /** The item that holds the tab stop (the roving focus). */
  active: string | null;
  /** Every selected item, in list order. */
  keys: readonly string[];
  isSelected(this: void, key: string): boolean;
  /** Selects this item alone (null: none). */
  select(this: void, key: string | null): void;
  /** Ctrl+click: adds the item to the selection, or takes it away. */
  toggle(this: void, key: string): void;
  /** Shift+click: selects every item from the last one clicked to this one. */
  extendTo(this: void, key: string): void;
  /** Ctrl+A: every item. */
  selectAll(this: void): void;
}

interface SelectionState {
  /** The item clicked last. */
  primary: string | null;
  /** Where a Shift+click run starts. */
  anchor: string | null;
  set: ReadonlySet<string>;
}

const NONE: SelectionState = { primary: null, anchor: null, set: new Set() };

export function useCollectionSelection(keys: readonly string[]): CollectionSelection {
  const [state, setState] = useState<SelectionState>(NONE);
  const present = useMemo(() => new Set(keys), [keys]);
  const order = useRef(keys);
  order.current = keys;
  const live = useMemo(() => keys.filter((k) => state.set.has(k)), [keys, state.set]);
  const liveSet = useMemo(() => new Set(live), [live]);
  const primary = state.primary !== null && liveSet.has(state.primary) ? state.primary : (live.at(-1) ?? null);

  const select = useCallback((key: string | null) => setState(key === null ? NONE : { primary: key, anchor: key, set: new Set([key]) }), []);
  const toggle = useCallback(
    (key: string) =>
      setState((s) => {
        const set = new Set(s.set);
        if (set.has(key)) set.delete(key);
        else set.add(key);
        return { primary: set.has(key) ? key : s.primary === key ? null : s.primary, anchor: key, set };
      }),
    [],
  );
  const extendTo = useCallback(
    (key: string) =>
      setState((s) => {
        const list = order.current;
        const from = s.anchor === null ? -1 : list.indexOf(s.anchor);
        const to = list.indexOf(key);
        if (to < 0) return s;
        if (from < 0) return { primary: key, anchor: key, set: new Set([key]) };
        const [a, b] = from <= to ? [from, to] : [to, from];
        return { primary: key, anchor: s.anchor, set: new Set(list.slice(a, b + 1)) };
      }),
    [],
  );
  const selectAll = useCallback(() => setState((s) => ({ primary: s.primary ?? order.current[0] ?? null, anchor: s.anchor ?? order.current[0] ?? null, set: new Set(order.current) })), []);
  const isSelected = useCallback((key: string) => liveSet.has(key) && present.has(key), [liveSet, present]);
  return { selected: primary, active: primary ?? keys[0] ?? null, keys: live, isSelected, select, toggle, extendTo, selectAll };
}

/** What a click with these keys held does to the selection: Ctrl (or ⌘) adds or takes away, Shift selects a run. */
export function clickSelect(selection: CollectionSelection, key: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
  if (e.ctrlKey || e.metaKey) selection.toggle(key);
  else if (e.shiftKey) selection.extendTo(key);
  else selection.select(key);
}

/** Moves the DOM focus to the element of `container` that carries `data-key={key}`, once React has drawn it. */
export function focusKey(container: HTMLElement | null, key: string): void {
  requestAnimationFrame(() => {
    const el = container?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    el?.focus({ preventScroll: false });
    el?.scrollIntoView({ block: 'nearest' });
  });
}

/** The point to open an item's menu at from the keyboard: just under its ⋮ button's right edge (the menu opens leftwards). */
export function menuPointFor(el: Element): { x: number; y: number } {
  const more = el.querySelector('[data-more]') ?? el;
  const r = more.getBoundingClientRect();
  return { x: r.right, y: r.bottom };
}

/** The context-menu key, or Shift+F10: open the item's menu from the keyboard. */
export function isMenuKey(e: { key: string; shiftKey: boolean }): boolean {
  return e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
}
