// CL8 · The smoke test after every deploy: a stranger is refused, /mcp answers 401 with its metadata, the web library's files
// load with the right types, and one sync round trip works.
//
//   node scripts/smoke.mjs --url https://sickofpdfs-staging.<you>.workers.dev
//   node scripts/smoke.mjs --url http://127.0.0.1:8787 --fake-github http://127.0.0.1:<port>    (against `pnpm dev:test`)
//
// With --fake-github it signs in for real through the fake GitHub, as a stranger (refused) and as the owner (a push and a pull).
// Against a real Worker nobody can sign in headless, so it checks every door without a token, and does the sync round trip
// only when SMOKE_ACCESS_TOKEN (a sync token, 1 hour) is set; that round trip only reads.
// Also registers the extension and Android clients, because /authorize does so first.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { arg } from './cloud-env.mjs';

const W = (arg('url') ?? '').replace(/\/$/, '');
const GH = arg('fake-github');
const EXTENSION_ID = arg('extension-id', 'donjaoofgenmbfgfcefnmlgmhiffbglk');
if (!/^https?:\/\//.test(W)) {
  console.error('usage: node scripts/smoke.mjs --url <worker address> [--fake-github <address>]');
  process.exit(2);
}
let failed = 0;
const check = (cond, what) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) failed++;
};
const b64url = (b) => Buffer.from(b).toString('base64url');
const redirectUri = `https://${EXTENSION_ID}.chromiumapp.org/oauth`;

// Doors without a token
const health = await fetch(`${W}/api/health`).then((r) => r.json()).catch(() => null);
check(health?.ok === true, `health (${health?.environment ?? 'no answer'})`);
const as = await fetch(`${W}/.well-known/oauth-authorization-server`).then((r) => r.json()).catch(() => null);
check(as?.issuer === W && as.authorization_response_iss_parameter_supported === true, 'authorization server metadata, with iss');
const mcp = await fetch(`${W}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
check(mcp.status === 401 && (mcp.headers.get('www-authenticate') ?? '').includes(`resource_metadata="${W}/.well-known/oauth-protected-resource/mcp"`), '/mcp answers 401 with its metadata');
const prm = await fetch(`${W}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json()).catch(() => null);
check(prm?.resource === `${W}/mcp`, 'protected resource metadata');
check((await fetch(`${W}/api/sync/head`)).status === 401, 'sync needs a token');
check((await fetch(`${W}/api/sync/head`, { headers: { authorization: 'Bearer nobody:nothing:nothing' } })).status === 401, 'a made-up token is refused');
check((await fetch(`${W}/api/export/documents`, { headers: { authorization: 'Bearer wrong-export-token-123456' } })).status === 401, 'export needs the export token');

async function signIn(who) {
  const verifier = b64url(randomBytes(48));
  const state = b64url(randomBytes(12));
  const q = new URLSearchParams({ response_type: 'code', client_id: 'sickofpdfs-extension', redirect_uri: redirectUri, scope: 'sync offline_access', state, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: `${W}/api` });
  const cookies = new Map();
  let url = `${W}/authorize?${q}`;
  for (let hop = 0; hop < 8; hop++) {
    const mine = url.startsWith(W);
    const res = await fetch(url, { redirect: 'manual', headers: mine && cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {} });
    if (mine) for (const l of res.headers.getSetCookie()) { const [p] = l.split(';'); const i = p.indexOf('='); cookies.set(p.slice(0, i), p.slice(i + 1)); }
    const loc = res.headers.get('location');
    if (!loc) return { status: res.status, text: await res.text() };
    const next = new URL(loc, url);
    if (next.href.startsWith(redirectUri)) {
      const code = next.searchParams.get('code');
      const t = await fetch(`${W}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: 'sickofpdfs-extension', code_verifier: verifier, resource: `${W}/api` }) });
      return { token: (await t.json()).access_token };
    }
    if (GH && next.href.startsWith(GH)) next.searchParams.set('as', who);
    url = next.href;
  }
  return { status: 0, text: 'too many redirects' };
}

// The web library: signed out, "/" goes to sign in; its files load with the right types (from R2 in production)
const home = await fetch(`${W}/`, { redirect: 'manual' });
check(home.status === 302 && (home.headers.get('location') ?? '').startsWith('/login'), '"/" sends a signed-out visit to sign in');
const login = await fetch(`${W}/login`);
const loginText = await login.text();
const notSetUp = login.status === 503 && loginText.includes('Sign-in is not set up yet');
check((login.status === 200 && loginText.includes('Sign in with GitHub')) || notSetUp, `the sign-in page (${notSetUp ? 'GitHub sign-in is not set up yet' : login.status})`);
check(/default-src 'none'/.test(login.headers.get('content-security-policy') ?? ''), 'the sign-in page has its security policy');
for (const [path, type] of [['/pages.css', 'text/css'], ['/pdf/pdfium.wasm', 'application/wasm'], ['/pdf/NotoSans-Regular.ttf', 'font/ttf']]) {
  const r = await fetch(`${W}${path}`, { method: 'HEAD' });
  check(r.status === 200 && (r.headers.get('content-type') ?? '').startsWith(type) && r.headers.get('x-content-type-options') === 'nosniff', `${path} loads as ${type}`);
}
if (health?.environment === 'production') {
  // production's files come from R2 (src/web/r2-assets.ts), which never answers a missing script with the library page
  const missing = await fetch(`${W}/assets/no-such-file.js`, { method: 'HEAD' });
  check(missing.status === 404, 'a missing file is a 404, not the library page');
}

// Registers the first-party clients, and shows the extension's sign-in starts at GitHub (or, before the owner adds the GitHub
// sign-in keys, says plainly that sign-in is not set up)
const start = await fetch(`${W}/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'sickofpdfs-extension', redirect_uri: redirectUri, scope: 'sync', state: 'x', code_challenge: b64url(randomBytes(32)), code_challenge_method: 'S256', resource: `${W}/api` })}`, { redirect: 'manual' });
if (notSetUp) check(start.status === 503 && (await start.text()).includes('Sign-in is not set up yet'), 'the extension\'s sign-in says it is not set up yet');
else check(start.status === 302 && /\/login\/oauth\/authorize/.test(start.headers.get('location') ?? ''), 'the extension\'s sign-in goes to GitHub');

let token = process.env.SMOKE_ACCESS_TOKEN ?? null;
if (GH) {
  const s = await signIn('stranger');
  check(!s.token && s.status === 403, 'a stranger is refused');
  token = (await signIn('owner')).token ?? null;
  check(Boolean(token), 'the owner signs in');
} else console.log('note: no fake GitHub here, so the stranger is checked at the doors only (a real stranger is refused at the GitHub callback)');

if (token) {
  const api = (p, init = {}) => fetch(`${W}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const head = await api('/api/sync/head').then((r) => r.json());
  check(Number.isInteger(head.head), 'head');
  if (GH) {
    const dev = await api('/api/devices', { method: 'POST', body: '{"name":"smoke"}' }).then((r) => r.json());
    const stamp = `${String(Date.now()).padStart(13, '0')}-0000-smoke`;
    const pushed = await api('/api/sync/push', { method: 'POST', body: JSON.stringify({ device: dev.device, entries: [{ table: 'settings', id: 'smoke.check', baseRev: 0, hlc: stamp, row: { key: 'smoke.check', value: randomUUID() } }] }) }).then((r) => r.json());
    const pulled = await api(`/api/sync/pull?since=${head.head}`).then((r) => r.json());
    check(pushed.applied?.length === 1 && pulled.entries?.some((e) => e.id === 'smoke.check'), 'one sync round trip (push, then pull)');
  } else {
    const pulled = await api('/api/sync/pull?since=0&limit=1').then((r) => r.json());
    check(Array.isArray(pulled.entries), 'one sync round trip (pull only: a deployed library is never written by the smoke test)');
  }
} else console.log('note: set SMOKE_ACCESS_TOKEN for the sync round trip on a deployed Worker');

console.log(failed ? `${failed} check(s) failed` : 'smoke test passed');
process.exit(failed ? 1 : 0);
