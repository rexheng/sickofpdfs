/*
Copyright 2012 Mozilla Foundation

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
// Adapted from pdf.js extensions/chromium/pdfHandler.js (see LICENSE.pdfjs in this folder).

import { VIEWER_PATH } from '../../shared/viewer-url';
import { isHeaderConditionSupported } from './feature-check';
import { buildTakeoverRules } from './rules';

/**
 * How PDFs reach the viewer in this browser session.
 * - `dnr`: declarativeNetRequest redirects them by their response headers (Chrome 128 and later).
 * - `content-script`: the rules could not be registered; the content script catches every PDF Chrome shows.
 */
export type TakeoverMode = 'dnr' | 'content-script';

const MODE_KEY = 'takeoverMode';

let inFlight: Promise<TakeoverMode> | undefined;

/**
 * Registers the takeover rules, once per browser session. Dynamic rules persist, so redirects work while the
 * service worker sleeps; but they survive extension updates too, so they are rebuilt on the first wake of each
 * session. (`runtime.onInstalled` would be the obvious place, but it does not fire in every case, for example in
 * Incognito: https://issues.chromium.org/issues/41029550.) The flag in `chrome.storage.session` is set last, so a
 * wake that was cut short registers again at the next one.
 */
export function registerTakeover(): Promise<TakeoverMode> {
  inFlight ??= register().catch((error: unknown) => {
    inFlight = undefined; // try again at the next wake
    throw error;
  });
  return inFlight;
}

async function register(): Promise<TakeoverMode> {
  const stored: unknown = (await chrome.storage.session.get(MODE_KEY))[MODE_KEY];
  if (stored === 'dnr' || stored === 'content-script') return stored;

  // We have no dynamic rules but these, so whatever is there came from an earlier version.
  const oldIds = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id);

  let mode: TakeoverMode = 'content-script';
  try {
    // Chrome 123 to 127 accept a rule and ignore its responseHeaders condition, which would redirect every request.
    if (!(await isHeaderConditionSupported(chrome.declarativeNetRequest))) throw new Error('DNR responseHeaders conditions are not supported');
    // One call replaces the old rules with the new ones, so there is no moment without rules while PDFs are loading.
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds, addRules: buildTakeoverRules(chrome.runtime.getURL(VIEWER_PATH)) });
    mode = 'dnr';
  } catch (error) {
    // The content script (embed.content) then catches PDFs that Chrome shows, as it does for PDFs without a Content-Type.
    console.error('sickofpdfs: could not register the PDF redirect rules; falling back to the content script.', error);
    // Old rules that stay would redirect on a Chrome that cannot read their conditions.
    if (oldIds.length > 0) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: oldIds }).catch(() => undefined);
  }
  await chrome.storage.session.set({ [MODE_KEY]: mode });
  return mode;
}
