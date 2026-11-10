// Makes the site's static files in public/ from src/pages: index.html, features.html, privacy.html, 404.html and _headers.
// Wrangler runs it before every `wrangler dev` and `wrangler deploy` (wrangler.jsonc, "build").
//
// The settings come from wrangler.jsonc `vars` (the top level, or `--env production`), so the pages and the Worker read the same
// values. The ElevenReader link comes from packages/core/src/links.ts, exactly as it is there.
//
// Usage: node scripts/build.mjs [--env production]
//   A production build stops with an error while CONTACT_EMAIL is empty, so the privacy page never ships with a placeholder.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const file = (p) => new URL(p, root);
const args = process.argv.slice(2);
const envName = args.includes('--env') ? args[args.indexOf('--env') + 1] : null;

// --- settings
const config = parseJsonc(readFileSync(file('wrangler.jsonc'), 'utf8'));
const scope = envName ? config.env?.[envName] : config;
if (!scope) fail(`wrangler.jsonc has no environment "${envName}"`);
const vars = scope.vars ?? {};
const setting = (name) => String(vars[name] ?? '').trim();
const contactEmail = setting('CONTACT_EMAIL');
if (envName === 'production' && !contactEmail) fail('Set CONTACT_EMAIL in wrangler.jsonc (env.production.vars) before deploying: the privacy page needs it.');

// --- the shared link, from @sop/core (links.ts has no imports, so Node can load it on its own)
const links = await import(new URL('./links.ts', import.meta.resolve('@sop/core')).href);
const sponsorUrl = links.ELEVENREADER_STUDENT_URL;
if (typeof sponsorUrl !== 'string' || !sponsorUrl.startsWith('https://')) fail('ELEVENREADER_STUDENT_URL is missing from packages/core/src/links.ts');

// --- the pages
const { homePage } = await import('../src/pages/home.ts');
const { featuresPage } = await import('../src/pages/features.ts');
const { privacyPage, notFoundPage } = await import('../src/pages/privacy.ts');
const { STYLE } = await import('../src/pages/layout.ts');
const script = readFileSync(file('src/pages/home.client.js'), 'utf8');

const pages = {
  'index.html': homePage({ sponsorUrl, cwsItemId: setting('CWS_ITEM_ID'), playAppId: setting('PLAY_APP_ID'), script }),
  'features.html': featuresPage(),
  'privacy.html': privacyPage({ contactEmail }),
  '404.html': notFoundPage(),
};
for (const [name, html] of Object.entries(pages)) writeFileSync(file(`public/${name}`), html);

// --- headers for the static files. The inline style and script are allowed by their hashes; the only other site a page
// may talk to is Cloudflare's bot check, and only the home page's script asks for it.
const hash = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
const csp = [
  "default-src 'none'",
  `script-src ${hash(script)} https://challenges.cloudflare.com`,
  `style-src ${hash(STYLE)}`,
  "img-src 'self'",
  "connect-src 'self'",
  'frame-src https://challenges.cloudflare.com',
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
writeFileSync(
  file('public/_headers'),
  [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '/elevenlabs-logo-black.svg',
    '  Cache-Control: public, max-age=604800',
    '/favicon.svg',
    '  Cache-Control: public, max-age=604800',
    '/*.webp',
    '  Cache-Control: public, max-age=604800',
    '',
  ].join('\n'),
);

const size = (name) => `${name} ${(Buffer.byteLength(pages[name]) / 1024).toFixed(1)} KB`;
console.log(`site: built ${Object.keys(pages).map(size).join(', ')}${envName ? ` (${envName})` : ''}${contactEmail ? '' : '; CONTACT_EMAIL is empty, so the privacy page shows a placeholder'}`);

/** JSON with // and /* comments and trailing commas (wrangler.jsonc). Text inside strings is kept as it is. */
function parseJsonc(text) {
  const upTo = (t, mark, from, extra) => (t.indexOf(mark, from) === -1 ? t.length : t.indexOf(mark, from) + extra);
  const withoutComments = scan(text, (t, i) => (t.startsWith('//', i) ? upTo(t, '\n', i, 0) : t.startsWith('/*', i) ? upTo(t, '*/', i + 2, 2) : -1));
  const withoutTrailingCommas = scan(withoutComments, (t, i) => (t[i] === ',' && /^\s*[}\]]/.test(t.slice(i + 1)) ? i + 1 : -1));
  return JSON.parse(withoutTrailingCommas);
}

/** Copies `text`, except the stretches that `skip` marks (it returns where a stretch ends, or -1), never inside a string. */
function scan(text, skip) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const end = skip(text, i);
    if (end === -1) out += text[i++];
    else i = end;
  }
  return out;
}

function fail(message) {
  console.error(`site build: ${message}`);
  process.exit(1);
}
