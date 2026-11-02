// The owner's own rules for the learning filter, and the few records the filter keeps on this computer (contracts §5):
// - "Never save this file": a salted fingerprint in the local-only store (`sop-local`), read before any page is read;
// - the deny and allow lists: the synced settings `filter.deny` and `filter.allow` in the library store;
// - "Report a wrong decision": the owner's label and a salted fingerprint, never the file.
// The list of forgotten readings is not here: it is the library store's own, written with Forget's delete (R88, R89).
//
// Privacy: every record here is the owner's own action. Nothing is written because a PDF was opened, and nothing about a
// PDF is logged. In Incognito there is no rules source at all (nothing is saved there).
import type { FilterRules, Sha256 } from '@sop/core';
import type { FilterReportLabel, LocalOnlyStore } from '../../local-only/secrets-store';
import type { StoreClient } from '../../store/client';

/** The synced settings that hold the lists (contracts §5): JSON arrays of hosts, web addresses and folders. */
export const ALLOW_LIST_KEY = 'filter.allow';
export const DENY_LIST_KEY = 'filter.deny';

export type FilterLists = Pick<FilterRules, 'deny' | 'allow'>;

export interface FilterRulesSource {
  /** The owner's choice for these exact bytes. Rejects when it cannot be read: the caller must not save on its own then. */
  fileChoice(sha: Sha256): Promise<'never' | null>;
  /** The deny and allow lists. Rejects when they cannot be read. */
  lists(): Promise<FilterLists>;
  /** "Always for this site": adds a host or folder to the allow list. */
  allow(entry: string): Promise<void>;
  /** "Never for this file" (or Forget's "Never save this file"). */
  neverSave(shas: readonly Sha256[]): Promise<void>;
  /** The PDF was saved: the owner's latest choice wins, so it is not "never save" any more. */
  saved(shas: readonly Sha256[]): Promise<void>;
  /** "Report a wrong decision". */
  report(sha: Sha256, label: FilterReportLabel): Promise<void>;
}

export interface RulesSourceDeps {
  /** The local-only store; null when it cannot be opened. */
  local(): Promise<LocalOnlyStore | null>;
  /**
   * Whether the local-only database exists yet. Reads ask this first, so opening a PDF never creates the database: until
   * the owner keeps a choice, there is nothing to read. Left out: assume it does.
   */
  localExists?(): Promise<boolean>;
  /** The library store; null when it cannot be reached. */
  store(): Promise<StoreClient | null>;
}

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

export function createRulesSource(d: RulesSourceDeps): FilterRulesSource {
  async function local(): Promise<LocalOnlyStore> {
    const l = await d.local();
    if (l === null) throw new Error('local-only-unavailable: this computer’s private store could not be opened');
    return l;
  }
  /** For a read: null when nothing was ever kept here (the database does not exist), so a read creates nothing. */
  async function readable(): Promise<LocalOnlyStore | null> {
    if (d.localExists !== undefined && !(await d.localExists())) return null;
    return local();
  }
  async function store(): Promise<StoreClient> {
    const s = await d.store();
    if (s === null) throw new Error('library-unavailable: the library could not be opened in this tab');
    return s;
  }
  const each = async (shas: readonly Sha256[], f: (sha: Sha256) => Promise<void>): Promise<void> => {
    for (const sha of new Set(shas)) if (sha.length > 0) await f(sha);
  };

  return {
    async fileChoice(sha) {
      const l = await readable();
      return l !== null && (await l.isNeverSave(sha)) ? 'never' : null;
    },
    async lists() {
      const s = await store();
      const [deny, allow] = await Promise.all([s.getSetting(DENY_LIST_KEY), s.getSetting(ALLOW_LIST_KEY)]);
      return { deny: stringList(deny), allow: stringList(allow) };
    },
    async allow(entry) {
      await (await store()).addToSettingList(ALLOW_LIST_KEY, entry);
    },
    async neverSave(shas) {
      const l = await local();
      await each(shas, (sha) => l.addNeverSave(sha));
    },
    async saved(shas) {
      const l = await readable();
      if (l === null) return; // nothing was ever kept, so there is nothing to take back
      await each(shas, (sha) => l.removeNeverSave(sha));
    },
    async report(sha, label) {
      await (await local()).addFilterReport(sha, label);
    },
  };
}

/** What "Always for this site" adds to the allow list for a PDF's link. */
export interface SiteRule {
  /** The list entry: a host ("moodle.lse.ac.uk"), or a folder on this computer ("/home/me/Readings/"). */
  entry: string;
  /** "site" for a web link, "folder" for a file on this computer: the button says "Always for this site" or "… folder". */
  kind: 'site' | 'folder';
}

/**
 * The allow-list entry for a PDF's own link: its host for a web link (without a leading "www.", so the whole site counts),
 * its folder for a file on this computer. Null for anything else (a file picked from disk, a blob link): there is no site.
 */
export function siteRuleFor(link: string | null): SiteRule | null {
  if (link === null) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    return host === '' ? null : { entry: host, kind: 'site' };
  }
  if (url.protocol === 'file:') {
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    if (folder === '' || folder === '/') return null; // never the whole disk
    // file:///C:/Users/me/x.pdf has the path /C:/Users/me/; a Windows drive loses its leading slash
    const local = folder.replace(/^\/([A-Za-z]:\/)/, '$1');
    if (/^[A-Za-z]:\/$/.test(local)) return null;
    const share = url.host !== '' && url.host !== 'localhost' ? `//${url.host}${local}` : local;
    return { entry: share, kind: 'folder' };
  }
  return null;
}
