// The notes panel in the viewer (plan S15): Shift+F4 opens it, Ctrl+Alt+N and Ctrl+Alt+P step through the notes, and
// in a narrow window it is where the comment cards go. App.tsx mounts it with one line.
//
// What it does with drafts, so no text is lost:
// - Esc in a note or reply box sends what was typed (the controller's reading of the spec: Esc "saves typed text");
//   Esc on an empty box drops it, and an empty new note takes its highlight with it.
// - Leaving a card (another card, Esc on the card, next or previous note) drops an empty draft only. Text that was
//   typed stays as a draft on its card, saved by the draft keeper, until it is sent.
import type { CommentId, ThreadId } from '@sop/core';
import { Icon, Tooltip } from '@sop/ui';
import type { JumpHistory, PageSize, ViewerStore } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnnotationSession } from '../annotations/session';
import { Snackbar } from '../chrome/Snackbar';
import { installShortcuts } from '../shortcuts';
import { createNotesCommands, type NotesCommand } from './commands';
import { listNotes, type NoteEntry, type NoteSpot, type NotesFilter, spotOf } from './model';
import { distanceBelowTop, goToSpot, noteStops, stepNote } from './navigate';
import { NotesPanel } from './NotesPanel';
import styles from './NotesPanelMount.module.css';
import { notesPanel, useCardsFolded, useNotesPanelOpen } from './panel-state';

export interface NotesPanelMountProps {
  /** The tab's annotation session. Null while there is none: then nothing is shown and the keys do nothing. */
  session: AnnotationSession | null;
  /** The page list, for the reading position and the jumps. */
  pageList: RefObject<PageListApi | null>;
  /** The view state (the zoom, for the jump history's "where you were"). */
  viewer: ViewerStore;
  /** The document's page sizes in points. */
  pages: readonly PageSize[];
  /** Task 24's jump history, so Back returns from a run of note jumps. Null until it lands: a note's page is shown. */
  jumps: JumpHistory | null;
  /**
   * The viewer's command list. When given, the three commands go there (the View menu, the shortcut sheet and the keys
   * all come from it) and this component installs no keys of its own; it is called with null when the panel goes.
   */
  onCommands?: (commands: NotesCommand[] | null) => void;
}

export function NotesPanelMount(p: NotesPanelMountProps) {
  if (p.session === null) return null;
  return <Mounted {...p} session={p.session} />;
}

type MountedProps = NotesPanelMountProps & { session: AnnotationSession };

/** How long the snackbar shows a message (chrome/Snackbar.tsx). */
const NOTE_SHOWN_MS = 4000;

function Mounted({ session, pageList, viewer, pages, jumps, onCommands }: MountedProps) {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const state = useSyncExternalStore(subscribe, () => session.state());
  const open = useNotesPanelOpen();
  const folded = useCardsFolded();
  const [filter, setFilter] = useState<NotesFilter>('all');
  const [said, setSaid] = useState('');
  const [note, setNote] = useState<{ text: string } | null>(null);
  const cards = useRef(new Map<ThreadId, HTMLElement>());
  const panel = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  const focusOnOpen = useRef(false);

  const available = state.mode !== 'view-only';
  const all = useMemo(() => listNotes(state), [state]);
  const shown = useMemo(() => (filter === 'all' ? all : listNotes(state, 'mine')), [all, filter, state]);
  const total = all.placed.length + all.unplaced.length;
  const entry = useCallback((id: ThreadId | null) => (id === null ? undefined : [...all.placed, ...all.unplaced].find((e) => e.id === id)), [all]);

  // The panel closes with the document, and on Incognito's view-only session it never opens.
  useEffect(() => () => notesPanel.setOpen(false), []);
  useEffect(() => {
    if (!available) notesPanel.setOpen(false);
  }, [available]);

  const show = useCallback((spot: NoteSpot | null) => {
    const api = pageList.current;
    if (spot === null || api === null) return;
    goToSpot(spot, { jumps, api, pages, scale: viewer.get().scale });
  }, [jumps, pageList, pages, viewer]);

  /** Leaving a card: an empty draft goes (an empty new note with its highlight). Typed text stays a draft. */
  const leave = useCallback((id: ThreadId | null) => {
    if (id === null) return;
    for (const d of session.state().drafts) if (d.threadId === id && d.body.trim() === '') void session.cancel(d.id);
  }, [session]);

  const activate = useCallback((id: ThreadId) => {
    const was = session.state().active;
    if (was !== id) leave(was);
    session.setActive(id);
  }, [leave, session]);

  const deactivate = useCallback(() => {
    leave(session.state().active);
    session.setActive(null);
  }, [leave, session]);

  // Every step is read out. A step is shown on screen when it wrapped round or found nothing; while that message is
  // up, the steps after it update it, so it never shows a note the reader has already left.
  const shownUntil = useRef(0);
  const say = useCallback((text: string, visible: boolean) => {
    setSaid(text);
    if (!visible && Date.now() > shownUntil.current) return;
    shownUntil.current = Date.now() + NOTE_SHOWN_MS;
    setNote({ text });
  }, []);

  /** Ctrl+Alt+N (1) and Ctrl+Alt+P (−1). */
  const step = useCallback((dir: 1 | -1) => {
    const api = pageList.current;
    const s = session.state();
    const stops = noteStops(listNotes(s).placed);
    if (api === null || stops.length === 0) {
      say(total > 0 ? 'These notes aren’t on any page. Press Shift+F4 to see them.' : 'This PDF has no notes yet.', true);
      return;
    }
    const to = stepNote(stops, dir, s.active, (st) => distanceBelowTop(st, pages, api));
    if (to === null) return;
    activate(to.stop.id);
    show(to.stop);
    const where = `Note ${to.index + 1} of ${stops.length}, page ${to.stop.pageIndex + 1}.`;
    if (to.wrapped && stops.length > 1) say(`${dir === 1 ? 'Back to the first note.' : 'Back to the last note.'} ${where}`, true);
    else say(where, false);
  }, [activate, pageList, pages, say, session, show, total]);

  /** Opens or closes the panel. Opened from a key or a button, it takes the focus; closed, it gives it back to the pages. */
  const setOpen = useCallback((next: boolean, o: { focus: boolean }) => {
    const inside = panel.current?.contains(document.activeElement) ?? false;
    notesPanel.setOpen(next);
    if (!next && inside) document.querySelector<HTMLElement>('[role="document"]')?.focus({ preventScroll: true });
    if (next && o.focus) focusOnOpen.current = true;
  }, []);
  const toggle = useCallback(() => setOpen(!notesPanel.isOpen(), { focus: true }), [setOpen]);

  // The commands: into the viewer's list when it takes them, otherwise keys of our own.
  const latest = useRef({ toggle, step, available });
  useEffect(() => {
    latest.current = { toggle, step, available };
  });
  const commands = useMemo(
    () =>
      createNotesCommands({
        togglePanel: () => latest.current.toggle(),
        panelOpen: () => notesPanel.isOpen(),
        step: (dir) => latest.current.step(dir),
        available: () => latest.current.available,
      }),
    [],
  );
  useEffect(() => {
    if (onCommands !== undefined) {
      onCommands(commands);
      return () => onCommands(null);
    }
    return installShortcuts(commands.map((c) => ({ id: c.id, keys: c.keys, run: () => c.run(), enabled: () => c.enabled() })));
  }, [commands, onCommands]);

  // The panel just opened from a key or a button: the focus goes to the active card, or to the selected tab.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const active = session.state().active;
    const target = (active !== null ? cards.current.get(active) : undefined) ?? panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    target?.focus({ preventScroll: true });
  }, [open, session]);

  // In a narrow window the cards fold into the panel: a note that becomes active (a new note, a clicked mark, the
  // next note) opens it, so the card always has somewhere to be. A note that is not on the tab shown switches to All.
  const lastActive = useRef(state.active);
  useEffect(() => {
    const was = lastActive.current;
    lastActive.current = state.active;
    if (state.active === null || state.active === was) return;
    if (folded && !notesPanel.isOpen()) setOpen(true, { focus: false });
    if (filter === 'mine' && entry(state.active)?.mine === false) setFilter('all');
  }, [state.active, folded, filter, entry, setOpen]);

  // The card that becomes active is scrolled into sight in the list (once: typing in it must not move the list).
  useEffect(() => {
    if (!open || state.active === null) return;
    const el = cards.current.get(state.active);
    if (el && list.current) reveal(list.current, el);
  }, [open, state.active, filter]);

  const activeEntry = entry(state.active);
  const focusNote = activeEntry !== undefined && activeEntry.comments.length === 0 ? activeEntry.id : null;

  const onDraftChange = useCallback((e: NoteEntry, body: string) => {
    const id = e.draft?.id ?? session.startReply(e.id);
    session.typeDraft(id, body);
  }, [session]);
  const onDraftSend = useCallback((e: NoteEntry, body: string) => {
    const id = e.draft?.id ?? session.startReply(e.id);
    session.typeDraft(id, body);
    void session.send(id);
  }, [session]);
  const onDraftEscape = useCallback((e: NoteEntry, body: string) => {
    const id = e.draft?.id;
    if (id !== undefined) {
      if (body.trim() === '') void session.cancel(id);
      else {
        session.typeDraft(id, body);
        void session.send(id);
      }
    }
    // The box is done with: the focus goes to its card, where a second Esc closes the card.
    cards.current.get(e.id)?.focus({ preventScroll: true });
  }, [session]);
  const onDelete = useCallback((id: CommentId) => void session.removeComment(id), [session]);
  // "Show where it was": the place the note was stored at. The click also reaches the card, which goes to where the
  // note is now; this jump runs after that one, so it is the one the reader sees.
  const onShowOriginal = useCallback((e: NoteEntry) => {
    const was = spotOf(e.thread.anchor, e.thread);
    setTimeout(() => show(was), 0);
  }, [show]);
  const onActivate = useCallback((id: ThreadId) => {
    activate(id);
    show(entry(id)?.spot ?? null);
  }, [activate, entry, show]);
  const cardRef = useCallback((id: ThreadId, el: HTMLElement | null) => {
    if (el === null) cards.current.delete(id);
    else cards.current.set(id, el);
  }, []);

  if (!available) return null;
  return (
    <div className={styles.mount} data-open={open ? 'true' : 'false'}>
      {open ? (
        <NotesPanel
          panelRef={panel}
          listRef={list}
          notes={shown}
          total={total}
          filter={filter}
          onFilter={setFilter}
          active={state.active}
          focusNote={focusNote}
          onClose={() => setOpen(false, { focus: false })}
          onActivate={onActivate}
          onDeactivate={deactivate}
          onDraftChange={onDraftChange}
          onDraftSend={onDraftSend}
          onDraftEscape={onDraftEscape}
          onDelete={onDelete}
          onShowOriginal={onShowOriginal}
          cardRef={cardRef}
        />
      ) : (
        total > 0 && <ShowNotesButton count={total} onClick={() => setOpen(true, { focus: true })} />
      )}
      <p className={styles.srOnly} role="status">
        {said}
      </p>
      <Snackbar note={note} />
    </div>
  );
}

/**
 * The way back to the panel with the mouse: a small pill at the bottom right, "the notes of this PDF", with how many
 * there are. It shows only when the PDF has notes and the panel is closed (the panel has its own Close).
 */
function ShowNotesButton({ count, onClick }: { count: number; onClick: () => void }) {
  const label = count === 1 ? 'Show notes (1 note)' : `Show notes (${count} notes)`;
  return (
    <div className={styles.showRow} data-viewer-chrome="">
      <Tooltip label="Show notes" shortcut="Shift+F4">
        <button type="button" className={styles.show} aria-label={label} onClick={onClick}>
          <Icon name="comment" size={20} />
          <span className={styles.showCount}>{count}</span>
        </button>
      </Tooltip>
    </div>
  );
}

/** Scrolls `list` (and only it) so `el` is in sight, with a little room above it. */
function reveal(list: HTMLElement, el: HTMLElement): void {
  const box = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const room = parseFloat(getComputedStyle(list).paddingTop) || 0;
  if (r.top < box.top + room) list.scrollTop -= box.top + room - r.top;
  else if (r.bottom > box.bottom - room) list.scrollTop += Math.min(r.bottom - (box.bottom - room), r.top - (box.top + room));
}
