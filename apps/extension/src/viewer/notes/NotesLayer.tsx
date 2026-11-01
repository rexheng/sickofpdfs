// Comments in the viewer (Phase 2, S14): Ctrl+Alt+M, type, Enter, and the note is a card in the margin with replies,
// as in Google Docs (spec "The Ctrl+Alt+M flow"; plan section 2, S14).
//
// - The margin column appears once the document has a note, or a note box opens. The pages then move left in one move
//   (at fit width they get narrower), and the line the note is on stays where it was on screen.
// - The note box sits in the margin, level with its line, so it never covers the text.
// - Enter sends. Esc, or a click away, sends a new note that has text and cancels an empty one (its highlight goes too).
//   A reply with text is sent too when its card is left (the controller's ruling, the same in the notes panel). Nothing
//   typed is ever lost: drafts and edits go through the draft keeper (contracts section 3, "no lost text").
// - A clicked card turns light and moves 12 px left; the mark layer darkens its passage at the same time (S13 reads
//   the session's `active`). Clicking the passage of a note opens its card too.
//
// It mounts as the 'comments' feature of annotations/wire.ts (feature.tsx), on S13's one session for the document. Its
// commands run from the viewer's command list (commands.ts binds Ctrl+Alt+M); this layer only publishes what they do.
import type { NormRect } from '@sop/core';
import { Dialog, Icon, type CardPlacement } from '@sop/ui';
import { useViewerState, type ViewerStore } from '@sop/viewer';
import type { PageListApi } from '@sop/viewer/react';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CommentId, CommentRow, Resolution, ThreadId, ThreadRow } from '../annotations/boundary';
import type { NotesHost } from '../annotations/wire';
import { isTypingTarget } from '../shortcuts';
import { CARD_ID_PREFIX, CardColumn, type ColumnCard } from './CardColumn';
import { createCommentFlow, type CommentContext, type NoteTarget } from './comment-flow';
import { anchorHit, anchorLabel, anchorTop, columnLeft, MARGIN_RESERVE, PIN_SIZE, pointInContent, rectInContent, shownAnchor } from './margin';
import { hadNotes, rememberNotes } from './margin-at-open';
import { marginFolded, publishNoteCommands, subscribeMarginFolded, type NoteCommands } from './notes-host';
import styles from './NotesLayer.module.css';
import type { NotesWiring } from './wiring';

export interface NotesLayerProps {
  /** The open document's notes (annotations/wire.ts): its session, the page list, the view and the selection. */
  host: NotesHost;
}

export function NotesLayer({ host }: NotesLayerProps) {
  const wiring = useMemo<NotesWiring>(
    () => ({
      session: host.session,
      flushDrafts: () => host.flushDrafts(),
      makeTextAnchor: (ranges) => host.textAnchor(ranges),
      highlightColor: () => host.lastColor(),
    }),
    [host],
  );
  return <Notes host={host} wiring={wiring} />;
}

/** The comment being edited in its card, and the text in its editor. */
interface Editing {
  id: CommentId;
  threadId: ThreadId;
  body: string;
}

/** "Show where it was": the passage's stored place, outlined for a moment. */
interface Ghost {
  page: number;
  rects: NormRect[];
}

const GHOST_MS = 2500;
/** How far "Show where it was" and a restored note scroll their passage down from the top of the view. */
const REVEAL_FROM_TOP = 0.3;

function Notes({ host: notes, wiring }: { host: NotesHost; wiring: NotesWiring }) {
  const { session } = wiring;
  const pages = notes.pageList;
  const store = notes.view;
  const pageSizes = notes.pages;
  const subscribe = useCallback((cb: () => void) => session.subscribe(cb), [session]);
  const s = useSyncExternalStore(subscribe, () => session.state());
  const host = useOverlayHost(pages);
  const scroller = host?.closest<HTMLElement>('[role="document"]') ?? null;
  const layoutTick = useLayoutTick(store, host);
  const folded = useSyncExternalStore(subscribeMarginFolded, marginFolded);

  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const setEditing = useCallback((e: Editing | null) => {
    editingRef.current = e;
    setEditingState(e);
  }, []);
  const [focusThread, setFocusThread] = useState<ThreadId | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: CommentId; replies: number } | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const opening = useRef<{ threadId: ThreadId; t0: number } | null>(null);
  /** Notes and edits whose box has had its first focus (opened here, or restored after a reload). */
  const handled = useRef(new Set<string>());

  // Hands the keys back to the pages (scrolling, the mark keys) by letting go of the focus. Focusing the page list itself
  // would draw its keyboard focus ring around the whole page area.
  const focusPages = useCallback(() => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && a !== document.body) a.blur();
  }, []);

  const flow = useMemo(
    () =>
      createCommentFlow({
        wiring,
        clearSelection: () => document.getSelection()?.removeAllRanges(),
        currentPage: () => store.get().currentPage,
        pageSize: (i) => pageSizes[i],
      }),
    [wiring, store, pageSizes],
  );

  // ---------------------------------------------------------------- finishing a note

  /** An edit is closed: a changed text is sent (Esc and a click away never lose text); otherwise it is cancelled. */
  const finishEdit = useCallback(
    (e: Editing) => {
      const live = session.state().comments.find((c) => c.id === e.id);
      if (live && e.body.trim() !== '' && e.body !== live.body) void session.editComment(e.id, e.body);
      else void session.cancelEdit(e.id);
    },
    [session],
  );

  /**
   * The active card loses its turn. A new note with text is sent and an empty one cancelled (its highlight goes too);
   * an edit is sent if it changed; a reply with text is sent and an empty reply box leaves nothing behind (ruling:
   * leaving a card sends typed text, in the margin and in the notes panel alike).
   */
  const finishOpen = useCallback(() => {
    const e = editingRef.current;
    if (e) {
      finishEdit(e);
      setEditing(null);
    }
    const st = session.state();
    const thread = st.threads.find((t) => t.id === st.active);
    if (!thread) return;
    const own = st.drafts.filter((d) => d.threadId === thread.id);
    if (thread.draftOfTab !== null) {
      const root = own[0];
      if (root) void (root.body.trim() !== '' ? session.send(root.id) : session.cancel(root.id));
    } else {
      for (const d of own) void (d.body.trim() !== '' ? session.send(d.id) : session.cancel(d.id));
    }
  }, [session, finishEdit, setEditing]);

  const activate = useCallback(
    (id: ThreadId) => {
      if (session.state().active === id) return;
      finishOpen();
      session.setActive(id);
    },
    [session, finishOpen],
  );

  const deactivate = useCallback(() => {
    finishOpen();
    session.setActive(null);
  }, [session, finishOpen]);

  // ---------------------------------------------------------------- the commands

  /** Shows the note that was just made or found: its card active, its box focused. */
  const open = useCallback(
    (target: NoteTarget, t0: number) => {
      opening.current = { threadId: target.threadId, t0 };
      handled.current.add(target.threadId); // opened here, not restored
      const wasActive = session.state().active === target.threadId;
      session.setActive(target.threadId);
      setFocusThread(target.threadId);
      // An open card already shows its box, which focuses itself only when it appears.
      if (wasActive) focusBoxSoon(target.threadId);
    },
    [session],
  );
  /** Nothing was made: a margin opened for it closes again if the document has no notes. */
  const nothingOpened = useCallback(
    (target: NoteTarget | null) => {
      if (target === null && session.state().threads.length === 0) pages.current?.setReserveRight(0);
    },
    [session, pages],
  );

  /** Opens the margin before the note appears, keeping `keep` (client px) where it is on screen. */
  const openMargin = useCallback((keep?: { clientX: number; clientY: number }) => {
    const a = pages.current;
    if (a && !marginFolded() && a.reserveRight() !== MARGIN_RESERVE) a.setReserveRight(MARGIN_RESERVE, keep);
  }, [pages]);

  const commands = useMemo<NoteCommands>(() => {
    const enabled = () => session.state().mode !== 'view-only';
    return {
      'marks.comment': {
        enabled,
        run: () => {
          const t0 = performance.now();
          // Read what the note is about before anything moves: opening the margin lays the pages out again.
          const ctx: CommentContext = { ranges: notes.selection(), pointer: pointerOnPage(pages.current, pointer.current) };
          const keep = selectionStart() ?? (pointer.current ? { clientX: pointer.current.x, clientY: pointer.current.y } : undefined);
          finishOpen();
          void flow.comment(ctx, { before: () => openMargin(keep), after: (target) => open(target, t0) }).then(nothingOpened);
        },
      },
      'marks.documentNote': {
        enabled,
        run: () => {
          const t0 = performance.now();
          finishOpen();
          const target = flow.documentNote({ before: () => openMargin(), after: (x) => open(x, t0) });
          nothingOpened(target);
          // A note on the whole document sits at the top of the first page: show it there.
          if (target && pages.current && pages.current.currentPage() !== 0) void pages.current.goToPage(0);
        },
      },
    };
  }, [session, notes, pages, flow, finishOpen, open, openMargin, nothingOpened]);

  // One listener for the keys: the viewer's command list (commands.ts) runs these through the 'comments' feature.
  useEffect(() => {
    publishNoteCommands(commands);
    return () => publishNoteCommands(null);
  }, [commands]);

  // ---------------------------------------------------------------- the margin

  // The column shows while the document has a note, unless the notes panel holds the cards (open, or a narrow window).
  // A note box that is opening has already opened it (openMargin). R60: a PDF that had notes last time opened with the
  // margin (reserveAtOpen); it is kept until the stored notes have loaded, so the page never narrows late.
  const sha = notes.opened.loaded.sha256;
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void session.ready.then(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, [session]);
  const [heldAtOpen] = useState(() => hadNotes(sha));
  const hasNotes = s.threads.length > 0;
  const marginOn = (hasNotes || (heldAtOpen && !loaded)) && !folded;
  useEffect(() => {
    const a = pages.current;
    if (a) a.setReserveRight(marginOn ? MARGIN_RESERVE : 0);
  }, [marginOn, pages, host]);
  // What the next open of this file reserves: only a PDF whose notes are stored is remembered (never an unsaved one).
  useEffect(() => {
    if (!loaded) return;
    if (!hasNotes) rememberNotes(sha, false);
    else if (s.mode === 'stored') rememberNotes(sha, true);
  }, [loaded, hasNotes, s.mode, sha]);
  useEffect(() => () => pages.current?.setReserveRight(0), [pages]);

  // ---------------------------------------------------------------- the pointer, clicks and Esc

  useEffect(() => {
    if (!scroller) return;
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    const leave = () => {
      pointer.current = null;
    };
    scroller.addEventListener('pointermove', move, { passive: true });
    scroller.addEventListener('pointerleave', leave);
    return () => {
      scroller.removeEventListener('pointermove', move);
      scroller.removeEventListener('pointerleave', leave);
    };
  }, [scroller]);

  /** The most recent note whose passage is under client point (x, y). */
  const noteAt = useCallback(
    (x: number, y: number): ThreadId | null => {
      const p = pages.current?.pdfPointAt(x, y);
      const size = p ? pageSizes[p.pageIndex] : undefined;
      if (!p || !size) return null;
      const u = p.x / size.width;
      const v = p.y / size.height;
      const st = session.state();
      let best: ThreadRow | null = null;
      for (const t of st.threads) {
        const a = shownAnchor(t.anchor, st.placement.get(t.id));
        if (a && anchorHit(a, p.pageIndex, u, v) && (!best || t.createdAt >= best.createdAt)) best = t;
      }
      return best?.id ?? null;
    },
    [pages, pageSizes, session],
  );

  useEffect(() => {
    // A press anywhere outside the active card (not in a menu or a dialog) is a click away.
    const down = (e: PointerEvent) => {
      const st = session.state();
      if (st.active === null && editingRef.current === null) return;
      const el = e.target instanceof Element ? e.target : null;
      if (!el || el === scroller) return; // the page list's own scroll bar
      if (el.closest(`[id^="${CARD_ID_PREFIX}"], [data-note-pin]`)) return; // a card or a pin: its own click decides
      if (el.closest('[data-notes-panel]')) return; // the notes panel (S15) runs its own cards
      if (el.closest('[role="menu"], [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')) return;
      if (st.active !== null && noteAt(e.clientX, e.clientY) === st.active) return; // the active note's own passage
      deactivate();
    };
    // A click (not a drag) on a note's passage opens its card, as in Docs.
    const click = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      if (!(e.target instanceof Element) || !e.target.closest('[data-page-index]')) return;
      if (document.getSelection()?.isCollapsed === false) return;
      const hit = noteAt(e.clientX, e.clientY);
      if (hit !== null) activate(hit);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isTypingTarget(e.target)) return;
      if (session.state().active === null) return;
      deactivate();
    };
    document.addEventListener('pointerdown', down, { capture: true });
    scroller?.addEventListener('click', click);
    window.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, { capture: true });
      scroller?.removeEventListener('click', click);
      window.removeEventListener('keydown', key);
    };
  }, [session, scroller, noteAt, activate, deactivate]);

  // ---------------------------------------------------------------- drafts and edits restored after a reload

  useEffect(() => {
    // A restored new note: the session makes it active. Its box takes the caret, at the end of the text.
    const t = s.threads.find((x) => x.id === s.active);
    if (t && t.draftOfTab !== null && !handled.current.has(t.id)) {
      handled.current.add(t.id);
      reveal(t.id);
      focusBoxSoon(t.id); // its box appeared before this effect ran, so it did not take the focus itself
    }
    // A restored edit of a sent note: its editor opens again with the unsent text.
    if (editingRef.current === null) {
      const e = s.editDrafts.find((x) => !handled.current.has(`edit:${x.commentId}`));
      if (e) {
        handled.current.add(`edit:${e.commentId}`);
        session.setActive(e.threadId);
        setEditing({ id: e.commentId, threadId: e.threadId, body: e.body });
        reveal(e.threadId);
      }
    }
    for (const x of s.threads) if (x.draftOfTab === null) handled.current.add(x.id);
  }, [s, session, setEditing]);

  /** Brings a card into view (a note restored somewhere else in the document). */
  function reveal(id: ThreadId): void {
    requestAnimationFrame(() => {
      const el = document.getElementById(`${CARD_ID_PREFIX}${id}`);
      const sc = el?.closest<HTMLElement>('[role="document"]');
      if (!el || !sc) return;
      const r = el.getBoundingClientRect();
      const v = sc.getBoundingClientRect();
      if (r.top >= v.top && r.bottom <= v.bottom) return;
      sc.scrollTop += r.top - v.top - sc.clientHeight * REVEAL_FROM_TOP;
    });
  }

  // The note box took the caret: the speed budget's mark (spec: under 100 ms from the key).
  useLayoutEffect(() => {
    const o = opening.current;
    if (!o || s.active !== o.threadId || !document.getElementById(`${CARD_ID_PREFIX}${o.threadId}`)) return;
    opening.current = null;
    performance.mark('sop:notebox-open', { detail: { ms: performance.now() - o.t0 } });
  });
  // The box focuses itself when it mounts; after that render the request is spent.
  useEffect(() => {
    if (focusThread !== null) setFocusThread(null);
  }, [focusThread]);

  // ---------------------------------------------------------------- "Show where it was"

  const showOriginal = useCallback(
    (t: ThreadRow) => {
      if (t.anchor.kind !== 'text') return;
      const page = t.anchor.start.page;
      const rects = t.anchor.rects.find((r) => r.page === page)?.rects ?? [];
      const box = pages.current?.pageBoxes()[page];
      const first = rects[0];
      if (!box || !scroller) return;
      const y = first ? rectInContent(first, box).y : box.top;
      scroller.scrollTop = y - scroller.clientHeight * REVEAL_FROM_TOP;
      setGhost({ page, rects });
    },
    [pages, scroller],
  );
  useEffect(() => {
    if (!ghost) return;
    const timer = setTimeout(() => setGhost(null), GHOST_MS);
    return () => clearTimeout(timer);
  }, [ghost]);

  // ---------------------------------------------------------------- the cards

  void layoutTick; // the boxes below are read again whenever the pages are laid out again
  const boxes = pages.current?.pageBoxes() ?? [];
  const layoutKey = boxes.length > 0 ? `${boxes[0].left}|${boxes[0].top}|${boxes[0].width}|${boxes[0].rotation}` : '';
  const lastLayout = useRef(layoutKey);
  const animate = lastLayout.current === layoutKey;
  useEffect(() => {
    lastLayout.current = layoutKey;
  });

  const now = Date.now();
  const cards: ColumnCard[] = [];
  const pins: { t: ThreadRow; x: number; y: number }[] = [];
  for (const t of s.threads) {
    const res = s.placement.get(t.id);
    const shown = shownAnchor(t.anchor, res);
    if (!shown) continue; // "Couldn't place": nothing is drawn; the notes panel lists it
    const top = anchorTop(shown, boxes);
    if (top === null) continue;
    if (shown.kind === 'point' && boxes[shown.page]) pins.push({ t, ...pointInContent(shown.point, boxes[shown.page]) });
    cards.push({ id: t.id, anchorTop: top, card: cardProps(t, res) });
  }

  function threadComments(t: ThreadRow): CommentRow[] {
    return s.comments.filter((c) => c.threadId === t.id);
  }
  /** The thread's unsent text: its first comment (a new note) or a reply. */
  function draftOf(t: ThreadRow): CommentRow | undefined {
    return s.drafts.find((d) => d.threadId === t.id);
  }
  function draftId(t: ThreadRow): CommentId {
    return draftOf(t)?.id ?? session.startReply(t.id);
  }

  function cardProps(t: ThreadRow, res: Resolution | undefined): ColumnCard['card'] {
    const isNew = t.draftOfTab !== null;
    const list = threadComments(t);
    const placement = placementOf(res);
    const edit = editing && editing.threadId === t.id ? { id: editing.id, body: editing.body } : null;
    return {
      comments: list,
      draft: draftOf(t)?.body ?? null,
      onActivate: () => activate(t.id),
      onDeactivate: () => {
        deactivate();
        focusPages();
      },
      onDraftChange: (body) => session.typeDraft(draftId(t), body),
      onDraftSend: (body) => {
        const id = draftId(t);
        session.typeDraft(id, body);
        void session.send(id);
        if (isNew) focusPages(); // the note is on its card; reading goes on
      },
      onDraftEscape: (body) => {
        // Esc with text sends it, a new note or a reply alike (plan section 7); Esc on an empty box drops it.
        const d = draftOf(t);
        if (d && body.trim() !== '') {
          session.typeDraft(d.id, body);
          void session.send(d.id);
        } else if (d) void session.cancel(d.id);
        session.setActive(null);
        focusPages();
      },
      onDraftFlush: () => wiring.flushDrafts(),
      editing: edit,
      onEditStart: (id) => {
        const body = session.startEdit(id);
        if (body === null) return;
        const was = editingRef.current;
        if (was && was.id !== id) {
          finishEdit(was);
          setEditing(null); // finished once: activate() below must not finish it again
        }
        if (session.state().active !== t.id) activate(t.id);
        setEditing({ id, threadId: t.id, body });
        focusEditorSoon(t.id);
      },
      onEditChange: (body) => {
        const e = editingRef.current;
        if (!e) return;
        setEditing({ ...e, body });
        session.typeEdit(e.id, body);
      },
      onEditSave: (body) => {
        const e = editingRef.current;
        if (!e) return;
        setEditing(null);
        void session.editComment(e.id, body);
      },
      onEditEscape: (body) => {
        const e = editingRef.current;
        if (!e) return;
        setEditing(null);
        finishEdit({ ...e, body });
      },
      onDelete: (id) => {
        const root = list[0];
        if (root && root.id === id) setConfirmDelete({ id, replies: list.length - 1 });
        else void session.removeComment(id);
      },
      placement,
      onShowOriginal: placement === 'moved' ? () => showOriginal(t) : undefined,
      label: anchorLabel(t.anchor),
      autoFocus: focusThread === t.id,
      now,
    };
  }

  const left = columnLeft(boxes);
  const content = (
    <>
      {ghost && boxes[ghost.page] && (
        <div className={styles.ghosts} aria-hidden="true">
          {ghost.rects.map((r, i) => {
            const b = rectInContent(r, boxes[ghost.page]);
            return <div key={i} className={styles.ghost} style={{ left: b.x, top: b.y, width: b.width, height: b.height }} />;
          })}
        </div>
      )}
      {pins.map(({ t, x, y }) => (
        <button
          key={t.id}
          type="button"
          className={styles.pin}
          data-note-pin=""
          data-theme="light"
          data-active={s.active === t.id ? 'true' : 'false'}
          style={{ left: x - PIN_SIZE / 2, top: y - PIN_SIZE / 2 }}
          aria-label={`Note on page ${(t.anchor.kind === 'point' ? t.anchor.page : 0) + 1}`}
          onClick={() => activate(t.id)}
        >
          <Icon name="comment" size={20} filled />
        </button>
      ))}
      {cards.length > 0 && !folded && <CardColumn cards={cards} left={left} activeId={s.active} animate={animate} />}
    </>
  );

  const root = confirmDelete === null ? undefined : s.comments.find((c) => c.id === confirmDelete.id);
  return (
    <>
      {host && createPortal(content, host)}
      <Dialog
        open={confirmDelete !== null && root !== undefined}
        title="Delete this note?"
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        actions={[
          { label: 'Cancel', onClick: () => setConfirmDelete(null) },
          {
            label: 'Delete',
            primary: true,
            onClick: () => {
              if (confirmDelete) void session.removeComment(confirmDelete.id);
              setConfirmDelete(null);
            },
          },
        ]}
      >
        {confirmDelete !== null && confirmDelete.replies > 0
          ? `The note and its ${confirmDelete.replies === 1 ? 'reply' : `${confirmDelete.replies} replies`} will be deleted. Its highlight stays.`
          : 'The note will be deleted. Its highlight stays.'}
      </Dialog>
    </>
  );
}

/** How the card shows where its note sits (contracts D7: a close match is never silent). */
function placementOf(r: Resolution | undefined): CardPlacement {
  if (!r) return 'placed';
  if (!r.placed) return 'unplaced';
  return r.by === 'fuzzy' || r.by === 'caption' || r.by === 'image' ? 'moved' : 'placed';
}

/** Puts the caret at the end of a card's note or reply box, unless the focus is already in that card. */
function focusBoxSoon(threadId: ThreadId): void {
  requestAnimationFrame(() => {
    const card = document.getElementById(`${CARD_ID_PREFIX}${threadId}`);
    const box = card?.querySelector<HTMLTextAreaElement>('textarea');
    if (!card || !box || card.contains(document.activeElement)) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  });
}

/**
 * Puts the caret in a card's edit box. "Edit" is picked from the comment's ⋮ menu, and the menu gives the focus back to
 * its button as it closes, after the box has taken it; so the box takes it back once the menu has gone.
 */
function focusEditorSoon(threadId: ThreadId): void {
  const tryFocus = () => {
    const box = document.getElementById(`${CARD_ID_PREFIX}${threadId}`)?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit note"]');
    if (!box || document.activeElement === box) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
  };
  for (const ms of [0, 30, 80, 160]) setTimeout(tryFocus, ms);
}

/** The page point under the pointer, when it is over a page. */
function pointerOnPage(api: PageListApi | null, at: { x: number; y: number } | null) {
  return api && at ? api.pdfPointAt(at.x, at.y) : null;
}

/** Where the selection starts on screen: the line that must stay put when the margin opens. */
function selectionStart(): { clientX: number; clientY: number } | undefined {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return undefined;
  const r = sel.getRangeAt(0).getClientRects()[0];
  return r ? { clientX: r.left, clientY: r.top } : undefined;
}

/** The page list's overlay, once its first layout has made it. */
function useOverlayHost(pages: RefObject<PageListApi | null>): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(() => pages.current?.overlayHost() ?? null);
  useEffect(() => {
    if (host?.isConnected) return;
    let frame = 0;
    const look = () => {
      const el = pages.current?.overlayHost() ?? null;
      if (el) setHost(el);
      else frame = requestAnimationFrame(look);
    };
    look();
    return () => cancelAnimationFrame(frame);
  }, [pages, host]);
  return host;
}

/** Changes whenever the pages are laid out again: a zoom, a rotation, a spread, or the scroll area's size. */
function useLayoutTick(store: ViewerStore, host: HTMLElement | null): string {
  const view = useViewerState(store, (v) => `${v.scale}|${v.viewRotation}|${v.spread}`);
  const [resized, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sizer = host?.parentElement;
    if (!sizer) return;
    const ro = new ResizeObserver(() => bump());
    ro.observe(sizer);
    return () => ro.disconnect();
  }, [host]);
  return `${view}|${resized}`;
}

