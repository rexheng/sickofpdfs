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
  itemsOf,
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
// S18 (R92): tags on rows and cards, several readings at once, Group by, a tag's own list, and About this PDF.
import { AboutPanel } from '../about/AboutPanel';
import { groupEntries, groupOfKey, useGrouping, useGroups } from '../tags/grouping';
import { GroupByMenu } from '../tags/GroupByMenu';
import { RowTags } from '../tags/RowTags';
import { sayWith } from '../tags/say';
import { SelectionBar } from '../tags/SelectionBar';
import { TagDialog } from '../tags/TagDialog';
import { TagTitle } from '../tags/TagTitle';
import { useReadingTags, useTagList, useTagReadings } from '../tags/use-tags';

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
  /** My library: the Group by choice (R92 smart sorting). */
  groupable?: boolean;
  /** My library narrowed to the readings with this tag (the left column's Tags, a click on a chip). */
  tagFilter?: string | null;
}

/**
 * Room for the list's columns: below these widths (px) the Authors and then the Pages columns step aside. S18: Authors
 * goes a little sooner, so the titles keep room when the details panel takes the right side of the window. TB5: sooner
 * again, so a laptop window (1280 px) shows the whole title and a tag rather than "Demaine et al.".
 */
const AUTHORS_MIN = 1000;
const PAGES_MIN = 720;

const keyOf = (item: LibraryItem) => item.doc.id;

export function ReadingsView({ title, view, defaultSort, sortable, groupByDate = false, chips, empty, note, groupable = false, tagFilter = null }: ReadingsViewProps) {
  const { data, notify } = useLibrary();
  const tags = data.tags ?? null;
  const say = useMemo(() => sayWith(notify), [notify]);
  const groupingState = useGrouping();
  const grouping = groupable && tags !== null ? groupingState.grouping : 'none';
  const tagList = useTagList(tags);
  const tagReadings = useTagReadings(tags, tagFilter);
  const narrowed = tagFilter !== null;
  const [layout, setLayout] = useLayoutPreference();
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const trash = view === 'trash';
  // The date ranges are worked out once per choice, so "Last 7 days" does not ask again on every render.
  const filter = useMemo(() => toQueryFilter(filters), [filters]);
  const readings = useReadings(data, { view, sort, filter });
  const state = readings.state;

  // Search is the Ctrl+K palette (TB5: one search box, over the bar at the top).
  const shown = useMemo(() => (state.kind === 'ready' ? state.items.filter((i) => !narrowed || tagReadings?.has(i.doc.id) === true) : []), [state, narrowed, tagReadings]);

  // While grouping or showing one tag, the rest of the library is fetched too, so every reading is seen.
  const { loadMore } = readings;
  const needAll = grouping !== 'none' || narrowed;
  useEffect(() => {
    if (needAll && state.kind === 'ready' && state.nextCursor !== null) loadMore();
  }, [needAll, state, loadMore]);

  const groups = useGroups(tags, grouping, state);
  const entries = useMemo<CollectionEntry<LibraryItem>[]>(() => {
    if (grouping !== 'none') return groups === null ? [] : groupEntries(groups, new Map(shown.map((i) => [i.doc.id, i])), groupingState.collapsed);
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
  }, [shown, groupByDate, grouping, groups, groupingState.collapsed]);
  const lines = useMemo(() => itemsOf(entries), [entries]);
  const keys = useMemo(() => lines.map((l) => l.key), [lines]);
  const selection = useCollectionSelection(keys);
  const shownIds = useMemo(() => shown.map((i) => i.doc.id), [shown]);
  const readingTags = useReadingTags(tags, shownIds);
  /** The selected readings, each once (a reading can be in two groups). */
  const selectedItems = useMemo(() => {
    const byKey = new Map(lines.map((l) => [l.key, l.item]));
    const seen = new Set<string>();
    return selection.keys.flatMap((k) => {
      const item = byKey.get(k);
      if (item === undefined || seen.has(item.doc.id)) return [];
      seen.add(item.doc.id);
      return [item];
    });
  }, [lines, selection.keys]);
  const primary = useMemo(() => lines.find((l) => l.key === selection.selected)?.item ?? null, [lines, selection.selected]);

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
      void openReading(item, data.savedPdf).then((ok) => !ok && notify({ text: 'This PDF has no saved link or copy to open it from.' }), failed);
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
  const [tagTarget, setTagTarget] = useState<{ ids: LibraryItem['doc']['id'][]; title: string } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** "Tags…" for a reading: for every selected reading when it is one of several selected. */
  const tagsFor = (item: LibraryItem) => {
    const many = selectedItems.length > 1 && selectedItems.some((i) => i.doc.id === item.doc.id) ? selectedItems : [item];
    setTagTarget({ ids: many.map((i) => i.doc.id), title: readingTitle(item) });
  };
  const trashMany = (items: readonly LibraryItem[]) => {
    const ids = items.map((i) => i.doc.id);
    void Promise.all(ids.map((id) => data.trashDocument(id))).then(
      () => {
        selection.select(null);
        notify({ text: ids.length === 1 ? 'Moved to Trash' : `Moved ${ids.length} readings to Trash`, action: { label: 'Undo', onClick: () => void Promise.all(ids.map((id) => data.restoreDocument(id))).catch(failed) } });
      },
      failed,
    );
  };
  const menuItems = (item: LibraryItem) =>
    readingMenu(item, {
      open: () => open(item),
      star: (on) => star(item, on),
      rename: () => setRenaming(item),
      copyLink: () => copyLink(item),
      trash: () => moveToTrash(item),
      restore: () => restore(item),
      ...(tags !== null ? { tags: () => tagsFor(item) } : {}),
      ...(data.about !== undefined ? { about: () => setAboutOpen(true) } : {}),
    });

  /** A right-click opens the menu at the pointer; the ⋮ button and the keyboard open it under the button, leftwards. */
  const openMenu = (item: LibraryItem, at: { x: number; y: number }, from: 'pointer' | 'keyboard') => setMenu({ item, at, align: from === 'pointer' ? 'start' : 'end' });
  const root = useRef<HTMLDivElement>(null);
  /** The ⋮ button of a row or card: the menu opens under it. (A grouped reading can be on two lines: the one clicked counts.) */
  const openMenuFromButton = (item: LibraryItem) => {
    const pressed = document.activeElement;
    const button = pressed instanceof HTMLElement && pressed.hasAttribute('data-more') ? pressed : root.current?.querySelector(`[data-key="${CSS.escape(keyOf(item))}"] [data-more]`);
    const key = button?.closest('[data-key]')?.getAttribute('data-key') ?? keyOf(item);
    const r = button?.getBoundingClientRect();
    if (!selection.isSelected(key)) selection.select(key);
    if (r !== undefined) openMenu(item, { x: r.right, y: r.bottom }, 'keyboard');
  };
  const onKey = (e: KeyboardEvent<HTMLElement>, item: LibraryItem): boolean => {
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (e.key === 'Delete' && !trash) {
      if (selectedItems.length > 1 && selectedItems.some((i) => i.doc.id === item.doc.id)) trashMany(selectedItems);
      else moveToTrash(item);
    } else if (e.key === 'Escape') selection.select(null);
    else if (plain && e.key.toLowerCase() === 'i' && !trash && data.about !== undefined) setAboutOpen((o) => !o);
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
  /**
   * The tag a line need not show, because the page or the heading above it says it already: the tag's own page, or the
   * course, topic or tag group the line is in (TB5: no "Course: 14.01" on every row under "Course: 14.01").
   */
  const saidAbove = (key: string): string | null => (grouping !== 'none' ? groupOfKey(key) : null) ?? tagFilter;
  const columns: TableColumn<LibraryItem>[] = [
    {
      id: 'name',
      label: SORT_LABELS.title,
      primary: true,
      sortKey: 'title',
      render: (i, key) => (
        <>
          <FileTypeIcon kind="pdf" size={24} />
          <CellText title={readingTitle(i)}>{readingTitle(i)}</CellText>
          <Badges item={i} />
          {tags !== null && (
            <RowTags documentId={i.doc.id} list={readingTags.get(i.doc.id) ?? []} tags={tags} say={say} max={1} tabbable={false} except={saidAbove(key)} onMore={() => tagsFor(i)} />
          )}
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

  const titleEnd = !nothingAtAll && (
    <>
      {groupable && tags !== null && !narrowed && <GroupByMenu value={grouping} onChange={groupingState.setGrouping} />}
      <SegmentedToggle
        label="Layout"
        value={layout}
        onChange={setLayout}
        options={[
          { value: 'list', icon: 'menu', label: 'List layout' },
          { value: 'grid', icon: 'grid_view', label: 'Grid layout' },
        ]}
      />
      {!trash && data.about !== undefined && <IconButton icon="info" label={aboutOpen ? 'Hide details' : 'View details'} size={40} pressed={aboutOpen} shortcut="I" onClick={() => setAboutOpen((o) => !o)} />}
    </>
  );
  const many = selectedItems.length > 1;
  const header = (
    <>
      {narrowed ? <TagTitle tag={tagList?.find((t) => t.id === tagFilter) ?? null} all={tagList} end={titleEnd} /> : <PageTitle title={title} end={titleEnd} />}
      {!nothingAtAll && note}
      {many && !trash ? (
        <SelectionBar
          count={selectedItems.length}
          onClear={() => selection.select(null)}
          onTags={tags === null ? undefined : () => setTagTarget({ ids: selectedItems.map((i) => i.doc.id), title: '' })}
          onStar={() => void Promise.all(selectedItems.map((i) => data.setStarred(i.doc.id, true))).then(() => notify({ text: `Starred ${selectedItems.length} readings` }), failed)}
          onTrash={() => trashMany(selectedItems)}
        />
      ) : (
        chips.length > 0 && !nothingAtAll && <FilterChips chips={chips} value={filters} onChange={setFilters} />
      )}
    </>
  );

  let body: ReactNode;
  if (state.kind === 'loading' || (narrowed && tagReadings === null) || (grouping !== 'none' && groups === null)) body = null;
  else if (state.kind === 'error') {
    body = (
      <EmptyState icon="error" title="Couldn’t show your library" actions={<TextButton label="Try again" variant="tonal" onClick={readings.retry} />}>
        <p>Your readings and notes are safe. Something went wrong while loading them.</p>
      </EmptyState>
    );
  } else if (nothingAtAll) body = empty;
  else if (shown.length === 0 && narrowed && !filtered) {
    body = (
      <EmptyState icon="sell" title="No readings have this tag" actions={<TextButton label="Show all readings" variant="tonal" onClick={() => (location.hash = '#/library')} />}>
        <p>Give a reading this tag from its menu: Tags.</p>
      </EmptyState>
    );
  } else if (shown.length === 0) {
    body = (
      <EmptyState icon="search_off" title="No readings match these filters" actions={<TextButton label="Clear filters" variant="tonal" onClick={() => setFilters(NO_FILTERS)} />} />
    );
  } else {
    const footer = <LoadMore active={state.nextCursor !== null} onVisible={readings.loadMore} />;
    // Grouped, the order inside each group is fixed: the most recently opened first (R92).
    const sorting = sortable && grouping === 'none';
    // Cards keep the same height: a line for tags on every card once any shown reading has one.
    const cardTags = tags !== null && shown.some((i) => (readingTags.get(i.doc.id)?.length ?? 0) > 0);
    body =
      layout === 'list' ? (
        <ItemTable
          label={title}
          columns={columns}
          entries={entries}
          selection={selection}
          sort={sorting ? { key: sort.by, dir: sort.dir } : null}
          onSort={sorting ? (key) => setSort(nextSort(sort, key as Sort['by'])) : undefined}
          headerEnd={sorting ? <SortMenu sort={sort} onSort={setSort} /> : undefined}
          renderActions={(item, { active }) => rowActions(item, active)}
          onOpen={open}
          onMenu={openMenu}
          onRowKey={onKey}
          footer={footer}
          {...(grouping !== 'none' ? { onToggleSection: groupingState.toggle } : {})}
        />
      ) : (
        <>
          {sorting && (
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
            renderCard={(item, { active, key }) => ({
              icon: <FileTypeIcon kind="pdf" size={24} />,
              title: readingTitle(item),
              badges: <Badges item={item} compact />,
              more: more(item, active),
              thumbnail: <CardThumbnail id={item.doc.id} stored={item.doc.blobStored} />,
              ...(cardTags
                ? { footer: tags !== null && <RowTags documentId={item.doc.id} list={readingTags.get(item.doc.id) ?? []} tags={tags} say={say} max={1} tabbable={false} except={saidAbove(key)} onMore={() => tagsFor(item)} /> }
                : {}),
            })}
            onOpen={open}
            onMenu={openMenu}
            onCardKey={onKey}
            footer={footer}
            {...(grouping !== 'none' ? { onToggleSection: groupingState.toggle } : {})}
          />
        </>
      );
  }

  return (
    <div ref={root} className={styles.view}>
      <ContentCard header={header}>{body}</ContentCard>
      {aboutOpen && !trash && <AboutPanel documentId={primary?.doc.id ?? null} onClose={() => setAboutOpen(false)} />}
      {tags !== null && <TagDialog tags={tags} target={tagTarget} onClose={() => setTagTarget(null)} say={say} />}
      <PointMenu at={menu?.at ?? null} align={menu?.align} items={menu === null ? [] : menuItems(menu.item)} onClose={() => setMenu(null)} label="Reading actions" />
      <RenameDialog
        title={renaming === null ? null : (renaming.doc.title ?? readingTitle(renaming))}
        onClose={() => setRenaming(null)}
        onSave={(t) => {
          const item = renaming;
          setRenaming(null);
          if (item !== null) void setTitle(item.doc.id, t).catch(failed);
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
