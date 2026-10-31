// Serves fixtures/out/ on 127.0.0.1:<random port> for the spike tests.
// CORS is open because the extension page (chrome-extension://…) fetches from this origin.
// Files are streamed, so the multi-GB fixtures of later checks work too.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_OUT = fileURLToPath(new URL('../fixtures/out/', import.meta.url));

const TYPES = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
};

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
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
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
