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

/** How long a request's Referer and method are kept. The service worker may sleep sooner, which is fine: they are needed seconds after the load. */
const KEEP_MS = 5 * 60_000;

interface Entry {
  referer: string | null;
  method: string;
  at: number;
}

// log.get(tabId).get(frameId) = the request that loaded the document in that frame.
const log = new Map<number, Map<number, Entry>>();

/** Remembers the Referer and the method of every http(s) page and frame request, in memory only. */
export function installRequestLog(): void {
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.tabId < 0) return; // not from a tab
      const referer = details.requestHeaders?.find((h) => h.name.toLowerCase() === 'referer')?.value || null;
      record(details.tabId, details.frameId, referer, details.method);
    },
    { urls: ['*://*/*'], types: ['main_frame', 'sub_frame'] },
    ['requestHeaders', 'extraHeaders'], // the Referer is an "extra" header
  );
}

function record(tabId: number, frameId: number, referer: string | null, method: string): void {
  const now = Date.now();
  for (const [tab, frames] of log) {
    for (const [frame, entry] of frames) if (now - entry.at > KEEP_MS) frames.delete(frame);
    if (frames.size === 0) log.delete(tab);
  }
  let frames = log.get(tabId);
  if (!frames) log.set(tabId, (frames = new Map<number, Entry>()));
  frames.set(frameId, { referer, method, at: now });
}

/**
 * The Referer and method of the request that loaded the document in this tab and frame, if it was seen in the last
 * five minutes. `null` when it was not (the service worker may have slept in between).
 */
export function getRequestInfo(tabId: number, frameId: number): { referer: string | null; method: string } | null {
  const entry = log.get(tabId)?.get(frameId);
  if (!entry) return null;
  if (Date.now() - entry.at > KEEP_MS) {
    log.get(tabId)?.delete(frameId);
    return null;
  }
  return { referer: entry.referer, method: entry.method };
}

/** Forgets a tab (it was closed). */
export function forgetTab(tabId: number): void {
  log.delete(tabId);
}
