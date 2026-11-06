// Notes (plan S14; spec "Every note and thread across all readings, newest first, searchable"). Docs' tabs choose which:
// All, Mine (threads the owner wrote in), Claude (threads Claude answered in) and Trash (notes deleted in the last 30 days,
// with Restore). The search pill at the top looks through the notes, the passages they are on and the readings' titles.
// "Export notes" saves every reading's notes as Markdown (S3's format), one file per reading, in a zip, as a download, and
// says so in a snackbar. Claude's formulas stay as `$…$`.
// R77's "Recovered notes" sit at the top of All and Mine whenever there are any.
import { dayOf } from '@sop/core';
import { TextButton } from '@sop/ui';
import { ContentCard, EmptyState, PageTitle, QuietButton } from '@sop/ui/library';
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../../app/context';
import type { NoteItem, NotesQuery } from '../../data/pages-data';
import { RECENT_GROUPS, recentGroup } from '../../components/format';
import { ViewNote } from '../../components/ReadingsView';
import { NoteCard } from './NoteCard';
import styles from './Notes.module.css';
import { openNoteReading } from './open-note';
import { RestoreLeftOut } from '../../settings/RestoreLeftOut';
import { RecoveredNotes } from './RecoveredNotes';
import { useNotes } from './use-notes';

type Tab = 'all' | 'mine' | 'claude' | 'trash';
const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'claude', label: 'Claude' },
  { id: 'trash', label: 'Trash' },
];
const QUERIES: Record<Tab, Omit<NotesQuery, 'limit' | 'cursor'>> = { all: {}, mine: { author: 'me' }, claude: { author: 'claude' }, trash: { trashed: true } };

/** The note's newest activity: its latest comment, or (in Trash) when it was deleted. */
const whenOf = (n: NoteItem): number => n.thread.deletedAt ?? Math.max(0, ...n.comments.map((c) => c.createdAt));

/** A formula in a reply from Claude, as the export keeps it: `$…$` or `$$…$$` with a TeX command, a sub- or superscript in it. */
const MATHS = /\$[^$\n]*[\\^_][^$\n]*\$/u;

/** Saves a file the way Chrome saves any download (into the downloads folder, or where Chrome asks). */
function downloadFile(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  // Chrome has taken the file by then; the address is let go so the zip is not kept in memory.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function NotesPage() {
  const library = useLibrary();
  const { data, notify } = library;
  const [tab, setTab] = useState<Tab>('all');
  const notes = useNotes(data, QUERIES[tab]);
  const state = notes.state;
  const [exporting, setExporting] = useState(false);
  const now = Date.now();

  // Search is the Ctrl+K palette (TB5: one search box), which finds notes by their words too.
  const shown = useMemo(() => (state.kind === 'ready' ? state.items : []), [state]);

  const groups = useMemo(() => {
    const out: { label: string; items: NoteItem[] }[] = [];
    for (const label of RECENT_GROUPS) {
      const items = shown.filter((n) => recentGroup(whenOf(n), now) === label);
      if (items.length > 0) out.push({ label, items });
    }
    return out;
  }, [shown, now]);

  const restore = (n: NoteItem) => {
    data.restoreNote(n.thread).then(
      () => notify({ text: `The note is back on ${n.title}` }),
      () => notify({ text: 'Couldn’t restore it. Try again.' }),
    );
  };

  // A download, as Chrome saves any file, then a snackbar that says what was saved and where (TB6, student 3: the save-file
  // picker gave no sign at all when it could not show).
  const exportNotes = async (): Promise<void> => {
    setExporting(true);
    try {
      const chunks: Uint8Array[] = [];
      const files = await data.exportNotes(new WritableStream<Uint8Array>({ write: (chunk) => void chunks.push(chunk) }));
      if (files === 0) {
        notify({ text: 'There are no notes to save yet.' });
        return;
      }
      const zip = new Blob(chunks as BlobPart[], { type: 'application/zip' });
      const name = `sickofpdfs-notes-${dayOf(Date.now())}.zip`;
      downloadFile(zip, name);
      // The zip stores its files as they are, so its text shows whether any note holds a formula.
      const maths = MATHS.test(await zip.text());
      const what = files === 1 ? 'the notes of 1 reading' : `the notes of ${files} readings`;
      notify({ text: `Saved ${what} in ${name}, in your downloads.${maths ? ' Formulas stay as $…$, the form papers use.' : ''}` });
    } catch {
      notify({ text: 'Couldn’t save the notes. Try again.' });
    } finally {
      setExporting(false);
    }
  };

  // ---- the tabs (the ARIA tabs pattern: Left and Right, Home and End move and choose) ----
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const i = (next + TABS.length) % TABS.length;
    const t = TABS[i];
    if (t === undefined) return;
    setTab(t.id);
    tabRefs.current[i]?.focus();
  };

  const header = (
    <>
      <PageTitle
        title="Notes"
        end={<QuietButton icon="download" label={exporting ? 'Saving…' : 'Export notes'} disabled={exporting} onClick={() => void exportNotes()} title="Save every reading’s notes as Markdown files, in one zip file" />}
      />
      <div role="tablist" aria-label="Which notes to show" className={styles.tabs} onKeyDown={onTabKey}>
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`notes-tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="notes-panel"
            tabIndex={t.id === tab ? 0 : -1}
            className={styles.tab}
            onClick={() => setTab(t.id)}
          >
            <span className={styles.tabLabel}>{t.label}</span>
          </button>
        ))}
      </div>
    </>
  );

  let list: ReactNode;
  if (state.kind === 'loading') list = null;
  else if (state.kind === 'error') {
    list = (
      <EmptyState icon="error" title="Couldn’t show your notes" actions={<TextButton label="Try again" variant="tonal" onClick={notes.retry} />}>
        <p>Your notes are safe. Something went wrong while loading them.</p>
      </EmptyState>
    );
  } else if (shown.length === 0) list = <Empty tab={tab} />;
  else {
    list = (
      <>
        {groups.map((g) => (
          <section key={g.label} className={styles.group} aria-labelledby={`notes-group-${g.label}`}>
            <h2 id={`notes-group-${g.label}`} className={styles.groupTitle}>
              {g.label}
            </h2>
            <div className={styles.list}>
              {g.items.map((n) => (
                <NoteCard
                  key={n.thread.id}
                  note={n}
                  now={now}
                  onOpen={() => void openNoteReading(n.thread, library)}
                  {...(tab === 'trash' ? { onRestore: () => restore(n) } : {})}
                />
              ))}
            </div>
          </section>
        ))}
        <LoadMore active={state.nextCursor !== null} onVisible={notes.loadMore} />
      </>
    );
  }

  return (
    <ContentCard header={header}>
      <div id="notes-panel" role="tabpanel" aria-labelledby={`notes-tab-${tab}`} className={styles.panel}>
        {(tab === 'all' || tab === 'mine') && <RestoreLeftOut />}
        {(tab === 'all' || tab === 'mine') && <RecoveredNotes now={now} />}
        {tab === 'trash' && <ViewNote>Notes in Trash are deleted for good after 30 days. Restore puts one back on its reading.</ViewNote>}
        {list}
      </div>
    </ContentCard>
  );
}

function Empty({ tab }: { tab: Tab }) {
  switch (tab) {
    case 'all':
      return (
        <EmptyState icon="comment" title="No notes yet">
          <p>Select some text in a PDF and add a comment, or add a note to a page. Your notes show up here, newest first.</p>
        </EmptyState>
      );
    case 'mine':
      return (
        <EmptyState icon="comment" title="No notes of yours yet">
          <p>Notes you write on your PDFs show up here, newest first.</p>
        </EmptyState>
      );
    case 'claude':
      return (
        <EmptyState icon="comment" title="No answers from Claude yet">
          <p>When you ask Claude about a passage, the note with its answer shows up here.</p>
        </EmptyState>
      );
    case 'trash':
      return (
        <EmptyState icon="delete" title="No deleted notes">
          <p>Notes you delete stay here for 30 days, so you can put them back.</p>
        </EmptyState>
      );
  }
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

