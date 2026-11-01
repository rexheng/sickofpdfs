// Which input the person used last: a pointer (mouse, pen, touch) or the keyboard. A menu that was closed with the
// pointer gives the focus to the page (MenuBar's and DropdownMenu's `returnFocus`) instead of to its button, so no
// focus ring is left behind and the reading keys keep working; a menu closed from the keyboard keeps the button
// focused, with its ring, as keyboard users expect.

let last: 'pointer' | 'keyboard' = 'keyboard';

if (typeof document !== 'undefined') {
  // Capture phase, so the answer is ready before any menu reacts to the same event.
  document.addEventListener('pointerdown', () => (last = 'pointer'), { capture: true, passive: true });
  document.addEventListener('keydown', () => (last = 'keyboard'), { capture: true, passive: true });
}

/** The last press was a pointer press, not a key. */
export function lastInputWasPointer(): boolean {
  return last === 'pointer';
}
