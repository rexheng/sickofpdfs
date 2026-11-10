// The privacy page (spec R111). The Chrome Web Store, Google Play and the App Store each need one. Short, and true: every line
// here must match what the extension, the apps and this site really do.

import { esc, renderPage } from './layout.ts';

export interface PrivacyConfig {
  /** Who to write to. Empty: a marked placeholder (a production build refuses to run while it is empty). */
  contactEmail: string;
}

/** Change this date whenever the words below change. */
const UPDATED = '10 November 2026';

export function privacyPage(c: PrivacyConfig): string {
  const contact = c.contactEmail
    ? `<a href="mailto:${esc(c.contactEmail)}">${esc(c.contactEmail)}</a>`
    : '<mark>[contact email: the owner fills this in]</mark>';

  const main = [
    '<h1>Privacy</h1>',
    '<h2>The extension and the apps</h2>',
    '<p>Your PDFs and notes stay on your device, and in a backup folder if you choose one. Nothing is sent anywhere unless you turn it on or ask for it:</p>',
    '<ul class="plain">',
    '<li><b>Claude:</b> when you ask Claude, the text you ask about goes to Anthropic, with your own API key.</li>',
    '<li><b>Online lookups</b> (off at first): for a saved paper, only its DOI or arXiv number goes to Crossref or arXiv.</li>',
    '<li><b>Search:</b> words you choose to search for open in Google or Google Scholar, in a new tab.</li>',
    '<li><b>Listen with ElevenReader:</b> opens ElevenReader’s website. On Android, it hands the PDF to the ElevenReader app if you have it.</li>',
    '<li><b>Cloud sync</b> (coming): your saved readings and notes go to the server you connect.</li>',
    '</ul>',
    '<p>No ads, no trackers, no analytics.</p>',
    '<h2>This website</h2>',
    '<ul class="plain">',
    '<li>The waitlist keeps your email address and the date you joined. We use them only to tell you when cloud sync is ready. We never share or sell them.</li>',
    '<li>The form uses Cloudflare Turnstile to check you are not a bot. It loads only when you use the form. To do the check, Cloudflare sees your IP address and browser (<a href="https://www.cloudflare.com/turnstile-privacy-policy/">Turnstile privacy notice</a>).</li>',
    '<li>To stop abuse, we count sign-up tries from each connection for one minute. We don’t keep IP addresses or logs.</li>',
    '<li>This site sets no cookies. Cloudflare hosts it.</li>',
    '</ul>',
    '<h2>Contact</h2>',
    `<p>To delete your email from the waitlist, or to ask anything: ${contact}</p>`,
    `<p class="small">Updated ${UPDATED}.</p>`,
  ].join('\n');

  return renderPage({ title: 'Privacy', description: 'What sickofpdfs and its website keep, and what they send.', current: 'privacy', main });
}

export function notFoundPage(): string {
  return renderPage({ title: 'Not found', current: null, main: '<h1>Not found</h1>\n<p>This page doesn’t exist. <a href="/">Go to the home page</a>.</p>' });
}
