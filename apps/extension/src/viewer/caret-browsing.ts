// Caret browsing (ruling R93): the switch. View → "Caret browsing", or F7.
//
// - F7 is Chrome's own key for caret browsing. The viewer page gets the key before Chrome does, and taking it (its
//   default prevented) stops Chrome's "Turn on caret browsing?" question, so F7 turns the viewer's own text cursor on
//   and off instead (checked with real key presses on Chromium; see the caret report).
// - Remembered on this computer for every PDF and followed live by every viewer tab (remembered-switch.ts); off at first.
// - The cursor itself is @sop/viewer's CaretBrowsing (TextLayerController.caret); App.tsx joins it to this switch.
import { rememberedSwitch, useSwitch } from './remembered-switch';

/** The chrome.storage.local key: true when the owner has turned caret browsing on. */
export const CARET_BROWSING_KEY = 'view.caretBrowsing';

export const caretBrowsingSwitch = rememberedSwitch(CARET_BROWSING_KEY, 'caret browsing');

/** What the tab that turned it says, at the bottom of the window. */
export const CARET_ON_NOTE = 'Caret browsing is on. The arrow keys move the text cursor. Hold Shift to select.';
export const CARET_OFF_NOTE = 'Caret browsing is off.';

/** The switch, for a component (the View menu's check): re-renders when it changes. */
export function useCaretBrowsing(): boolean {
  return useSwitch(caretBrowsingSwitch);
}
