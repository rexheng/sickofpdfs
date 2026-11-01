// The notes panel (plan S15): every note of the PDF in one place, like Google Docs' comments sidebar (research 02
// section 4.11; drive-refs live-17 and live-18). It is a controlled component: NotesPanelMount owns the session, which
// note is active, and what each action does.
import type { CommentId, ThreadId } from '@sop/core';
import { Icon, IconButton, ThreadCard } from '@sop/ui';
import { type KeyboardEvent, type Ref, useId, useRef } from 'react';
import type { NoteEntry, NoteList, NotesFilter } from './model';
import styles from './NotesPanel.module.css';

export interface NotesPanelProps {
  notes: NoteList;
  /** How many notes the PDF has in all, whatever the tab shows (for the empty message). */
  total: number;
  filter: NotesFilter;
  onFilter(this: void, f: NotesFilter): void;
  active: ThreadId | null;
  /** A new note whose box takes the caret when it opens. */
  focusNote: ThreadId | null;
  onClose(this: void): void;
  onActivate(this: void, id: ThreadId): void;
  onDeactivate(this: void): void;
  onDraftChange(this: void, note: NoteEntry, body: string): void;
  onDraftSend(this: void, note: NoteEntry, body: string): void;
  onDraftEscape(this: void, note: NoteEntry, body: string): void;
  onDelete(this: void, id: CommentId): void;
  /** "Show where it was" on a moved note. */
  onShowOriginal(this: void, note: NoteEntry): void;
  /** Each card's element, for scrolling it into view and giving it the focus. */
  cardRef(this: void, id: ThreadId, el: HTMLElement | null): void;
  /** The panel, so the mount can put the focus in it when it opens. */
  panelRef?: Ref<HTMLElement>;
  /** The scrolling list of cards. */
  listRef?: Ref<HTMLDivElement>;
}

const TABS: { id: NotesFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
];

/**
 * Docs' sidebar on the viewer's dark canvas: 320 px wide with 16 px corners, a 56 px header ("Notes" and Close), the
 * All and Mine tabs, then the cards, 16 px apart. A card turns light when it is active and shows its replies and the
 * reply box. Notes whose text is not in this copy of the PDF are listed last, under "Couldn't place".
 */
export function NotesPanel(p: NotesPanelProps) {
  const titleId = useId();
  const tabsId = useId();
  const unplacedId = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const { placed, unplaced } = p.notes;
  const empty = placed.length === 0 && unplaced.length === 0;

  // Esc anywhere in the panel that nothing else used (an active card uses the first Esc) closes it.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    p.onClose();
  };

  // The tabs follow the ARIA tabs pattern: Left and Right (and Home, End) move between them and select.
  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>, at: number) => {
    const to = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = (to + TABS.length) % TABS.length;
    p.onFilter(TABS[next].id);
    tabs.current[next]?.focus();
  };

  // Under "Couldn't place" the heading says it once, so the cards there do not each repeat the label.
  const card = (note: NoteEntry) => (
    <li key={note.id} className={styles.item}>
      <ThreadCard
        ref={(el: HTMLElement | null) => p.cardRef(note.id, el)}
        id={`sop-panel-note-${note.id}`}
        comments={note.comments}
        draft={note.draft?.body ?? null}
        active={p.active === note.id}
        onActivate={() => p.onActivate(note.id)}
        onDeactivate={p.onDeactivate}
        onDraftChange={(body) => p.onDraftChange(note, body)}
        onDraftSend={(body) => p.onDraftSend(note, body)}
        onDraftEscape={(body) => p.onDraftEscape(note, body)}
        onDelete={p.onDelete}
        placement={note.placement === 'unplaced' ? 'placed' : note.placement}
        onShowOriginal={note.placement === 'moved' ? () => p.onShowOriginal(note) : undefined}
        label={note.label}
        quote={note.quote}
        autoFocus={p.focusNote === note.id}
      />
    </li>
  );

  return (
    <aside ref={p.panelRef} className={styles.panel} aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className={styles.header}>
        <h2 id={titleId} className={styles.title}>
          Notes
        </h2>
        <IconButton icon="close" label="Close notes" shortcut="Shift+F4" size={40} iconSize={24} onClick={p.onClose} />
      </div>
      <div role="tablist" aria-label="Which notes to show" className={styles.tabs}>
        {TABS.map((t, i) => {
          const selected = p.filter === t.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${tabsId}-${t.id}`}
              aria-selected={selected}
              aria-controls={`${tabsId}-list`}
              tabIndex={selected ? 0 : -1}
              className={styles.tab}
              onClick={() => p.onFilter(t.id)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className={styles.tabLabel}>{t.label}</span>
            </button>
          );
        })}
      </div>
      <div ref={p.listRef} role="tabpanel" id={`${tabsId}-list`} aria-labelledby={`${tabsId}-${p.filter}`} className={styles.list}>
        {empty && <EmptyMessage mine={p.filter === 'mine'} total={p.total} />}
        {placed.length > 0 && (
          <ol className={styles.cards} aria-label={p.filter === 'mine' ? 'Your notes' : 'Notes'}>
            {placed.map(card)}
          </ol>
        )}
        {unplaced.length > 0 && (
          <section className={styles.unplaced} aria-labelledby={unplacedId}>
            <h3 id={unplacedId} className={styles.sectionTitle}>
              <Icon name="location_off" size={20} className={styles.sectionIcon} />
              Couldn&rsquo;t place
              <span className={styles.count}>{unplaced.length}</span>
            </h3>
            <p className={styles.sectionNote}>
              {unplaced.length === 1
                ? 'The text this note was on isn’t in this copy of the PDF, so it isn’t shown on the pages.'
                : 'The text these notes were on isn’t in this copy of the PDF, so they aren’t shown on the pages.'}
            </p>
            <ol className={styles.cards}>{unplaced.map(card)}</ol>
          </section>
        )}
      </div>
    </aside>
  );
}

/** What an empty tab says: how to add a note, or that the owner has none of their own here. */
function EmptyMessage({ mine, total }: { mine: boolean; total: number }) {
  return (
    <div className={styles.empty}>
      <Icon name="comment" size={24} className={styles.emptyIcon} />
      {mine && total > 0 ? (
        <p className={styles.emptyTitle}>You haven’t written any notes on this PDF</p>
      ) : (
        <>
          <p className={styles.emptyTitle}>No notes yet</p>
          <p className={styles.emptyHint}>Select some text, then press Ctrl+Alt+M to add a note.</p>
        </>
      )}
    </div>
  );
}
