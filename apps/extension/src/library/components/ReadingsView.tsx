// The body of My library, Recent, Starred and Trash: the title row with the list/grid toggle, the filter chips, and
// the readings as Drive's list or grid, with the row menu, Rename, and the snackbar's Undo.
import { FileTypeIcon, IconButton, Icon, TextButton } from '@sop/ui';
import {
  CellText,
  type CollectionEntry,
  ContentCard,
  EmptyState,
  ItemGrid,
  ItemTable,
  PageTitle,
  PointMenu,
  RowActions,
  SegmentedToggle,
  type TableColumn,
  useCollectionSelection,
} from '@sop/ui/library';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../app/context';
import type { LibraryItem, LibraryQuery } from '../data/types';
import { useReadings } from '../data/use-readings';
import { CardThumbnail } from './CardThumbnail';
import { type ChipName, FilterChips } from './FilterChips';
import { type Filters, isFiltered, NO_FILTERS, toQueryFilter } from './filters';
import { formatAuthors, formatDate, formatDateLong, formatNotes, formatPages, RECENT_GROUPS, recentGroup, readingTitle } from './format';
import { copyText, openReading, readingLink, readingMenu } from './reading-actions';
import styles from './ReadingsView.module.css';
import { RenameDialog } from './RenameDialog';
import { nextSort, type Sort, SORT_LABELS } from './sort';
import { SortMenu } from './SortMenu';
import { useLayoutPreference } from './use-layout';

export interface ReadingsViewProps {
  /** The page title: "My library". */
  title: string;
  view: LibraryQuery['view'];
  /** The order the page opens with. */
  defaultSort: Sort;
  /** False: the order is fixed (Recent is always newest first). */
  sortable: boolean;
  /** Recent: headings by when each reading was last opened ("Today", "Earlier this week"). */
  groupByDate?: boolean;
  chips: readonly ChipName[];
  /** What the page shows when it has no readings at all. */
  empty: ReactNode;
  /** A line under the title (Trash: how long things stay). */
  note?: ReactNode;
}

/** Room for the list's columns: below these widths (px) the Authors and then the Pages columns step aside. */
const AUTHORS_MIN = 760;
const PAGES_MIN = 720;

const keyOf = (item: LibraryItem) => item.doc.id;

/** Search in the pill: every word must be in the title or the authors (accents and case ignored). */
function matches(item: LibraryItem, words: readonly string[]): boolean {
  const hay = fold(`${readingTitle(item)} ${item.doc.authors.join(' ')}`);
  return words.every((w) => hay.includes(w));
}
const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function ReadingsView({ title, view, defaultSort, sortable, groupByDate = false, chips, empty, note }: ReadingsViewProps) {
  const { data, notify, search } = useLibrary();
  const [layout, setLayout] = useLayoutPreference();
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const trash = view === 'trash';
  // The date ranges are worked out once per choice, so "Last 7 days" does not ask again on every render.
  const filter = useMemo(() => toQueryFilter(filters), [filters]);
  const readings = useReadings(data, { view, sort, filter });
  const state = readings.state;

  const words = useMemo(() => fold(search).split(/\s+/).filter(Boolean), [search]);
  const searching = words.length > 0;
  const shown = useMemo(() => (state.kind === 'ready' ? state.items.filter((i) => !searching || matches(i, words)) : []), [state, searching, words]);

  // While searching, the rest of the library is fetched too, so the filter sees every reading.
  const { loadMore } = readings;
  useEffect(() => {
    if (searching && state.kind === 'ready' && state.nextCursor !== null) loadMore();
  }, [searching, state, loadMore]);

  const entries = useMemo<CollectionEntry<LibraryItem>[]>(() => {
    if (!groupByDate) return shown.map((item) => ({ kind: 'item', key: keyOf(item), item }));
    const now = Date.now();
    const out: CollectionEntry<LibraryItem>[] = [];
    for (const group of RECENT_GROUPS) {
      const inGroup = shown.filter((i) => recentGroup(i.lastOpened, now) === group);
      if (inGroup.length === 0) continue;
      out.push({ kind: 'section', id: group, label: group });
      for (const item of inGroup) out.push({ kind: 'item', key: keyOf(item), item });
    }
    return out;
  }, [shown, groupByDate]);
  const keys = useMemo(() => shown.map(keyOf), [shown]);
  const selection = useCollectionSelection(keys);

  // ---- actions ----
  const [menu, setMenu] = useState<{ item: LibraryItem; at: { x: number; y: number }; align: 'start' | 'end' } | null>(null);
  const [renaming, setRenaming] = useState<LibraryItem | null>(null);
  const failed = useCallback(() => notify({ text: 'That didn’t work. Try again.' }), [notify]);

  const open = useCallback(
    (item: LibraryItem) => {
      if (item.doc.deletedAt !== null) {
        notify({ text: 'Restore this reading to open it.', action: { label: 'Restore', onClick: () => void data.restoreDocument(item.doc.id).catch(failed) } });
        return;
      }
      void openReading(item).then((ok) => !ok && notify({ text: 'This PDF has no saved link to open it from.' }), failed);
    },
    [data, notify, failed],
  );
  const star = useCallback((item: LibraryItem, on: boolean) => void data.setStarred(item.doc.id, on).catch(failed), [data, failed]);
  const moveToTrash = useCallback(
    (item: LibraryItem) => {
      data.trashDocument(item.doc.id).then(
        () => notify({ text: 'Moved to Trash', action: { label: 'Undo', onClick: () => void data.restoreDocument(item.doc.id).catch(failed) } }),
        failed,
      );
    },
    [data, notify, failed],
  );
  const restore = useCallback(
    (item: LibraryItem) => {
      data.restoreDocument(item.doc.id).then(
        () => notify({ text: 'Restored', action: { label: 'Undo', onClick: () => void data.trashDocument(item.doc.id).catch(failed) } }),
        failed,
      );
    },
    [data, notify, failed],
  );
  const copyLink = useCallback(
    (item: LibraryItem) => {
      const link = readingLink(item);
      if (link !== null) void copyText(link).then((ok) => notify({ text: ok ? 'Link copied' : 'Couldn’t copy the link. Try again.' }));
    },
    [notify],
  );
  const { setTitle } = data;
  const menuItems = (item: LibraryItem) =>
    readingMenu(item, {
      open: () => open(item),
      star: (on) => star(item, on),
      rename: setTitle === null ? null : () => setRenaming(item),
      copyLink: () => copyLink(item),
      trash: () => moveToTrash(item),
      restore: () => restore(item),
    });

  /** A right-click opens the menu at the pointer; the ⋮ button and the keyboard open it under the button, leftwards. */
  const openMenu = (item: LibraryItem, at: { x: number; y: number }, from: 'pointer' | 'keyboard') => setMenu({ item, at, align: from === 'pointer' ? 'start' : 'end' });
  const root = useRef<HTMLDivElement>(null);
  /** The ⋮ button of a row or card: the menu opens under it. */
  const openMenuFromButton = (item: LibraryItem) => {
    const button = root.current?.querySelector(`[data-key="${CSS.escape(keyOf(item))}"] [data-more]`);
    const r = button?.getBoundingClientRect();
    selection.select(keyOf(item));
    if (r !== undefined) openMenu(item, { x: r.right, y: r.bottom }, 'keyboard');
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, item: LibraryItem): boolean => {
    if (e.key === 'Delete' && !trash) moveToTrash(item);
    else if (e.key === 'Escape') selection.select(null);
    else return false;
    return true;
  };

  // ---- the parts ----
  const more = (item: LibraryItem, active: boolean) => (
    <IconButton
      icon="more_vert"
      label="More actions"
      size={40}
      iconSize={20}
      data-more=""
      aria-haspopup="menu"
      tabIndex={active ? 0 : -1}
      onClick={() => openMenuFromButton(item)}
    />
  );
  const rowActions = (item: LibraryItem, active: boolean) => (
    <>
      <RowActions>
        {trash ? (
          <IconButton icon="restore_from_trash" label="Restore" size={40} iconSize={20} tabIndex={-1} onClick={() => restore(item)} />
        ) : (
          <>
            <IconButton
              icon="star"
              label={item.doc.starred ? 'Remove from Starred' : 'Add to Starred'}
              pressed={item.doc.starred}
              size={40}
              iconSize={20}
              tabIndex={-1}
              onClick={() => star(item, !item.doc.starred)}
            />
            <IconButton icon="delete" label="Move to Trash" size={40} iconSize={20} tabIndex={-1} onClick={() => moveToTrash(item)} />
          </>
        )}
      </RowActions>
      {more(item, active)}
    </>
  );

  const dateColumn: TableColumn<LibraryItem> = trash
    ? {
        id: 'trashed',
        label: 'Date trashed',
        width: 'var(--sop-col-date)',
        render: (i) => <CellText title={formatDateLong(i.doc.deletedAt ?? 0)}>{formatDate(i.doc.deletedAt ?? 0)}</CellText>,
      }
    : sort.by === 'added'
      ? {
          id: 'added',
          label: SORT_LABELS.added,
          width: 'var(--sop-col-date)',
          sortKey: 'added',
          render: (i) => <CellText title={formatDateLong(i.doc.createdAt)}>{formatDate(i.doc.createdAt)}</CellText>,
        }
      : {
          id: 'lastOpened',
          label: SORT_LABELS.lastOpened,
          width: 'var(--sop-col-date)',
          sortKey: 'lastOpened',
          render: (i) => <CellText title={formatDateLong(i.lastOpened)}>{formatDate(i.lastOpened)}</CellText>,
        };
  const columns: TableColumn<LibraryItem>[] = [
    {
      id: 'name',
      label: SORT_LABELS.title,
      primary: true,
      sortKey: 'title',
      render: (i) => (
        <>
          <FileTypeIcon kind="pdf" size={24} />
          <CellText title={readingTitle(i)}>{readingTitle(i)}</CellText>
          <Badges item={i} />
        </>
      ),
    },
    { id: 'authors', label: 'Authors', width: 'var(--sop-col-authors)', minTableWidth: AUTHORS_MIN, render: (i) => <CellText title={i.doc.authors.join(', ')}>{formatAuthors(i.doc.authors)}</CellText> },
    dateColumn,
    { id: 'pages', label: 'Pages', width: 'var(--sop-col-pages)', minTableWidth: PAGES_MIN, sortKey: 'pages', render: (i) => <CellText title={formatPages(i.doc.pageCount)}>{i.doc.pageCount}</CellText> },
  ];

  const filtered = isFiltered(filters);
  const ready = state.kind === 'ready';
  const nothingAtAll = ready && state.total === 0 && !filtered;

  const header = (
    <>
      <PageTitle
        title={title}
        end={
          !nothingAtAll && (
            <SegmentedToggle
              label="Layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'list', icon: 'menu', label: 'List layout' },
                { value: 'grid', icon: 'grid_view', label: 'Grid layout' },
              ]}
            />
          )
        }
      />
      {!nothingAtAll && note}
      {chips.length > 0 && !nothingAtAll && <FilterChips chips={chips} value={filters} onChange={setFilters} />}
    </>
  );

  let body: ReactNode;
  if (state.kind === 'loading') body = null;
  else if (state.kind === 'error') {
    body = (
      <EmptyState icon="error" title="Couldn’t show your library" actions={<TextButton label="Try again" variant="tonal" onClick={readings.retry} />}>
        <p>Your readings and notes are safe. Something went wrong while loading them.</p>
      </EmptyState>
    );
  } else if (nothingAtAll) body = empty;
  else if (shown.length === 0 && searching) {
    body = (
      <EmptyState icon="search_off" title={`No readings match “${search.trim()}”`}>
        <p>The search looks at titles and authors.</p>
      </EmptyState>
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState icon="search_off" title="No readings match these filters" actions={<TextButton label="Clear filters" variant="tonal" onClick={() => setFilters(NO_FILTERS)} />} />
    );
  } else {
    const footer = <LoadMore active={state.nextCursor !== null} onVisible={readings.loadMore} />;
    body =
      layout === 'list' ? (
        <ItemTable
          label={title}
          columns={columns}
          entries={entries}
          selection={selection}
          sort={sortable ? { key: sort.by, dir: sort.dir } : null}
          onSort={sortable ? (key) => setSort(nextSort(sort, key as Sort['by'])) : undefined}
          headerEnd={sortable ? <SortMenu sort={sort} onSort={setSort} /> : undefined}
          renderActions={(item, { active }) => rowActions(item, active)}
          onOpen={open}
          onMenu={openMenu}
          onRowKey={onKey}
          footer={footer}
        />
      ) : (
        <>
          {sortable && (
            <div className={styles.gridHeader}>
              <button type="button" className={styles.gridSort} onClick={() => setSort(nextSort(sort, sort.by))} aria-label={`Sorted by ${SORT_LABELS[sort.by]}. Turn the order round`}>
                <span>{SORT_LABELS[sort.by]}</span>
                <span className={styles.sortChip}>
                  <Icon name={sort.dir === 'asc' ? 'arrow_upward' : 'arrow_downward'} size={20} />
                </span>
              </button>
              <SortMenu sort={sort} onSort={setSort} />
            </div>
          )}
          <ItemGrid
            label={title}
            entries={entries}
            selection={selection}
            renderCard={(item, { active }) => ({
              icon: <FileTypeIcon kind="pdf" size={24} />,
              title: readingTitle(item),
              badges: <Badges item={item} compact />,
              more: more(item, active),
              thumbnail: <CardThumbnail id={item.doc.id} stored={item.doc.blobStored} />,
            })}
            onOpen={open}
            onMenu={openMenu}
            onCardKey={onKey}
            footer={footer}
          />
        </>
      );
  }

  return (
    <div ref={root} className={styles.view}>
      <ContentCard header={header}>{body}</ContentCard>
      <PointMenu at={menu?.at ?? null} align={menu?.align} items={menu === null ? [] : menuItems(menu.item)} onClose={() => setMenu(null)} label="Reading actions" />
      <RenameDialog
        title={renaming === null ? null : (renaming.doc.title ?? readingTitle(renaming))}
        onClose={() => setRenaming(null)}
        onSave={(t) => {
          const item = renaming;
          setRenaming(null);
          if (item !== null && setTitle !== null) void setTitle(item.doc.id, t).catch(failed);
        }}
      />
    </div>
  );
}

/** After the name: a star when starred, and how many notes it has. */
function Badges({ item, compact = false }: { item: LibraryItem; compact?: boolean }) {
  const notes = item.noteCount;
  if (!item.doc.starred && (compact || notes === 0)) return null;
  return (
    <span className={styles.badges}>
      {item.doc.starred && (
        <span className={styles.badge} title="Starred" aria-label="Starred" role="img">
          <Icon name="star" size={20} filled />
        </span>
      )}
      {!compact && notes > 0 && (
        <span className={styles.notes} title={formatNotes(notes)} aria-label={formatNotes(notes)} role="img">
          <Icon name="comment" size={20} />
          <span aria-hidden="true">{notes}</span>
        </span>
      )}
    </span>
  );
}

/** At the end of the list: asks for the next page when it comes near the screen. */
function LoadMore({ active, onVisible }: { active: boolean; onVisible(this: void): void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!active || node === null) return;
    const observer = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && onVisible(), { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, onVisible]);
  return <div ref={el} className={styles.loadMore} aria-hidden="true" />;
}

/** A quiet line under the title, with an icon: Trash's "deleted for good after 30 days". */
export function ViewNote({ children }: { children: ReactNode }) {
  return (
    <p className={styles.note}>
      <Icon name="info" size={20} />
      <span>{children}</span>
    </p>
  );
}
