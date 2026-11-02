// Bold word starts (ruling R90): the switch (View → "Bold word starts", Alt+Shift+S, or Settings → Reading) and how
// bold it draws (Settings → Reading → How bold).
//
// - Both are remembered on this computer for every PDF, in chrome.storage.local; the switch is off until the owner turns
//   it on (remembered-switch.ts). Every viewer tab follows both live (chrome.storage.onChanged).
// - Nothing about any PDF is stored. (They are view settings, so an Incognito tab may change the switch too, as Chrome's
//   own settings can be changed there.)
// - The drawing is @sop/viewer's WordStartsController and WordStartsLayer; App.tsx joins them to these.
import { useSyncExternalStore } from 'react';
import { rememberedSwitch, useSwitch } from './remembered-switch';

/** The chrome.storage.local key: true when the owner has turned bold word starts on (Settings → Reading writes it too). */
export const WORD_STARTS_KEY = 'view.boldWordStarts';

/** R90's quiet note, shown once per tab, the first time a scanned page is in view with the switch on. */
export const WORD_STARTS_SCAN_NOTE = 'Bold word starts works on text pages. This page is a scanned image.';

export const wordStartsSwitch = rememberedSwitch(WORD_STARTS_KEY, 'bold word starts');

/** The switch, for a component (the View menu's check): re-renders when it changes. */
export function useWordStarts(): boolean {
  return useSwitch(wordStartsSwitch);
}

/**
 * The chrome.storage.local key of "How bold" (Settings → Reading): 'light', 'medium' or 'strong'. Missing or anything
 * else means medium. Written only by the Settings page; every viewer tab follows it live.
 */
export const WORD_STARTS_STRENGTH_KEY = 'view.boldWordStartsStrength';

export type WordStartsStrength = 'light' | 'medium' | 'strong';

/**
 * How much of a face's own regular-to-bold gain each strength draws (R90b's synthetic bold): medium is the face's own
 * bold. Light and strong were chosen by eye on crops at 100% and 200%: 0.7 and 1.35 looked almost like medium at 100%
 * (the ink a bold adds was 0.87 and 1.14 of medium's), 0.5 and 1.6 are three clear steps (0.66–0.76 and 1.21–1.34).
 * The counters stay open at every strength (bold-painter.ts caps the gain per glyph).
 */
export const WORD_STARTS_GAIN: Readonly<Record<WordStartsStrength, number>> = { light: 0.5, medium: 1, strong: 1.6 };

const asStrength = (v: unknown): WordStartsStrength => (v === 'light' || v === 'strong' ? v : 'medium');

let strength: WordStartsStrength = 'medium';
let strengthStarted = false;
const strengthListeners = new Set<() => void>();

/** "How bold", read once and followed in every tab. Outside an extension page it stays medium. */
export const wordStartsStrength = {
  get(this: void): WordStartsStrength {
    startStrength();
    return strength;
  },
  subscribe(this: void, onChange: () => void): () => void {
    startStrength();
    strengthListeners.add(onChange);
    return () => strengthListeners.delete(onChange);
  },
};

/** "How bold", for a component: re-renders when it changes. */
export function useWordStartsStrength(): WordStartsStrength {
  return useSyncExternalStore(wordStartsStrength.subscribe, wordStartsStrength.get);
}

function startStrength(): void {
  if (strengthStarted) return;
  strengthStarted = true;
  const apply = (v: unknown) => {
    const next = asStrength(v);
    if (next === strength) return;
    strength = next;
    for (const l of [...strengthListeners]) l();
  };
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[WORD_STARTS_STRENGTH_KEY];
      if (area === 'local' && change !== undefined) apply(change.newValue);
    });
    chrome.storage.local.get(WORD_STARTS_STRENGTH_KEY).then(
      (stored) => apply(stored[WORD_STARTS_STRENGTH_KEY]),
      () => {},
    );
  } catch {
    // not an extension page
  }
}

let scanNoteShown = false;

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
