// The badge on the toolbar icon while a backup is waiting for the owner's click (spec: "the extension icon shows a badge whenever
// a backup is waiting for your click"), or is on hold because it could have lost something (R86). Its tooltip says which, and why.
//
// Only the service worker (and extension pages) may use `chrome.action`; the offscreen document that writes the backup may not.
// So the writer sends a message, and the service worker's listener (`installBackupBadge`) sets the badge. A badge does not survive
// a browser restart, so the service worker also reads the status record when it starts and when the browser does.
import { openHandleStore } from './handle-store';
import { badgeOf, type BadgeState, HELD_TITLES, type HeldReason, WAITING_MESSAGE } from './status';

export const BADGE_MESSAGE = 'sop-backup:badge';
/** The toolbar icon's tooltip while the backup waits for a click, and when nothing needs the owner. */
export const BADGE_TITLE = WAITING_MESSAGE;
/** The manifest's own title (wxt.config.ts): the toolbar menu saves the page or opens the library (R103). */
export const DEFAULT_TITLE = 'sickofpdfs: save this page or open your library';
const BADGE_TEXT = '!';
/** The error colour of the light theme (GM3 error). A badge cannot read a CSS variable. */
const BADGE_COLOR = '#B3261C';

interface BadgeMessage {
  type: typeof BADGE_MESSAGE;
  badge: BadgeState;
}

const HELD = new Set<string>(Object.keys(HELD_TITLES));

/** A badge state that is well formed; null for anything else. */
export function asBadge(x: unknown): BadgeState | null {
  if (typeof x !== 'object' || x === null) return null;
  const b = x as { attention?: unknown; held?: unknown };
  if (b.attention === null) return { attention: null };
  if (b.attention === 'waiting') return { attention: 'waiting' };
  if (b.attention === 'held' && typeof b.held === 'string' && HELD.has(b.held)) return { attention: 'held', held: b.held as HeldReason };
  return null;
}

/** From the offscreen document or a page: show or clear the badge. Never throws; the next status change says it again. */
export function announceBackupBadge(badge: BadgeState): void {
  try {
    const message: BadgeMessage = { type: BADGE_MESSAGE, badge };
    const sent: unknown = chrome.runtime.sendMessage(message);
    if (sent instanceof Promise) sent.catch(() => {}); // nobody listening (the service worker is starting): it reads the status itself
  } catch {
    // The extension context is gone.
  }
}

/** The tooltip for a badge state. */
export const badgeTitle = (b: BadgeState): string => (b.attention === 'waiting' ? BADGE_TITLE : b.attention === 'held' ? HELD_TITLES[b.held] : DEFAULT_TITLE);

/** In the service worker: sets or clears the badge. */
export async function setBackupBadge(badge: BadgeState): Promise<void> {
  const on = badge.attention !== null;
  await chrome.action.setBadgeText({ text: on ? BADGE_TEXT : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  await chrome.action.setTitle({ title: badgeTitle(badge) });
}

/** The badge the status record asks for, put on the icon. Used when the service worker starts. */
export async function restoreBackupBadge(): Promise<void> {
  // In Incognito the extension only views PDFs: there is no library and no backup, so nothing is opened or kept there.
  if (chrome.extension.inIncognitoContext) return;
  const handles = await openHandleStore();
  try {
    await setBackupBadge(badgeOf(await handles.getStatus()));
  } finally {
    handles.close();
  }
}

/** Registers the listener. Call it synchronously when the service worker starts, so a message wakes it. */
export function installBackupBadge(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
    if (typeof raw !== 'object' || raw === null || (raw as { type?: unknown }).type !== BADGE_MESSAGE || sender.id !== chrome.runtime.id) return false;
    const badge = asBadge((raw as { badge?: unknown }).badge);
    if (badge !== null) setBackupBadge(badge).catch((error: unknown) => console.error('sickofpdfs: the backup badge was not set', error));
    return false; // no answer is sent
  });
  restoreBackupBadge().catch(() => {});
}
