// Your own rules: the allow and deny lists. An entry is a site ("moodle.lse.ac.uk"), a site with a folder
// ("example.com/readings/"), a web address prefix ("https://example.com/readings/") or a folder on this computer
// ("C:\Users\me\Readings" or "/home/me/readings").
//
// A site entry matches that host and its subdomains on whole labels, so "lse.ac.uk" does not match "notlse.ac.uk".

import { parseLink } from './hosts';

interface Target {
  /** http(s) host and path, or null for other links. */
  web: { host: string; path: string; href: string } | null;
  /** A file link's path in the form "c:/users/me/x.pdf" or "/home/me/x.pdf", lower-case; or null. */
  file: string | null;
}

function toTarget(link: string | null | undefined): Target {
  const none: Target = { web: null, file: null };
  const parts = parseLink(link);
  if (!parts || !link) return none;
  if (parts.protocol === 'http:' || parts.protocol === 'https:') {
    return { web: { host: parts.host, path: parts.path, href: `${parts.protocol}//${parts.host}${parts.path}` }, file: null };
  }
  if (parts.protocol === 'file:') {
    // file:///C:/Users/me/x.pdf has the path /c:/users/me/x.pdf; a Windows drive loses its leading slash
    const path = parts.path.replace(/^\/([a-z]:\/)/, '$1');
    const share = parts.host && parts.host !== 'localhost' ? `//${parts.host}${path}` : path;
    return { web: null, file: share };
  }
  return none;
}

function isFolderPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith('/') || path.length === prefix.length || path[prefix.length] === '/';
}

function entryMatches(entryRaw: string, t: Target): boolean {
  const entry = entryRaw.trim().toLowerCase();
  if (!entry) return false;

  // a folder on this computer: a Windows path, a network path or a rooted path
  if (/^[a-z]:[\\/]/.test(entry) || entry.startsWith('\\\\') || entry.startsWith('/')) {
    if (t.file === null) return false;
    const prefix = entry.replaceAll('\\', '/').replace(/^\/\/+/, '//');
    return isFolderPrefix(t.file, prefix);
  }
  if (entry.startsWith('file:')) {
    if (t.file === null) return false;
    const e = toTarget(entry).file;
    return e !== null && isFolderPrefix(t.file, e);
  }

  if (t.web === null) return false;

  // a web address prefix
  if (/^https?:\/\//.test(entry)) {
    const e = toTarget(entry).web;
    if (!e) return false;
    const rootOnly = e.path === '/' || e.path === '';
    if (t.web.host !== e.host && !(rootOnly && t.web.host.endsWith(`.${e.host}`))) return false;
    return rootOnly || isFolderPrefix(t.web.path, e.path);
  }

  // a site, optionally with a folder: "example.com" or "example.com/readings/"
  const slash = entry.indexOf('/');
  const hostPart = (slash < 0 ? entry : entry.slice(0, slash)).replace(/^\*\./, '').replace(/:\d+$/, '');
  const pathPart = slash < 0 ? '' : entry.slice(slash);
  if (!hostPart) return false;
  // a one-word entry such as "com" names one host ("moodle" on an intranet), not every site that ends in it
  const subdomains = hostPart.includes('.');
  if (t.web.host !== hostPart && !(subdomains && t.web.host.endsWith(`.${hostPart}`))) return false;
  return pathPart === '' || pathPart === '/' || isFolderPrefix(t.web.path, pathPart);
}

/**
 * True when any list entry matches the PDF's own link or the page it was opened from. Entries that cannot be read
 * never match, so a typo in the list can only fail to apply, never apply to everything.
 */
export function listMatches(entries: readonly string[] | undefined, url: string | null, viaPage?: string | null): boolean {
  if (!entries?.length) return false;
  const targets = [toTarget(url), toTarget(viaPage)];
  return entries.some((e) => targets.some((t) => entryMatches(e, t)));
}
