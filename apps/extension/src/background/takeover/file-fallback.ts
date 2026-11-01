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

import { splitPageFragment } from '../../shared/urls';
import { buildViewerUrl } from '../../shared/viewer-url';
import { isEscaped } from './escape';

/**
 * Without "Allow access to file URLs", declarativeNetRequest never sees file:// requests. They still show up in
 * webNavigation, so the tab is sent to the viewer from here; the viewer finds it has no access to the file and asks
 * the person to switch the setting on. With access on, the redirect rule has it and this does nothing.
 */
export function installFileFallback(): void {
  chrome.webNavigation.onBeforeNavigate.addListener(
    (details) => {
      if (details.frameId === 0) void takeOver(details.tabId, details.url);
    },
    // pathSuffix, not urlSuffix: a "#page=2" or "?x" after the name must not hide a .pdf. Case matters in these
    // filters, so both spellings are listed; the redirect rule (case-insensitive) covers the rest when access is on.
    { url: [{ urlPrefix: 'file://', pathSuffix: '.pdf' }, { urlPrefix: 'file://', pathSuffix: '.PDF' }] },
  );
}

async function takeOver(tabId: number, url: string): Promise<void> {
  if (await chrome.extension.isAllowedFileSchemeAccess()) return; // the redirect rule has it
  if (await isEscaped(tabId, url)) return; // the person chose Chrome's viewer for this file
  const { url: source, page } = splitPageFragment(url);
  await chrome.tabs.update(tabId, { url: buildViewerUrl({ source, back: null, page }) });
}
