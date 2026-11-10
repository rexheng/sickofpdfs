// Deploys the owner's production Worker from this machine or from CI, in one go. Each step is safe to run again.
//
//   node scripts/deploy-production.mjs [--dry-run] [--skip-build] [--skip-restore-point] [--skip-secrets] [--github-id <number>]
//
// Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. On the build machine the proxy adds the real token to every request
// to api.cloudflare.com, so CLOUDFLARE_API_TOKEN=proxy-injected is enough there.
//
// Why it is not a plain `wrangler deploy`: on this account Wrangler cannot upload Workers static assets, and the web library
// (about 27 MB: the PDF engine, its fonts and the scripts) is too big to put inside the Worker. So its files go to the R2
// bucket `sop-web`, one folder per build, and the Worker serves them from there (src/web/r2-assets.ts).
//
// Steps:
//   1. build the web library into apps/cloud/public (pnpm build:web);
//   2. upload it to R2: sop-web/<WEB_BUILD>/<path>, with the right content types. WEB_BUILD is a hash of every file, so an
//      unchanged build uploads nothing, and an older Worker version keeps its own files;
//   3. record a D1 Time Travel restore point for every database (written to .wrangler/restore-points/, and printed);
//   4. apply any missing D1 migrations;
//   5. deploy the Worker with WEB_BUILD;
//   6. set the secrets that are missing: ALLOWED_GITHUB_ID (from --github-id or ALLOWED_GITHUB_ID), and a fresh random
//      SESSION_SECRET and SOP_EXPORT_TOKEN. Existing secrets are never replaced (a new SESSION_SECRET would sign you out).
//      The random values go to Wrangler on stdin only: never printed, never in a file, never on a command line.
//      GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are the owner's to add (docs/setup/cloud.md);
//   7. the smoke test.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { wrangler } from './apply-local.mjs';
import { appDir, arg, envConfig, flag, runWrangler } from './cloud-env.mjs';

const ENV = 'production';
const BUCKET = 'sop-web';
const dryRun = flag('dry-run');
const cfg = envConfig(ENV);
const log = (...a) => console.log('[deploy production]', ...a);

if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (on the build machine: CLOUDFLARE_API_TOKEN=proxy-injected).');
  process.exit(2);
}
if (!cfg.r2_buckets.some((b) => b.binding === 'WEB' && b.bucket_name === BUCKET) || cfg.vars.STATIC_SOURCE !== 'r2') {
  console.error(`wrangler.jsonc env.production must bind WEB to ${BUCKET} and set STATIC_SOURCE to "r2".`);
  process.exit(2);
}

// 1. Build
if (!flag('skip-build')) {
  log('1. building the web library');
  if (!dryRun) {
    const r = spawnSync('pnpm', ['build:web'], { cwd: appDir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('the web library did not build');
  }
} else log('1. build skipped (--skip-build)');

// 2. Upload
const { CONTENT_TYPES } = await import('../src/web/r2-assets.ts');
const publicDir = join(appDir, 'public');
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
// _headers and dotfiles are for the static assets only; the Worker sets those headers itself.
const files = walk(publicDir)
  .map((abs) => ({ abs, path: relative(publicDir, abs).split(sep).join('/') }))
  .filter((f) => !f.path.split('/').some((p) => p.startsWith('.') || p.startsWith('_')))
  .sort((a, b) => a.path.localeCompare(b.path));
for (const need of ['index.html', 'viewer.html', 'pages.css', 'pdf/pdfium.wasm']) {
  if (!files.some((f) => f.path === need)) throw new Error(`the build has no ${need}: run without --skip-build`);
}
const buildHash = createHash('sha256');
for (const f of files) buildHash.update(`${f.path}\0${createHash('sha256').update(readFileSync(f.abs)).digest('hex')}\n`);
const WEB_BUILD = buildHash.digest('hex').slice(0, 32);
const typeOf = (path) => CONTENT_TYPES[/\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';
log(`2. web library build ${WEB_BUILD}: ${files.length} files`);

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' };
/** Runs Wrangler without waiting, for the parallel upload. */
const wranglerAsync = (args) =>
  new Promise((done) => {
    const p = spawn(process.execPath, [wrangler, ...args], { cwd: appDir, env: wranglerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (status) => done({ status, out }));
  });

const marker = `${BUCKET}/${WEB_BUILD}/.complete`;
const uploaded = !dryRun && runWrangler(['r2', 'object', 'get', marker, '--pipe', '--remote'], { allowFail: true }).status === 0;
if (uploaded) log(`   already in R2 (${BUCKET}/${WEB_BUILD}/), nothing to upload`);
else {
  const made = runWrangler(['r2', 'bucket', 'create', BUCKET], { dryRun, allowFail: true });
  if (made.status !== 0 && !/already exists/i.test(`${made.stdout}${made.stderr}`)) throw new Error(`the bucket ${BUCKET} could not be made`);
  const queue = [...files];
  let done = 0;
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const args = ['r2', 'object', 'put', `${BUCKET}/${WEB_BUILD}/${f.path}`, '--file', f.abs, '--content-type', typeOf(f.path), '--remote'];
      if (dryRun) {
        if (done++ < 3) console.log(`  [dry run] wrangler ${args.join(' ')}`);
        continue;
      }
      let r = await wranglerAsync(args);
      if (r.status !== 0) r = await wranglerAsync(args); // one retry
      if (r.status !== 0) throw new Error(`upload failed: ${f.path}\n${r.out.slice(-800)}`);
      done++;
      if (done % 10 === 0 || done === files.length) log(`   uploaded ${done}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // Written last: its presence means every file of this build is in R2.
  runWrangler(['r2', 'object', 'put', marker, '--pipe', '--content-type', 'text/plain', '--remote'], { dryRun, input: `${new Date().toISOString()}\n` });
}

// 3. Restore point
if (!flag('skip-restore-point')) {
  log('3. restore point for every database');
  const dir = join(appDir, '.wrangler', 'restore-points');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${ENV}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const r = spawnSync(process.execPath, ['scripts/restore-point.mjs', '--env', ENV, '--out', out, ...(dryRun ? ['--dry-run'] : [])], { cwd: appDir, stdio: 'inherit', env: wranglerEnv });
  if (r.status !== 0) throw new Error('no restore point, so nothing was changed');
  if (!dryRun) {
    for (const p of JSON.parse(readFileSync(out, 'utf8')).points) log(`   to go back: ${p.restore}`);
    log(`   saved in ${relative(appDir, out)}`);
  }
} else log('3. restore point skipped (--skip-restore-point)');

// 4. Schema
log('4. database migrations');
for (const d of cfg.d1_databases) {
  const r = runWrangler(['d1', 'migrations', 'apply', d.binding, '--remote', '--env', ENV], { dryRun, input: 'y\n' });
  const said = `${r.stdout}`.match(/No migrations to apply|applied|✅.*/i)?.[0] ?? 'done';
  log(`   ${d.binding} (${d.database_name}): ${said}`);
}

// 5. Deploy
log('5. deploying the Worker');
const dep = runWrangler(['deploy', '--env', ENV, '--var', `WEB_BUILD:${WEB_BUILD}`], { dryRun });
if (!dryRun) {
  const lines = dep.stdout.split('\n').filter((l) => /https:\/\/|schedule|Current Version ID|Uploaded|Total Upload/i.test(l));
  for (const l of lines) log(`   ${l.trim()}`);
}

// 6. Secrets (only the missing ones; values on stdin only)
if (!flag('skip-secrets')) {
  log('6. secrets');
  let have = [];
  if (!dryRun) {
    const r = runWrangler(['secret', 'list', '--env', ENV, '--format', 'json'], { allowFail: true });
    try {
      have = JSON.parse(r.stdout).map((s) => s.name);
    } catch {
      have = [];
    }
  }
  const githubId = (arg('github-id') ?? process.env.ALLOWED_GITHUB_ID ?? '').trim();
  if (githubId && !/^\d+$/.test(githubId)) throw new Error('--github-id must be the numeric GitHub id');
  const add = {};
  if (githubId) add.ALLOWED_GITHUB_ID = githubId;
  else if (!have.includes('ALLOWED_GITHUB_ID')) log('   ALLOWED_GITHUB_ID is missing: pass --github-id <number>, or nobody can sign in');
  if (!have.includes('SESSION_SECRET')) add.SESSION_SECRET = randomBytes(48).toString('base64url');
  if (!have.includes('SOP_EXPORT_TOKEN')) add.SOP_EXPORT_TOKEN = randomBytes(48).toString('base64url');
  if (Object.keys(add).length) {
    runWrangler(['secret', 'bulk', '--env', ENV], { dryRun, input: JSON.stringify(add) });
    log(`   set ${Object.keys(add).join(', ')}`);
  } else log('   nothing to set');
  for (const k of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']) {
    if (!have.includes(k)) log(`   ${k} is not set yet: sign-in shows "Sign-in is not set up yet" until you add it (docs/setup/cloud.md)`);
  }
} else log('6. secrets skipped (--skip-secrets)');

// 7. Smoke test
log('7. smoke test');
if (dryRun) log(`  [dry run] node scripts/smoke.mjs --url ${cfg.vars.PUBLIC_URL}`);
else {
  const r = spawnSync(process.execPath, ['scripts/smoke.mjs', '--url', cfg.vars.PUBLIC_URL], { cwd: appDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
log(`done: ${cfg.vars.PUBLIC_URL} (web build ${WEB_BUILD})`);
