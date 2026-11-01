import { isOpenableUrl, stripFragment } from '../../shared/urls';
import { allocateRuleId } from './rule-ids';

/** How long a person's choice of Chrome's viewer holds for one address in one tab. */
const ESCAPE_MS = 60_000;
/** Above every takeover rule (priorities 1 to 6). */
const ALLOW_PRIORITY = 100;

interface Escape {
  /** The address, as the network stack sees it, without a fragment. */
  url: string;
  /** Time (ms since 1970) at which the choice stops holding. */
  until: number;
  /** The session rule that lets the request through. */
  ruleId: number;
}

// One record per tab, so two tabs never write the same key.
const keyOf = (tabId: number) => `escaped:${tabId}`;

async function read(tabId: number): Promise<Escape | null> {
  const value = (await chrome.storage.session.get(keyOf(tabId)))[keyOf(tabId)] as Escape | undefined;
  return value ?? null;
}

/** `url` as a regular expression (RE2, which declarativeNetRequest uses) that matches that address and nothing else. */
export function escapeForRegexFilter(url: string): string {
  return `^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

/**
 * A condition on the address that is as exact as Chrome allows. A regex is exact, but Chrome refuses one that
 * compiles to too much memory (a long signed address); then a text pattern is used, and when the address holds a
 * `*` or `^` (which a text pattern cannot escape) the pattern is the part before it. A wider pattern only lets
 * more of this one tab's next navigation through, for at most a minute.
 */
async function matchAddress(address: string): Promise<{ regexFilter: string } | { urlFilter: string }> {
  const regex = escapeForRegexFilter(address);
  if ((await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: true })).isSupported) return { regexFilter: regex };
  const special = address.search(/[*^]/);
  return special < 0 ? { urlFilter: `|${address}|` } : { urlFilter: `|${address.slice(0, special)}` };
}

/**
 * Lets the next top-level request for `url` in this tab through the takeover rules: one session rule that allows it
 * (priority 100, this tab, main frame only) and a record that the content script's check reads (`isEscaped`). Does
 * not navigate.
 */
export async function armEscape(tabId: number, url: string): Promise<void> {
  if (!isOpenableUrl(url)) throw new Error('only http, https and file addresses can be opened in Chrome');
  // The request that matches carries the fragment too (measured: a rule for ".../a.pdf" does not match ".../a.pdf#page=2").
  const href = new URL(url).href;
  const target = stripFragment(href);
  await dropEscape(tabId);
  const ruleId = await allocateRuleId();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id: ruleId,
        priority: ALLOW_PRIORITY,
        action: { type: 'allow' },
        condition: { ...(await matchAddress(href)), isUrlFilterCaseSensitive: true, tabIds: [tabId], resourceTypes: ['main_frame'] },
      },
    ],
  });
  await chrome.storage.session.set({ [keyOf(tabId)]: { url: target, until: Date.now() + ESCAPE_MS, ruleId } satisfies Escape });
  // The rule goes at the first commit in the tab or the tab's close; this timer is the backstop while the worker is awake.
  setTimeout(() => void expire(tabId, ruleId), ESCAPE_MS + 1000);
}

/** Shows `url` in Chrome's own viewer, once: the rule lets this tab's request through, then the tab goes there. */
export async function openInChromeViewer(tabId: number, url: string): Promise<void> {
  await armEscape(tabId, url);
  await navigateEscaped(tabId, url);
}

/** Sends the tab to an address that `armEscape` armed. Disarms again if Chrome refuses. */
export async function navigateEscaped(tabId: number, url: string): Promise<void> {
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (error) {
    await dropEscape(tabId);
    throw error;
  }
}

/** Did the person choose Chrome's viewer for this address in this tab in the last minute? The content script's sniff path asks. */
export async function isEscaped(tabId: number, url: string): Promise<boolean> {
  const escape = await read(tabId);
  if (!escape || escape.until <= Date.now()) return false;
  try {
    return stripFragment(new URL(url).href) === escape.url;
  } catch {
    return false;
  }
}

/** Removes the tab's allow rule and its record. */
async function dropEscape(tabId: number): Promise<void> {
  const escape = await read(tabId);
  if (!escape) return;
  await chrome.storage.session.remove(keyOf(tabId));
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [escape.ruleId] });
}

async function expire(tabId: number, ruleId: number): Promise<void> {
  const escape = await read(tabId);
  if (escape?.ruleId === ruleId) await dropEscape(tabId);
}

/**
 * A top-level page committed in `tabId`. If it is the address that was let through, the one-time rule has done its
 * job and goes, but the record stays until it expires so that the content script (which runs next) is told to leave
 * Chrome's viewer alone. Any other page means the person went elsewhere: both go.
 */
export async function onTabCommitted(tabId: number, url: string): Promise<void> {
  const escape = await read(tabId);
  if (!escape) return;
  if (stripFragment(url) !== escape.url) return dropEscape(tabId);
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [escape.ruleId] });
}

export async function onTabRemoved(tabId: number): Promise<void> {
  await dropEscape(tabId);
}

/** At each wake: removes escapes that ran out while the worker slept. */
export async function sweepExpiredEscapes(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const now = Date.now();
  for (const [key, value] of Object.entries(all)) {
    const match = /^escaped:(\d+)$/.exec(key);
    if (match && (value as Escape).until <= now) await dropEscape(Number(match[1]));
  }
}
