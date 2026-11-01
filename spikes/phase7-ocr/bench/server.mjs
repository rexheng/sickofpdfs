// Local file server for the bench: serves test-assets/ocr/ at /files/…, and takes results at PUT /save/…
// (raw/<engine>/… go to results/raw/, everything else under test-assets/ocr/). CORS and CORP are open because the
// extension page (cross-origin isolated) fetches from here. Every request is counted, so a run can show what the page asked for.
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const OCR_ASSETS = resolve(fileURLToPath(new URL('../../../test-assets/ocr/', import.meta.url)));
export const RESULTS = resolve(fileURLToPath(new URL('../results/', import.meta.url)));
const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

export function startServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, PUT, OPTIONS');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    requests.push(`${req.method} ${path}`);
    if (req.method === 'PUT' && path.startsWith('/save/')) {
      const rel = path.slice('/save/'.length);
      const dest = resolve(rel.startsWith('raw/') ? join(RESULTS, rel) : join(OCR_ASSETS, rel));
      if (!dest.startsWith(RESULTS + sep) && !dest.startsWith(OCR_ASSETS + sep)) return void res.writeHead(403).end();
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, Buffer.concat(chunks));
      return void res.writeHead(204).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    if (!path.startsWith('/files/')) return void res.writeHead(404).end();
    const file = resolve(join(OCR_ASSETS, path.slice('/files/'.length)));
    if (!file.startsWith(OCR_ASSETS + sep)) return void res.writeHead(403).end();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': info.size });
    if (req.method === 'HEAD') return void res.end();
    pipeline(createReadStream(file), res, () => {});
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ origin: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) })));
}
