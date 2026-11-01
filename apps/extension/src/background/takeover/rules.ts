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

/** The rule ids 1 to 6 are the dynamic takeover rules, in priority order (6 is the highest priority, 1 the lowest). */
export const TAKEOVER_RULE_COUNT = 6;

type Rule = chrome.declarativeNetRequest.Rule;
type RuleWithoutOrder = Omit<Rule, 'id' | 'priority'>;

// "allow" means: ignore the rules of this extension with a lower priority.
const IGNORE_OTHER_RULES = { type: 'allow' } as const;

/**
 * The declarativeNetRequest rules that send PDFs to the viewer: pdf.js's `registerPdfRedirectRule` without its
 * `pdfjs.action=download` rule (the escape hatch here is a one-time rule made per tab, see escape.ts).
 * `viewerUrl` is the viewer page's address; a redirect appends `?DNR:<the PDF's address>`, because DNR cannot
 * URL-encode it (`parseViewerUrl` reads that form).
 *
 * The first rule has the highest priority. The response-header conditions need Chrome 128; `isHeaderConditionSupported`
 * checks that before these are registered.
 */
export function buildTakeoverRules(viewerUrl: string): Rule[] {
  const redirectToViewer = {
    type: 'redirect',
    redirect: { regexSubstitution: `${viewerUrl}?DNR:\\0` },
  } as const;

  const rules: RuleWithoutOrder[] = [
    {
      // Local PDF files, when "Allow access to file URLs" is on. Without it DNR never sees file:// requests, and
      // file-fallback.ts takes over.
      condition: { regexFilter: '^file://.*\\.pdf$', resourceTypes: ['main_frame', 'sub_frame'] },
      action: redirectToViewer,
    },
    {
      // A frame that serves a PDF as an attachment is a download: leave it alone. (In the main frame the viewer
      // opens it anyway, since most often people want to read it and servers are often misconfigured.)
      condition: {
        urlFilter: '*',
        resourceTypes: ['sub_frame'],
        responseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
      action: IGNORE_OTHER_RULES,
    },
    {
      // "=download" in the address and an attachment: a real download (this is how Google Drive's download link works).
      condition: {
        urlFilter: '=download',
        resourceTypes: ['main_frame'],
        responseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
      action: IGNORE_OTHER_RULES,
    },
    {
      // A PDF by its Content-Type. The viewer re-fetches with GET, so a response to a POST stays in Chrome's viewer.
      condition: {
        regexFilter: '^.*$',
        excludedRequestMethods: ['post'],
        resourceTypes: ['main_frame', 'sub_frame'],
        responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*'] }],
      },
      action: redirectToViewer,
    },
    {
      // The wrong Content-Type (a generic download type), but a PDF by the file name in the address.
      condition: {
        regexFilter: '^.*\\.pdf\\b.*$',
        excludedRequestMethods: ['post'],
        resourceTypes: ['main_frame', 'sub_frame'],
        responseHeaders: [{ header: 'content-type', values: ['application/octet-stream', 'application/octet-stream;*'] }],
      },
      action: redirectToViewer,
    },
    {
      // The wrong Content-Type (a text type, say), but a PDF by the Content-Disposition file name. A generic
      // download type (application/octet-stream) is left alone: with an attachment header that is a download link.
      // "responseHeaders" is an OR, so the AND with "Content-Type is not application/octet-stream" is built from
      // excludedResponseHeaders: the rule does not match when Content-Type is exactly that. (It matches when there
      // is no Content-Type; then the browser would sniff the type anyway.)
      //
      // pdf.js lists the same header with "excludedValues" here. Chrome reads that the other way round (the rule
      // then matches only application/octet-stream or no Content-Type at all, measured on Chrome 153), which would
      // open every generic download link and ignore a PDF mislabelled as text. "values" gives the behaviour the
      // comment in pdf.js describes.
      condition: {
        regexFilter: '^.*$',
        excludedRequestMethods: ['post'],
        resourceTypes: ['main_frame', 'sub_frame'],
        responseHeaders: [{ header: 'content-disposition', values: ['*.pdf', '*.pdf"*', "*.pdf'*"] }],
        excludedResponseHeaders: [{ header: 'content-type', values: ['application/octet-stream', 'application/octet-stream;*'] }],
      },
      action: redirectToViewer,
    },
  ];

  return rules.map((rule, i) => ({ ...rule, id: i + 1, priority: rules.length - i }));
}
