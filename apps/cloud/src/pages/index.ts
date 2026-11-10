// The server-rendered pages (CL13): sign in, "This library is private", the consent page and the error pages. Plain HTML with
// no script, in the web library's look: one style sheet, /pages.css, built from the shared tokens with the bundled fonts
// (apps/cloud/web/src/pages/pages.css), so these pages load nothing from another site. Everything that came from outside (a
// client's name, a GitHub login, a host) is escaped. The wording is for the owner: short sentences, no jargon.
//
// No `form-action` in the policy on purpose: the sign-in form's answer is a redirect to GitHub, and the consent form's a
// redirect to the app that asked, and browsers apply `form-action` to those redirects too.

const CSP = "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'";

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Our mark, as the library's top bar draws it (the Material Symbol menu_book on a primary tile), and the product's name. */
const MARK = '<div class="mark"><span class="tile" aria-hidden="true">menu_book</span><span class="word">sickofpdfs</span></div>';

export function page(title: string, body: string, status = 200, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  h.set('x-frame-options', 'DENY');
  h.set('content-security-policy', CSP);
  // same-origin, not no-referrer: with no-referrer a browser sends `Origin: null` on our own form posts
  h.set('referrer-policy', 'same-origin');
  h.set('x-content-type-options', 'nosniff');
  return new Response(
    `<!doctype html><html lang="en" data-theme="light"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f8fafd"><title>${escapeHtml(title)} - sickofpdfs</title><link rel="stylesheet" href="/pages.css"><body><main>${MARK}<h1>${escapeHtml(title)}</h1>${body}</main>`,
    { status, headers: h },
  );
}

export const signInPage = (action: string, next = '/'): Response =>
  page(
    'Sign in',
    `<p>Your library is private. Sign in with your GitHub account to open it.</p><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="next" value="${escapeHtml(next)}"><button class="primary">Sign in with GitHub</button></form><p class="foot">Only the owner of this library can sign in.</p>`,
  );

export const notYourAccountPage = (login?: string): Response =>
  page(
    'This library is private',
    `<p>${login ? `You signed in to GitHub as <strong>${escapeHtml(login)}</strong>, but this` : 'This'} library belongs to someone else. Nothing was shared.</p><p class="muted">If this is your library, sign out of GitHub, then sign in with your own account.</p>`,
    403,
  );

export const errorPage = (title: string, message: string, status = 400): Response =>
  page(title, `<p>${escapeHtml(message)}</p><p class="muted">Close this window and try again.</p>`, status);

export interface ConsentView {
  clientName: string;
  /** For a client that publishes its own description (CIMD): the domain it is published on. */
  publishedBy?: string;
  /** Our own app (no "unverified" line). */
  ourApp: boolean;
  /** Where the sign-in goes back to (a host, or an app address). */
  redirectHost: string;
  /** It goes to an app on this computer. */
  loopback: boolean;
  /** Plain lines for what it may do. */
  abilities: string[];
  handle: string;
  action: string;
  /** Offer "Allow reading only" (the connector, when it asked to comment). */
  offerReadOnly: boolean;
}

/** The consent page. The first button allows; the form carries only the one-time handle. */
export function consentPage(v: ConsentView, headers: HeadersInit = {}): Response {
  const who = v.publishedBy
    ? `<p class="muted">Published by <strong>${escapeHtml(v.publishedBy)}</strong>.</p>`
    : v.ourApp
      ? ''
      : '<p class="muted">This app gave its own name. The name is not checked.</p>';
  const local = v.loopback ? '<p class="note">This sends access to an app on this computer. Only continue if you just started signing in from it.</p>' : '';
  return page(
    `Allow ${v.clientName}?`,
    `${who}<p>It will be able to:</p><ul>${v.abilities.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul><p>Access goes to <strong>${escapeHtml(v.redirectHost)}</strong>.</p>${local}` +
      `<form method="post" action="${escapeHtml(v.action)}"><input type="hidden" name="handle" value="${escapeHtml(v.handle)}">` +
      `<button class="primary" name="decision" value="approve">Allow</button>` +
      (v.offerReadOnly ? '<button name="decision" value="read-only">Allow reading only</button>' : '') +
      '<button name="decision" value="deny">Cancel</button></form>',
    200,
    headers,
  );
}

/** Shown while the GitHub sign-in app is not connected yet (no GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET on the Worker). */
export const signInNotSetUpPage = (): Response =>
  page(
    'Sign-in is not set up yet',
    '<p>Your library is ready, but GitHub sign-in is not connected yet.</p><p class="muted">To finish, add your two GitHub sign-in keys in the Cloudflare dashboard. The cloud setup guide shows each click.</p>',
    503,
  );

export const claudeOffPage = (): Response =>
  page('Claude is turned off', "<p>You turned off Claude's access to your library.</p><p>To connect Claude, turn it on in your library's Settings first.</p>", 503);

/** Where the Android app's app-link sign-in lands when the app did not open. It never shows the code. */
export const backToAppPage = (): Response => page('Go back to the app', '<p>Sign-in is done. If the app did not open by itself, go back to it now.</p>');
