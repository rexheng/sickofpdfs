// The few `chrome.*` calls the extension's viewer and library make, answered inside the app. It must be the first module a
// page loads: several extension modules read `chrome` as soon as they load (the viewer's engine reads chrome.runtime.getURL).
//
// The app is one WebView that shows one page at a time, so a "tab" is the page on screen: opening a tab goes to that page (Back
// comes back), and a web link leaves the app for the phone's browser, only when the owner clicked it. Nothing here sends
// anything over the network.
import { isNativeApp, SopPlatform } from './native';

/** The app's version, from apps/mobile/package.json (vite.config.ts). */
declare const __SOP_APP_VERSION__: string;

type Listener = (...args: never[]) => unknown;

/** A `chrome.events.Event` that only this page fires. */
function event<L extends Listener>() {
  const listeners = new Set<L>();
  return {
    addListener: (l: L) => void listeners.add(l),
    removeListener: (l: L) => void listeners.delete(l),
    hasListener: (l: L) => listeners.has(l),
    hasListeners: () => listeners.size > 0,
    fire: (...args: Parameters<L>) => {
      for (const l of [...listeners]) {
        try {
          (l as (...a: Parameters<L>) => unknown)(...args);
        } catch (e) {
          console.error('sickofpdfs: a storage listener failed', e);
        }
      }
    },
  };
}

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type AreaName = 'local' | 'session';
const storageChanged = event<(changes: Record<string, StorageChange>, area: AreaName) => void>();

/** `chrome.storage.local` (localStorage) or `.session` (sessionStorage, which lasts as long as the app's page history). */
function storageArea(area: AreaName) {
  const prefix = `sop-chrome-${area}:`;
  const backing = (): Storage | null => {
    try {
      return area === 'local' ? localStorage : sessionStorage;
    } catch {
      return null;
    }
  };
  const read = (key: string): unknown => {
    const raw = backing()?.getItem(prefix + key);
    if (raw === null || raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  };
  const allKeys = (): string[] => {
    const s = backing();
    if (s === null) return [];
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k?.startsWith(prefix)) keys.push(k.slice(prefix.length));
    }
    return keys;
  };
  const done = <T>(value: T, cb: unknown): Promise<T> => {
    if (typeof cb === 'function') queueMicrotask(() => (cb as (v: T) => void)(value));
    return Promise.resolve(value);
  };
  return {
    get(keys?: string | string[] | Record<string, unknown> | null, cb?: unknown) {
      const out: Record<string, unknown> = {};
      if (keys === null || keys === undefined) {
        for (const k of allKeys()) out[k] = read(k);
      } else if (typeof keys === 'string' || Array.isArray(keys)) {
        for (const k of typeof keys === 'string' ? [keys] : keys) {
          const v = read(k);
          if (v !== undefined) out[k] = v;
        }
      } else {
        for (const [k, fallback] of Object.entries(keys)) out[k] = read(k) ?? fallback;
      }
      return done(out, cb);
    },
    set(items: Record<string, unknown>, cb?: unknown) {
      const changes: Record<string, StorageChange> = {};
      const s = backing();
      for (const [k, v] of Object.entries(items)) {
        const oldValue = read(k);
        if (v === undefined) continue;
        try {
          s?.setItem(prefix + k, JSON.stringify(v));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
        changes[k] = { oldValue, newValue: v };
      }
      if (Object.keys(changes).length > 0) queueMicrotask(() => storageChanged.fire(changes, area));
      return done(undefined, cb);
    },
    remove(keys: string | string[], cb?: unknown) {
      const changes: Record<string, StorageChange> = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        const oldValue = read(k);
        if (oldValue === undefined) continue;
        backing()?.removeItem(prefix + k);
        changes[k] = { oldValue };
      }
      if (Object.keys(changes).length > 0) queueMicrotask(() => storageChanged.fire(changes, area));
      return done(undefined, cb);
    },
    clear(cb?: unknown) {
      void this.remove(allKeys());
      return done(undefined, cb);
    },
  };
}

/** The app's own address for a file of the build (the extension's `chrome.runtime.getURL`). */
export const appUrl = (path: string): string => `${location.origin}/${path.replace(/^\/+/, '')}`;

/** Is `url` a page or file of the app itself (or a blob: link this page made)? */
export function isAppUrl(url: string): boolean {
  return url.startsWith(`${location.origin}/`) || url.startsWith(`blob:${location.origin}/`);
}

/**
 * Shows `url`: a page of the app replaces the one on screen (Back comes back to it); a web link opens in the phone's browser.
 * Anything else (a file:// link, chrome://) cannot be shown on the phone and is left alone.
 */
export function navigate(url: string, o: { replace?: boolean } = {}): void {
  if (isAppUrl(url)) {
    if (o.replace === true) location.replace(url);
    else location.assign(url);
    return;
  }
  if (/^https?:/i.test(url)) {
    if (isNativeApp()) void SopPlatform.openExternal({ url }).catch(() => {});
    else window.open(url, '_blank', 'noopener');
  }
}

/** The one "tab": the page on screen. */
const thisTab = () => ({ id: 1, index: 0, windowId: 1, active: true, url: location.href, incognito: false });

/** The answers the extension's service worker would give the viewer (shared/messages.ts). */
function answer(message: unknown): unknown {
  const m = message as { type?: unknown; url?: unknown };
  switch (m.type) {
    case 'takeover:prepare-fetch':
      // Only the app's own pages open the viewer, so every address it is given is one the owner opened.
      return { known: typeof m.url === 'string' && isAppUrl(m.url), referer: null, back: null, pageTitle: null };
    case 'takeover:open-in-chrome':
      return { ok: false };
    case 'takeover:embedded':
      return { opened: false };
    case 'takeover:can-take-over':
      return false;
    default:
      return undefined;
  }
}

const manifest = { manifest_version: 3, name: 'sickofpdfs', version: __SOP_APP_VERSION__, description: 'A PDF reader with highlights and comments.' };

const shim = {
  runtime: {
    id: 'com.sickofpdfs.reader',
    getURL: appUrl,
    getManifest: () => ({ ...manifest }),
    sendMessage: (message: unknown) => Promise.resolve(answer(message)),
    onMessage: event(),
    onStartup: event(),
    onInstalled: event(),
    getContexts: () => Promise.resolve([]),
    lastError: undefined,
  },
  extension: {
    inIncognitoContext: false,
    isAllowedFileSchemeAccess: () => Promise.resolve(true),
  },
  storage: {
    local: storageArea('local'),
    session: storageArea('session'),
    onChanged: storageChanged,
  },
  tabs: {
    create: (o: { url?: string }) => {
      if (typeof o.url === 'string') navigate(o.url);
      return Promise.resolve(thisTab());
    },
    update: (idOrProps: number | { url?: string }, props?: { url?: string }) => {
      const p = typeof idOrProps === 'number' ? props : idOrProps;
      if (typeof p?.url === 'string') navigate(p.url);
      return Promise.resolve(thisTab());
    },
    getCurrent: () => Promise.resolve(thisTab()),
    get: () => Promise.resolve(thisTab()),
    query: () => Promise.resolve([thisTab()]),
    reload: () => {
      location.reload();
      return Promise.resolve();
    },
    onRemoved: event(),
    onUpdated: event(),
    onActivated: event(),
  },
  windows: { update: () => Promise.resolve({}) },
  action: { setBadgeText: () => Promise.resolve(), setBadgeBackgroundColor: () => Promise.resolve(), setTitle: () => Promise.resolve() },
};

(globalThis as { chrome?: unknown }).chrome = shim;
