// Shared by the deploy kit (bootstrap, restore-point, smoke, backup). Node only, no dependencies. Nothing here prints a secret.
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { wrangler } from './apply-local.mjs';

export const appDir = fileURLToPath(new URL('..', import.meta.url));
export const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url));
export const ENVIRONMENTS = ['staging', 'production'];

/** wrangler.jsonc without its comments (strings are kept as they are). */
export function readConfig(text = readFileSync(configPath, 'utf8')) {
  let out = '';
  for (let i = 0, inStr = false; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export function envConfig(name) {
  if (!ENVIRONMENTS.includes(name)) throw new Error(`--env must be one of ${ENVIRONMENTS.join(', ')}`);
  const c = readConfig().env?.[name];
  if (!c) throw new Error(`wrangler.jsonc has no env.${name}`);
  return c;
}

/**
 * The Worker secrets each environment gets that are made from the one SESSION_SECRET in GitHub: different for staging and
 * production, so a staging secret can never open production. The backup job makes the same export token the same way.
 */
export function derivedSecret(sessionSecret, purpose, env) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return createHmac('sha256', sessionSecret).update(`sickofpdfs:${purpose}:${env}`).digest('hex');
}

export function arg(name, fallback) {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : fallback;
}
export const flag = (name) => process.argv.slice(2).includes(`--${name}`);

/** Runs the pinned Wrangler. `input` goes to stdin (never in the command line, so it is never in a log). */
export function runWrangler(args, { input, dryRun = false, allowFail = false } = {}) {
  if (dryRun) {
    console.log(`  [dry run] wrangler ${args.join(' ')}${input ? '  (with input on stdin)' : ''}`);
    return { status: 0, stdout: '', stderr: '' };
  }
  const r = spawnSync(process.execPath, [wrangler, ...args], { cwd: appDir, encoding: 'utf8', input, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' } });
  if (r.status !== 0 && !allowFail) {
    console.error(r.stdout, r.stderr);
    throw new Error(`wrangler ${args[0]} ${args[1] ?? ''} failed`);
  }
  return r;
}
