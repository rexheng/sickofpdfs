// The search palette in the library tab (Ctrl+K, S15). It finds readings, pages and notes, and takes you to the library's
// own pages. A hit opens its reading in a new tab, at the right place, from the saved copy. It opens over the search bar at
// the top, as that bar grown into its answers (TB5: one search box, Drive-style); a click or a letter typed in the bar
// opens it too.
import { useEffect, useMemo } from 'react';
import { Palette, type PaletteCommandGroup, type PaletteStore, type PaletteTarget, openTargetInNewTab, palette, usePaletteState } from '../../shared/palette';
import { installShortcuts } from '../../viewer/shortcuts';
import { ROUTES, routeHref } from '../routes/routes';
import { searchBarAnchor } from './Shell';

export interface LibraryPaletteProps {
  /** The library store; null while it opens, or when there is none. */
  store: PaletteStore | null;
  /** Why there is nothing to search (Incognito, or it could not be opened). */
  unavailable: string | null;
}

/** Ctrl+K opens the palette, or closes it. Call it once for the page. */
export function useLibraryPaletteKey(): void {
  useEffect(() => installShortcuts([{ id: 'palette', keys: ['Ctrl+K'], run: () => palette.toggle() }]), []);
}

/** The library's pages, as the palette's last group: "Open Trash" for the words "trash". */
const GO_TO: PaletteCommandGroup = {
  heading: 'Go to',
  commands: ROUTES.map((r) => ({
    id: `go.${r.id}`,
    label: `Open ${r.label}`,
    icon: r.icon,
    run: () => {
      location.hash = routeHref(r.id);
    },
  })),
};

export function LibraryPalette({ store, unavailable }: LibraryPaletteProps) {
  const { open, query, opened } = usePaletteState();
  if (!open) return null;
  return <Open key={opened} store={store} unavailable={unavailable} initialQuery={query} />;
}

function Open({ store, unavailable, initialQuery }: LibraryPaletteProps & { initialQuery: string }) {
  const onOpen = useMemo(
    () => async (target: PaletteTarget): Promise<string | null> => (store === null ? 'Your library isn’t open yet.' : openTargetInNewTab(target, store)),
    [store],
  );
  return <Palette store={store} unavailable={unavailable} commands={GO_TO} initialQuery={initialQuery} onOpen={onOpen} onClose={() => palette.close()} anchor={searchBarAnchor} />;
}
