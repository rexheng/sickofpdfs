// Spec-blind tests for the fixture server (interface: 127.0.0.1, random port; /f/<name> serves test-assets/<name>
// as application/pdf; requests(path) counts requests; also used by Vitest from Task 20).
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSamplePdf, REPO_ROOT } from './sample-pdf.spec-blind';
import { startFixtureServer } from './server';

type Server = Awaited<ReturnType<typeof startFixtureServer>>;
const NAME = 't12-server-check.pdf';
let server: Server;

/** One GET with the path exactly as given (fetch() and URL would tidy `..` away before it left). */
function rawGet(origin: string, path: string): Promise<{ status: number; type: string | undefined; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    http
      .get({ hostname, port, path }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
      })
      .on('error', reject);
  });
}

beforeAll(async () => {
  await ensureSamplePdf(NAME);
  server = await startFixtureServer();
});
afterAll(async () => {
  await server.close();
});

describe('the fixture server', () => {
  it('serves test-assets/<name> at /f/<name> as application/pdf, byte for byte', async () => {
    const want = await readFile(join(REPO_ROOT, 'test-assets', NAME));
    const got = await rawGet(server.origin, `/f/${NAME}`);
    expect(got.status).toBe(200);
    expect(got.type).toMatch(/^application\/pdf/);
    expect(got.body.equals(want)).toBe(true);
  });

  it('listens on 127.0.0.1 on its own random port, and url() joins onto the origin', async () => {
    const other = await startFixtureServer();
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(other.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(other.origin).not.toBe(server.origin);
      expect(server.url(`/f/${NAME}`)).toBe(`${server.origin}/f/${NAME}`);
    } finally {
      await other.close();
    }
  });

  it('counts requests per path, and only for the server that got them', async () => {
    const other = await startFixtureServer();
    try {
      const before = server.requests(`/f/${NAME}`);
      for (let i = 0; i < 3; i++) await rawGet(server.origin, `/f/${NAME}`);
      expect(server.requests(`/f/${NAME}`)).toBe(before + 3);
      expect(other.requests(`/f/${NAME}`)).toBe(0);
      expect(server.requests('/f/never-asked-for.pdf')).toBe(0);
    } finally {
      await other.close();
    }
  });

  it('answers a file that does not exist with 404, not a crash or an empty 200', async () => {
    const got = await rawGet(server.origin, '/f/no-such-file.pdf');
    expect(got.status).toBe(404);
    expect((await rawGet(server.origin, `/f/${NAME}`)).status).toBe(200); // still alive
  });

  it.each([
    ['dot-dot segments', '/f/../package.json'],
    ['dot-dot at the start of the name', '/f/../../package.json'],
    ['encoded slash', '/f/..%2fpackage.json'],
    ['encoded dots', '/f/%2e%2e/%2e%2e/package.json'],
    ['double-encoded', '/f/%252e%252e%252fpackage.json'],
    ['backslash', '/f/..%5cpackage.json'],
  ])('never serves a file from outside test-assets/: %s', async (_name, path) => {
    const got = await rawGet(server.origin, path);
    expect(got.status).not.toBe(200);
    expect(got.body.toString('utf8')).not.toContain('"name": "sickofpdfs"');
  });

  it('stops listening after close()', async () => {
    const short = await startFixtureServer();
    await short.close();
    await expect(rawGet(short.origin, `/f/${NAME}`)).rejects.toThrow();
  });
});
