// The owner's own rules for the learning filter, and the few records the filter keeps on this computer (contracts §5):
// - "Never save this file": a salted fingerprint in the local-only store (`sop-local`), read before any page is read. It also
//   goes to the owner's other devices (the web library's upload, the phone) as the synced setting `filter.never.<code>`. The
//   code is a one-way scramble of the fingerprint, cut to 128 bits (`neverCode`): never the fingerprint itself, so the cloud
//   cannot tell which file it is, or link it to a reading, unless it already holds that very file;
// - the deny and allow lists: the synced settings `filter.deny` and `filter.allow` in the library store;
// - "Report a wrong decision": the owner's label and a salted fingerprint, never the file.
// The list of forgotten readings is not here: it is the library store's own, written with Forget's delete (R88, R89).
//
// Privacy: every record here is the owner's own action. Nothing is written because a PDF was opened, and nothing about a
// PDF is logged. In Incognito there is no rules source at all (nothing is saved there).
import { cleanList, type FilterRules, isListEntryOk, type Sha256 } from '@sop/core';
import type { FilterReportLabel, LocalOnlyStore } from '../../local-only/secrets-store';
import type { StoreClient } from '../../store/client';

/** The synced settings that hold the lists (contracts §5): JSON arrays of hosts, web addresses and folders. */
export const ALLOW_LIST_KEY = 'filter.allow';
export const DENY_LIST_KEY = 'filter.deny';

export type FilterLists = Pick<FilterRules, 'deny' | 'allow'>;

/** The synced setting that says "Never save this file" for one file, on every device: `filter.never.<code>`, value true. */
export const NEVER_SAVE_PREFIX = 'filter.never.';

/**
 * The code a "Never save this file" choice syncs under: SHA-256 of the fingerprint with this app's own label, cut to 128 bits
 * (32 hex characters, so it can never be mistaken for a fingerprint). One way: it cannot be turned back into the fingerprint.
 */
export async function neverCode(sha: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sickofpdfs never-save v1:${sha}`)));
  return Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface FilterRulesSource {
  /**
   * The owner's choice for these bytes: 'never' when any of `shas` is kept as "never save" (R91: the reading's id, its
   * downloads and the opened copy are all kept). Rejects when it cannot be read: the caller must not save on its own then.
   */
  fileChoice(shas: Sha256 | readonly Sha256[]): Promise<'never' | null>;
  /** The deny and allow lists, without the entries that may not be on them (R91). Rejects when they cannot be read. */
  lists(): Promise<FilterLists>;
  /** "Always for …": adds a host or folder to the allow list. Rejects an entry R91 refuses. */
  allow(entry: string): Promise<void>;
  /** "Never for this file" (or Forget's "Never save this file"). */
  neverSave(shas: readonly Sha256[]): Promise<void>;
  /** R91: the owner's own explicit Save, and nothing else, takes "never save" back for these fingerprints. */
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

  /** The synced "never save" choices (made on any device) for these fingerprints. False when the library cannot be reached. */
  async function neverSynced(shas: readonly string[]): Promise<boolean> {
    const s = await d.store();
    if (s === null) return false;
    for (const sha of shas) if ((await s.getSetting(`${NEVER_SAVE_PREFIX}${await neverCode(sha)}`)) === true) return true;
    return false;
  }
  /** Keeps (true) or takes back (null) the synced choice for these fingerprints. */
  async function setSynced(shas: readonly string[], on: boolean): Promise<void> {
    const s = on ? await store() : await d.store();
    if (s === null) return;
    for (const sha of new Set(shas)) {
      if (sha.length === 0) continue;
      const key = `${NEVER_SAVE_PREFIX}${await neverCode(sha)}`;
      // taking back a choice that was never synced writes nothing
      if (on || (await s.getSetting(key)) === true) await s.setSetting(key, on ? true : null);
    }
  }

  return {
    async fileChoice(shas) {
      const list = [...new Set(typeof shas === 'string' ? [shas] : shas)].filter((sha) => sha.length > 0);
      const l = await readable();
      if (l !== null) for (const sha of list) if (await l.isNeverSave(sha)) return 'never';
      // chosen on another device (the setting came by sync)
      return (await neverSynced(list)) ? 'never' : null;
    },
    async lists() {
      const s = await store();
      const [deny, allow] = await Promise.all([s.getSetting(DENY_LIST_KEY), s.getSetting(ALLOW_LIST_KEY)]);
      return { deny: cleanList(deny, 'deny'), allow: cleanList(allow, 'allow') };
    },
    async allow(entry) {
      if (!isListEntryOk(entry, 'allow')) throw new Error('bad-input: this place cannot be on the allow list');
      await (await store()).addToSettingList(ALLOW_LIST_KEY, entry);
    },
    async neverSave(shas) {
      const l = await local();
      await each(shas, (sha) => l.addNeverSave(sha));
      await setSynced(shas, true);
    },
    async saved(shas) {
      await setSynced(shas, false);
      const l = await readable();
      if (l === null) return; // nothing was ever kept, so there is nothing to take back
      await each(shas, (sha) => l.removeNeverSave(sha));
    },
    async report(sha, label) {
      await (await local()).addFilterReport(sha, label);
    },
  };
}

/** What "Always for …" adds to the allow list for a PDF's link. */
export interface SiteRule {
  /** The list entry: a host ("moodle.lse.ac.uk"), or a folder on this computer ("/home/me/Courses/Week 3 readings/"). */
  entry: string;
  /** "site" for a web link, "folder" for a file on this computer. */
  kind: 'site' | 'folder';
  /** R91: the place's name for the button and the note: the host, or the folder's own name ("Week 3 readings"). */
  place: string;
}

/**
 * The allow-list entry for a PDF's own link: its host for a web link (without a leading "www.", so the whole site counts),
 * its folder for a file on this computer. Null when there is no place to name (a file picked from disk, a blob link), and
 * for a catch-all place R91 refuses (Downloads, a mail attachment, a shared store, a chat file host): then the banner
 * offers no "Always".
 */
export function siteRuleFor(link: string | null): SiteRule | null {
  if (link === null) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  let rule: SiteRule | null = null;
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    rule = host === '' ? null : { entry: host, kind: 'site', place: host };
  } else if (url.protocol === 'file:') {
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    // file:///C:/Users/me/x.pdf has the path /C:/Users/me/; a Windows drive loses its leading slash
    const local = folder.replace(/^\/([A-Za-z]:\/)/, '$1');
    const share = url.host !== '' && url.host !== 'localhost' ? `//${url.host}${local}` : local;
    const name = local.split('/').filter((s) => s !== '').pop() ?? '';
    rule = name === '' ? null : { entry: share, kind: 'folder', place: name };
  }
  return rule !== null && isListEntryOk(rule.entry, 'allow') ? rule : null;
}
