// Deploys the public site with its pages inside the Worker, instead of as Workers static assets.
//
//   node scripts/deploy-inline.mjs [--dry-run]
//
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. On the build machine the proxy adds the real token to every request to
// api.cloudflare.com, so CLOUDFLARE_API_TOKEN=proxy-injected is enough there.
//
// Why: on this account Wrangler cannot upload static assets (that one upload step is refused). The site is small (well under
// the free plan's 3 MB Worker limit), so its files can live in the Worker itself. It answers exactly like the static assets
// would (wrangler.jsonc, env.production.assets): the headers from public/_headers, "/privacy" serves privacy.html, "/privacy/"
// and "/privacy.html" go to "/privacy", and an unknown address gets 404.html with status 404.
//
// Steps:
//   1. build the pages for production (scripts/build.mjs --env production);
//   2. bundle src/worker.ts with Wrangler (a dry run: nothing is sent);
//   3. write index.js: the pages and pictures, and a small static-file server that sits in front of the bundled Worker;
//   4. write a Wrangler config from env.production, without "assets" and "build", and deploy it.
// The Worker's secrets (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY) stay on the Worker; a deploy does not touch them.
// The output is in .wrangler/deploy-inline/ (gitignored). With --dry-run it stops before the deploy.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const out = join(root, '.wrangler', 'deploy-inline');
const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
const log = (...a) => console.log('[site deploy]', ...a);
const MAX_BYTES = 3 * 1024 * 1024; // the free plan's Worker size limit (after gzip); we check the raw size, which is stricter

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${what} failed`);
  }
  return r.stdout;
}

if (!dryRun && (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (on the build machine: CLOUDFLARE_API_TOKEN=proxy-injected).');
  process.exit(2);
}

// 1. Pages
log('1. building the pages for production');
run(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/build.mjs', '--env', 'production'], 'the page build');

// The production settings, read the way scripts/build.mjs reads them (wrangler.jsonc without its comments)
const config = JSON.parse(
  readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1'),
);
const prod = config.env?.production;
if (!prod) throw new Error('wrangler.jsonc has no env.production');

// 2. Bundle the Worker (Wrangler's dry run sends nothing)
log('2. bundling the Worker');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run(process.execPath, [wrangler, 'deploy', '--dry-run', '--env', 'production', '--outdir', join(out, 'bundle')], 'the Worker bundle');
const bundled = readdirSync(join(out, 'bundle')).find((n) => /\.js$/.test(n));
if (!bundled) throw new Error('Wrangler wrote no bundle');
writeFileSync(join(out, 'worker.js'), readFileSync(join(out, 'bundle', bundled)));

// 3. The static files, and the server in front of the Worker
const publicDir = join(root, 'public');
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const TYPES = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  png: 'image/png',
  ico: 'image/x-icon',
  json: 'application/json; charset=utf-8',
};
const FILES = {};
for (const abs of walk(publicDir)) {
  const path = `/${relative(publicDir, abs).split(sep).join('/')}`;
  if (path.split('/').some((p) => p.startsWith('.') || p.startsWith('_'))) continue; // _headers is read below
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const type = TYPES[ext] ?? 'application/octet-stream';
  const bytes = readFileSync(abs);
  FILES[path] = type.startsWith('text/') || ext === 'svg' || ext === 'json' ? { body: bytes.toString('utf8'), type } : { b64: bytes.toString('base64'), type };
}
if (!FILES['/index.html'] || !FILES['/404.html']) throw new Error('the page build made no index.html or 404.html');

/** public/_headers as [{ pattern, headers }], in file order (Cloudflare applies every rule that matches). */
const RULES = [];
for (const line of readFileSync(join(publicDir, '_headers'), 'utf8').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) RULES.push({ pattern: line.trim(), headers: {} });
  else {
    const i = line.indexOf(':');
    if (i > 0 && RULES.length) RULES[RULES.length - 1].headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
}

const index = `// Made by apps/site/scripts/deploy-inline.mjs. Do not edit: run the script again.
import api from './worker.js';
const FILES = ${JSON.stringify(FILES)};
const RULES = ${JSON.stringify(RULES)};
const match = (pattern, path) => new RegExp('^' + pattern.replace(/[.+?^\${}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '.*') + '$').test(path);
function bytes(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
function serve(request) {
  const url = new URL(request.url);
  let p = url.pathname;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  // html_handling "drop-trailing-slash": /privacy serves privacy.html; /privacy/ and /privacy.html go to /privacy
  if (p.length > 1 && p.endsWith('/')) return Response.redirect(url.origin + p.slice(0, -1) + url.search, 307);
  if (p === '/index.html') return Response.redirect(url.origin + '/' + url.search, 307);
  if (p.endsWith('.html') && FILES[p]) return Response.redirect(url.origin + p.slice(0, -5) + url.search, 307);
  const key = p === '/' ? '/index.html' : FILES[p] ? p : FILES[p + '.html'] ? p + '.html' : null;
  const f = key ? FILES[key] : FILES['/404.html'];
  const status = key ? 200 : 404;
  const h = new Headers({ 'content-type': f.type });
  for (const r of RULES) if (match(r.pattern, key ?? p)) for (const [k, v] of Object.entries(r.headers)) h.set(k, v);
  if (request.method === 'HEAD') return new Response(null, { status, headers: h });
  return new Response(f.b64 ? bytes(f.b64) : f.body, { status, headers: h });
}
export default {
  fetch(request, env, ctx) { return api.fetch(request, { ...env, ASSETS: { fetch: serve } }, ctx); },
  scheduled(controller, env, ctx) { return api.scheduled(controller, env, ctx); },
};
`;
writeFileSync(join(out, 'index.js'), index);
const size = statSync(join(out, 'index.js')).size + statSync(join(out, 'worker.js')).size;
log(`3. ${Object.keys(FILES).length} files inside the Worker, ${(size / 1024).toFixed(0)} KB in all`);
if (size > MAX_BYTES) throw new Error('the Worker is over 3 MB: make the pictures smaller');

// 4. Config (env.production without "assets" and "build"; the database id and the rest as they are) and deploy
const rest = { ...prod };
delete rest.assets;
delete rest.build;
const inlineConfig = {
  name: prod.name,
  main: 'index.js',
  compatibility_date: config.compatibility_date,
  ...rest,
  no_bundle: true,
  rules: [{ type: 'ESModule', globs: ['**/*.js'] }],
  d1_databases: prod.d1_databases.map((d) => ({ binding: d.binding, database_name: d.database_name, database_id: d.database_id })),
};
writeFileSync(join(out, 'wrangler.json'), JSON.stringify(inlineConfig, null, 2));
log(`4. ${dryRun ? 'would deploy' : 'deploying'} ${prod.name} (${prod.vars.SITE_ORIGIN})`);
if (!dryRun) {
  const said = run(process.execPath, [wrangler, 'deploy', '--config', join(out, 'wrangler.json')], 'the deploy');
  for (const l of said.split('\n').filter((x) => /https:\/\/|schedule|Version ID|Total Upload/i.test(x))) log(`   ${l.trim()}`);
} else log(`   the files are in ${relative(root, out)}`);
