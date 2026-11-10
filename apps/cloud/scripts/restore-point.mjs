// CL8 · Records a D1 Time Travel restore point for every database of one environment, before its schema or Worker changes.
// The production deploy runs this first and stops if it fails. Time Travel keeps 7 days on the free plan.
//
//   node scripts/restore-point.mjs --env production [--out restore-point.json] [--dry-run]
//
// It writes the bookmarks to --out (the workflow keeps it as an artifact for 30 days) and to the job summary, with the exact
// command that goes back to them:  wrangler d1 time-travel restore <database> --bookmark <bookmark> --env <env>
import { appendFileSync, writeFileSync } from 'node:fs';
import { arg, envConfig, flag, runWrangler } from './cloud-env.mjs';

const envName = arg('env', 'production');
const out = arg('out', 'restore-point.json');
const dryRun = flag('dry-run');
const cfg = envConfig(envName);
const at = new Date().toISOString();
const points = [];
for (const d of cfg.d1_databases) {
  const r = runWrangler(['d1', 'time-travel', 'info', d.database_name, '--env', envName, '--json'], { dryRun });
  let bookmark = 'dry-run-bookmark';
  if (!dryRun) {
    try {
      bookmark = JSON.parse(r.stdout).bookmark;
    } catch {
      bookmark = /bookmark[^\w]+([0-9a-f-]{20,})/i.exec(r.stdout)?.[1];
    }
    if (!bookmark) throw new Error(`no restore point for ${d.database_name}`);
  }
  points.push({ database: d.database_name, bookmark, restore: `wrangler d1 time-travel restore ${d.database_name} --bookmark ${bookmark} --env ${envName}` });
  console.log(`restore point ${d.database_name}: ${bookmark}`);
}
writeFileSync(out, JSON.stringify({ environment: envName, at, commit: process.env.GITHUB_SHA ?? null, ref: process.env.GITHUB_REF ?? null, points }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Restore point (${envName}, ${at})\n\n${points.map((p) => `- \`${p.database}\`: \`${p.restore}\``).join('\n')}\n`);
}
