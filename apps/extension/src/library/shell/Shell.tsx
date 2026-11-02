import { IconButton } from '@sop/ui';
import { LibraryShell, NavList, ProductMark, SearchPill } from '@sop/ui/library';
import { type ReactNode, type Ref, useEffect, useRef } from 'react';
import { palette } from '../../shared/palette';
import { BackupAttention } from '../settings/BackupAttention';
import { DEFAULT_ROUTE } from '../routes/pages';
import { ROUTES, type RouteId, routeHref } from '../routes/routes';
import type { UploadOutcome } from '../data/types';
import { NewMenu, type NewMenuHandle } from './NewMenu';
import { TagsNav } from '../tags/TagsNav';
import { useTagInAddress } from '../tags/tag-route';

const NAV_ITEMS = ROUTES.map((r) => ({ id: r.id, label: r.label, icon: r.icon, href: routeHref(r.id), group: r.group }));

export interface ShellProps {
  route: RouteId;
  search: string;
  onSearch(this: void, text: string): void;
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
 * The library's frame, as Drive's: our mark and the search pill in the top bar, Settings at its right, "+ New" and the
 * navigation on the left, and the page in the white card. "/" puts the cursor in the search pill, as in Drive.
 */
export function Shell({ route, search, onSearch, onNotify, newMenu, onUpload, children }: ShellProps) {
  const field = useRef<HTMLInputElement>(null);
  const addressTag = useTagInAddress();
  /** S18: My library showing one tag: that tag's pill is the selected one, not My library's. */
  const tag = route === 'library' ? addressTag : null;
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
      // Enter looks deeper: the same words in the Ctrl+K palette, which also searches pages and notes (S15).
      search={<SearchPill ref={field} value={search} onChange={onSearch} label="Search in library" onEnter={() => palette.open({ query: search.trim() })} />}
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
