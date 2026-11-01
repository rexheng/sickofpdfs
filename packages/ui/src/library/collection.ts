import { useCallback, useMemo, useState } from 'react';

/** One line of a list or grid: an item, or the heading of a group of items (Recent's "Today", "Earlier this week"). */
export type CollectionEntry<T> = { kind: 'section'; id: string; label: string } | { kind: 'item'; key: string; item: T };

/** The items of `entries`, in order, without the headings. */
export function itemsOf<T>(entries: readonly CollectionEntry<T>[]): { key: string; item: T }[] {
  return entries.flatMap((e) => (e.kind === 'item' ? [{ key: e.key, item: e.item }] : []));
}

/** The entries split at each heading: the items before the first heading form a group with no heading. */
export function sectionsOf<T>(entries: readonly CollectionEntry<T>[]): { id: string; label: string | null; items: { key: string; item: T }[] }[] {
  const out: { id: string; label: string | null; items: { key: string; item: T }[] }[] = [];
  for (const e of entries) {
    if (e.kind === 'section') out.push({ id: e.id, label: e.label, items: [] });
    else {
      if (out.length === 0) out.push({ id: '', label: null, items: [] });
      out.at(-1)?.items.push({ key: e.key, item: e.item });
    }
  }
  return out;
}

/**
 * Which item is selected and which one the keyboard is on, for a list or a grid. Drive moves both together: the arrow
 * keys select as they go. A key that is no longer among `keys` (the item left the view) counts as none.
 */
export interface CollectionSelection {
  selected: string | null;
  /** The item that holds the tab stop (the roving focus). */
  active: string | null;
  select(this: void, key: string | null): void;
}

export function useCollectionSelection(keys: readonly string[]): CollectionSelection {
  const [selected, setSelected] = useState<string | null>(null);
  const present = useMemo(() => new Set(keys), [keys]);
  const live = selected !== null && present.has(selected) ? selected : null;
  const select = useCallback((key: string | null) => setSelected(key), []);
  return { selected: live, active: live ?? keys[0] ?? null, select };
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
