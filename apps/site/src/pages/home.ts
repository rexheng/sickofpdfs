// The home page (spec R111): one line on what it does, who uses it, a real count, the downloads, the cloud sync waitlist and
// the sponsor. Only the words that are needed.

import { esc, renderPage } from './layout.ts';

export interface HomeConfig {
  /** ELEVENREADER_STUDENT_URL from packages/core/src/links.ts, exactly as it is. */
  sponsorUrl: string;
  /** The Chrome Web Store listing id, or '' until there is one. */
  cwsItemId: string;
  /** The Google Play app id, or '' until the listing is live. */
  playAppId: string;
  /** The page's own script (home.client.js). */
  script: string;
}

interface Download {
  platform: string;
  /** The store link, or the words to show while there is none. */
  link: { href: string; text: string } | string;
}

function downloads(c: HomeConfig): Download[] {
  return [
    {
      platform: 'Chrome',
      link: c.cwsItemId ? { href: `https://chromewebstore.google.com/detail/${encodeURIComponent(c.cwsItemId)}`, text: 'Chrome Web Store' } : 'Coming soon',
    },
    {
      platform: 'Android',
      link: c.playAppId ? { href: `https://play.google.com/store/apps/details?id=${encodeURIComponent(c.playAppId)}`, text: 'Google Play' } : 'Coming soon',
    },
    { platform: 'iOS', link: 'Soon' },
  ];
}

export function homePage(c: HomeConfig): string {
  // The store shows the version and size; this table has no source for them yet, so it shows a dash rather than a guess.
  const rows = downloads(c)
    .map((d) => {
      const link = typeof d.link === 'string' ? esc(d.link) : `<a href="${esc(d.link.href)}">${esc(d.link.text)}</a>`;
      return `<tr><td>${link}</td><td>${esc(d.platform)}</td><td>–</td><td>–</td></tr>`;
    })
    .join('');

  const sponsor = esc(c.sponsorUrl);
  const main = [
    '<p><b>sickofpdfs</b> is a PDF reader for Chrome: highlight, comment and ask Claude.</p>',
    '<p>Trusted by students at UC Berkeley, LSE, NUS, NTU and UCL.</p>',
    // filled from /api/count by the script; stays hidden when there is no number to show
    '<p id="count" hidden></p>',
    '<h2 id="download">Download</h2>',
    `<table><thead><tr><th scope="col">Link</th><th scope="col">Platform</th><th scope="col">Version</th><th scope="col">Size</th></tr></thead><tbody>${rows}</tbody></table>`,
    '<h2 id="waitlist">Cloud sync waitlist</h2>',
    '<p>Cloud sync puts your notes on every device. Get an email when it’s ready.</p>',
    '<form id="join" novalidate>',
    '<label for="email">Email</label>',
    '<div class="row"><input id="email" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" maxlength="254" required aria-describedby="join-status"><button type="submit">Join</button></div>',
    '<div id="bot-check"></div>',
    '<p id="join-status" class="status" role="status" aria-live="polite"></p>',
    '<noscript><p>Turn on JavaScript to join.</p></noscript>',
    '</form>',
    '<p class="small">We keep only your email and the date you joined. <a href="/privacy">Privacy</a></p>',
  ].join('\n');

  // The sponsor, marked as such. ElevenLabs' own logo file, unaltered, with clear space equal to its height on every side.
  const aside = [
    '<aside class="sponsor" aria-labelledby="sponsor">',
    '<h2 id="sponsor">Sponsor</h2>',
    `<a class="logo" href="${sponsor}" rel="sponsored noopener"><img src="/elevenlabs-logo-black.svg" width="124" height="16" alt="ElevenLabs"></a>`,
    `<p><a href="${sponsor}" rel="sponsored noopener">ElevenReader</a> reads your PDFs aloud. Students get a free year.</p>`,
    '</aside>',
  ].join('\n');

  return renderPage({
    title: null,
    description: 'A PDF reader for Chrome: highlight, comment and ask Claude.',
    current: 'home',
    main,
    aside,
    script: c.script,
  });
}
