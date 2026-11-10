// The web's version of apps/extension/src/library/shell/Shell.tsx (swapped in by vite.config.ts): the library's frame.
//   - On a computer: Drive's frame, as in Chrome (our mark and the search bar on top, "+ New" with Upload PDF (CL15), the pages
//     and tags on the left, the page in the white card), with the sync status and Settings at the top right.
//   - On a phone (720 px or narrower): a top bar with the page's name, search, the sync status and the other pages, the page in
//     Drive's white card, a bottom bar with Home, My library, Recent and Notes, and Drive's round "+" to upload a PDF.
// Uploads show in Drive's panel at the bottom right, and a PDF dropped on the page is uploaded too (upload/).
// A reading's own page (/d/<sha>) is drawn in the same frame, in place of the library page the address would otherwise show.
import { DropdownMenu, Icon, IconButton } from '@sop/ui';
import { LibraryShell, NavList, ProductMark, SearchPill } from '@sop/ui/library';
import { type ReactNode, type Ref, useContext, useEffect, useImperativeHandle, useRef, useSyncExternalStore } from 'react';
import { LibraryContext } from '@ext/library/app/context';
import { palette } from '@ext/shared/palette';
import type { UploadOutcome } from '@ext/library/data/types';
import { ROUTES, type RouteId, routeHref } from '@ext/library/routes/routes';
import type { NewMenuHandle } from '@ext/library/shell/NewMenu';
import { TagsNav } from '@ext/library/tags/TagsNav';
import { useTagInAddress } from '@ext/library/tags/tag-route';
import { ReadingPage } from '../reading/ReadingPage';
import { DropToUpload, UploadFab, UploadInput, type UploadPicker, WebNewButton } from '../upload/NewUpload';
import { UploadPanel } from '../upload/UploadPanel';
import { SignOutForm } from '../settings/SignOut';
import { SyncStatusChip } from './SyncStatus';
import { useWebRoute } from './web-route';
import styles from './Shell.module.css';

const SEARCH_LABEL = 'Search in library';

/** Where the palette opens: over the search bar on a computer; in its usual place on a phone, which has no bar. */
export function searchBarAnchor(): { top: number; left: number; width: number; bar: true } | null {
  const bar = document.querySelector<HTMLElement>(`[role="search"]:has(input[aria-label="${SEARCH_LABEL}"])`);
  if (bar === null) return null;
  const r = bar.getBoundingClientRect();
  return r.width === 0 ? null : { top: r.top, left: r.left, width: r.width, bar: true };
}

export interface ShellProps {
  route: RouteId;
  onNotify(this: void, text: string): void;
  newMenu: Ref<NewMenuHandle>;
  onUpload: ((file: File) => Promise<UploadOutcome>) | null;
  children: ReactNode;
}

const PHONE = '(max-width: 720px)';
function subscribeWidth(cb: () => void): () => void {
  const q = matchMedia(PHONE);
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
}
const isPhone = () => matchMedia(PHONE).matches;
export const usePhone = (): boolean => useSyncExternalStore(subscribeWidth, isPhone, isPhone);

const NAV_ITEMS = ROUTES.map((r) => ({ id: r.id, label: r.label, icon: r.icon, href: routeHref(r.id), group: r.group }));

export function Shell({ route, onNotify, newMenu, children }: ShellProps) {
  const web = useWebRoute();
  const phone = usePhone();
  const addressTag = useTagInAddress();
  // "/" opens the search, as in Drive and in the extension's library (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey || typing || e.defaultPrevented) return;
      e.preventDefault();
      palette.open();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const picker = useRef<UploadPicker>(null);
  // The library's "open a file" (Ctrl+O, an empty library's button) uploads on the web: there is no viewer tab to open it in.
  useImperativeHandle(newMenu, () => ({ pickFile: () => picker.current?.pick() }), []);
  void onNotify;
  // The reading's page needs the library: until it has started, the empty card the library shows while it opens.
  const started = useContext(LibraryContext) !== null;
  const page = web.kind === 'reading' && started ? <ReadingPage key={web.sha} sha={web.sha} page={web.page} note={web.note} /> : children;
  const current = web.kind === 'reading' ? null : route;
  const pick = () => picker.current?.pick();
  return (
    <>
      {phone ? (
        <PhoneFrame route={current} upload={<UploadFab onPick={pick} disabled={!started} />}>
          {page}
        </PhoneFrame>
      ) : (
        <DesktopFrame route={current} tag={current === 'library' ? addressTag : null} newButton={<WebNewButton onPick={pick} disabled={!started} />}>
          {page}
        </DesktopFrame>
      )}
      <UploadInput ref={picker} />
      <DropToUpload enabled={started} />
      <UploadPanel />
    </>
  );
}

function DesktopFrame({ route, tag, newButton, children }: { route: RouteId | null; tag: string | null; newButton: ReactNode; children: ReactNode }) {
  return (
    <LibraryShell
      mark={
        <a href={routeHref('home')} aria-label="Library, first page" className={styles.markLink}>
          <ProductMark label="Library" />
        </a>
      }
      search={<SearchPill label={SEARCH_LABEL} onOpen={(typed) => palette.open({ query: typed })} />}
      topEnd={
        <>
          <SyncStatusChip />
          <IconButton icon="settings" label="Settings" size={40} onClick={() => (location.hash = routeHref('settings'))} />
        </>
      }
      newButton={newButton}
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

/** The bottom bar's pages; the rest are in the top bar's menu. */
const TABS: RouteId[] = ['home', 'library', 'recent', 'notes'];

function PhoneFrame({ route, upload, children }: { route: RouteId | null; upload: ReactNode; children: ReactNode }) {
  const more = ROUTES.filter((r) => !TABS.includes(r.id));
  return (
    <div className={styles.phone}>
      <header className={styles.phoneTop}>
        <div className={styles.phoneSearch}>
          <SearchPill label={SEARCH_LABEL} onOpen={(typed) => palette.open({ query: typed })} />
        </div>
        <SyncStatusChip compact />
        <DropdownMenu
          trigger={<IconButton icon="more_vert" label="More pages" size={40} />}
          items={[
            ...more.map((r) => ({ kind: 'item' as const, id: r.id, label: r.label, icon: r.icon, onSelect: () => (location.hash = routeHref(r.id)) })),
            { kind: 'separator' as const },
            { kind: 'item' as const, id: 'sign-out', label: 'Sign out', icon: 'logout' as const, onSelect: () => document.querySelector<HTMLFormElement>('#sop-sign-out')?.requestSubmit() },
          ]}
        />
        <SignOutForm id="sop-sign-out" hidden />
      </header>
      <main className={styles.phoneMain}>{children}</main>
      {upload}
      <nav className={styles.tabs} aria-label="Library">
        {TABS.map((id) => {
          const r = ROUTES.find((x) => x.id === id)!;
          const selected = id === route;
          return (
            <a key={id} href={routeHref(id)} className={styles.tab} aria-current={selected ? 'page' : undefined}>
              <span className={styles.tabIcon}>
                <Icon name={r.icon} size={24} filled={selected} />
              </span>
              <span className={styles.tabLabel}>{r.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
