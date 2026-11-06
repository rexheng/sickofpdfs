// Home (plan S14; spec "Home | Drive Home | 'Welcome' title, collapsible Continue reading and Recent notes sections").
// Drive's Home in its top-left form (02 section 4.8): the greeting as the page title, then sections that fold away under a
// chevron, each with "View all". Continue reading shows the readings opened last as cards, with where you stopped; Recent
// notes the newest notes. Notes that could not go back on their PDF (R77) are pointed out at the top.
import { Icon, TextButton } from '@sop/ui';
import { ContentCard, EmptyState, PageTitle } from '@sop/ui/library';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useLibrary } from '../../app/context';
import { openReading } from '../../components/reading-actions';
import { ViewNote } from '../../components/ReadingsView';
import { routeHref } from '../../routes/routes';
import { NoteCard } from '../Notes/NoteCard';
import { openNoteReading } from '../Notes/open-note';
import { useRecoveredNotes } from '../Notes/RecoveredNotes';
import { useNotes } from '../Notes/use-notes';
import styles from './Home.module.css';
import { ResumeCard } from './ResumeCard';
import { useUpdatedNote } from './updated-note';
import { useContinueReading } from './use-continue';

/** How many readings Continue reading asks for; it shows one row of what fits, so Recent notes stays in view. */
const CONTINUE_ASK = 12;
const CONTINUE_ROWS = 1;
/** How many notes Recent notes asks for; it shows two rows of what fits. */
const RECENT_NOTES = 6;
const NOTES_ROWS = 2;

type Fold = 'continue' | 'notes';
const FOLDED_KEY = 'library.home.folded';

/** Which sections the owner folded away, remembered in this browser. */
function useFolded(): [ReadonlySet<Fold>, (f: Fold) => void] {
  const [folded, setFolded] = useState<ReadonlySet<Fold>>(() => {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]');
      return new Set(Array.isArray(v) ? v.filter((x): x is Fold => x === 'continue' || x === 'notes') : []);
    } catch {
      return new Set();
    }
  });
  const toggle = (f: Fold) =>
    setFolded((now) => {
      const next = new Set(now);
      if (!next.delete(f)) next.add(f);
      try {
        localStorage.setItem(FOLDED_KEY, JSON.stringify([...next]));
      } catch {
        // blocked storage: the choice lasts until the page closes
      }
      return next;
    });
  return [folded, toggle];
}

/** How many cards fit in a row of a grid whose cards are at least `minToken` wide (Drive's grid: 200 px, 16 px apart). */
function useColumns(minToken: string, fallback: number): [(el: HTMLElement | null) => void, number] {
  const [columns, setColumns] = useState(4);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    if (el === null) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const min = parseFloat(style.getPropertyValue(minToken)) || fallback;
      const gap = parseFloat(style.columnGap) || 16;
      setColumns(Math.max(1, Math.floor((el.clientWidth + gap) / (min + gap))));
    };
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
    measure();
  }, [minToken, fallback]);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, columns];
}

export function HomePage() {
  const library = useLibrary();
  const { data, notify, pickFile } = library;
  const [folded, toggle] = useFolded();
  const continuing = useContinueReading(data, CONTINUE_ASK);
  const notes = useNotes(data, {}, RECENT_NOTES);
  const [recovered] = useRecoveredNotes();
  const [gridRef, columns] = useColumns('--sop-grid-card-min', 200);
  const [notesRef, noteColumns] = useColumns('--sop-notes-panel-w', 320);
  const now = Date.now();

  const state = continuing.state;
  const [updated, dismissUpdated] = useUpdatedNote(state.kind === 'ready' ? state.total > 0 : null);
  const empty = state.kind === 'ready' && state.total === 0 && notes.state.kind === 'ready' && notes.state.items.length === 0;

  const open = (entry: { item: Parameters<typeof openReading>[0] }) =>
    void openReading(entry.item, data.savedPdf).then(
      (ok) => !ok && notify({ text: 'This PDF has no saved link or copy to open it from.' }),
      () => notify({ text: 'That didn’t work. Try again.' }),
    );

  let continueBody: ReactNode = null;
  if (state.kind === 'error') {
    continueBody = (
      <p className={styles.quiet}>
        Couldn’t show your readings. <TextButton label="Try again" onClick={continuing.retry} />
      </p>
    );
  } else if (state.kind === 'ready' && state.items.length === 0) {
    continueBody = <p className={styles.quiet}>The PDFs you read show up here, so you can carry on where you stopped.</p>;
  } else if (state.kind === 'ready') {
    continueBody = (
      <ul ref={gridRef} className={styles.cards}>
        {state.items.slice(0, columns * CONTINUE_ROWS).map((entry) => (
          <li key={entry.item.doc.id} className={styles.cardSlot}>
            <ResumeCard entry={entry} now={now} onOpen={() => open(entry)} />
          </li>
        ))}
      </ul>
    );
  }

  let notesBody: ReactNode = null;
  if (notes.state.kind === 'error') {
    notesBody = (
      <p className={styles.quiet}>
        Couldn’t show your notes. <TextButton label="Try again" onClick={notes.retry} />
      </p>
    );
  } else if (notes.state.kind === 'ready' && notes.state.items.length === 0) {
    notesBody = <p className={styles.quiet}>Notes you write on your PDFs show up here, newest first.</p>;
  } else if (notes.state.kind === 'ready') {
    notesBody = (
      <div ref={notesRef} className={styles.notes}>
        {notes.state.items.slice(0, noteColumns * NOTES_ROWS).map((n) => (
          <NoteCard key={n.thread.id} note={n} now={now} compact onOpen={() => void openNoteReading(n.thread, library)} />
        ))}
      </div>
    );
  }

  return (
    <ContentCard header={<PageTitle title="Welcome to your library" />}>
      {updated !== null && (
        <ViewNote>
          {updated} <TextButton label="Got it" onClick={dismissUpdated} />
        </ViewNote>
      )}
      {recovered.length > 0 && (
        <ViewNote>
          {recovered.length === 1 ? '1 note' : `${recovered.length} notes`} couldn’t go back on {recovered.length === 1 ? 'its' : 'their'} PDF. {recovered.length === 1 ? 'It is' : 'They are'}{' '}
          kept for you under Recovered notes. <TextButton label="Show them" onClick={() => (location.hash = routeHref('notes'))} />
        </ViewNote>
      )}
      {empty ? (
        <EmptyState icon="auto_stories" title="Your learning PDFs will appear here" actions={<TextButton label="Open a PDF" variant="tonal" onClick={pickFile} />}>
          <p>Open a paper, lecture notes or a textbook in Chrome, and it is saved here by itself, with your notes.</p>
          <p>Receipts and private documents are never saved.</p>
        </EmptyState>
      ) : (
        <>
          <HomeSection id="continue" title="Continue reading" open={!folded.has('continue')} onToggle={() => toggle('continue')} viewAll={{ label: 'View all', name: 'View all recent readings', route: 'recent' }}>
            {continueBody}
          </HomeSection>
          <HomeSection id="notes" title="Recent notes" open={!folded.has('notes')} onToggle={() => toggle('notes')} viewAll={{ label: 'View all', name: 'View all notes', route: 'notes' }}>
            {notesBody}
          </HomeSection>
        </>
      )}
    </ContentCard>
  );
}

/** A Home section as Drive draws "Suggested files": a chevron and the title that fold it, and "View all" at the right. */
function HomeSection({
  id,
  title,
  open,
  onToggle,
  viewAll,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onToggle(this: void): void;
  viewAll: { label: string; name: string; route: 'recent' | 'notes' };
  children: ReactNode;
}) {
  return (
    <section className={styles.section} aria-labelledby={`home-${id}-title`}>
      <div className={styles.sectionHead}>
        <h2 id={`home-${id}-title`} className={styles.sectionTitle}>
          <button type="button" className={styles.fold} aria-expanded={open} aria-controls={`home-${id}-body`} onClick={onToggle}>
            <Icon name="keyboard_arrow_down" size={24} className={open ? styles.chevron : `${styles.chevron} ${styles.chevronFolded}`} />
            <span>{title}</span>
          </button>
        </h2>
        <TextButton label={viewAll.label} aria-label={viewAll.name} onClick={() => (location.hash = routeHref(viewAll.route))} />
      </div>
      <div id={`home-${id}-body`} hidden={!open} className={styles.sectionBody}>
        {children}
      </div>
    </section>
  );
}
