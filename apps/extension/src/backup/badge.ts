// The badge on the toolbar icon while a backup is waiting for the owner's click (spec: "the extension icon shows a badge whenever
// a backup is waiting for your click").
//
// Only the service worker (and extension pages) may use `chrome.action`; the offscreen document that writes the backup may not.
// So the writer sends a message, and the service worker's listener (`installBackupBadge`) sets the badge. A badge does not survive
// a browser restart, so the service worker also reads the status record when it starts and when the browser does.
import { openHandleStore } from './handle-store';

export const BADGE_MESSAGE = 'sop-backup:badge';
/** The toolbar icon's tooltip while the badge shows, and when it does not. */
export const BADGE_TITLE = 'Backup is waiting. Click to allow.';
export const DEFAULT_TITLE = 'Open your library';
const BADGE_TEXT = '!';
/** The error colour of the light theme (GM3 error). A badge cannot read a CSS variable. */
const BADGE_COLOR = '#B3261C';

interface BadgeMessage {
  type: typeof BADGE_MESSAGE;
  waiting: boolean;
}

const isBadgeMessage = (x: unknown): x is BadgeMessage =>
  typeof x === 'object' && x !== null && (x as { type?: unknown }).type === BADGE_MESSAGE && typeof (x as { waiting?: unknown }).waiting === 'boolean';

/** From the offscreen document or a page: show or clear the badge. Never throws; the next status change says it again. */
export function announceBackupBadge(waiting: boolean): void {
  try {
    const message: BadgeMessage = { type: BADGE_MESSAGE, waiting };
    const sent: unknown = chrome.runtime.sendMessage(message);
    if (sent instanceof Promise) sent.catch(() => {}); // nobody listening (the service worker is starting): it reads the status itself
  } catch {
    // The extension context is gone.
  }
}

/** In the service worker: sets or clears the badge. */
export async function setBackupBadge(waiting: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: waiting ? BADGE_TEXT : '' });
  if (waiting) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setTitle({ title: waiting ? BADGE_TITLE : DEFAULT_TITLE });
}

/** The badge the status record asks for, put on the icon. Used when the service worker starts. */
export async function restoreBackupBadge(): Promise<void> {
  // In Incognito the extension only views PDFs: there is no library and no backup, so nothing is opened or kept there.
  if (chrome.extension.inIncognitoContext) return;
  const handles = await openHandleStore();
  try {
    const status = await handles.getStatus();
    await setBackupBadge(status.phase === 'waiting');
  } finally {
    handles.close();
  }
}

/** Registers the listener. Call it synchronously when the service worker starts, so a message wakes it. */
export function installBackupBadge(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
    if (!isBadgeMessage(raw) || sender.id !== chrome.runtime.id) return false;
    setBackupBadge(raw.waiting).catch((error: unknown) => console.error('sickofpdfs: the backup badge was not set', error));
    return false; // no answer is sent
  });
  restoreBackupBadge().catch(() => {});
}
