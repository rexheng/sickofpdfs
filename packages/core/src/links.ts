// Links shared by the extension, the Android app and the site (spec "Launch", R111 and R112).

/** The owner's ElevenReader student offer (ambassador link). Never change its query: it carries the referral. */
export const ELEVENREADER_STUDENT_URL = 'https://elevenreader.io/students?utm_source=ambassador&utm_campaign=95JF5-42KMR';

/** The public site's address. Empty until the site is deployed; a build may set it with SOP_SITE_ORIGIN. */
export const SITE_ORIGIN: string = (globalThis as { SOP_SITE_ORIGIN?: string }).SOP_SITE_ORIGIN ?? '';

/** The cloud waitlist page, or null while the site has no address yet. */
export function waitlistUrl(): string | null {
  return SITE_ORIGIN ? `${SITE_ORIGIN.replace(/\/$/, '')}/#waitlist` : null;
}
