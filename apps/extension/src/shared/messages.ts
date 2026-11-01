/**
 * What the viewer, the content script and the service worker say to each other (`chrome.runtime.sendMessage`).
 * Types only: the receiving side is `background/takeover/messages.ts`, which checks who sent each message.
 * Large data never travels here; these carry addresses and flags.
 */
export type RuntimeMessage =
  /**
   * The viewer that fills the tab is about to load `url` itself (http, https or file). Reply: whether this tab really
   * opened that address (`known`, background/takeover/grants.ts), and the Referer the re-fetch will carry.
   */
  | { type: 'takeover:prepare-fetch'; url: string }
  /** Content script: Chrome is showing a PDF that no rule redirected (no Content-Type, so Chrome sniffed it). */
  | { type: 'takeover:sniffed'; url: string }
  /** Content script: may the viewer take this document over? Reply: false after a POST or while escaped. */
  | { type: 'takeover:can-take-over'; url: string }
  /** The viewer: show the extension's page in chrome://extensions, where "Allow access to file URLs" lives. */
  | { type: 'takeover:open-file-settings' }
  /** The viewer: show `url` in Chrome's own viewer, once. */
  | { type: 'takeover:open-in-chrome'; url: string }
  /** A PDF is embedded in a page (content script) or the viewer sits in a frame: open `url` in the whole tab. */
  | { type: 'takeover:embedded'; url: string }
  /** A viewer in a frame, after the owner's click: open `url`, the PDF's own address, in a new tab beside this one. */
  | { type: 'takeover:open-in-new-tab'; url: string }
  /** The viewer's "Back to page": do not take over the embedded PDFs of `pageUrl` again in this tab. */
  | { type: 'takeover:suppress-embeds'; pageUrl: string };

/** The reply to each message, by `type`. The reply to `sniffed` and the others without a value is `undefined`. */
export interface RuntimeReplies {
  /**
   * `known: false`: the tab was never seen opening this address. The viewer then loads it without the owner's
   * sign-in, or not at all for a local file. `back`: the page this tab was seen embedding the PDF in ("Back to page").
   */
  'takeover:prepare-fetch': { known: boolean; referer: string | null; back: string | null };
  'takeover:sniffed': undefined;
  'takeover:can-take-over': boolean;
  'takeover:open-file-settings': undefined;
  /** `ok: false` when Chrome would not open the address (for example a file the extension may not read). */
  'takeover:open-in-chrome': { ok: boolean };
  /** `opened: false` when this page's embedded PDFs are suppressed (after "Back to page"): stay where you are. */
  'takeover:embedded': { opened: boolean };
  'takeover:open-in-new-tab': undefined;
  'takeover:suppress-embeds': undefined;
}

export type RuntimeReplyOf<M extends RuntimeMessage> = RuntimeReplies[M['type']];
