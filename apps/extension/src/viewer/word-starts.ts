// Bold word starts (ruling R90): the switch. View → "Bold word starts", or Alt+Shift+S.
//
// - It is remembered on this computer for every PDF, in chrome.storage.local, and is off until the owner turns it on.
// - Every viewer tab follows it live: turning it on in one tab turns it on in the others (chrome.storage.onChanged).
// - The value is one boolean: nothing about any PDF is stored. (It is a view setting, so an Incognito tab may change it
//   too, as Chrome's own settings can be changed there.)
// - The drawing is @sop/viewer's WordStartsController and WordStartsLayer; App.tsx joins them to this switch.
import { useSyncExternalStore } from 'react';

/** The chrome.storage.local key: true when the owner has turned bold word starts on. */
export const WORD_STARTS_KEY = 'view.boldWordStarts';

/** R90's quiet note, shown once per tab, the first time a scanned page is in view with the switch on. */
export const WORD_STARTS_SCAN_NOTE = 'Bold word starts works on text pages. This page is a scanned image.';

let on = false;
let touched = false;
let started = false;
let scanNoteShown = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const l of [...listeners]) l();
}

/** Reads the stored value once, and follows changes made in any tab. Outside an extension page it stays off. */
function start(): void {
  if (started) return;
  started = true;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[WORD_STARTS_KEY];
      if (area !== 'local' || change === undefined) return;
      apply(change.newValue === true);
    });
    chrome.storage.local.get(WORD_STARTS_KEY).then(
      (stored) => {
        if (!touched) apply(stored[WORD_STARTS_KEY] === true); // a toggle before the answer came wins
      },
      () => {},
    );
  } catch {
    // not an extension page (unit tests): the switch stays off
  }
}

/** The switch, as the viewer's commands and pages read it. */
export const wordStartsSwitch = {
  get(this: void): boolean {
    start();
    return on;
  },
  /** Calls `onChange` whenever the switch changes, in this tab or another. */
  subscribe(this: void, onChange: () => void): () => void {
    start();
    listeners.add(onChange);
    return () => listeners.delete(onChange);
  },
  /** Turns it the other way here at once, and remembers it for every tab. */
  toggle(this: void): void {
    start();
    touched = true;
    const next = !on;
    apply(next);
    try {
      chrome.storage.local.set({ [WORD_STARTS_KEY]: next }).catch((err: unknown) => console.error('sickofpdfs: could not remember the bold word starts switch', err));
    } catch {
      // not an extension page
    }
  },
};

/** The switch, for a component: re-renders when it changes. */
export function useWordStarts(): boolean {
  return useSyncExternalStore(wordStartsSwitch.subscribe, wordStartsSwitch.get);
}

/**
 * Shows R90's scan note through `show` the first time this tab asks, and never again in this tab. Returns whether it
 * was shown now.
 */
export function noteScannedPageOnce(show: (text: string) => void): boolean {
  if (scanNoteShown) return false;
  scanNoteShown = true;
  show(WORD_STARTS_SCAN_NOTE);
  return true;
}
