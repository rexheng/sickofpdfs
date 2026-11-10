// CL8 · Bootstrap one environment on the owner's Cloudflare account. Runs only from the "Bootstrap cloud" workflow, only after
// the owner's OK (plan Round 6), and never for `local`.
//
//   node scripts/bootstrap.mjs --env staging|production [--dry-run]
//
// Steps, each safe to run again (an existing database, bucket or namespace is reused, never replaced):
//   1. find or create the D1 databases, the R2 bucket and the KV namespace named in wrangler.jsonc's env block;
//   2. write their ids and the workers.dev address into wrangler.jsonc (the workflow commits it);
//   3. apply the schema (D1 migrations) to every database;
//   4. deploy the Worker;
//   5. set its secrets: the GitHub OAuth App, the owner's id, and two secrets made from SESSION_SECRET for this environment
//      only (the session secret and the backup export token);
//   6. run the smoke test, which also registers the extension and Android clients (/authorize registers them).
//
// Needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, ALLOWED_GITHUB_ID, SESSION_SECRET, GH_OAUTH_CLIENT_ID, GH_OAUTH_CLIENT_SECRET.
// --dry-run prints every command and the config change and touches nothing.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { appDir, arg, configPath, derivedSecret, envConfig, flag, runWrangler } from './cloud-env.mjs';

const envName = arg('env');
const dryRun = flag('dry-run');
const cfg = envConfig(envName);
const log = (...a) => console.log(`[bootstrap ${envName}]`, ...a);

const need = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'ALLOWED_GITHUB_ID', 'SESSION_SECRET', 'GH_OAUTH_CLIENT_ID', 'GH_OAUTH_CLIENT_SECRET'];
const missing = need.filter((k) => !process.env[k]);
if (missing.length && !dryRun) {
  console.error(`Missing secrets: ${missing.join(', ')}. See docs/setup/cloud.md.`);
  process.exit(1);
}
if (process.env.ALLOWED_GITHUB_ID && !/^\d+$/.test(process.env.ALLOWED_GITHUB_ID)) {
  console.error('ALLOWED_GITHUB_ID must be your numeric GitHub id (https://api.github.com/users/<you> shows it as "id").');
  process.exit(1);
}

const json = (r, fallback) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return fallback;
  }
};

// 1. Resources
log('1. databases, bucket and key-value namespace');
const dbIds = {};
let d1 = dryRun ? [] : json(runWrangler(['d1', 'list', '--json']), []);
for (const d of cfg.d1_databases) {
  let found = d1.find((x) => x.name === d.database_name);
  if (!found) {
    log(`   creating database ${d.database_name}`);
    runWrangler(['d1', 'create', d.database_name], { dryRun });
    d1 = dryRun ? [{ name: d.database_name, uuid: `dry-run-${d.binding.toLowerCase()}` }, ...d1] : json(runWrangler(['d1', 'list', '--json']), []);
    found = d1.find((x) => x.name === d.database_name);
  } else log(`   reusing database ${d.database_name}`);
  if (!found) throw new Error(`database ${d.database_name} was not created`);
  dbIds[d.database_name] = found.uuid;
}
for (const b of cfg.r2_buckets) {
  const r = runWrangler(['r2', 'bucket', 'create', b.bucket_name], { dryRun, allowFail: true });
  if (r.status !== 0 && !/already exists/i.test(`${r.stdout}${r.stderr}`)) throw new Error(`bucket ${b.bucket_name} could not be created (is R2 turned on?)`);
  log(`   bucket ${b.bucket_name} ready`);
}
const kvTitle = `sickofpdfs-${envName}-oauth`;
let kv = dryRun ? [] : json(runWrangler(['kv', 'namespace', 'list']), []);
let ns = kv.find((n) => n.title === kvTitle || n.title.endsWith(`-${kvTitle}`));
if (!ns) {
  runWrangler(['kv', 'namespace', 'create', kvTitle], { dryRun });
  kv = dryRun ? [{ id: 'dry-run-kv', title: kvTitle }] : json(runWrangler(['kv', 'namespace', 'list']), []);
  ns = kv.find((n) => n.title === kvTitle || n.title.endsWith(`-${kvTitle}`));
}
if (!ns) throw new Error('the key-value namespace was not created');
log(`   key-value namespace ${ns.title} ready`);

let subdomain = 'dry-run-subdomain';
if (!dryRun) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } });
  const body = await res.json();
  subdomain = body?.result?.subdomain;
  if (!subdomain) throw new Error('No workers.dev subdomain yet. Pick one in the Cloudflare dashboard (Workers & Pages), then run again.');
}

// 2. Write the ids into this env's block only
log('2. writing the ids into wrangler.jsonc');
const text = readFileSync(configPath, 'utf8');
const start = text.indexOf(`"${envName}": {`);
if (start < 0) throw new Error(`no "${envName}" block in wrangler.jsonc`);
const nextEnv = ['"staging": {', '"production": {'].map((m) => text.indexOf(m, start + 1)).filter((i) => i > start);
const end = nextEnv.length ? Math.min(...nextEnv) : text.length;
let block = text.slice(start, end);
for (const [name, id] of Object.entries(dbIds)) {
  block = block.replace(new RegExp(`("database_name": "${name}", "database_id": )"[^"]*"`), `$1"${id}"`);
}
block = block.replace(/("binding": "OAUTH_KV", "id": )"[^"]*"/, `$1"${ns.id}"`);
block = block.replace(/("PUBLIC_URL": "https:\/\/[^.]+\.)[^."]+(\.workers\.dev")/, `$1${subdomain}$2`);
const next = text.slice(0, start) + block + text.slice(end);
const publicUrl = /"PUBLIC_URL": "([^"]+)"/.exec(block)?.[1];
if (dryRun) log(`   would set ${Object.keys(dbIds).length} database ids, the namespace id and PUBLIC_URL=${publicUrl}`);
else writeFileSync(configPath, next);
if (block.includes('REPLACE_AT_BOOTSTRAP') && !dryRun) throw new Error('a placeholder is left in wrangler.jsonc');

// 3. Schema
log('3. schema');
for (const d of cfg.d1_databases) runWrangler(['d1', 'migrations', 'apply', d.binding, '--remote', '--env', envName], { dryRun, input: 'y\n' });

// 4. Deploy
log('4. deploy');
runWrangler(['deploy', '--env', envName], { dryRun });

// 5. Secrets (one JSON on stdin; nothing on the command line)
log('5. secrets');
const secrets = dryRun
  ? { GITHUB_CLIENT_ID: '…', GITHUB_CLIENT_SECRET: '…', ALLOWED_GITHUB_ID: '…', SESSION_SECRET: '…', SOP_EXPORT_TOKEN: '…' }
  : {
      GITHUB_CLIENT_ID: process.env.GH_OAUTH_CLIENT_ID,
      GITHUB_CLIENT_SECRET: process.env.GH_OAUTH_CLIENT_SECRET,
      ALLOWED_GITHUB_ID: process.env.ALLOWED_GITHUB_ID,
      SESSION_SECRET: derivedSecret(process.env.SESSION_SECRET, 'session', envName),
      SOP_EXPORT_TOKEN: derivedSecret(process.env.SESSION_SECRET, 'export', envName),
    };
runWrangler(['secret', 'bulk', '--env', envName], { dryRun, input: JSON.stringify(secrets) });
log(`   set ${Object.keys(secrets).join(', ')}`);

// 6. Smoke
log('6. smoke test');
if (dryRun) log(`  [dry run] node scripts/smoke.mjs --url ${publicUrl}`);
else {
  const r = spawnSync(process.execPath, ['scripts/smoke.mjs', '--url', publicUrl], { cwd: appDir, stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}
log(`done. The Worker is at ${publicUrl}. GitHub OAuth App callback: ${publicUrl}/oauth/github/callback`);
