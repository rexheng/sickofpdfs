// The notes panel in the viewer (plan S15): Shift+F4 or the toolbar's Notes button opens it, Ctrl+Alt+N and
// Ctrl+Alt+P step through the notes from where the reader is (R70), and when the cards do not fit beside the pages it is
// where they go (R69). App.tsx mounts it with one line.
//
// What it does with drafts, so no text is lost:
// - Esc in a note or reply box never sends (TB5 ruling): it closes the box, and what was typed stays on the card as
//   "Not sent yet", for Enter or Comment later. Esc on an empty box drops it, and an empty new note takes its highlight
//   with it.
// - Leaving a card (another card, Esc on the card, next or previous note) does the same, as in the margin (S14; the
//   controller's ruling): a note or reply with text is sent, an empty one is dropped. While it is being typed, the
//   draft keeper keeps the text safe.
import type { CommentId, ThreadId } from '@sop/core';
import { lastInputWasPointer } from '@sop/ui';
import type { JumpHistory, PageSize, ViewerStore } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AnnotationSession } from '../annotations/session';
import { Snackbar } from '../chrome/Snackbar';
import { boxOfKind, type CarriedBox, carryBox, isBoxMoving, isEditBox } from '../notes/box-carry';
import { CARD_ID_PREFIX } from '../notes/CardColumn';
import { keptOf } from '../notes/kept';
import { installShortcuts } from '../shortcuts';
import { createNotesCommands, type NotesCommand } from './commands';
import { listNotes, type NoteEntry, type NoteSpot, type NotesFilter, spotOf } from './model';
import { distanceBelowTop, goToSpot, noteStops, stepNote } from './navigate';
import { NotesPanel } from './NotesPanel';
import styles from './NotesPanelMount.module.css';
import { cardsFolded, notesPanel, openEdit, publishNotesButton, useCardsFolded, useNotesPanelOpen, useOpenEdit } from './panel-state';

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
/** A note's words are kept this far inside the page column's edges when they are scrolled into it. */
const CLEAR_OF_EDGE = 16;
/** How much of a spot's surroundings (a point, a page corner) counts as its words. */
const WORDS_SHOWN = 240;

function Mounted({ session, pageList, viewer, pages, jumps, onCommands }: MountedProps) {
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const state = useSyncExternalStore(subscribe, () => session.state());
  const open = useNotesPanelOpen();
  const folded = useCardsFolded();
  const editing = useOpenEdit();
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

  /** An open edit is closed: a changed text is sent (Esc and leaving never lose text); otherwise it is cancelled. */
  const finishEdit = useCallback((body?: string) => {
    const e = openEdit.get();
    if (e === null) return;
    openEdit.set(null);
    const text = body ?? e.body;
    const live = session.state().comments.find((c) => c.id === e.id);
    if (live && text.trim() !== '' && text !== live.body) void session.editComment(e.id, text);
    else void session.cancelEdit(e.id);
  }, [session]);

  /** Leaving a card: a draft with text is sent; an empty one goes (an empty new note with its highlight). */
  const leave = useCallback((id: ThreadId | null) => {
    if (id === null) return;
    if (openEdit.get()?.threadId === id) finishEdit();
    for (const d of session.state().drafts) if (d.threadId === id) void (d.body.trim() === '' ? session.cancel(d.id) : session.send(d.id));
  }, [session, finishEdit]);

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
    // R70: from where the reader is. The active note counts only while it is still in view.
    const viewH = api.viewportHeight();
    const active = s.active !== null && stops.some((st) => st.id === s.active && inView(distanceBelowTop(st, pages, api), viewH)) ? s.active : null;
    const to = stepNote(stops, dir, active, (st) => distanceBelowTop(st, pages, api));
    if (to === null) return;
    activate(to.stop.id);
    show(to.stop);
    const where = `Note ${to.index + 1} of ${stops.length}, page ${to.stop.pageIndex + 1}.`;
    if (to.wrapped && stops.length > 1) say(`${dir === 1 ? 'Back to the first note.' : 'Back to the last note.'} ${where}`, true);
    else say(where, false);
  }, [activate, pageList, pages, say, session, show, total]);

  // The note box in the panel that had the caret last, and when: a click on Close takes the caret to the button first.
  const lastBox = useRef<{ box: CarriedBox; at: number } | null>(null);
  useEffect(() => {
    const el = panel.current;
    if (!open || el === null) return;
    const onOut = (e: FocusEvent) => {
      const b = e.target instanceof HTMLTextAreaElement ? panelBoxOf(e.target) : null;
      if (b !== null) lastBox.current = { box: b, at: performance.now() };
    };
    el.addEventListener('focusout', onOut);
    return () => el.removeEventListener('focusout', onOut);
  }, [open]);

  /**
   * Opens or closes the panel. Opened from a key or a button, it takes the focus; closed, it gives it back to the pages,
   * or, when a note box had the caret (or had it a moment ago, before Close was clicked) and the margin cards fit, to that
   * note's box in its margin card, caret and all (a layout change never closes a box).
   */
  const setOpen = useCallback((next: boolean, o: { focus: boolean }) => {
    const inside = panel.current?.contains(document.activeElement) ?? false;
    const now = document.activeElement instanceof HTMLTextAreaElement && inside ? panelBoxOf(document.activeElement) : null;
    const recent = lastBox.current !== null && performance.now() - lastBox.current.at < RECENT_BOX_MS ? lastBox.current.box : null;
    const b = now ?? recent;
    lastBox.current = null;
    if (!next && inside && b !== null && !cardsFolded() && session.state().active === b.threadId) {
      carryBox(b, () => boxOfKind(document.getElementById(`${CARD_ID_PREFIX}${b.threadId}`), b));
      notesPanel.setOpen(false);
      return;
    }
    notesPanel.setOpen(next);
    if (!next && inside) document.querySelector<HTMLElement>('[role="document"]')?.focus({ preventScroll: true });
    if (next && o.focus) focusOnOpen.current = true;
  }, [session]);
  const toggle = useCallback(() => setOpen(!notesPanel.isOpen(), { focus: true }), [setOpen]);

  // The toolbar's Notes button (NotesButton.tsx): how many notes, and the panel's toggle.
  useEffect(() => {
    if (!available) return;
    publishNotesButton({ count: total, toggle });
  }, [available, total, toggle]);
  useEffect(() => () => publishNotesButton(null), []);

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

  // The panel just opened from a key or a button: the focus goes to the active card, or to the selected tab. Opened with
  // the pointer (the toolbar's Notes button), it goes to the panel itself, so no ring shows on a tab the owner did not
  // choose (TB4); Esc still closes it, and the first Tab reaches its controls, ring and all.
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    const active = session.state().active;
    const target = lastInputWasPointer()
      ? panel.current
      : ((active !== null ? cards.current.get(active) : undefined) ?? panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'));
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

  // The card that becomes active is scrolled into sight in the list. Then, as it grows (an answer streaming in, a reply
  // being typed), the list follows its foot, so the newest words and the reply box stay in view (TB6). The card is never
  // taller than the list (NotesPanel.module.css), so its top stays in view too. The owner scrolling the list (the wheel,
  // the scroll bar, the keys) stops the following until another card becomes active.
  useEffect(() => {
    const ls = list.current;
    const el = state.active === null ? undefined : cards.current.get(state.active);
    if (!open || !ls || !el) return;
    reveal(ls, el);
    let follow = true;
    const stop = () => {
      follow = false;
    };
    const onPointer = (e: PointerEvent) => e.target === ls && stop(); // the list's own scroll bar
    const onKey = (e: KeyboardEvent) => !(e.target instanceof HTMLTextAreaElement) && SCROLL_KEYS.has(e.key) && stop();
    const observer = new ResizeObserver(() => follow && reveal(ls, el));
    observer.observe(el);
    ls.addEventListener('wheel', stop, { passive: true });
    ls.addEventListener('touchmove', stop, { passive: true });
    ls.addEventListener('pointerdown', onPointer);
    ls.addEventListener('keydown', onKey);
    return () => {
      observer.disconnect();
      ls.removeEventListener('wheel', stop);
      ls.removeEventListener('touchmove', stop);
      ls.removeEventListener('pointerdown', onPointer);
      ls.removeEventListener('keydown', onKey);
    };
  }, [open, state.active, filter]);

  // The panel never covers the pages: while it is open the page column ends before it (App.module.css). A page the
  // reader zoomed wider than that column scrolls sideways inside it, so the active note's words (the passage or the
  // figure Claude was asked about) are scrolled into the column when they are past its right edge. It runs a frame
  // after the panel opens, once the column has its new width and the pages their new place.
  useEffect(() => {
    if (!open || state.active === null) return;
    const e = entry(state.active);
    const api = pageList.current;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>('[role="document"]');
        const span = e && api ? clientSpan(e, api, pages) : null;
        if (!span || !scroller) return;
        const box = scroller.getBoundingClientRect();
        // Its end inside the column, without pushing its start off the column's left edge.
        const need = span.right - (box.left + scroller.clientWidth - CLEAR_OF_EDGE);
        const room = span.left - (box.left + CLEAR_OF_EDGE);
        const by = Math.min(need, room);
        if (by > 1) scroller.scrollBy({ left: by, behavior: 'smooth' });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, state.active, entry, pageList, pages]);

  const activeEntry = entry(state.active);
  // A new note's box takes the caret when it appears, unless it is a box moving in from the margin (box-carry.ts puts
  // the caret back where it was, after the letters typed meanwhile).
  const focusNote = activeEntry !== undefined && activeEntry.comments.length === 0 && !isBoxMoving(activeEntry.id) ? activeEntry.id : null;

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
      // TB5 ruling: Esc never sends. Typed text stays on the card as "Not sent yet"; an empty box is dropped. The card lets
      // go without the "leaving a card sends" step, so the next Esc (which closes the panel) does not send it either.
      if (body.trim() === '') void session.cancel(id);
      else session.typeDraft(id, body);
    }
    if (session.state().active === e.id) session.setActive(null);
    // The box is done with: the focus goes to its card, where a second Esc closes the panel.
    cards.current.get(e.id)?.focus({ preventScroll: true });
  }, [session]);
  const onDraftCancel = useCallback((e: NoteEntry) => {
    // Cancel throws the unsent text away: a new note goes, with its highlight; a reply box empties.
    if (e.draft !== null) void session.cancel(e.draft.id);
    cards.current.get(e.id)?.focus({ preventScroll: true });
  }, [session]);
  const onEditChange = useCallback((body: string) => {
    const e = openEdit.get();
    if (e === null) return;
    openEdit.set({ ...e, body });
    session.typeEdit(e.id, body);
  }, [session]);
  const onEditSave = useCallback((body: string) => {
    const e = openEdit.get();
    if (e === null) return;
    openEdit.set(null);
    void session.editComment(e.id, body);
  }, [session]);
  const onEditEscape = useCallback((body: string) => {
    const e = openEdit.get();
    finishEdit(body);
    if (e !== null) cards.current.get(e.threadId)?.focus({ preventScroll: true });
  }, [finishEdit]);
  const onEditCancel = useCallback(() => {
    const e = openEdit.get();
    if (e === null) return;
    openEdit.set(null);
    void session.cancelEdit(e.id);
    cards.current.get(e.threadId)?.focus({ preventScroll: true });
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
          onDraftCancel={onDraftCancel}
          editing={editing}
          onEditChange={onEditChange}
          onEditSave={onEditSave}
          onEditEscape={onEditEscape}
          onEditCancel={onEditCancel}
          onDelete={onDelete}
          onShowOriginal={onShowOriginal}
          cardRef={cardRef}
          keptOf={(e) => keptOf(state, e.id)}
          onRetrySave={() => void session.retryParked()}
        />
      ) : null}
      <p className={styles.srOnly} role="status">
        {said}
      </p>
      <Snackbar note={note} />
    </div>
  );
}

/** Where a note's words (or its spot) are across the screen, in client px; null when it has no place on a page. */
function clientSpan(e: NoteEntry, api: PageListApi, pages: readonly PageSize[]): { left: number; right: number } | null {
  const a = e.placement === 'unplaced' ? null : e.thread.anchor;
  const at = (page: number, u: number, v: number) => {
    const size = pages[page];
    return size ? api.clientPointOf({ pageIndex: page, x: u * size.width, y: v * size.height }) : null;
  };
  if (a?.kind === 'text' && e.spot) {
    let left = Infinity;
    let right = -Infinity;
    for (const g of a.rects) {
      if (g.page !== e.spot.pageIndex) continue;
      for (const r of g.rects) {
        const p = at(g.page, r[0], r[1]);
        const q = at(g.page, r[2], r[3]);
        if (!p || !q) continue;
        left = Math.min(left, p.x, q.x);
        right = Math.max(right, p.x, q.x);
      }
    }
    if (Number.isFinite(left)) return { left, right };
  }
  if (!e.spot) return null;
  const p = at(e.spot.pageIndex, e.spot.x, e.spot.y);
  return p && Number.isFinite(p.x) ? { left: p.x, right: p.x + WORDS_SHOWN } : null;
}

/** Keys that scroll the list: pressing one stops the list following the active card. */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** How long after a panel box lost the caret a Close still takes the box back to the margin. */
const RECENT_BOX_MS = 1000;

/** A note box of the panel, with its caret, as box-carry.ts moves it. */
function panelBoxOf(box: HTMLTextAreaElement): CarriedBox | null {
  const id = box.closest('[id^="sop-panel-note-"]')?.id.slice('sop-panel-note-'.length);
  return id === undefined ? null : { threadId: id, start: box.selectionStart, end: box.selectionEnd, edit: isEditBox(box) };
}

/** Whether a note this far below the top of the view (CSS px) is in a view `height` tall. */
function inView(below: number, height: number): boolean {
  return below >= 0 && below < height;
}

/** Scrolls `list` (and only it) so `el` is in sight, with a little room above it. */
function reveal(list: HTMLElement, el: HTMLElement): void {
  const box = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const room = parseFloat(getComputedStyle(list).paddingTop) || 0;
  if (r.top < box.top + room) list.scrollTop -= box.top + room - r.top;
  else if (r.bottom > box.bottom - room) list.scrollTop += Math.min(r.bottom - (box.bottom - room), r.top - (box.top + room));
}
