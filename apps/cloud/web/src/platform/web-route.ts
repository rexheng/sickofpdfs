// The web library's two kinds of address:
//   /#/<page>                       a library page, as in the extension (`library.html#/<page>`): Home, My library, Notes, …
//   /d/<sha>?page=N#c=<thread id>   a reading's own page, at page N (1-based) and a note (plan CL13's deep link)
// Moving between them never reloads the page, so the library in this tab is filled from the cloud once.
import { useSyncExternalStore } from 'react';

export type WebRoute = { kind: 'library' } | { kind: 'reading'; sha: string; page: number | null; note: string | null };

const READING = /^\/d\/([0-9a-f]{64})\/?$/;
const CHANGED = 'sop:web-route';

export function readingHref(sha: string, o: { page?: number | null; note?: string | null } = {}): string {
  const page = o.page !== null && o.page !== undefined && o.page >= 1 ? `?page=${Math.floor(o.page)}` : '';
  const note = o.note ? `#c=${encodeURIComponent(o.note)}` : '';
  return `/d/${sha}${page}${note}`;
}

/** Goes to a page of the web library without reloading. Back comes back. */
export function goTo(href: string, o: { replace?: boolean } = {}): void {
  if (o.replace === true) history.replaceState(null, '', href);
  else history.pushState(null, '', href);
  window.dispatchEvent(new Event(CHANGED));
  if (READING.test(location.pathname)) window.scrollTo(0, 0);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null; // a stray "%" in a hand-typed address
  }
}

function read(): WebRoute {
  const m = READING.exec(location.pathname);
  if (m === null) return { kind: 'library' };
  const page = Number(new URLSearchParams(location.search).get('page'));
  const note = /^#c=(.+)$/.exec(location.hash)?.[1];
  return { kind: 'reading', sha: m[1] ?? '', page: Number.isInteger(page) && page >= 1 ? page : null, note: note ? safeDecode(note) : null };
}

// The same answer until the address changes, as useSyncExternalStore needs.
let key = '';
let current: WebRoute = { kind: 'library' };
function snapshot(): WebRoute {
  const k = `${location.pathname}${location.search}${location.hash}`;
  if (k !== key) {
    key = k;
    current = read();
  }
  return current;
}

/** A library page's link (`#/home`) clicked on a reading's page: the library page, at the web library's own address. */
function onHashChange(): void {
  if (location.pathname !== '/' && location.hash.startsWith('#/')) history.replaceState(null, '', `/${location.hash}`);
  window.dispatchEvent(new Event(CHANGED));
}
if (typeof window !== 'undefined') window.addEventListener('hashchange', onHashChange);

function subscribe(cb: () => void): () => void {
  window.addEventListener(CHANGED, cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener(CHANGED, cb);
    window.removeEventListener('popstate', cb);
  };
}

export function useWebRoute(): WebRoute {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
