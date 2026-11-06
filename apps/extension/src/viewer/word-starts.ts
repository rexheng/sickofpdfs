// Bold word starts (ruling R90): the switch (View → "Bold word starts", Alt+Shift+S, or Settings → Reading) and how
// bold it draws (Settings → Reading → How bold).
//
// - Both are remembered on this computer for every PDF, in chrome.storage.local; the switch is off until the owner turns
//   it on (remembered-switch.ts). Every viewer tab follows both live (chrome.storage.onChanged).
// - Nothing about any PDF is stored. (They are view settings, so an Incognito tab may change the switch too, as Chrome's
//   own settings can be changed there.)
// - The drawing is @sop/viewer's WordStartsController and WordStartsLayer; App.tsx joins them to these.
import type { BoldLook } from '@sop/viewer/react';
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
 * How heavy each strength draws (R90c): the gain on each face's own regular-to-bold gain (R90b's synthetic bold), and
 * the edge darkening (paintBold's `boost`). At 100% on a 1× screen the letters' gaps and counters leave little room to
 * grow (R90c keeps them open), so the heavier steps also darken the edges, which moves no outline. Medium is the face's
 * own bold with a little edge darkening.
 *
 * Each step differs from its neighbour by at least a third of the Off → Light step (Test build 6 visual critic), at
 * 100% and 200% on 1× and 2× screens, measured on PLOS ONE and Attention: Light at 0.9 was within a fifth of Medium at
 * 200% and on 2× screens, where edge darkening adds little, so Light is half the face's bold.
 */
export const WORD_STARTS_LOOK: Readonly<Record<WordStartsStrength, BoldLook>> = {
  light: { gain: 0.5, boost: 0 },
  medium: { gain: 1, boost: 0.8 },
  strong: { gain: 1.4, boost: 2.2 },
};

const asStrength = (v: unknown): WordStartsStrength => (v === 'light' || v === 'strong' ? v : 'medium');

let strength: WordStartsStrength = 'medium';
let strengthStarted = false;
let strengthChosen = false;
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

/** 'off', or the strength it is on at: View → Bold word starts' choice (R90c). */
export function wordStartsLevel(): 'off' | WordStartsStrength {
  return wordStartsSwitch.get() ? wordStartsStrength.get() : 'off';
}

/**
 * View → Bold word starts → Off, Light, Medium or Strong (R90c): here at once, and remembered for every tab in the keys
 * Settings → Reading uses (Off keeps the strength for next time).
 */
export function chooseWordStarts(level: 'off' | WordStartsStrength): void {
  if (level !== 'off') {
    strengthChosen = true;
    applyStrength(level);
    try {
      chrome.storage.local.set({ [WORD_STARTS_STRENGTH_KEY]: level }).catch((err: unknown) => console.error('sickofpdfs: could not remember how bold', err));
    } catch {
      // not an extension page
    }
  }
  wordStartsSwitch.set(level !== 'off');
}

function applyStrength(v: unknown): void {
  const next = asStrength(v);
  if (next === strength) return;
  strength = next;
  for (const l of [...strengthListeners]) l();
}

function startStrength(): void {
  if (strengthStarted) return;
  strengthStarted = true;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes[WORD_STARTS_STRENGTH_KEY];
      if (area === 'local' && change !== undefined) applyStrength(change.newValue);
    });
    chrome.storage.local.get(WORD_STARTS_STRENGTH_KEY).then(
      (stored) => strengthChosen || applyStrength(stored[WORD_STARTS_STRENGTH_KEY]), // a choice before the answer came wins
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
