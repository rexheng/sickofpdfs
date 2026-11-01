import { useCallback, useRef, useState } from 'react';

export type Theme = 'light' | 'dark';

/** The theme in force at `node`: the nearest data-theme attribute, or light when there is none (themes are explicit). */
export function themeAt(node: Element | null): Theme {
  return node?.closest('[data-theme]')?.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * Radix portals menus, tooltips and dialogs into <body>, outside the element that carries data-theme. A component
 * puts `ref` on an element that stays in place (its trigger, or a hidden probe), and copies `theme` onto the portaled
 * content as data-theme. The content then gets the same tokens as the place it was opened from, whether the theme is
 * set on <html> or on a viewer root. `refresh()` reads it again; call it when the layer opens.
 */
export function useInheritedTheme<T extends Element>(): { ref: (node: T | null) => void; theme: Theme; refresh: () => void } {
  const node = useRef<T | null>(null);
  const [theme, setTheme] = useState<Theme>('light');
  const ref = useCallback((el: T | null) => {
    node.current = el;
    if (el !== null) setTheme(themeAt(el));
  }, []);
  const refresh = useCallback(() => {
    setTheme(themeAt(node.current));
  }, []);
  return { ref, theme, refresh };
}
