// The few `chrome.*` calls the extension's library makes, answered inside the web library (adapted from the phone app's shim,
// apps/mobile/src/platform/chrome-shim.ts). It must be the first module the page loads: several extension modules read `chrome`
// as soon as they load.
//
// A "tab" is this page: opening the viewer for a reading goes to the reading's page here (Back comes back), and a web link opens
// in a new browser tab, only when the owner clicked it. Nothing here sends anything over the network.
import { parseViewerUrl } from '@ext/shared/viewer-url';
import { goTo, readingHref } from './web-route';

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

/** The web library's own address for a file of the build (the extension's `chrome.runtime.getURL`). */
export const appUrl = (path: string): string => `${location.origin}/${path.replace(/^\/+/, '')}`;

/** Is `url` a page or file of the web library itself? */
export function isAppUrl(url: string): boolean {
  return url.startsWith(`${location.origin}/`);
}

/**
 * Shows `url`: the extension's viewer address for a reading goes to that reading's page here; another page of the web library
 * replaces this one; a web link opens in a new browser tab (it never learns where it was opened from). Anything else (a
 * file:// link, chrome://) cannot be shown in a browser page and is left alone.
 */
export function navigate(url: string): void {
  if (url.startsWith(appUrl('viewer.html'))) {
    const p = parseViewerUrl(url);
    if (typeof p.doc === 'string' && /^[0-9a-f]{64}$/.test(p.doc)) goTo(readingHref(p.doc, { page: p.page, note: p.note ?? null }));
    return;
  }
  if (isAppUrl(url)) {
    location.assign(url);
    return;
  }
  if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

/** The one "tab": the page on screen. */
const thisTab = () => ({ id: 1, index: 0, windowId: 1, active: true, url: location.href, incognito: false });

/** No service worker answers here: every message the library sends gets "nothing". */
const answer = (): unknown => undefined;

const manifest = { manifest_version: 3, name: 'sickofpdfs', version: __SOP_APP_VERSION__, description: 'Your sickofpdfs library on the web.' };

const shim = {
  runtime: {
    id: 'sickofpdfs-web',
    getURL: appUrl,
    getManifest: () => ({ ...manifest }),
    sendMessage: () => Promise.resolve(answer()),
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
