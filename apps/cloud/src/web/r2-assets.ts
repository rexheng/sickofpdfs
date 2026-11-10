// The web library's static files from R2, for production (STATIC_SOURCE = "r2").
//
// Why: on this account Wrangler cannot upload Workers static assets (the upload step is refused), and the web library (the
// PDF engine, its fonts and the scripts, about 27 MB) is far too big to put inside the Worker. So `scripts/deploy-production.mjs`
// uploads the built files (apps/cloud/public) to the R2 bucket `sop-web`, under `<WEB_BUILD>/<path>`, and passes WEB_BUILD (a
// hash of every file) to the Worker. Each deploy has its own folder, so a Worker version always serves the files it was built
// with, and going back to an older version brings its files back too.
//
// This answers exactly like the static assets do for the Worker (`c.env.ASSETS.fetch`), with the same rules as
// web/public/_headers: "/" is index.html, "/viewer" is viewer.html, "/index.html" and "/viewer.html" redirect to the short
// address, an unknown page address gets index.html (single-page app), and a missing file is a 404. Locally (`wrangler dev`, the
// tests) the real static assets are used and none of this runs.
import type { Env } from '../env';

/** The same list as web/public/_headers. web/app.ts adds the page-only headers again on top, which is harmless. */
const FILE_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' blob: data:; font-src 'self'; style-src 'self' 'unsafe-inline'; manifest-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'cross-origin-opener-policy': 'same-origin',
};

/** Content types by extension, used when an object was stored without one. The deploy script sets the same types. */
export const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  wasm: 'application/wasm',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

const extension = (path: string): string => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';

/** Hashed files (assets/name-HASH.ext) never change; everything else is checked again every time (cheap, with the ETag). */
function cacheControl(path: string): string {
  if (path.endsWith('.html')) return 'no-store';
  if (path.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return 'public, max-age=0, must-revalidate';
}

const plain = (status: number, text: string, extra: HeadersInit = {}): Response =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra } });

/** Maps a request path to a file in the build, the way the static assets do. `redirect` is set for /index.html and /viewer.html. */
function resolve(pathname: string): { file: string; redirect?: string } {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    p = pathname;
  }
  p = p.replace(/^\/+/, '');
  if (p === '') return { file: 'index.html' };
  if (p === 'index.html') return { file: 'index.html', redirect: '/' };
  if (p === 'viewer') return { file: 'viewer.html' };
  if (p === 'viewer.html') return { file: 'viewer.html', redirect: '/viewer' };
  return { file: p };
}

const isBody = (o: R2Object | R2ObjectBody): o is R2ObjectBody => 'body' in o;

/** A stand-in for the static-assets binding, backed by the R2 bucket `WEB`. Only `fetch` is used (web/app.ts). */
export function r2Assets(env: Env): Fetcher {
  const bucket = env.WEB;
  const build = (env.WEB_BUILD ?? '').trim();
  const fetchFile = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    if (!bucket || !/^[0-9a-f]{16,64}$/.test(build)) return plain(503, 'The web library is not uploaded yet.');
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed', { allow: 'GET, HEAD' });
    const url = new URL(request.url);
    const { file, redirect } = resolve(url.pathname);
    if (redirect) return new Response(null, { status: 307, headers: { location: `${redirect}${url.search}`, 'cache-control': 'no-store' } });
    // Never let a path step out of this build's folder, and never serve a dotfile (such as the upload's .complete marker).
    if (file.split('/').some((part) => part === '' || part.startsWith('.')) || file.startsWith('_')) return plain(404, 'Not found');

    const read = (n: string): Promise<R2Object | R2ObjectBody | null> => (request.method === 'HEAD' ? bucket.head(`${build}/${n}`) : bucket.get(`${build}/${n}`));
    let name = file;
    let obj = await read(name);
    if (obj === null && extension(name) === '') {
      // A page address the library handles itself (single-page app): give it the library page.
      name = 'index.html';
      obj = await read(name);
    }
    if (obj === null) return plain(404, 'Not found');

    const etag = `"${build.slice(0, 16)}"`;
    const headers = new Headers(FILE_HEADERS);
    headers.set('content-type', obj.httpMetadata?.contentType ?? CONTENT_TYPES[extension(name)] ?? 'application/octet-stream');
    headers.set('cache-control', cacheControl(name));
    headers.set('etag', etag);
    const ifNoneMatch = request.headers.get('if-none-match') ?? '';
    if (!name.endsWith('.html') && ifNoneMatch.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) {
      if (isBody(obj)) await obj.body.cancel();
      return new Response(null, { status: 304, headers });
    }
    headers.set('content-length', String(obj.size));
    if (!isBody(obj)) return new Response(null, { status: 200, headers });
    return new Response(obj.body, { status: 200, headers });
  };
  return { fetch: fetchFile, connect: () => { throw new Error('not supported'); } };
}
