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

/** How long a request's Referer and method are kept. The service worker may sleep sooner, which is fine: they are needed seconds after the load. */
const KEEP_MS = 5 * 60_000;
/** A busy page loads many frames and plugins; only the last ones matter. */
const MAX_REQUESTS = 500;

/** The kinds of request logged: documents in a tab or a frame, and what an `<embed>` or `<object>` loads. */
export type LoggedType = 'main_frame' | 'sub_frame' | 'object';

export interface LoggedRequest {
  /** The request's address (a request carries no fragment). */
  url: string;
  type: LoggedType;
  /** The Referer Chrome sent with it; null for none. */
  referer: string | null;
  method: string;
}

interface Entry extends LoggedRequest {
  tabId: number;
  at: number;
}

// Every logged request by requestId, oldest first. A request that a server redirects keeps its requestId and ends up
// with its last address.
const byRequest = new Map<string, Entry>();
// byFrame.get(tabId).get(frameId) = the request that loaded the document in that frame.
const byFrame = new Map<number, Map<number, Entry>>();

/** Remembers the address, Referer and method of every http(s) page, frame and plugin request, in memory only. */
export function installRequestLog(): void {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return; // not from a tab
      const referer = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'referer')?.value || null;
      const type = details.type as LoggedType;
      record(details.requestId, details.frameId, { url: details.url, type, referer, method: details.method, tabId: details.tabId, at: Date.now() });
    },
    { urls: ['*://*/*'], types: ['main_frame', 'sub_frame', 'object'] },
    ['requestHeaders', 'extraHeaders'], // the Referer is an "extra" header
  );
}

function record(requestId: string, frameId: number, entry: Entry): void {
  for (const [id, old] of byRequest) {
    if (entry.at - old.at <= KEEP_MS && byRequest.size < MAX_REQUESTS) break;
    byRequest.delete(id);
  }
  byRequest.delete(requestId); // re-inserted last: it is the newest
  byRequest.set(requestId, entry);
  for (const [tab, frames] of byFrame) {
    for (const [frame, old] of frames) if (entry.at - old.at > KEEP_MS) frames.delete(frame);
    if (frames.size === 0) byFrame.delete(tab);
  }
  if (entry.type === 'object') return; // a plugin's request loads no document of its own
  let frames = byFrame.get(entry.tabId);
  if (!frames) byFrame.set(entry.tabId, (frames = new Map<number, Entry>()));
  frames.set(frameId, entry);
}

const fresh = (entry: Entry | undefined): entry is Entry => entry !== undefined && Date.now() - entry.at <= KEEP_MS;

/**
 * The Referer and method of the request that loaded the document in this tab and frame, if it was seen in the last
 * five minutes. `null` when it was not (the service worker may have slept in between).
 */
export function getRequestInfo(tabId: number, frameId: number): { referer: string | null; method: string } | null {
  const entry = byFrame.get(tabId)?.get(frameId);
  return fresh(entry) ? { referer: entry.referer, method: entry.method } : null;
}

/** The request with this requestId (webRequest's own id), if it was logged in the last five minutes. */
export function requestById(requestId: string): LoggedRequest | null {
  const entry = byRequest.get(requestId);
  return fresh(entry) ? entry : null;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return stripFragment(new URL(a).href) === stripFragment(new URL(b).href);
  } catch {
    return false;
  }
}

/** The newest request of one of `types` for `url` (compared without a fragment) in this tab, in any frame. */
export function findRequest(tabId: number, url: string, types: readonly LoggedType[]): LoggedRequest | null {
  let found: Entry | null = null;
  for (const entry of byRequest.values()) {
    if (entry.tabId === tabId && types.includes(entry.type) && fresh(entry) && sameAddress(entry.url, url)) found = entry;
  }
  return found;
}

/** Forgets a tab (it was closed). */
export function forgetTab(tabId: number): void {
  byFrame.delete(tabId);
  for (const [id, entry] of byRequest) if (entry.tabId === tabId) byRequest.delete(id);
}
