import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';

/**
 * A second web site for the walkthroughs that need another origin: a course page that links to PDFs on a file host.
 * The harness's fixture server (support/server.ts) is one origin and keeps no record of request headers; a site here
 * is another origin (a different host name or port), answers what its routes say, and keeps every request it got
 * with its headers, so a test can see what the browser sent where.
 *
 * Another origin is "external" to the network gate, so tests that start a site run with `networkGate: 'observe'`
 * (see `siteTest`) and the gate is applied to everything that is not one of these sites.
 */
export interface SiteRequest {
  method: string;
  /** The path, without the query. */
  path: string;
  /** The query with its `?`, or ''. */
  search: string;
  headers: IncomingHttpHeaders;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, request: SiteRequest) => void | Promise<void>;

export interface Site {
  /** `http://<host>:<port>` */
  origin: string;
  url(path: string): string;
  /** Every request so far, oldest first. */
  log: SiteRequest[];
  /** The requests so far for `path`, oldest first. */
  requestsTo(path: string): SiteRequest[];
  route(path: string, handler: Handler): void;
  html(path: string, body: string): void;
  pdf(path: string, bytes: Uint8Array): void;
  /** True for an address on this site. */
  owns(url: string): boolean;
  close(): Promise<void>;
}

let tiny: Promise<Uint8Array> | undefined;
/** One small valid PDF page. */
export function tinyPdf(): Promise<Uint8Array> {
  tiny ??= PDFDocument.create().then((doc) => {
    doc.addPage([300, 200]).drawText('sickofpdfs test site', { x: 24, y: 100 });
    return doc.save();
  });
  return tiny;
}

/** Starts a site on `host` (127.0.0.1 or localhost: two hosts, so two origins, and two cookie jars) at a random port. */
export async function startSite(host: 'localhost' | '127.0.0.1'): Promise<Site> {
  const routes = new Map<string, Handler>();
  const log: SiteRequest[] = [];

  const server = createServer((req, res) => {
    void (async () => {
      const parsed = new URL(req.url ?? '/', 'http://x');
      const request: SiteRequest = { method: req.method ?? 'GET', path: decodeURIComponent(parsed.pathname), search: parsed.search, headers: req.headers };
      log.push(request);
      const handler = routes.get(request.path);
      if (!handler) return void res.writeHead(404).end();
      await handler(req, res, request);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const origin = `http://${host}:${(server.address() as AddressInfo).port}`;

  const site: Site = {
    origin,
    url: (p) => `${origin}/${p.replace(/^\/+/, '')}`,
    log,
    requestsTo: (p) => log.filter((r) => r.path === p),
    route: (p, h) => void routes.set(p, h),
    html: (p, body) =>
      site.route(p, (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><meta charset="utf-8">${body}`);
      }),
    pdf: (p, bytes) =>
      site.route(p, (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.byteLength, 'cache-control': 'no-store' }).end(bytes);
      }),
    owns: (u) => u.startsWith(`${origin}/`),
    close: () =>
      new Promise<void>((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
  // What the request carried, as JSON: how a test sees which Referer and cookies a request had.
  // Open to any origin, with cookies, so that what a test learns from it does not depend on how a page is allowed to read it.
  site.route('/echo', (_req, res, request) => {
    res
      .writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'access-control-allow-origin': request.headers.origin ?? '*',
        'access-control-allow-credentials': 'true',
      })
      .end(JSON.stringify({ headers: request.headers }));
  });
  return site;
}
