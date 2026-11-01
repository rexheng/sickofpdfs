import { IconButton } from '@sop/ui';
import { LibraryShell, NavList, ProductMark, SearchPill } from '@sop/ui/library';
import { type ReactNode, type Ref, useEffect, useRef } from 'react';
import { DEFAULT_ROUTE } from '../routes/pages';
import { ROUTES, type RouteId, routeHref } from '../routes/routes';
import { NewMenu, type NewMenuHandle } from './NewMenu';

const NAV_ITEMS = ROUTES.map((r) => ({ id: r.id, label: r.label, icon: r.icon, href: routeHref(r.id), group: r.group }));

export interface ShellProps {
  route: RouteId;
  search: string;
  onSearch(this: void, text: string): void;
  onNotify(this: void, text: string): void;
  newMenu: Ref<NewMenuHandle>;
  children: ReactNode;
}

/** True while the person types in a field, so single-key shortcuts stay out of the way (global constraints). */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * The library's frame, as Drive's: our mark and the search pill in the top bar, Settings at its right, "+ New" and the
 * navigation on the left, and the page in the white card. "/" puts the cursor in the search pill, as in Drive.
 */
export function Shell({ route, search, onSearch, onNotify, newMenu, children }: ShellProps) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey || typing(e.target) || e.defaultPrevented) return;
      e.preventDefault();
      field.current?.focus();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  return (
    <LibraryShell
      mark={
        <a href={routeHref(DEFAULT_ROUTE)} aria-label="Library, first page" style={{ display: 'inline-flex', color: 'inherit', textDecoration: 'none' }}>
          <ProductMark label="Library" />
        </a>
      }
      search={<SearchPill ref={field} value={search} onChange={onSearch} label="Search in library" />}
      topEnd={<IconButton icon="settings" label="Settings" size={40} onClick={() => (location.hash = routeHref('settings'))} />}
      newButton={<NewMenu ref={newMenu} onNotify={onNotify} />}
      nav={<NavList items={NAV_ITEMS} current={route} label="Library" />}
    >
      {children}
    </LibraryShell>
  );
}
