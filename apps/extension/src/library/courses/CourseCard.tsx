// One course on the Courses page (plan 8.5b), as Drive draws a file card grown into a list (02 sections 4.7 and 4.8): the
// tonal card; a header strip with the course's icon, its name, its codes and how many readings, and ⋮ (Rename, Merge); the
// readings in a white box, the title first and the authors under it; then the course's newest notes. A reading's ⋮ moves it
// to another course or takes it out of this one.
import { FileTypeIcon, Icon, IconButton, type MenuItemDef, TextButton } from '@sop/ui';
import { PointMenu } from '@sop/ui/library';
import { useId, useState } from 'react';
import type { NoteItem } from '../data/pages-data';
import type { LibraryItem } from '../data/types';
import { formatDate, readingTitle } from '../components/format';
import { whereLabel } from '../pages/Notes/NoteCard';
import { cx, readingsCount } from '../tags/tag-format';
import styles from './CourseCard.module.css';
import type { CourseCardData } from './use-courses';

/** How many readings a card lists before "Show all". */
const FIRST_READINGS = 4;

const KIND_WORD: Record<LibraryItem['doc']['kind'], string> = { paper: 'Paper', book: 'Book', slides: 'Slides', other: 'PDF' };

/** The line under a reading's title: its authors, or what it is when they are not known ("Slides · 54 pages"). */
export function secondLine(item: LibraryItem): string {
  const names = item.doc.authors.map((a) => a.trim()).filter(Boolean);
  if (names.length > 0) return names.join(', ');
  const pages = item.doc.pageCount === 1 ? '1 page' : `${item.doc.pageCount} pages`;
  return `${KIND_WORD[item.doc.kind]} · ${pages}`;
}

/** "CS231n · 3 readings", "14.01, 6.006 · 5 readings", "2 readings" (a course made by hand has no code). */
export function courseLine(codes: readonly string[], count: number): string {
  return codes.length === 0 ? readingsCount(count) : `${codes.join(', ')} · ${readingsCount(count)}`;
}

/** A note's words as one plain line: links read as their text, no Markdown marks. */
function plain(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*_`#>~]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Where a ⋮ menu opens: under the button that was pressed. */
function underButton(): { x: number; y: number } | null {
  const r = document.activeElement?.getBoundingClientRect();
  return r === undefined ? null : { x: r.right, y: r.bottom };
}

export interface ReadingRowProps {
  item: LibraryItem;
  /** The reading's menu: what moving it means here. */
  menu: MenuItemDef[];
  onOpen(this: void): void;
  /** The white box of a course card, or the page's own list. */
  tone?: 'card' | 'page';
}

/** One reading: the PDF icon, the title, the authors under it, and ⋮ at the right (shown on hover and focus). */
export function ReadingRow({ item, menu, onOpen, tone = 'card' }: ReadingRowProps) {
  const [at, setAt] = useState<{ x: number; y: number; align: 'start' | 'end' } | null>(null);
  const title = readingTitle(item);
  return (
    <li
      className={cx(styles.row, tone === 'page' && styles.pageRow, at !== null && styles.rowMenuOpen)}
      onContextMenu={(e) => {
        e.preventDefault();
        setAt({ x: e.clientX, y: e.clientY, align: 'start' });
      }}
    >
      <button type="button" className={styles.rowOpen} title={`Open ${title}`} onClick={onOpen}>
        <FileTypeIcon kind="pdf" size={24} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{title}</span>
          <span className={styles.rowSecond}>{secondLine(item)}</span>
        </span>
      </button>
      <IconButton
        icon="more_vert"
        size={32}
        iconSize={20}
        label={`More actions for ${title}`}
        className={styles.rowMore}
        aria-haspopup="menu"
        onClick={() => {
          const p = underButton();
          if (p !== null) setAt({ ...p, align: 'end' });
        }}
      />
      <PointMenu at={at} align={at?.align} label={`Actions for ${title}`} items={menu} onClose={() => setAt(null)} />
    </li>
  );
}

export interface CourseCardProps {
  card: CourseCardData;
  now: number;
  /** False when there is no other course to merge with. */
  canMerge: boolean;
  onOpen(this: void, item: LibraryItem): void;
  onOpenNote(this: void, note: NoteItem): void;
  onRename(this: void): void;
  onMerge(this: void): void;
  onMove(this: void, item: LibraryItem): void;
  onTakeOut(this: void, item: LibraryItem): void;
}

export function CourseCard({ card, now, canMerge, onOpen, onOpenNote, onRename, onMerge, onMove, onTakeOut }: CourseCardProps) {
  const { course, readings, notes } = card;
  const [all, setAll] = useState(false);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; align: 'start' | 'end' } | null>(null);
  const titleId = useId();
  const shown = all ? readings : readings.slice(0, FIRST_READINGS);
  const courseMenu: MenuItemDef[] = [
    { kind: 'item', id: 'rename', label: 'Rename', icon: 'edit', onSelect: onRename },
    { kind: 'item', id: 'merge', label: 'Merge with another course…', icon: 'call_merge', onSelect: onMerge, disabled: !canMerge, ...(canMerge ? {} : { disabledReason: 'there is no other course yet' }) },
  ];
  const readingMenu = (item: LibraryItem): MenuItemDef[] => [
    { kind: 'item', id: 'open', label: 'Open', icon: 'open_in_new', onSelect: () => onOpen(item) },
    { kind: 'separator' },
    { kind: 'item', id: 'move', label: 'Move to another course…', icon: 'drive_file_move', onSelect: () => onMove(item) },
    { kind: 'item', id: 'out', label: 'Take out of this course', icon: 'do_not_disturb_on', onSelect: () => onTakeOut(item) },
  ];

  return (
    <article className={styles.card} aria-labelledby={titleId}>
      <header
        className={styles.head}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuAt({ x: e.clientX, y: e.clientY, align: 'start' });
        }}
      >
        <span className={styles.badge} aria-hidden="true">
          <Icon name="school" size={20} />
        </span>
        <div className={styles.names}>
          <h2 id={titleId} className={styles.name} title={course.name}>
            {course.name}
          </h2>
          <p className={styles.meta}>{courseLine(course.codes, readings.length)}</p>
        </div>
        <IconButton
          icon="more_vert"
          label={`Course actions for ${course.name}`}
          aria-haspopup="menu"
          onClick={() => {
            const p = underButton();
            if (p !== null) setMenuAt({ ...p, align: 'end' });
          }}
        />
        <PointMenu at={menuAt} align={menuAt?.align} label={`Course actions for ${course.name}`} items={courseMenu} onClose={() => setMenuAt(null)} />
      </header>

      <ul className={styles.list} aria-label={`Readings in ${course.name}`}>
        {shown.map((item) => (
          <ReadingRow key={item.doc.id} item={item} menu={readingMenu(item)} onOpen={() => onOpen(item)} />
        ))}
      </ul>
      {readings.length > FIRST_READINGS && (
        <div className={styles.more}>
          <TextButton label={all ? 'Show fewer' : `Show all ${readings.length} readings`} onClick={() => setAll((v) => !v)} />
        </div>
      )}

      {notes.length > 0 && (
        <section className={styles.notes} aria-label={`Newest notes in ${course.name}`}>
          <h3 className={styles.notesTitle}>Newest notes</h3>
          <ul className={styles.noteList}>
            {notes.map((n) => {
              const first = n.comments[0];
              const when = Math.max(0, ...n.comments.map((c) => c.createdAt));
              return (
                <li key={n.thread.id}>
                  <button type="button" className={styles.note} title={`Open this note in ${n.title}`} onClick={() => onOpenNote(n)}>
                    <Icon name="comment" size={20} className={styles.noteIcon} />
                    <span className={styles.noteText}>
                      <span className={styles.noteBody}>{first === undefined ? '' : plain(first.body)}</span>
                      <span className={styles.noteWhere}>
                        <span className={styles.noteReading}>{n.title}</span>
                        <span className={styles.noteTail}>
                          {' · '}
                          {whereLabel(n.thread.anchor, n.thread.pageIndex, n.shownPage)} · {formatDate(when, now)}
                        </span>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </article>
  );
}
