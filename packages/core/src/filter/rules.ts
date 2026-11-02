// Your own rules: the allow and deny lists. An entry is a site ("moodle.lse.ac.uk"), a site with a folder
// ("example.com/readings/"), a web address prefix ("https://example.com/readings/") or a folder on this computer
// ("C:\Users\me\Courses\Readings" or "/home/me/courses/readings").
//
// A site entry matches that host and its subdomains on whole labels, so "lse.ac.uk" does not match "notlse.ac.uk".
//
// R91: the owner's choices can only make the filter more careful, never less. So:
// - both lists refuse an entry that would match far more than one place, and drop it when it is read: a bare top-level
//   domain ("com"), a bare shared suffix ("co.uk"), `/`, a drive root, `file:///`, the folder that holds the home folders;
// - the allow list also refuses catch-all places, where everyone's receipts, payslips and CVs land: Downloads, Desktop,
//   Documents, the home folder, anything less than two levels below home, temp folders; mail attachments; Drive, OneDrive,
//   Dropbox and iCloud downloads; shared object stores; chat file hosts. The banner never offers them either.
// The same check runs for an entry the banner makes, one the owner types, and one that arrives by sync.

import { parseLink } from './hosts';

export type ListKind = 'allow' | 'deny';

/** The longest list entry: a site, a web address or a folder. */
export const MAX_LIST_ENTRY = 2048;

// ---- the shared deny set (R91) ---------------------------------------------------------------------------------------

/**
 * Hosts that serve everyone's files. The allow list never holds one of these, a host under one, or a host above one
 * ("google.com" holds mail.google.com and drive.google.com).
 */
export const CATCH_ALL_HOSTS: readonly string[] = [
  // mail attachments (Gmail, Outlook and other webmail)
  'mail.google.com', 'googleusercontent.com', 'outlook.com', 'outlook.live.com', 'outlook.office.com',
  'outlook.office365.com', 'attachments.office.net', 'mail.yahoo.com', 'proton.me',
  // Drive, OneDrive, Dropbox and iCloud downloads, and file-sending services
  'drive.google.com', 'docs.google.com', 'usercontent.google.com', 'onedrive.live.com', 'onedrive.com', '1drv.ms',
  '1drv.com', 'sharepoint.com', 'dropbox.com', 'dropboxusercontent.com', 'icloud.com', 'icloud-content.com', 'box.com',
  'boxcloud.com', 'wetransfer.com',
  // shared object stores (and Google Cloud Storage, matched by GOOGLE_APIS below)
  'amazonaws.com', 'storage.cloud.google.com', 'blob.core.windows.net',
  'digitaloceanspaces.com', 'r2.dev', 'r2.cloudflarestorage.com', 'backblazeb2.com', 'wasabisys.com',
  // chat file hosts
  'slack.com', 'slack-edge.com', 'slack-files.com', 'discord.com', 'discordapp.com', 'discordapp.net',
  'teams.microsoft.com', 'teams.live.com', 'whatsapp.net', 'telegram.org',
];

/** A folder with one of these names, anywhere in the path, is where files land by themselves: never on the allow list. */
const TRANSIENT_FOLDERS: ReadonlySet<string> = new Set([
  'downloads', 'download', 'tmp', 'temp', 'appdata', 'library', 'cache', 'caches', '.cache', 'inetcache',
  'content.outlook', 'mail downloads', 'temporary internet files',
]);

/** A folder with one of these names holds everything of its kind: never on the allow list itself. */
const CATCH_ALL_FOLDERS: ReadonlySet<string> = new Set([
  'desktop', 'documents', 'my documents', 'onedrive', 'dropbox', 'google drive', 'googledrive', 'my drive',
  'icloud drive', 'icloud', 'mobile documents', 'box', 'home', 'users', 'public', 'shared', 'attachments',
]);

/** Second-level names that many sites share ("co.uk", "ac.jp"): as a whole entry they name every site under them. */
const SHARED_SUFFIX = /^(?:co|com|ac|edu|gov|govt|org|net|or|ne|go|nhs|sch|ltd|plc|me|mil|nic|police|nom|gob|gv)\.[a-z]{2}$/;

/**
 * Google's API hosts, Google Cloud Storage among them (storage.<this>.com). Written as a pattern because the plain address
 * would trip the build's check for CDN addresses in the bundle (apps/extension/scripts/check-no-cdn.mjs); here it is only a
 * place the allow list refuses, never an address anything fetches.
 */
const GOOGLE_APIS = /(^|\.)google(?:apis)\.com$/;

const underHost = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/** True for a host on the catch-all list, under one, or above one. */
export function isCatchAllHost(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/\.$/, '');
  return GOOGLE_APIS.test(host) || CATCH_ALL_HOSTS.some((c) => underHost(host, c) || underHost(c, host));
}

// ---- reading an entry ------------------------------------------------------------------------------------------------

type Entry =
  | { kind: 'web'; host: string; path: string; rootOnly: boolean; prefix: boolean }
  | { kind: 'folder'; path: string }
  | { kind: 'bad' };

/** A file link's path in the form "c:/users/me/x.pdf", "//server/share/x.pdf" or "/home/me/x.pdf", lower-case; or null. */
function fileLinkPath(link: string): string | null {
  const parts = parseLink(link);
  if (!parts || parts.protocol !== 'file:') return null;
  // file:///C:/Users/me/x.pdf has the path /c:/users/me/x.pdf; a Windows drive loses its leading slash
  const path = parts.path.replace(/^\/([a-z]:\/)/, '$1');
  return parts.host && parts.host !== 'localhost' ? `//${parts.host}${path}` : path;
}

const HOST_CHARS = /^[a-z0-9.-]+$|^\[[0-9a-f:.]+\]$/;

function readEntry(raw: string): Entry {
  const entry = raw.trim().toLowerCase();
  if (!entry || entry.length > MAX_LIST_ENTRY) return { kind: 'bad' };
  // a folder on this computer: a Windows path, a network path or a rooted path
  if (/^[a-z]:([\\/]|$)/.test(entry) || entry.startsWith('\\\\') || entry.startsWith('/')) {
    return { kind: 'folder', path: entry.replaceAll('\\', '/').replace(/^\/\/+/, '//') };
  }
  if (entry.startsWith('file:')) {
    const path = fileLinkPath(entry);
    return path === null ? { kind: 'bad' } : { kind: 'folder', path };
  }
  // a web address prefix
  if (/^https?:\/\//.test(entry)) {
    const parts = parseLink(entry);
    if (!parts || !parts.host) return { kind: 'bad' };
    return { kind: 'web', host: parts.host, path: parts.path, rootOnly: parts.path === '/' || parts.path === '', prefix: true };
  }
  if (/^[a-z][a-z0-9+.-]*:/.test(entry) && !/^[^/:]+:\d+(\/|$)/.test(entry)) return { kind: 'bad' }; // another kind of link
  // a site, optionally with a folder: "example.com" or "example.com/readings/"
  const slash = entry.indexOf('/');
  const host = (slash < 0 ? entry : entry.slice(0, slash)).replace(/^\*\./, '').replace(/:\d+$/, '').replace(/\.$/, '');
  const path = slash < 0 ? '' : entry.slice(slash);
  if (!host || !HOST_CHARS.test(host)) return { kind: 'bad' };
  return { kind: 'web', host, path, rootOnly: path === '' || path === '/', prefix: false };
}

/** A folder path's folders, and how many of them make its root: a home folder, a drive, a network share, or none (`/`). */
function folderParts(path: string): { parts: string[]; base: number; home: boolean } {
  const parts = path.split('/').filter((s) => s !== '');
  if (path.startsWith('//')) return { parts, base: 2, home: false }; // //server/share
  const [a, b] = parts;
  if (a !== undefined && /^[a-z]:$/.test(a)) {
    if (b === 'users' || b === 'documents and settings') return { parts, base: 3, home: true };
    return { parts, base: 1, home: false };
  }
  if (a === 'home' || a === 'users') return { parts, base: 2, home: true };
  if (a === 'root') return { parts, base: 1, home: true };
  if (a === 'var' && b === 'home') return { parts, base: 3, home: true };
  if (a === 'mnt' && b !== undefined && /^[a-z]$/.test(b) && parts[2] === 'users') return { parts, base: 4, home: true }; // WSL
  if (a === 'mnt' || a === 'volumes') return { parts, base: 2, home: false };
  if (a === 'media') return { parts, base: 3, home: false }; // /media/<user>/<drive>
  if (a === 'run' && b === 'media') return { parts, base: 4, home: false };
  return { parts, base: 0, home: false };
}

/** Why a folder entry is refused, or null. The allow list adds R91's catch-all places. */
function folderProblem(path: string, list: ListKind): string | null {
  const { parts, base, home } = folderParts(path);
  if (parts.length === 0) return 'the whole computer';
  if (parts.length < base) return home ? 'every home folder' : 'a whole drive';
  const below = parts.length - base;
  if (below === 0 && !home) return 'a whole drive';
  if (list === 'deny') return null;
  // R91: a folder of its own, at least two levels below home (or below a drive)
  if (below < 2) return home ? 'less than two levels below home' : 'less than two levels below a drive';
  const inside = home ? parts.slice(base) : parts;
  if (inside.some((s) => TRANSIENT_FOLDERS.has(s)) || (base === 0 && (parts[0] === 'var' || parts[0] === 'private'))) {
    return 'a folder files land in by themselves';
  }
  const last = parts[parts.length - 1] ?? '';
  if (CATCH_ALL_FOLDERS.has(last) || last.startsWith('onedrive - ')) return 'a folder that holds everything';
  return null;
}

/** Why a site or web address entry is refused, or null. */
function webProblem(host: string, list: ListKind): string | null {
  const bare = host.replace(/^\[|\]$/g, '');
  if (!bare.includes('.') && !bare.includes(':')) return 'a top-level domain, or a single name';
  if (SHARED_SUFFIX.test(bare)) return 'a name many sites share';
  if (list === 'allow' && isCatchAllHost(bare)) return 'a place that serves everyone’s files';
  return null;
}

/**
 * Why `entry` cannot go on the list, in plain words, or null when it can (R91). Both lists refuse an entry that would apply
 * to everything; the allow list also refuses catch-all places.
 */
export function listEntryProblem(entry: unknown, list: ListKind): string | null {
  if (typeof entry !== 'string') return 'not a site or folder';
  const e = readEntry(entry);
  if (e.kind === 'bad') return 'not a site or folder';
  return e.kind === 'folder' ? folderProblem(e.path, list) : webProblem(e.host, list);
}

/** True when `entry` may be on the list. */
export const isListEntryOk = (entry: unknown, list: ListKind): entry is string => listEntryProblem(entry, list) === null;

/** A stored list as the filter reads it: the entries that may be on that list, trimmed (R91: bad ones are dropped on read). */
export function cleanList(value: unknown, list: ListKind): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => isListEntryOk(x, list)).map((x) => x.trim()) : [];
}

// ---- matching --------------------------------------------------------------------------------------------------------

interface Target {
  /** http(s) host and path, or null for other links. */
  web: { host: string; path: string } | null;
  /** A file link's path in the form "c:/users/me/x.pdf" or "/home/me/x.pdf", lower-case; or null. */
  file: string | null;
}

function toTarget(link: string | null | undefined): Target {
  const none: Target = { web: null, file: null };
  const parts = parseLink(link);
  if (!parts || !link) return none;
  if (parts.protocol === 'http:' || parts.protocol === 'https:') return { web: { host: parts.host, path: parts.path }, file: null };
  if (parts.protocol === 'file:') return { web: null, file: fileLinkPath(link) };
  return none;
}

function isFolderPrefix(path: string, prefix: string): boolean {
  if (!path.startsWith(prefix)) return false;
  return prefix.endsWith('/') || path.length === prefix.length || path[prefix.length] === '/';
}

function entryMatches(e: Entry, t: Target): boolean {
  if (e.kind === 'bad') return false;
  if (e.kind === 'folder') return t.file !== null && isFolderPrefix(t.file, e.path);
  if (t.web === null) return false;
  // A site matches its subdomains, as does a web address of a whole site; a one-word host names that one host only.
  const subdomains = e.host.includes('.') && (!e.prefix || e.rootOnly);
  if (t.web.host !== e.host && !(subdomains && t.web.host.endsWith(`.${e.host}`))) return false;
  return e.rootOnly || isFolderPrefix(t.web.path, e.path);
}

/**
 * True when any entry of the list matches the PDF's own link or the page it was opened from. Entries that cannot be read,
 * or that may not be on this list (R91), never match: a typo, or an entry that came by sync, can only fail to apply, never
 * apply to everything. `list` says which list it is; left out, the allow list's stricter check is used.
 */
export function listMatches(entries: readonly string[] | undefined, url: string | null, viaPage?: string | null, list: ListKind = 'allow'): boolean {
  if (!entries?.length) return false;
  const targets = [toTarget(url), toTarget(viaPage)];
  return entries.some((raw) => isListEntryOk(raw, list) && targets.some((t) => entryMatches(readEntry(raw), t)));
}
