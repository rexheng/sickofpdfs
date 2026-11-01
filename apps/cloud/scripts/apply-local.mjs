// Applies the cloud schema (migrations/meta to META, migrations/text to every text shard) to a LOCAL Miniflare database kept in
// `--persist-to <dir>`. Nothing here talks to Cloudflare: every call passes `--local`, and the local config has only
// `local-only-*` ids. Usage: node scripts/apply-local.mjs <dir>
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
/** The Wrangler program from this package's own (pinned) install, so no global Wrangler is ever used. */
export const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

/** The databases the top-level (local) wrangler.jsonc binds. */
export const LOCAL_DATABASES = ['META', 'TEXT_0', 'TEXT_1'];

/** @returns {{ binding: string, ok: boolean, output: string }[]} */
export function applyLocal(stateDir) {
  return LOCAL_DATABASES.map((binding) => {
    const r = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', binding, '--local', '--persist-to', stateDir], {
      cwd: appDir,
      encoding: 'utf8',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', NO_COLOR: '1' },
    });
    return { binding, ok: r.status === 0, output: `${r.stdout}${r.stderr}` };
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/apply-local.mjs <state dir>');
    process.exit(2);
  }
  let failed = false;
  for (const r of applyLocal(dir)) {
    const line = /(\d+) commands executed successfully|No migrations to apply/.exec(r.output)?.[0] ?? (r.ok ? 'ok' : r.output.trim().split('\n').slice(-3).join(' '));
    console.log(`${r.binding}: ${r.ok ? line : `FAILED ${line}`}`);
    failed ||= !r.ok;
  }
  process.exit(failed ? 1 : 0);
}
