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

import type { RuntimeMessage, RuntimeReplies } from '../../shared/messages';
import { isOpenableUrl, splitPageFragment } from '../../shared/urls';
import { buildViewerUrl } from '../../shared/viewer-url';
import { areEmbedsSuppressed, openEmbeddedInTab, suppressEmbeds } from './embedded';
import { armEscape, isEscaped, navigateEscaped } from './escape';
import { findGrant, grant } from './grants';
import { clearStickyReferer, rememberedReferer, setStickyReferer } from './referer';
import { getRequestInfo } from './request-log';

type Sender = chrome.runtime.MessageSender;
type Reply = RuntimeReplies[keyof RuntimeReplies];

/** A message of ours that is well-formed; null for anything else (other features' messages, junk). */
function parse(raw: unknown): RuntimeMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'takeover:prepare-fetch':
    case 'takeover:open-in-new-tab':
    case 'takeover:sniffed':
    case 'takeover:can-take-over':
    case 'takeover:open-in-chrome':
    case 'takeover:embedded':
      return typeof m.url === 'string' ? (m as unknown as RuntimeMessage) : null;
    case 'takeover:suppress-embeds':
      return typeof m.pageUrl === 'string' ? (m as unknown as RuntimeMessage) : null;
    case 'takeover:open-file-settings':
      return m as unknown as RuntimeMessage;
    default:
      return null;
  }
}

/** Sent from one of this extension's own pages (the viewer), not from a content script running in a web page. */
function fromExtensionPage(sender: Sender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

/** Sent from this extension's content script, which runs inside a web page. */
function fromContentScript(sender: Sender): boolean {
  return sender.id === chrome.runtime.id && sender.tab !== undefined && !fromExtensionPage(sender);
}

/** May the viewer take over the document that the tab shows in this frame? False after a POST and while escaped. */
async function canTakeOver(tabId: number, frameId: number, url: string): Promise<boolean> {
  const info = getRequestInfo(tabId, frameId);
  // The viewer re-fetches with GET and cannot replay a form, so a document that came from one stays in Chrome.
  if (info && info.method !== 'GET') return false;
  return !(await isEscaped(tabId, url));
}

/**
 * A local PDF may be opened only for a page that is local itself. A web page can name `file:///...` in an
 * `<embed>`, which Chrome refuses to load, but the viewer (which may read local files) would not.
 */
function mayEmbed(url: string, pageUrl: string): boolean {
  if (!isOpenableUrl(url) || !isOpenableUrl(pageUrl)) return false;
  return !url.startsWith('file:') || pageUrl.startsWith('file:');
}

/**
 * Handles each message and returns its reply (`undefined` for those without one). `afterReply` runs after the reply
 * is sent: the tab is about to navigate away, and an answer that is sent first cannot be lost to that.
 */
async function handle(message: RuntimeMessage, sender: Sender, afterReply: (work: () => Promise<void>) => void): Promise<Reply> {
  const tab = sender.tab;
  const tabId = tab?.id;
  switch (message.type) {
    case 'takeover:prepare-fetch': {
      // Only the viewer that fills the tab loads a PDF; one in a frame never does (frame-escape.ts).
      if (!fromExtensionPage(sender) || tabId === undefined || sender.frameId !== 0 || !isOpenableUrl(message.url)) return { known: false, referer: null };
      const known = (await findGrant(tabId, message.url)) !== null;
      if (!/^https?:/.test(message.url)) return { known, referer: null };
      const referer = known ? (getRequestInfo(tabId, sender.frameId)?.referer ?? (await rememberedReferer(tabId, message.url))) : null;
      if (referer) await setStickyReferer(tabId, message.url, referer);
      else await clearStickyReferer(tabId);
      return { known, referer };
    }

    case 'takeover:can-take-over': {
      if (!fromContentScript(sender) || tabId === undefined) return false;
      return canTakeOver(tabId, sender.frameId ?? 0, message.url);
    }

    case 'takeover:sniffed': {
      // Only the page itself (not a frame), and only for the address the sender really is.
      if (!fromContentScript(sender) || tabId === undefined || sender.frameId !== 0 || sender.url !== message.url) return undefined;
      if (!isOpenableUrl(message.url) || !(await canTakeOver(tabId, 0, message.url))) return undefined;
      const { url: source, page } = splitPageFragment(message.url);
      await grant(tabId, source);
      await chrome.tabs.update(tabId, { url: buildViewerUrl({ source, back: null, page }) });
      return undefined;
    }

    case 'takeover:embedded': {
      const pageUrl = tab?.url;
      if (tabId === undefined || pageUrl === undefined || pageUrl.startsWith(chrome.runtime.getURL(''))) return { opened: false };
      if (!mayEmbed(message.url, pageUrl)) return { opened: false };
      if (fromExtensionPage(sender)) {
        // A viewer in a frame: only for a PDF the takeover put there. A page can write any address into a frame of
        // its own, and that must not become a fetch with the owner's sign-in in the whole tab.
        if ((await findGrant(tabId, message.url)) === null) return { opened: false };
      } else if (!fromContentScript(sender)) return { opened: false };
      if (await areEmbedsSuppressed(tabId, pageUrl)) return { opened: false };
      afterReply(() => openEmbeddedInTab(tabId, message.url, pageUrl));
      return { opened: true };
    }

    case 'takeover:suppress-embeds': {
      if (!fromExtensionPage(sender) || tabId === undefined || !isOpenableUrl(message.pageUrl)) return undefined;
      await suppressEmbeds(tabId, message.pageUrl);
      return undefined;
    }

    case 'takeover:open-in-chrome': {
      if (!fromExtensionPage(sender) || tabId === undefined || !isOpenableUrl(message.url)) return { ok: false };
      // Chrome does not let an extension without file access open a file: address, so say so instead of failing quietly.
      if (message.url.startsWith('file:') && !(await chrome.extension.isAllowedFileSchemeAccess())) return { ok: false };
      // Nor a local file that this tab was not seen opening: a web page may have named it (grants.ts).
      if (message.url.startsWith('file:') && (await findGrant(tabId, message.url)) === null) return { ok: false };
      await armEscape(tabId, message.url); // the rule is in place before the answer: the tab goes there right after it
      afterReply(() => navigateEscaped(tabId, message.url));
      return { ok: true };
    }

    case 'takeover:open-in-new-tab': {
      // A viewer in a frame, after the owner's click: the PDF's own address in a new tab beside this one. The tab then
      // goes through the takeover like any link the owner opens, under Chrome's own rules for that request.
      if (!fromExtensionPage(sender) || !tab || tab.id === undefined || sender.frameId === 0) return undefined;
      if (tab.url === undefined || !mayEmbed(message.url, tab.url)) return undefined;
      await chrome.tabs.create({ url: message.url, windowId: tab.windowId, index: tab.index + 1, openerTabId: tab.id });
      return undefined;
    }

    case 'takeover:open-file-settings': {
      if (!fromExtensionPage(sender) || !tab || tab.id === undefined) return undefined;
      // A page cannot navigate to chrome:// itself. A new tab beside the viewer keeps the PDF's tab as it is.
      await chrome.tabs.create({
        url: `chrome://extensions/?id=${chrome.runtime.id}`,
        windowId: tab.windowId,
        index: tab.index + 1,
        openerTabId: tab.id,
      });
      return undefined;
    }
  }
}

/** What a sender gets when handling its message failed: never "go ahead". */
function failureReply(message: RuntimeMessage): Reply {
  switch (message.type) {
    case 'takeover:can-take-over':
      return false;
    case 'takeover:prepare-fetch':
      return { known: false, referer: null };
    case 'takeover:open-in-chrome':
      return { ok: false };
    case 'takeover:embedded':
      return { opened: false };
    default:
      return undefined;
  }
}

/** The service worker's side of the takeover messages (shared/messages.ts). Register at the top level of the worker. */
export function installTakeoverMessages(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (reply?: Reply) => void) => {
    const message = parse(raw);
    if (!message) return false; // not ours: other listeners may answer
    const after: (() => Promise<void>)[] = [];
    handle(message, sender, (work) => after.push(work)).then(
      (reply) => {
        sendResponse(reply);
        for (const work of after) work().catch(() => console.error(`sickofpdfs: ${message.type} failed`));
      },
      () => {
        // Not the error itself: it may quote an address, and what a person opens is nobody else's business.
        console.error(`sickofpdfs: ${message.type} failed`);
        sendResponse(failureReply(message));
      },
    );
    return true; // the reply comes later
  });
}
