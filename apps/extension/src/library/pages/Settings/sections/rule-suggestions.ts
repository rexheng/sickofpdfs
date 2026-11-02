// Settings → Library rules: places the owner saves from often, offered for the "save from" list with a switch that starts
// off (spec: "suggestions such as moodle.lse.ac.uk that you switch on yourself"). Only places R91 lets on that list are
// offered, so Downloads, mail attachments, Drive and the like never appear.
import { listEntryProblem, listMatches } from '@sop/core';
import type { LibraryItem } from '../../../data/types';

export interface RuleSuggestion {
  /** What goes on the list: a site ("moodle.lse.ac.uk") or a folder ("C:\Users\me\Courses\EC1A1"). */
  entry: string;
  kind: 'site' | 'folder';
  /** How many saved readings came from there. */
  readings: number;
}

/** At least this many readings from one place make it a suggestion. */
export const SUGGEST_FROM = 2;
const MAX_SUGGESTIONS = 5;

/** The site or folder a reading's link names, as an entry would be written; null for other links. */
function placeOf(link: string): { entry: string; kind: 'site' | 'folder' } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname === '' ? null : { entry: url.hostname.toLowerCase().replace(/^www\./, ''), kind: 'site' };
  if (url.protocol !== 'file:') return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const folder = path.slice(0, path.lastIndexOf('/'));
  if (folder === '') return null;
  // file:///C:/Users/me/x.pdf is a Windows path: written with its drive and back slashes, as Explorer shows it
  const windows = /^\/[A-Za-z]:\//.test(folder);
  return { entry: windows ? folder.slice(1).replaceAll('/', '\\') : folder, kind: 'folder' };
}

/** The suggestions for the "save from" list: places on neither list, not covered by an allow entry, and allowed by R91. */
export function ruleSuggestions(items: readonly LibraryItem[], allow: readonly string[], deny: readonly string[]): RuleSuggestion[] {
  const listed = new Set([...allow, ...deny].map((e) => e.trim().toLowerCase()));
  const places = new Map<string, RuleSuggestion & { link: string }>();
  for (const item of items) {
    const link = item.location?.raw;
    if (item.doc.deletedAt !== null || link === undefined) continue;
    const place = placeOf(link);
    if (place === null) continue;
    const key = place.entry.toLowerCase();
    const seen = places.get(key);
    if (seen !== undefined) seen.readings++;
    else places.set(key, { ...place, readings: 1, link });
  }
  return [...places.values()]
    .filter((p) => p.readings >= SUGGEST_FROM && !listed.has(p.entry.toLowerCase()))
    .filter((p) => listEntryProblem(p.entry, 'allow') === null)
    .filter((p) => !listMatches(allow, p.link, null, 'allow') && !listMatches(deny, p.link, null, 'deny'))
    .sort((a, b) => b.readings - a.readings || a.entry.localeCompare(b.entry))
    .slice(0, MAX_SUGGESTIONS)
    .map((p): RuleSuggestion => ({ entry: p.entry, kind: p.kind, readings: p.readings }));
}
