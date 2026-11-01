// Serves fixtures/out/ on 127.0.0.1:<random port> for the spike tests.
// CORS is open because the extension page (chrome-extension://…) fetches from this origin.
// Files are streamed with their Content-Length, so large fixtures work too. A single
// `Range: bytes=a-b` (or `a-`, `-n`) gets 206; other range forms get the whole file. When the client goes
// away mid-file, or the read fails, pipeline() destroys both streams, which closes the file.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const FIXTURES_OUT = fileURLToPath(new URL('../fixtures/out/', import.meta.url));

const TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

/**
 * The byte range a `Range` header asks for, clamped to the file: null to send the whole file
 * (no header, or not one single bytes range), 'unsatisfiable' when it starts past the end.
 * @param {string | undefined} header
 * @param {number} size
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null}
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    return suffix === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  return start <= end ? { start, end } : null;
}

/**
 * @param {string} [root] folder to serve (default fixtures/out/)
 * @returns {Promise<{ origin: string, url(p: string): string, close(): Promise<void> }>}
 */
export function startServer(root = FIXTURES_OUT) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    let path;
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      return void res.writeHead(400).end();
    }
    const file = resolve(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) return void res.writeHead(403).end();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return void res.writeHead(404).end();
    const range = parseRange(req.headers.range, info.size);
    if (range === 'unsatisfiable') return void res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
    const { start, end } = range ?? { start: 0, end: info.size - 1 };
    res.writeHead(range ? 206 : 200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
      'accept-ranges': 'bytes',
      'access-control-expose-headers': 'accept-ranges, content-range',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD' || info.size === 0) return void res.end();
    pipeline(createReadStream(file, { start, end }), res, () => {}); // errors and early closes end both streams
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      const origin = `http://127.0.0.1:${port}`;
      done({
        origin,
        url: (p) => `${origin}/${p.replace(/^\/+/, '')}`,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}

// `node tests/server.mjs` serves the fixtures for a manual run.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { origin } = await startServer();
  console.log(`serving ${FIXTURES_OUT} at ${origin}`);
}
