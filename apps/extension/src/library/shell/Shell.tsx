import { IconButton } from '@sop/ui';
import { LibraryShell, NavList, ProductMark, SearchPill } from '@sop/ui/library';
import { type ReactNode, type Ref, useEffect } from 'react';
import { palette } from '../../shared/palette';
import { BackupAttention } from '../settings/BackupAttention';
import { DEFAULT_ROUTE } from '../routes/pages';
import { ROUTES, type RouteId, routeHref } from '../routes/routes';
import type { UploadOutcome } from '../data/types';
import { NewMenu, type NewMenuHandle } from './NewMenu';
import { TagsNav } from '../tags/TagsNav';
import { useTagInAddress } from '../tags/tag-route';

/** The search bar's words, and how the palette finds the bar to open over it. */
const SEARCH_LABEL = 'Search in library';

/** Where the library's palette opens: over the search bar, as the bar grown into its answers (TB5). Null: no bar. */
export function searchBarAnchor(): { top: number; left: number; width: number; bar: true } | null {
  const bar = document.querySelector<HTMLElement>(`[role="search"]:has(input[aria-label="${SEARCH_LABEL}"])`);
  if (bar === null) return null;
  const r = bar.getBoundingClientRect();
  return r.width === 0 ? null : { top: r.top, left: r.left, width: r.width, bar: true };
}

const NAV_ITEMS = ROUTES.map((r) => ({ id: r.id, label: r.label, icon: r.icon, href: routeHref(r.id), group: r.group }));

export interface ShellProps {
  route: RouteId;
  onNotify(this: void, text: string): void;
  newMenu: Ref<NewMenuHandle>;
  /** Upload PDF: saves a picked file into the library; null while the library is not open. */
  onUpload: ((file: File) => Promise<UploadOutcome>) | null;
  children: ReactNode;
}

/** True while the person types in a field, so single-key shortcuts stay out of the way (global constraints). */
function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/**
 * The library's frame, as Drive's: our mark and the search bar in the top bar, Settings at its right, "+ New" and the
 * navigation on the left, and the page in the white card. The search bar is the Ctrl+K palette's place (TB5: one search
 * box): a click or a typed letter opens the palette over it. "/" opens it too, as in Drive.
 */
export function Shell({ route, onNotify, newMenu, onUpload, children }: ShellProps) {
  const addressTag = useTagInAddress();
  /** S18: My library showing one tag: that tag's pill is the selected one, not My library's. */
  const tag = route === 'library' ? addressTag : null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey || typing(e.target) || e.defaultPrevented) return;
      e.preventDefault();
      palette.open();
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
      // One search box: the bar opens the Ctrl+K palette in its place, which finds readings, pages and notes (S15, TB5).
      search={<SearchPill label={SEARCH_LABEL} onOpen={(typed) => palette.open({ query: typed })} />}
      topEnd={
        <>
          <BackupAttention />
          <IconButton icon="settings" label="Settings" size={40} onClick={() => (location.hash = routeHref('settings'))} />
        </>
      }
      newButton={<NewMenu ref={newMenu} onNotify={onNotify} onUpload={onUpload} />}
      nav={
        <>
          <NavList items={NAV_ITEMS} current={tag === null ? route : null} label="Library" />
          <TagsNav current={tag} />
        </>
      }
    >
      {children}
    </LibraryShell>
  );
}
