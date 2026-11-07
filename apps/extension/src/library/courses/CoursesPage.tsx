// Courses (spec "Courses": "groups by course code found in the link, folder or first page (such as EC1A1); rename or merge
// freely"; plan 8.5b). One card per course: its name and codes, how many readings, the readings (title first, then authors),
// and its newest notes. Rename a course, merge two, move a reading to another course or take it out. The owner's changes
// always win: finding a course code again never undoes them. Under the cards, the readings that are in no course, folded
// away, each with "Add to a course". Private readings (R102, D9) are never shown here.
import { Icon, TextButton } from '@sop/ui';
import { ContentCard, EmptyState, PageTitle } from '@sop/ui/library';
import { type ReactNode, useMemo, useState } from 'react';
import { useLibrary } from '../app/context';
import { readingTitle } from '../components/format';
import { openReading } from '../components/reading-actions';
import { ViewNote } from '../components/ReadingsView';
import type { NoteItem } from '../data/pages-data';
import type { LibraryItem } from '../data/types';
import { openNoteReading } from '../pages/Notes/open-note';
import { sayWith } from '../tags/say';
import { readingsCount } from '../tags/tag-format';
import type { CourseRowWrite } from './courses-data';
import { CourseCard, ReadingRow } from './CourseCard';
import { type MoveTarget, MoveDialog, RenameCourseDialog } from './CourseDialogs';
import styles from './CoursesPage.module.css';
import { mergeRows, moveRows, newCourseRows, renameRows, takeOutRows, undoRows } from './group';
import { MergeDialog } from './MergeDialog';
import { type CourseCardData, useCourses } from './use-courses';

const FAILED = 'That didn’t work. Try again.';
const LOOSE_KEY = 'library.courses.looseOpen';

function readLooseOpen(): boolean {
  try {
    return localStorage.getItem(LOOSE_KEY) === '1';
  } catch {
    return false;
  }
}

/** How courses are found, in plain words: the empty state's text. */
function HowCoursesAreFound() {
  return (
    <>
      <p>sickofpdfs looks for course codes, such as CS50 or EC313. It finds them in a PDF’s title, its file name, its folder, and the page you opened it from.</p>
      <p>Readings with the same code go together here. Private PDFs are never put in a course.</p>
    </>
  );
}

export function CoursesPage() {
  const library = useLibrary();
  const { data, notify } = library;
  const say = sayWith(notify);
  const { state, save, retry } = useCourses(data);
  const [rename, setRename] = useState<CourseCardData | null>(null);
  const [merge, setMerge] = useState<CourseCardData | null>(null);
  const [move, setMove] = useState<{ item: LibraryItem; from: CourseCardData | null } | null>(null);
  const [looseOpen, setLooseOpen] = useState(readLooseOpen);
  const now = Date.now();
  const view = state.kind === 'ready' ? state.view : null;
  const cards = useMemo(() => view?.cards ?? [], [view]);

  /** Writes the change, says what happened, and offers Undo (the rows as they were). */
  const change = (rows: CourseRowWrite[], done: string) => {
    if (view === null) return;
    const undo = undoRows(rows, view.inputs);
    save(rows).then(
      () => say(done, () => void save(undo).catch(() => say(FAILED))),
      () => say(FAILED),
    );
  };

  const open = (item: LibraryItem) =>
    void openReading(item, data.savedPdf).then(
      (ok) => !ok && notify({ text: 'This PDF has no saved link or copy to open it from.' }),
      () => notify({ text: FAILED }),
    );
  const openNote = (n: NoteItem) => void openNoteReading(n.thread, library);

  const onRename = (name: string) => {
    if (view === null || rename === null) return;
    change(renameRows(rename.course, name, view.inputs.courses), `Renamed to “${name}”`);
    setRename(null);
  };
  const onMerge = (other: CourseCardData, name: string) => {
    if (view === null || merge === null) return;
    change(mergeRows(merge.course, other.course, name, view.inputs.courses), `Merged into one course, “${name}”`);
    setMerge(null);
  };
  const onMove = (to: MoveTarget) => {
    if (view === null || move === null) return;
    const id = move.item.doc.id;
    const title = readingTitle(move.item);
    if (to.kind === 'new') change(newCourseRows(id, to.name), `Made the course “${to.name}” with “${title}” in it`);
    else change(moveRows(id, to.card.course, view.inputs.courses), `Moved “${title}” to “${to.card.course.name}”`);
    setMove(null);
  };
  const onTakeOut = (item: LibraryItem, from: CourseCardData) => {
    if (view === null) return;
    const rows = takeOutRows(item.doc.id, from.course, view.groups, view.inputs.courses);
    change(rows, `Took “${readingTitle(item)}” out of “${from.course.name}”`);
  };
  const toggleLoose = () =>
    setLooseOpen((v) => {
      try {
        localStorage.setItem(LOOSE_KEY, v ? '0' : '1');
      } catch {
        // blocked storage: the choice lasts until the page closes
      }
      return !v;
    });

  let body: ReactNode = null;
  if (state.kind === 'error') {
    body = (
      <ViewNote>
        Couldn’t show your courses. <TextButton label="Try again" onClick={retry} />
      </ViewNote>
    );
  } else if (state.kind === 'none' || (view !== null && cards.length === 0)) {
    body = (
      <EmptyState icon="school" title="No courses found yet">
        <HowCoursesAreFound />
      </EmptyState>
    );
  } else if (view !== null) {
    body = (
      <>
        <p className={styles.lead}>Found from course codes in titles, file names, folders and the pages you opened PDFs from. Rename or merge them as you like.</p>
        <ul className={styles.grid} aria-label="Courses">
          {cards.map((card) => (
            <li key={card.course.key} className={styles.slot}>
              <CourseCard
                card={card}
                now={now}
                canMerge={cards.length > 1}
                onOpen={open}
                onOpenNote={openNote}
                onRename={() => setRename(card)}
                onMerge={() => setMerge(card)}
                onMove={(item) => setMove({ item, from: card })}
                onTakeOut={(item) => onTakeOut(item, card)}
              />
            </li>
          ))}
        </ul>
        {view.loose.length > 0 && (
          <section className={styles.loose} aria-labelledby="courses-loose-title">
            <h2 id="courses-loose-title" className={styles.looseTitle}>
              <button type="button" className={styles.fold} aria-expanded={looseOpen} aria-controls="courses-loose-body" onClick={toggleLoose}>
                <Icon name="keyboard_arrow_down" size={24} className={looseOpen ? styles.chevron : `${styles.chevron} ${styles.chevronFolded}`} />
                <span>Not in a course</span>
                <span className={styles.looseCount}>{readingsCount(view.loose.length)}</span>
              </button>
            </h2>
            <ul id="courses-loose-body" hidden={!looseOpen} className={styles.looseList} aria-label="Readings not in a course">
              {view.loose.map((item) => (
                <ReadingRow
                  key={item.doc.id}
                  item={item}
                  tone="page"
                  onOpen={() => open(item)}
                  menu={[
                    { kind: 'item', id: 'open', label: 'Open', icon: 'open_in_new', onSelect: () => open(item) },
                    { kind: 'separator' },
                    { kind: 'item', id: 'add', label: 'Add to a course…', icon: 'school', onSelect: () => setMove({ item, from: null }) },
                  ]}
                />
              ))}
            </ul>
          </section>
        )}
      </>
    );
  }

  return (
    <ContentCard header={<PageTitle title="Courses" />}>
      {body}
      <RenameCourseDialog course={rename} onRename={onRename} onClose={() => setRename(null)} />
      <MergeDialog from={merge} all={cards} onMerge={onMerge} onClose={() => setMerge(null)} />
      <MoveDialog move={move} all={cards} onMove={onMove} onClose={() => setMove(null)} />
    </ContentCard>
  );
}
