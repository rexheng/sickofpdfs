// The search palette in a viewer tab (Ctrl+K, S15). It searches the library whatever the tab is showing (a PDF that is still
// opening, or an error card, too), offers the viewer's commands as its last group, and shows a hit of the open document
// in place: a jump through the history, with no new tab. A hit of any other reading opens it in a new tab, from its saved
// copy. In Incognito there is no library: the palette says so and still finds commands.
import { Palette, type PaletteCommand, type PaletteCommandGroup, type PaletteStore, type PaletteTarget, openTargetInNewTab, palette, usePaletteState } from '../shared/palette';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { openLibrary } from '../background/open-library';
import { connectStore } from '../store/client';
import type { ViewerCommandId, ViewerCommands, ViewerUi } from './commands';
import { formatCombo } from './chrome/menus';
import { isIncognito } from './incognito';
import type { HitJumper } from './jump-to-hit';
import { libraryStore } from './use-store';

/** How long the viewer's own connection to the library is waited for before the palette makes one of its own. */
const OWN_STORE_AFTER_MS = 400;

let connecting: Promise<PaletteStore | null> | null = null;

/**
 * The library store for the palette. The viewer connects its own after the first page is drawn (use-store.ts); the palette
 * uses that one. While the PDF has not opened (or never does), it connects a store of its own, so Ctrl+K works at once.
 */
function paletteStore(): Promise<PaletteStore | null> {
  connecting ??= (async () => {
    if (isIncognito()) return null;
    const waited = await Promise.race([libraryStore(), new Promise<'later'>((resolve) => setTimeout(() => resolve('later'), OWN_STORE_AFTER_MS))]);
    const store = waited !== 'later' ? waited : await connectStore().catch(() => null);
    if (store === null) connecting = null; // a store that would not connect is tried again the next time
    return store;
  })();
  return connecting;
}

const INCOGNITO = 'Your library isn’t available in an Incognito window. Nothing is saved there.';
const UNAVAILABLE = 'Couldn’t open your library just now. Your readings and notes are safe.';

/** The commands shown first, while nothing is typed: the ones a reader reaches for most. */
const FIRST: ViewerCommandId[] = ['tools.find', 'tools.goToPage', 'notes.panel', 'view.fitWidth', 'view.zoomIn', 'view.zoomOut', 'file.print'];

/** The viewer's commands that can run now, as the palette's "Commands" group, with the library as the way out. */
function commandGroup(commands: ViewerCommands): PaletteCommandGroup {
  const list: PaletteCommand[] = [];
  const order = [...FIRST.flatMap((id) => commands.get(id) ?? []), ...[...commands.values()].filter((c) => !FIRST.includes(c.id))];
  for (const c of order) {
    if (!c.built || c.id === 'tools.search' || !c.enabled()) continue;
    list.push({
      id: c.id,
      label: c.label,
      ...(c.icon !== undefined ? { icon: c.icon } : {}),
      ...(c.keys[0] !== undefined ? { keys: formatCombo(c.keys[0]) } : {}),
      run: () => {
        if (c.enabled()) c.run();
      },
    });
  }
  list.push({ id: 'go.library', label: 'Open your library', icon: 'library_books', run: () => void openLibrary().catch(() => {}) });
  return { heading: 'Commands', commands: list };
}

export interface ViewerPaletteProps {
  commands: ViewerCommands;
  /** Shows hits in the open document; null while there is none. */
  jumper: HitJumper | null;
  ui: Pick<ViewerUi, 'showNote'>;
}

export function ViewerPalette(p: ViewerPaletteProps) {
  const { open, query, opened } = usePaletteState();
  if (!open) return null;
  return <Open key={opened} {...p} initialQuery={query} />;
}

function Open({ commands, jumper, ui, initialQuery }: ViewerPaletteProps & { initialQuery: string }) {
  const [store, setStore] = useState<PaletteStore | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void paletteStore().then((s) => {
      if (!live) return;
      if (s === null) setUnavailable(isIncognito() ? INCOGNITO : UNAVAILABLE);
      else setStore(s);
    });
    return () => {
      live = false;
    };
  }, []);
  const group = useMemo(() => commandGroup(commands), [commands]);
  const onOpen = useCallback(
    async (target: PaletteTarget): Promise<string | null> => {
      if (jumper !== null && jumper.documentId() === target.documentId) {
        // In this document: a jump in place. The palette closes first, so the focus is back on the pages when it lands.
        palette.close();
        if (!(await jumper.go(target))) ui.showNote(target.kind === 'note' ? 'Couldn’t find that note in this PDF.' : 'Couldn’t find that place in this PDF.');
        return null;
      }
      return store === null ? 'Your library isn’t available.' : openTargetInNewTab(target, store);
    },
    [jumper, store, ui],
  );
  return <Palette store={store} unavailable={unavailable} commands={group} initialQuery={initialQuery} onOpen={onOpen} onClose={() => palette.close()} />;
}
