// The library's pages and their places in the navigation (spec "Library pages": Home, My library, Recent, Starred,
// Notes, Trash, Settings). The address is `library.html#/<id>`, so Back, a reload and a bookmark keep the page.
import type { IconName } from '@sop/ui';

export type RouteId = 'home' | 'library' | 'recent' | 'starred' | 'notes' | 'trash' | 'settings';

export interface RouteDef {
  id: RouteId;
  /** The navigation label, and the page's name in the tab title. */
  label: string;
  icon: IconName;
  /** Drive's three groups, 16 px apart. */
  group: 1 | 2 | 3;
}

export const ROUTES: readonly RouteDef[] = [
  { id: 'home', label: 'Home', icon: 'home', group: 1 },
  { id: 'library', label: 'My library', icon: 'library_books', group: 1 },
  { id: 'recent', label: 'Recent', icon: 'schedule', group: 2 },
  { id: 'starred', label: 'Starred', icon: 'star', group: 2 },
  { id: 'notes', label: 'Notes', icon: 'comment', group: 2 },
  { id: 'trash', label: 'Trash', icon: 'delete', group: 3 },
  { id: 'settings', label: 'Settings', icon: 'settings', group: 3 },
];

export const routeHref = (id: RouteId): string => `#/${id}`;

/** The page an address names (`#/recent`), or null for none or one we do not know. */
export function routeFromHash(hash: string): RouteId | null {
  const id = /^#\/([a-z]+)/.exec(hash)?.[1];
  return ROUTES.find((r) => r.id === id)?.id ?? null;
}
