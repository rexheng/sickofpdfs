import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { HEADER_CASES } from './header-cases';

const TEST_ASSETS = fileURLToPath(new URL('../../test-assets/', import.meta.url));

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`: the one origin the network gate allows. */
  origin: string;
  /** The address of `path` on this server. */
  url(path: string): string;
  /** How many requests `path` (a pathname such as `/f/paper-50.pdf`; any query is ignored) has had so far. */
  requests(path: string): number;
  /** Successive GETs of `path` get successive bodies; the last one repeats. */
  serveSequence(path: string, bodies: Uint8Array[]): void;
}

const pathOf = (p: string) => new URL(p, 'http://x').pathname;

/** The byte range a `Range` header asks for: null for the whole file, 'unsatisfiable' when it starts past the end. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
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

let tinyPdf: Promise<Uint8Array> | undefined;
/** One small, valid page: the body of every `/h/*` answer. */
function tinyPdfBytes(): Promise<Uint8Array> {
  tinyPdf ??= PDFDocument.create().then((doc) => {
    doc.addPage([300, 200]).drawText('sickofpdfs fixture', { x: 24, y: 100 });
    return doc.save();
  });
  return tinyPdf;
}

/**
 * Serves the e2e fixtures on 127.0.0.1 at a random port.
 * - `/f/<name>`: `test-assets/<name>` as application/pdf, with `Range` support (`pnpm fixtures` builds that folder).
 * - `/h/*`: the HEADER_CASES, each with its own Content-Type and Content-Disposition; later tasks add pages here.
 * CORS is open because extension pages (chrome-extension://...) fetch from this origin.
 */
export async function startFixtureServer(): Promise<FixtureServer & { close(): Promise<void> }> {
  const counts = new Map<string, number>();
  const sequences = new Map<string, { bodies: Uint8Array[]; next: number }>();
  const headerCases = new Map<string, (typeof HEADER_CASES)[number]>(HEADER_CASES.map((c) => [pathOf(c.path), c]));

  async function serveFile(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const root = resolve(TEST_ASSETS);
    const file = resolve(join(root, name));
    if (!file.startsWith(root + sep)) return void res.writeHead(403).end();
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) return void res.writeHead(404).end();
    const range = parseRange(req.headers.range, info.size);
    if (range === 'unsatisfiable') return void res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
    const { start, end } = range ?? { start: 0, end: info.size - 1 };
    res.writeHead(range ? 206 : 200, {
      'content-type': 'application/pdf',
      'content-length': end - start + 1,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${info.size}` } : {}),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD' || info.size === 0) return void res.end();
    pipeline(createReadStream(file, { start, end }), res, () => {}); // an early close ends both streams
  }

  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-expose-headers', 'accept-ranges, content-range, content-length');
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
      let path: string;
      try {
        path = decodeURIComponent(pathOf(req.url ?? '/'));
      } catch {
        return void res.writeHead(400).end();
      }
      counts.set(path, (counts.get(path) ?? 0) + 1);

      const sequence = sequences.get(path);
      if (sequence) {
        const body = sequence.bodies[Math.min(sequence.next++, sequence.bodies.length - 1)];
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.byteLength, 'cache-control': 'no-store' });
        return void res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (path.startsWith('/f/')) return serveFile(req, res, path.slice(3));
      const headerCase = headerCases.get(path);
      if (headerCase) {
        const body = await tinyPdfBytes();
        res.writeHead(200, {
          ...(headerCase.ct !== null ? { 'content-type': headerCase.ct } : {}),
          ...('cd' in headerCase ? { 'content-disposition': headerCase.cd } : {}),
          'content-length': body.byteLength,
          'cache-control': 'no-store',
        });
        return void res.end(req.method === 'HEAD' ? undefined : body);
      }
      res.writeHead(404).end();
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: (p) => `${origin}/${p.replace(/^\/+/, '')}`,
    requests: (p) => counts.get(pathOf(p)) ?? 0,
    serveSequence(p, bodies) {
      if (bodies.length === 0) throw new Error('serveSequence needs at least one body');
      sequences.set(pathOf(p), { bodies, next: 0 });
    },
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}
