/*
Copyright 2015 Mozilla Foundation

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// Modified for sickofpdfs, 2026
// Adapted from pdf.js extensions/chromium/preserve-referer.js (see LICENSE.pdfjs in this folder).

import { stripFragment } from '../../shared/urls';
import { escapeForRegexFilter } from './escape';
import { allocateRuleId } from './rule-ids';

/**
 * Makes the viewer's own request for `url` carry `referer`: the one Chrome sent for that PDF, which the tab's record
 * keeps (grants.ts). Some hosts refuse a PDF without it. The rule can send that Referer nowhere else:
 * - only for the exact address `url` (a case-sensitive match of the whole address, with no wildcards: an address
 *   that holds `*` or `^`, which a text pattern would read as wildcards, is matched through an escaped regex);
 * - only for requests started by this extension's own pages (`initiatorDomains`), and only in this tab;
 * - only `xmlhttprequest` (the viewer's fetch and XHR).
 * It sets no other header, and never a cookie. A redirect to another address is not matched, so the Referer does not
 * follow a redirect to another host.
 *
 * Returns the session rule's id, or 0 when no rule could be made that matches only `url` (then the request keeps
 * Chrome's own Referer). An earlier rule of the same tab is replaced. The rule is removed when the tab navigates away
 * or closes (`clearStickyReferer`, called from tab-lifecycle.ts); a reload of the viewer makes it again from the record.
 */
export async function setStickyReferer(tabId: number, url: string, referer: string): Promise<number> {
  await clearStickyReferer(tabId);
  const target = stripFragment(new URL(url).href); // the address as the network stack sees it
  const matcher = await exactMatcher(target);
  if (!matcher) return 0;
  const id = await allocateRuleId();
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [
      {
        id,
        priority: 1,
        condition: {
          ...matcher,
          isUrlFilterCaseSensitive: true,
          initiatorDomains: [chrome.runtime.id], // the viewer, which has this extension's origin
          resourceTypes: ['xmlhttprequest'],
          tabIds: [tabId],
        },
        action: { type: 'modifyHeaders', requestHeaders: [{ operation: 'set', header: 'referer', value: referer }] },
      },
    ],
  });
  return id;
}

/**
 * The Referer Chrome sends from `page` to `target` under its default policy, strict-origin-when-cross-origin: the
 * page's whole address (without its fragment) to its own origin, only its origin to another, and none from https to
 * http or from a page that is not on the web. For an embedded PDF whose own request was not seen.
 */
export function defaultReferer(page: string, target: string): string | null {
  let from: URL;
  let to: URL;
  try {
    from = new URL(page);
    to = new URL(target);
  } catch {
    return null;
  }
  if (from.protocol !== 'http:' && from.protocol !== 'https:') return null;
  if (from.protocol === 'https:' && to.protocol !== 'https:') return null;
  if (from.origin !== to.origin) return `${from.origin}/`;
  from.hash = '';
  from.username = '';
  from.password = '';
  return from.href;
}

/** A condition that matches `target` and nothing else, or null if Chrome cannot express one. */
async function exactMatcher(target: string): Promise<{ urlFilter: string } | { regexFilter: string } | null> {
  // `*` and `^` mean something in a urlFilter and cannot be escaped there, so such an address goes through a regex.
  if (!/[*^]/.test(target)) return { urlFilter: `|${target}|` };
  const regex = escapeForRegexFilter(target);
  const { isSupported } = await chrome.declarativeNetRequest.isRegexSupported({ regex, isCaseSensitive: true });
  return isSupported ? { regexFilter: regex } : null;
}

/** Removes this tab's sticky Referer rule, if it has one. */
export async function clearStickyReferer(tabId: number): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  const ids = rules.filter((r) => r.action.type === 'modifyHeaders' && r.condition.tabIds?.includes(tabId)).map((r) => r.id);
  if (ids.length > 0) await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
}
