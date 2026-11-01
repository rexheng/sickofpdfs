// CL13 replaces these: the server-rendered pages (sign in, "not your account", consent). Plain HTML for now, so the sign-in
// flow can be exercised before the web slice lands. Anything shown here must be escaped.

const page = (title: string, body: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;margin:2rem auto;max-width:32rem;padding:0 1rem"><h1>${title}</h1>${body}`, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' },
  });

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const signInPage = (action: string): Response => page('Sign in', `<form method="post" action="${escapeHtml(action)}"><button>Sign in with GitHub</button></form>`);
export const notYourAccountPage = (): Response => page('Not your account', '<p>This library belongs to someone else.</p>');
export const consentPage = (client: string, scopes: string[], action: string): Response =>
  page('Allow access?', `<p>${escapeHtml(client)} wants to: ${escapeHtml(scopes.join(', '))}</p><form method="post" action="${escapeHtml(action)}"><button name="approve" value="1">Allow</button></form>`);
