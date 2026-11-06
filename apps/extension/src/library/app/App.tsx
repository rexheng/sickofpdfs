import '@sop/ui/tokens.css';
import '@sop/ui/base.css';
import { type IconName, registerFonts, TextButton } from '@sop/ui';
import { ContentCard, EmptyState, PageTitle, Snackbar, type SnackbarMessage } from '@sop/ui/library';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { forgetDraftJournal } from '../../viewer/annotations/draft-journal';
import { createThumbnailCache } from '../data/thumbnails';
import type { LibraryData } from '../data/types';
import { PAGES } from '../routes/pages';
import { ROUTES } from '../routes/routes';
import { LibraryPalette, useLibraryPaletteKey } from '../shell/LibraryPalette';
import { useRoute } from '../routes/use-route';
import type { NewMenuHandle } from '../shell/NewMenu';
import { Shell } from '../shell/Shell';
import { registerTagOperators } from '../tags/palette-operators';
import { LibraryContext, type LibraryContextValue } from './context';

/** How the library gets its data: the store (or, in test builds, the fake). null: this store cannot list the library. */
export type ConnectLibrary = () => Promise<LibraryData | null>;

type Start = { kind: 'starting' } | { kind: 'ready'; data: LibraryData } | { kind: 'failed' } | { kind: 'incognito' };

/** The library tab: the shell, the page the address names, and the snackbar. */
export function LibraryApp({ connect }: { connect: ConnectLibrary }) {
  const [start, setStart] = useState<Start>({ kind: 'starting' });
  const attempt = useCallback(() => {
    setStart({ kind: 'starting' });
    connect().then(
      (data) => setStart(data === null ? { kind: 'failed' } : { kind: 'ready', data }),
      () => setStart({ kind: 'failed' }),
    );
  }, [connect]);
  useEffect(() => {
    void registerFonts().catch(() => {}); // text falls back to the next font until the files load
    // An Incognito window only views PDFs (spec): it has no library of its own to show.
    if (chrome.extension.inIncognitoContext) setStart({ kind: 'incognito' });
    else attempt();
  }, [attempt]);
  return <Frame start={start} retry={attempt} />;
}

function Frame({ start, retry }: { start: Start; retry(this: void): void }) {
  const route = useRoute();
  const [message, setMessage] = useState<SnackbarMessage | null>(null);
  const nextId = useRef(1);
  const newMenu = useRef<NewMenuHandle>(null);
  const notify = useCallback((m: Omit<SnackbarMessage, 'id'>) => setMessage({ ...m, id: nextId.current++ }), []);
  const dismiss = useCallback(() => setMessage(null), []);
  const def = ROUTES.find((r) => r.id === route);
  useLibraryPaletteKey();

  useEffect(() => {
    document.title = `${def?.label ?? 'Library'} - sickofpdfs`;
  }, [def]);

  const data = start.kind === 'ready' ? start.data : null;
  useEffect(() => (data?.tags === undefined ? undefined : registerTagOperators(data.tags)), [data]); // S18: `tag:` and `course:` in Ctrl+K
  const thumbnails = useMemo(() => (data === null ? null : createThumbnailCache({ savedPdf: data.savedPdf, hasDocument: data.hasDocument })), [data]);
  useEffect(() => {
    if (data === null || thumbnails === null) return;
    void thumbnails.sweep().catch(() => {});
    return data.onChange((c) => {
      if (c.forgotten.length === 0) return;
      void thumbnails.forget(c.forgotten).catch(() => {});
      // R76: the store worker cannot reach this page's storage, so the drafts' crash-safe copies go from here
      for (const id of c.forgotten) forgetDraftJournal(id);
    });
  }, [data, thumbnails]);

  const context = useMemo<LibraryContextValue | null>(
    () => (data === null || thumbnails === null ? null : { data, thumbnails, notify, pickFile: () => newMenu.current?.pickFile() }),
    [data, thumbnails, notify],
  );

  let page;
  if (start.kind === 'incognito') {
    page = (
      <Notice title={def?.label ?? 'Library'} icon="lock" heading="Your library isn’t available in Incognito">
        <p>In an Incognito window sickofpdfs only shows PDFs. Nothing is saved. Open your library from a normal Chrome window.</p>
      </Notice>
    );
  } else if (start.kind === 'failed') {
    page = (
      <Notice title={def?.label ?? 'Library'} icon="error" heading="Couldn’t open your library" action={<TextButton label="Try again" variant="tonal" onClick={retry} />}>
        <p>Your readings and notes are safe. Something went wrong while opening them.</p>
      </Notice>
    );
  } else if (context === null) {
    page = <ContentCard>{null}</ContentCard>;
  } else {
    const Page = PAGES[route];
    page =
      Page !== undefined ? (
        <Page key={route} />
      ) : (
        <Notice title={def?.label ?? ''} icon={def?.icon ?? 'info'} heading={`${def?.label ?? 'This page'} isn’t ready yet`}>
          <p>It comes in a later test build.</p>
        </Notice>
      );
  }

  const shell = (
    <Shell route={route} onNotify={(text) => notify({ text })} newMenu={newMenu} onUpload={data?.savePickedPdf ?? null}>
      {page}
    </Shell>
  );
  return (
    <>
      {context === null ? shell : <LibraryContext.Provider value={context}>{shell}</LibraryContext.Provider>}
      <Snackbar message={message} onDismiss={dismiss} />
      <LibraryPalette store={data?.palette ?? null} unavailable={paletteUnavailable(start, data)} />
    </>
  );
}

/** Why Ctrl+K has nothing to search: null while the library is still opening, or when it is open and can search. */
function paletteUnavailable(start: Start, data: LibraryData | null): string | null {
  if (start.kind === 'incognito') return 'Your library isn’t available in an Incognito window. Nothing is saved there.';
  if (start.kind === 'failed') return 'Couldn’t open your library. Your readings and notes are safe.';
  if (data !== null && data.palette === undefined) return 'Search isn’t available in this sample library.';
  return null;
}

/** A page-sized message in the content card: the library cannot be shown, or the page is not built yet. */
function Notice({ title, icon, heading, action, children }: { title: string; icon: IconName; heading: string; action?: ReactNode; children: ReactNode }) {
  return (
    <ContentCard header={<PageTitle title={title} />}>
      <EmptyState icon={icon} title={heading} actions={action}>
        {children}
      </EmptyState>
    </ContentCard>
  );
}
