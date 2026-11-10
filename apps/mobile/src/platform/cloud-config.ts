// The app's cloud addresses (R109). Nothing here is ever called on its own: the owner's server is only a suggestion in Settings →
// Cloud until the owner taps Connect, and the waitlist opens in the phone's browser only when tapped.
import { waitlistUrl } from '@sop/core';

/** The owner's own server, filled in for "Connect my own server". */
export const OWNER_SERVER = 'https://sickofpdfs.rexheng-policy.workers.dev';

/** The public site, while the shared links do not name it yet (SITE_ORIGIN is set per build). */
const SITE = 'https://sickofpdfs-site.rexheng-policy.workers.dev';

/** "Join the waitlist". */
export const phoneWaitlistUrl = (): string => waitlistUrl() ?? `${SITE}/#waitlist`;

/**
 * The servers this build may talk to: the pages' Content-Security-Policy allows these and no other host (vite.config.ts writes
 * them into connect-src). The owner's server by default; a test build adds a local one with SOP_SYNC_ORIGINS.
 */
declare const __SOP_SYNC_ORIGINS__: readonly string[];
export const SYNC_ORIGINS: readonly string[] = __SOP_SYNC_ORIGINS__;

/** The Android app's sign-in redirect (contracts CA11; RFC 8252 private-use scheme). */
export const ANDROID_REDIRECT = 'com.sickofpdfs.reader:/oauth';
