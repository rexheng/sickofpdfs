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

/** The part of `chrome.declarativeNetRequest` that the probe uses (a fake stands in for it in tests). */
export interface DnrLike {
  updateSessionRules(o: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<void>;
}

/** A rule id that nothing else uses. The probe always removes its rule again. */
const PROBE_RULE_ID = 123456;

/**
 * Does this Chrome act on a `responseHeaders` rule condition? Chrome 123 to 127 accept such a rule and silently
 * ignore the condition, which would redirect every request to the viewer. The check has two steps; see
 * https://github.com/w3c/webextensions/issues/638#issuecomment-2181124486
 */
export async function isHeaderConditionSupported(dnr: DnrLike): Promise<boolean> {
  try {
    // Throws when the condition is not known to this Chrome.
    await dnr.updateSessionRules({
      addRules: [
        {
          id: PROBE_RULE_ID,
          condition: { responseHeaders: [{ header: 'whatever' }], urlFilter: '|does_not_match_anything' },
          action: { type: 'block' },
        },
      ],
    });
  } catch {
    return false;
  }
  // Chrome may know the property but keep the feature behind a flag. Then validation is skipped too, so a rule with
  // an invalid (empty) list is accepted. When the feature is on, that rule is refused.
  try {
    await dnr.updateSessionRules({
      removeRuleIds: [PROBE_RULE_ID],
      addRules: [
        {
          id: PROBE_RULE_ID,
          condition: { responseHeaders: [], urlFilter: '|does_not_match_anything' },
          action: { type: 'block' },
        },
      ],
    });
    return false; // validation skipped: the feature is off
  } catch {
    return true; // validation worked: the feature is on
  } finally {
    await dnr.updateSessionRules({ removeRuleIds: [PROBE_RULE_ID] });
  }
}
