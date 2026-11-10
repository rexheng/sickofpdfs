// The app's version of apps/extension/src/library/shell/Shell.tsx (swapped in by vite.config.ts): the library's frame on a phone.
// The same pages, data and dialogs as in Chrome; only the frame changes: a top bar with the page's name, search and the other
// pages, a bottom bar with Home, My library and Recent, and an "Open a PDF" button that opens Android's file picker.
import { DropdownMenu, Icon, IconButton } from '@sop/ui';
import { type ReactNode, type Ref, useCallback, useImperativeHandle } from 'react';
import { palette } from '@ext/shared/palette';
import type { UploadOutcome } from '@ext/library/data/types';
import { ROUTES, type RouteId, routeHref } from '@ext/library/routes/routes';
import type { NewMenuHandle } from '@ext/library/shell/NewMenu';
import { navigate } from './chrome-shim';
import { incomingViewerUrl } from './app-events';
import { isNativeApp, SopPlatform } from './native';
import styles from './Shell.module.css';

/** The palette opens over the desktop's search bar; the phone has none, so it opens in its usual place. */
export function searchBarAnchor(): null {
  return null;
}

export interface ShellProps {
  route: RouteId;
  onNotify(this: void, text: string): void;
  newMenu: Ref<NewMenuHandle>;
  onUpload: ((file: File) => Promise<UploadOutcome>) | null;
  children: ReactNode;
}

/** The bottom bar's pages; the rest are in the top bar's menu. */
const TABS: RouteId[] = ['home', 'library', 'recent'];

export function Shell({ route, onNotify, newMenu, children }: ShellProps) {
  const openPdf = useCallback(() => {
    if (!isNativeApp()) {
      onNotify('Open a PDF works in the Android app.');
      return;
    }
    SopPlatform.pickPdf().then(
      ({ pdf }) => {
        if (pdf !== null) navigate(incomingViewerUrl(pdf.id));
      },
      () => onNotify('Couldn’t open that file. Try again.'),
    );
  }, [onNotify]);
  useImperativeHandle(newMenu, () => ({ pickFile: openPdf }), [openPdf]);
  const more = ROUTES.filter((r) => !TABS.includes(r.id));
  return (
    <div className={styles.shell}>
      <header className={styles.top}>
        <p className={styles.title}>sickofpdfs</p>
        <IconButton icon="search" label="Search in library" size={40} onClick={() => palette.open()} />
        <DropdownMenu
          trigger={<IconButton icon="more_vert" label="More pages" size={40} />}
          items={more.map((r) => ({ kind: 'item' as const, id: r.id, label: r.label, icon: r.icon, onSelect: () => (location.hash = routeHref(r.id)) }))}
        />
      </header>
      <main className={styles.main}>{children}</main>
      <button type="button" className={styles.fab} onClick={openPdf}>
        <Icon name="file_open" size={24} />
        <span>Open a PDF</span>
      </button>
      <nav className={styles.tabs} aria-label="Library">
        {TABS.map((id) => {
          const r = ROUTES.find((x) => x.id === id)!;
          const current = id === route;
          return (
            <a key={id} href={routeHref(id)} className={styles.tab} aria-current={current ? 'page' : undefined}>
              <span className={styles.tabIcon}>
                <Icon name={r.icon} size={24} filled={current} />
              </span>
              <span className={styles.tabLabel}>{r.label}</span>
            </a>
          );
        })}
      </nav>
    </div>
  );
}
