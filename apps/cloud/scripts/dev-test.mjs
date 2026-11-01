// `pnpm -C apps/cloud dev:test`: the Worker on your machine, nothing on Cloudflare.
//
//   - a temporary folder for the databases, the bucket and the KV (removed when you stop; `--keep` leaves it),
//   - the schema applied to it (apply-local.mjs),
//   - a fake GitHub on its own port that signs in as the owner (`as=owner`) or as a stranger (`as=stranger`), and describes test
//     OAuth clients at /clients/<name> (test/fake-github.ts),
//   - `wrangler dev --local` with the Worker's variables pointed at the fake and throwaway secrets.
//
// Options: --port 8787   --keep   --check (start, ask the Worker its health, print it, stop; exit 1 if anything is wrong)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLocal, wrangler } from './apply-local.mjs';
import { FAKE_OWNER, FAKE_STRANGER, createFakeInternet } from '../test/fake-github.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const workerPort = Number(option('port', '8787'));
const check = flag('check');

const stateDir = option('state', undefined) ?? mkdtempSync(join(tmpdir(), 'sop-cloud-dev-'));
const log = (...a) => console.log('[dev:test]', ...a);

// 1. the fake GitHub
let internet;
const fake = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const r = internet.handle({
      method: req.method ?? 'GET',
      url: `http://${req.headers.host}${req.url}`,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : (v ?? '')])),
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
});
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
const fakePort = fake.address().port;
const fakeBase = `http://127.0.0.1:${fakePort}`;
internet = createFakeInternet({ githubHost: `127.0.0.1:${fakePort}`, clientHosts: [`127.0.0.1:${fakePort}`] });
log(`fake GitHub on ${fakeBase}`);

// 2. the schema
log(`temporary storage: ${stateDir}`);
for (const r of applyLocal(stateDir)) {
  log(`schema ${r.binding}: ${r.ok ? (/(\d+) commands executed successfully/.exec(r.output)?.[0] ?? 'ok') : `FAILED\n${r.output}`}`);
  if (!r.ok) {
    fake.close();
    process.exit(1);
  }
}

// 3. the Worker
const publicUrl = `http://127.0.0.1:${workerPort}`;
const vars = {
  PUBLIC_URL: publicUrl,
  GITHUB_BASE_URL: fakeBase,
  GITHUB_API_URL: fakeBase,
  GITHUB_CLIENT_ID: 'fake-client-id',
  GITHUB_CLIENT_SECRET: 'fake-secret',
  ALLOWED_GITHUB_ID: String(FAKE_OWNER.id),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  SOP_EXPORT_TOKEN: randomBytes(24).toString('hex'),
};
const child = spawn(
  process.execPath,
  [wrangler, 'dev', '--local', '--persist-to', stateDir, '--ip', '127.0.0.1', '--port', String(workerPort), ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`])],
  { cwd: appDir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));

let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  child.kill('SIGTERM');
  await new Promise((resolve) => (child.exitCode === null ? child.once('exit', resolve) : resolve(undefined)));
  fake.close();
  if (!flag('keep')) rmSync(stateDir, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
child.on('exit', (code) => {
  if (!stopping) {
    console.error(output.split('\n').slice(-15).join('\n'));
    log(`wrangler stopped by itself (exit ${code})`);
    void stop(1);
  }
});

// 4. wait until it answers
const started = Date.now();
let health = null;
while (Date.now() - started < 90_000) {
  try {
    const r = await fetch(`${publicUrl}/api/health`);
    if (r.ok) {
      health = await r.json();
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!health) {
  console.error(output.split('\n').slice(-20).join('\n'));
  log('the Worker did not answer within 90 seconds');
  await stop(1);
}
log(`Worker ready on ${publicUrl} after ${Math.round((Date.now() - started) / 100) / 10} s`);

if (check) {
  const db = await (await fetch(`${publicUrl}/api/health/db`)).json();
  console.log(JSON.stringify({ health, db }, null, 2));
  const ok = health.ok === true && health.environment === 'local' && db.ok === true && db.meta.objects > 0 && db.text.length === 2 && db.text.every((t) => t.objects > 0);
  log(ok ? 'CHECK OK: the Worker answers and the schema is applied' : 'CHECK FAILED');
  await stop(ok ? 0 : 1);
} else {
  console.log(`
  Worker              ${publicUrl}
  Health              ${publicUrl}/api/health      (local only: ${publicUrl}/api/health/db)
  Fake GitHub         ${fakeBase}
    sign in as the owner     add &as=owner to its /login/oauth/authorize address   (id ${FAKE_OWNER.id})
    sign in as a stranger    add &as=stranger                                       (id ${FAKE_STRANGER.id})
  Test OAuth clients  ${fakeBase}/clients/<name>?redirect_uri=<where to send the code>
  Storage             ${stateDir}${flag('keep') ? ' (kept)' : ' (removed when you stop)'}

  Press Ctrl+C to stop.
`);
}
