// A view switch remembered on this computer for every PDF (chrome.storage.local), off until the owner turns it on, and
// followed live by every open viewer tab (chrome.storage.onChanged). The value is one boolean: nothing about any PDF is
// stored. It is a view setting, so an Incognito tab may change it too, as Chrome's own settings can be changed there.
import { useSyncExternalStore } from 'react';

export interface RememberedSwitch {
  get(this: void): boolean;
  /** Calls `onChange` whenever the switch changes, in this tab or another. */
  subscribe(this: void, onChange: () => void): () => void;
  /** Turns it the other way here at once, and remembers it for every tab. Returns the new value. */
  toggle(this: void): boolean;
  /** Turns it on or off here at once, and remembers it for every tab. */
  set(this: void, on: boolean): void;
}

/** The switch stored under `key`. Outside an extension page (unit tests) it stays off and is not stored. */
export function rememberedSwitch(key: string, what: string): RememberedSwitch {
  let on = false;
  let touched = false;
  let started = false;
  const listeners = new Set<() => void>();
  const apply = (next: boolean) => {
    if (next === on) return;
    on = next;
    for (const l of [...listeners]) l();
  };
  const start = () => {
    if (started) return;
    started = true;
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        const change = changes[key];
        if (area !== 'local' || change === undefined) return;
        apply(change.newValue === true);
      });
      chrome.storage.local.get(key).then(
        (stored) => {
          if (!touched) apply(stored[key] === true); // a toggle before the answer came wins
        },
        () => {},
      );
    } catch {
      // not an extension page: the switch stays off
    }
  };
  const get = () => {
    start();
    return on;
  };
  const set = (next: boolean) => {
    start();
    touched = true;
    apply(next);
    try {
      chrome.storage.local.set({ [key]: next }).catch((err: unknown) => console.error(`sickofpdfs: could not remember the ${what} switch`, err));
    } catch {
      // not an extension page
    }
  };
  return {
    get,
    subscribe(onChange) {
      start();
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    toggle() {
      const next = !get();
      set(next);
      return next;
    },
    set,
  };
}

/** A switch, for a component: re-renders when it changes. */
export function useSwitch(s: RememberedSwitch): boolean {
  return useSyncExternalStore(s.subscribe, s.get);
}
