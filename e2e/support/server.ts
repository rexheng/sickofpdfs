import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { HEADER_CASES } from './header-cases';

/** The folder `pnpm fixtures` fills (gitignored). */
export const TEST_ASSETS = fileURLToPath(new URL('../../test-assets/', import.meta.url));

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

/** Small pages that link to or embed the `/h/*` PDFs. Each is served as text/html. */
const HTML_PAGES: Record<string, string> = {
  // A form whose POST answer is a PDF: Chrome keeps it, because the viewer cannot replay a POST.
  '/h/post-form': '<h1>Form</h1><form method="post" action="/h/post"><button type="submit">Open the PDF</button></form>',
  // A link to a PDF that the server serves only when the request carries this page as its Referer.
  '/h/referer-page': '<h1>Reading list</h1><p><a id="pdf" href="/h/needs-referer.pdf">The paper</a></p>',
  // An ordinary page with no PDF: what a web page (and any content script running in it) sees of the browser's storage.
  '/h/plain-page': '<h1>A plain page</h1><p>No PDF here.</p>',
  '/h/embed-page': '<h1>A page with an embedded PDF</h1><p>Above the PDF.</p><embed type="application/pdf" src="/h/plain.pdf" width="600" height="400"><p>Below the PDF.</p>',
  '/h/object-page': '<h1>A page with an embedded PDF</h1><p>Above the PDF.</p><object type="application/pdf" data="/h/plain.pdf" width="600" height="400"></object><p>Below the PDF.</p>',
  '/h/iframe-page': '<h1>A page with an embedded PDF</h1><p>Above the PDF.</p><iframe src="/h/plain.pdf" width="600" height="400"></iframe><p>Below the PDF.</p>',
  // The iframe's PDF is an attachment: a download, which the page must survive.
  '/h/iframe-attachment-page': '<h1>A page with an attached PDF</h1><iframe src="/h/attachment.pdf" width="600" height="400"></iframe>',
};

const htmlPage = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>fixture page</title></head><body>${body}</body></html>`;

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
 * - `/h/*`: the HEADER_CASES, each with its own Content-Type and Content-Disposition, and the pages in HTML_PAGES.
 *   `POST /h/post` answers a PDF. `/h/needs-referer.pdf` answers 403 unless the request's Referer is `/h/referer-page`.
 * CORS is open because extension pages (chrome-extension://...) fetch from this origin.
 */
export async function startFixtureServer(): Promise<FixtureServer & { close(): Promise<void> }> {
  const counts = new Map<string, number>();
  const sequences = new Map<string, { bodies: Uint8Array[]; next: number }>();
  const headerCases = new Map<string, { ct: string | null; cd?: string }>(HEADER_CASES.map((c) => [pathOf(c.path), c]));
  // The Referer-checked PDF is a plain PDF once the check above has passed.
  headerCases.set('/h/needs-referer.pdf', { ct: 'application/pdf' });

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
      const isPost = req.method === 'POST' && pathOf(req.url ?? '/') === '/h/post';
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isPost) return void res.writeHead(405).end();
      let path: string;
      try {
        path = decodeURIComponent(pathOf(req.url ?? '/'));
      } catch {
        return void res.writeHead(400).end();
      }
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (await serveLoaderRoute(req, res, path, counts.get(path)!)) return;

      const sequence = sequences.get(path);
      if (sequence) {
        const body = sequence.bodies[Math.min(sequence.next++, sequence.bodies.length - 1)];
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.byteLength, 'cache-control': 'no-store' });
        return void res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (path.startsWith('/f/')) return serveFile(req, res, path.slice(3));
      if (isPost) {
        req.resume(); // the form body is not needed
        const body = await tinyPdfBytes();
        return void res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': body.byteLength, 'cache-control': 'no-store' }).end(body);
      }
      if (path === '/h/post') return void res.writeHead(405, { allow: 'POST' }).end(); // only the form's POST answers
      const page = HTML_PAGES[path];
      if (page !== undefined) {
        const html = Buffer.from(htmlPage(page));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.byteLength, 'cache-control': 'no-store' });
        return void res.end(req.method === 'HEAD' ? undefined : html);
      }
      if (path === '/h/needs-referer.pdf' && req.headers.referer !== `http://${req.headers.host}/h/referer-page`) {
        return void res.writeHead(403, { 'content-type': 'text/plain' }).end('Referer required');
      }
      const headerCase = headerCases.get(path);
      if (headerCase) {
        const body = await tinyPdfBytes();
        res.writeHead(200, {
          ...(headerCase.ct !== null ? { 'content-type': headerCase.ct } : {}),
          ...(headerCase.cd !== undefined ? { 'content-disposition': headerCase.cd } : {}),
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

// ---- Task 20: the loader's routes ----
//   /h/once.pdf       a link that works once: the first GET gets a PDF, later ones 403 (the takeover used the one good
//                     response, so the viewer's own fetch fails)
//   /h/fake.pdf       a login page served as application/pdf
//   /h/truncated.pdf  the first 60% of a valid PDF, with a matching Content-Length
//   /h/huge.pdf       Content-Length 1.2 GB, a PDF header, then the socket is held
//   /h/password.pdf   a PDF that opens with the password "secret"
//   /mock?…           answers as mockPath() describes
// `/f/*` and `/mock` answer CORS for the requesting Origin with credentials allowed, so a page on another origin (the
// Vitest browser page) can fetch them with `credentials: 'include'`.

/** What `/mock` answers. */
export interface MockOptions {
  /** HTTP status (default 200). */
  status?: number;
  contentType?: string;
  /** The Content-Length header. With no `body` and no `chunked`, the headers are sent and the socket is then held. */
  contentLength?: number;
  body?: string;
  /** Streams `%PDF-1.7` and then `bytes` zero bytes, with no Content-Length (chunked transfer). */
  chunked?: boolean;
  bytes?: number;
}

/** The `/mock` address that answers as `o` describes. */
export function mockPath(o: MockOptions): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined) q.set(k, String(v));
  return `/mock?${q.toString()}`;
}

const PASSWORD_PDF = fileURLToPath(new URL('../../packages/viewer/test/fixtures/password-secret.pdf', import.meta.url));
const HUGE_BYTES = 1_200_000_000;
const PDF_HEADER = '%PDF-1.7\n';
const ZERO_CHUNK = new Uint8Array(64 * 1024);

function allowCredentialedCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin === undefined) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-expose-headers', 'accept-ranges, content-range, content-length, content-disposition');
  res.setHeader('vary', 'Origin');
}

/** Sends the headers and keeps the response open until the client goes away (or the server closes). */
function holdOpen(res: ServerResponse, status: number, headers: Record<string, string | number>, first?: string): void {
  res.writeHead(status, headers);
  res.flushHeaders();
  if (first !== undefined) res.write(first);
}

async function streamZeros(res: ServerResponse, bytes: number): Promise<void> {
  res.write(PDF_HEADER);
  let left = bytes;
  while (left > 0 && !res.destroyed) {
    const chunk = left >= ZERO_CHUNK.byteLength ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, left);
    left -= chunk.byteLength;
    if (!res.write(chunk)) await new Promise<void>((resume) => res.once('drain', resume).once('close', resume));
  }
  res.end();
}

/** Answers the Task 20 routes; returns false for any other path (after adding CORS to `/f/*`). */
async function serveLoaderRoute(req: IncomingMessage, res: ServerResponse, path: string, count: number): Promise<boolean> {
  if (path.startsWith('/f/')) {
    allowCredentialedCors(req, res);
    return false;
  }
  const pdf = { 'content-type': 'application/pdf', 'cache-control': 'no-store' };
  switch (path) {
    case '/h/once.pdf': {
      if (count > 1) {
        res.writeHead(403, { 'content-type': 'text/html' }).end('<p>This link has expired.</p>');
        return true;
      }
      const body = await tinyPdfBytes();
      res.writeHead(200, { ...pdf, 'content-length': body.byteLength }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    case '/h/fake.pdf': {
      const body = '<!doctype html><html><body><form>Please sign in</form></body></html>';
      res.writeHead(200, { ...pdf, 'content-length': Buffer.byteLength(body) }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    case '/h/truncated.pdf': {
      const whole = await tinyPdfBytes();
      const body = whole.subarray(0, Math.floor(whole.byteLength * 0.6));
      res.writeHead(200, { ...pdf, 'content-length': body.byteLength }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    case '/h/huge.pdf':
      holdOpen(res, 200, { ...pdf, 'content-length': HUGE_BYTES }, req.method === 'HEAD' ? undefined : PDF_HEADER);
      return true;
    case '/h/password.pdf': {
      const body = await readFile(PASSWORD_PDF);
      res.writeHead(200, { ...pdf, 'content-length': body.byteLength }).end(req.method === 'HEAD' ? undefined : body);
      return true;
    }
    case '/mock': {
      allowCredentialedCors(req, res);
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      const num = (k: string) => (q.has(k) ? Number(q.get(k)) : undefined);
      const status = num('status') ?? 200;
      const contentType = q.get('contentType');
      const headers: Record<string, string | number> = { 'cache-control': 'no-store', ...(contentType !== null ? { 'content-type': contentType } : {}) };
      const contentLength = num('contentLength');
      const body = q.get('body');
      if (q.get('chunked') === 'true') {
        res.writeHead(status, headers);
        await streamZeros(res, num('bytes') ?? 0);
      } else if (body !== null) {
        res.writeHead(status, { ...headers, 'content-length': contentLength ?? Buffer.byteLength(body) }).end(body);
      } else if (contentLength !== undefined) {
        holdOpen(res, status, { ...headers, 'content-length': contentLength });
      } else {
        res.writeHead(status, headers).end();
      }
      return true;
    }
    default:
      return false;
  }
}
