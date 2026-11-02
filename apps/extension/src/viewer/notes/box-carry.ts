// A note box is never closed or unfocused by a layout change (TB4 fix round, no lost text). When a zoom, a turn, two-page
// view, the rail or the notes panel folds the margin cards while a box has the caret, the box moves to where the note
// shows now (the notes panel), with its text and its caret; and back to its margin card when the panel closes and the
// cards fit. The text itself is never at risk: it lives in the session's draft. This keeps the caret, and the keys typed
// while the box moves.
//
// Between the old box going and the new one appearing (a frame or two), the caret waits in a hidden text box, so a key
// typed then is never a page shortcut (Space would scroll, H would highlight): it is typed into the new box.

/** The box that had the caret: its note, its caret, and whether it was the edit box of a sent comment. */
export interface CarriedBox {
  threadId: string;
  start: number;
  end: number;
  edit: boolean;
}

/** How long the new box may take to appear (frames, about one second). */
const MAX_FRAMES = 60;

/** The box in `el` that had the caret, if any, read before it goes. `cardOf` names the note a box belongs to. */
export function openBoxIn(el: Element | null, cardOf: (box: HTMLTextAreaElement) => string | null): CarriedBox | null {
  const box = document.activeElement;
  if (!(box instanceof HTMLTextAreaElement) || el === null || !el.contains(box)) return null;
  const threadId = cardOf(box);
  if (threadId === null) return null;
  return { threadId, start: box.selectionStart, end: box.selectionEnd, edit: isEditBox(box) };
}

/** Whether a note box is the edit box of a sent comment (NoteBox's 'edit' variant). */
export function isEditBox(box: HTMLTextAreaElement): boolean {
  return box.getAttribute('aria-label') === 'Edit note';
}

/** The note box of the same kind as `b` inside `card`, if it is there. */
export function boxOfKind(card: Element | null, b: CarriedBox): HTMLTextAreaElement | null {
  if (card === null) return null;
  for (const t of card.querySelectorAll('textarea')) if (isEditBox(t) === b.edit) return t;
  return null;
}

/**
 * Holds the caret in a hidden text box until `find` gives the box's new place, then puts the caret there as it was and
 * types what was typed in between. Gives up after about a second (the text is still in the draft).
 */
export function carryBox(b: CarriedBox, find: () => HTMLTextAreaElement | null): void {
  const holder = document.createElement('textarea');
  holder.setAttribute('aria-hidden', 'true');
  holder.tabIndex = -1;
  holder.style.cssText = 'position:fixed;inset:0 auto auto -10000px;inline-size:1px;block-size:1px;opacity:0';
  // Enter, Esc and Tab wait for the box itself: they would send, close or leave it.
  holder.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') e.preventDefault();
  });
  document.body.append(holder);
  holder.focus({ preventScroll: true });
  let frames = 0;
  const look = () => {
    const box = find();
    if (box?.isConnected === true) {
      const typed = holder.value;
      box.focus({ preventScroll: true });
      holder.remove();
      const length = box.value.length;
      box.setSelectionRange(Math.min(b.start, length), Math.min(b.end, length));
      // Through insertText, so the box's own input handler (the draft) sees it, and Ctrl+Z can take it back.
      if (typed !== '' && !document.execCommand('insertText', false, typed)) {
        box.setRangeText(typed, box.selectionStart, box.selectionEnd, 'end');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (++frames > MAX_FRAMES || !holder.isConnected) {
      holder.remove();
      return;
    }
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
}
