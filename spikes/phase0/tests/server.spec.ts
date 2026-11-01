import { randomBytes } from 'node:crypto';
import { readdir, readlink, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startServer } from './server.mjs';

// tests/server.mjs, which serves the fixtures: Content-Length, single ranges, and a client that goes away
// mid-file. No browser.
const SIZE = 64 * 1024 * 1024; // well over what the socket buffers hold, so the read stream is still open when the client leaves
let dir: string;
let file: string;
let bytes: Buffer;
let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sop-server-'));
  file = join(dir, 'big.bin');
  bytes = randomBytes(SIZE);
  await writeFile(file, bytes);
  server = await startServer(dir);
});
test.afterAll(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    request(server.url(path), { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    })
      .on('error', reject)
      .end();
  });
}

/** File descriptors of this process (the server runs in it) that are open on `path`. */
async function openFds(path: string): Promise<number> {
  let n = 0;
  for (const fd of await readdir('/proc/self/fd')) if ((await readlink(`/proc/self/fd/${fd}`).catch(() => '')) === path) n++;
  return n;
}

test('server: a whole file comes with its Content-Length and Accept-Ranges', async () => {
  const r = await get('big.bin');
  expect(r.status).toBe(200);
  expect(r.headers['content-length']).toBe(String(SIZE));
  expect(r.headers['accept-ranges']).toBe('bytes');
  expect(r.body.equals(bytes)).toBe(true);
});

test('server: single ranges get 206 with Content-Range; unsatisfiable ones 416', async () => {
  const mid = await get('big.bin', { range: 'bytes=1000-1999' });
  expect(mid.status).toBe(206);
  expect(mid.headers['content-range']).toBe(`bytes 1000-1999/${SIZE}`);
  expect(mid.headers['content-length']).toBe('1000');
  expect(mid.body.equals(bytes.subarray(1000, 2000))).toBe(true);

  const open = await get('big.bin', { range: `bytes=${SIZE - 10}-` });
  expect(open.status).toBe(206);
  expect(open.body.equals(bytes.subarray(SIZE - 10))).toBe(true);

  const suffix = await get('big.bin', { range: 'bytes=-5' });
  expect(suffix.status).toBe(206);
  expect(suffix.headers['content-range']).toBe(`bytes ${SIZE - 5}-${SIZE - 1}/${SIZE}`);
  expect(suffix.body.equals(bytes.subarray(SIZE - 5))).toBe(true);

  const clamped = await get('big.bin', { range: `bytes=${SIZE - 3}-${SIZE + 100}` });
  expect(clamped.status).toBe(206);
  expect(clamped.body.length).toBe(3);

  const beyond = await get('big.bin', { range: `bytes=${SIZE}-` });
  expect(beyond.status).toBe(416);
  expect(beyond.headers['content-range']).toBe(`bytes */${SIZE}`);
});

test('server: a client that leaves mid-file closes the file, and the server keeps serving', async () => {
  expect(await openFds(file)).toBe(0);
  await new Promise<void>((resolve, reject) => {
    const req = request(server.url('big.bin'), (res) => {
      res.once('data', () => {
        req.destroy(); // the client goes away after the first chunk
        resolve();
      });
    });
    req.on('error', (e) => (req.destroyed ? undefined : reject(e)));
    req.end();
  });
  await expect.poll(() => openFds(file), { timeout: 2000 }).toBe(0);
  const after = await get('big.bin', { range: 'bytes=0-9' });
  expect(after.status).toBe(206);
  expect(after.body.equals(bytes.subarray(0, 10))).toBe(true);
});
