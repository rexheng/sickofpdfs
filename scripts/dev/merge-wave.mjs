// `pnpm merge:wave`: merges one round of parallel worktree branches into the current branch, then runs the gates.
// Usage, from the main checkout:
//   node scripts/dev/merge-wave.mjs [--dry-run] [--no-gates] [--engine] <branch> [<branch> ...]
// Branches are cherry-picked in the order given; commits whose patch is already on HEAD are skipped. A conflict in
// pnpm-lock.yaml alone takes HEAD's copy and the lockfile is regenerated at the end. Any other conflict exits 2 and
// leaves the cherry-pick in progress. Gates: typecheck, lint, test, e2e (walkthroughs), golden:check (engine changes
// or --engine). Exit 0 when every gate that ran passed, 1 when one failed. Summary: .superpowers/merge-wave-last.json
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCK = 'pnpm-lock.yaml';
const ENGINE_PATHS = ['packages/viewer/src/backend/', 'packages/viewer/src/text-layer/', 'packages/viewer/src/render/', 'packages/viewer/src/text/', 'patches/'];
const FLAGS = ['--dry-run', '--no-gates', '--engine'];
const TRAILERS = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n'
  + 'Claude-Session: https://claude.ai/code/session_018a7n5nH5SCa485R8ETxAWJ';

const die = (msg, code = 1) => {
  console.error(`merge-wave: ${msg}`);
  process.exit(code);
};
const argv = process.argv.slice(2);
const branches = argv.filter((a) => !a.startsWith('--'));
if (!branches.length || argv.some((a) => a.startsWith('--') && !FLAGS.includes(a))) {
  die('usage: node scripts/dev/merge-wave.mjs [--dry-run] [--no-gates] [--engine] <branch> [<branch> ...]');
}
const dryRun = argv.includes('--dry-run');
const noGates = argv.includes('--no-gates');
const engine = argv.includes('--engine');

const gitEnv = { ...process.env, GIT_EDITOR: 'true' }; // never open an editor (cherry-pick --continue could hang)
const git = (...a) => {
  const r = spawnSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28, env: gitEnv });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const gitOrDie = (...a) => {
  const r = git(...a);
  if (r.code) die(`git ${a.join(' ')} failed:\n${r.err}`);
  return r.out;
};
const runPnpm = (...a) => {
  const r = spawnSync('pnpm', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const lines = (text) => text.split('\n').filter(Boolean);
const tail = (text) => text.trimEnd().split('\n').slice(-40).join('\n');

process.chdir(gitOrDie('rev-parse', '--show-toplevel'));

// 1. Refuse on tracked changes (untracked files are fine) and on unknown branches.
if (gitOrDie('status', '--porcelain', '--untracked-files=no')) {
  die('the working tree has uncommitted changes to tracked files. Commit or stash them first.');
}
for (const b of branches) {
  if (git('rev-parse', '--verify', '--quiet', `refs/heads/${b}`).code) die(`no local branch named ${b}`);
}

// Patch-id of a commit with pnpm-lock.yaml left out ('' when it changes only the lockfile). Cached per sha.
const patchIds = new Map();
function patchIdOf(sha) {
  if (!patchIds.has(sha)) {
    const diff = spawnSync('git', ['diff-tree', '-p', '--no-commit-id', sha, '--', '.', ':(exclude)pnpm-lock.yaml'], { encoding: 'utf8', maxBuffer: 1 << 28, env: gitEnv });
    const pid = spawnSync('git', ['patch-id', '--stable'], { encoding: 'utf8', input: diff.stdout ?? '', env: gitEnv });
    if (diff.status || pid.status) die(`could not compute the patch-id of ${sha}`);
    patchIds.set(sha, pid.stdout.split(' ')[0]);
  }
  return patchIds.get(sha);
}

// Commits on a branch that HEAD does not have yet, oldest first. A commit is already applied when HEAD has one with
// the same patch-id. The patch-id leaves out the lockfile: a lockfile conflict resolved with HEAD's copy changes the
// full patch, so `git cherry` would offer the commit again. A commit that changes only the lockfile counts as applied.
function pendingPicks(branch) {
  const candidates = lines(gitOrDie('rev-list', '--reverse', '--no-merges', `HEAD..${branch}`))
    .filter((sha) => patchIdOf(sha) !== '');
  if (!candidates.length) return [];
  const base = gitOrDie('merge-base', 'HEAD', branch);
  const onHead = new Set(lines(gitOrDie('rev-list', '--no-merges', `${base}..HEAD`)).map((sha) => patchIdOf(sha)));
  return candidates
    .filter((sha) => !onHead.has(patchIdOf(sha)))
    .map((sha) => ({
      branch,
      sha,
      subject: gitOrDie('log', '-1', '--format=%s', sha),
      files: lines(gitOrDie('diff-tree', '--no-commit-id', '--name-only', '-r', sha)),
    }));
}

if (dryRun) {
  for (const b of branches) {
    const picks = pendingPicks(b);
    console.log(`\n${b}: ${picks.length} commit(s) would be picked`);
    for (const p of picks) console.log(`  ${p.sha.slice(0, 7)} ${p.subject}\n      files: ${p.files.join(', ') || '(none)'}`);
  }
  process.exit(0);
}

// 2. Cherry-pick. Returns false when the commit was skipped because it only changed the lockfile.
let lockConflict = false;
function applyPick(p) {
  const r = git('cherry-pick', p.sha);
  if (r.code === 0) return true;
  const conflicted = lines(gitOrDie('diff', '--name-only', '--diff-filter=U'));
  if (!conflicted.length) die(`cherry-pick of ${p.sha.slice(0, 7)} from ${p.branch} failed:\n${r.err}`);
  if (conflicted.length > 1 || conflicted[0] !== LOCK) {
    console.error(`merge-wave: conflict in ${p.branch}, commit ${p.sha.slice(0, 7)} "${p.subject}"`);
    console.error(`Conflicted files:\n${conflicted.map((f) => `  ${f}`).join('\n')}`);
    console.error('The cherry-pick is left in progress. Resolve it by hand, then re-run with the same branches (commits already on HEAD are skipped).');
    process.exit(2);
  }
  gitOrDie('checkout', '--ours', '--', LOCK);
  gitOrDie('add', '--', LOCK);
  lockConflict = true;
  if (git('diff', '--cached', '--quiet').code === 0) {
    gitOrDie('cherry-pick', '--skip'); // nothing left but the lockfile, which now matches HEAD
    return false;
  }
  gitOrDie('cherry-pick', '--continue');
  return true;
}

const startHead = gitOrDie('rev-parse', 'HEAD');
const counts = [];
const changed = new Set();
for (const b of branches) {
  console.log(`\n== ${b}`);
  let picked = 0;
  for (const p of pendingPicks(b)) {
    p.files.forEach((f) => changed.add(f));
    const ok = applyPick(p);
    picked += ok ? 1 : 0;
    console.log(`  ${ok ? 'picked' : 'skipped'} ${p.sha.slice(0, 7)} ${p.subject}`);
  }
  counts.push({ branch: b, picked });
}

// 3. Regenerate the lockfile when a picked commit touched it or a package.json, and commit it if it changed.
let lockRegenerated = false;
if (lockConflict || changed.has(LOCK) || [...changed].some((f) => f.endsWith('package.json'))) {
  console.log('\n== regenerate lockfile (pnpm install)');
  const inst = runPnpm('install', '--no-frozen-lockfile');
  if (inst.code) die(`pnpm install failed (exit ${inst.code}); no lockfile commit made.\n${tail(inst.out)}`);
  if (gitOrDie('status', '--porcelain', '--', LOCK)) {
    gitOrDie('add', '--', LOCK);
    gitOrDie('commit', '-m', 'chore: regenerate lockfile after merge', '-m', TRAILERS);
    lockRegenerated = true;
  }
}

// 4. Gates. Each one runs even if an earlier one failed.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const hasScript = (s) => Boolean(pkg.scripts?.[s]);
const engineTouched = engine || [...changed].some((f) => ENGINE_PATHS.some((p) => f.startsWith(p)));
const plan = [
  { name: 'typecheck', args: ['typecheck'] },
  { name: 'lint', args: ['lint'] },
  { name: 'test', args: ['test'] },
  {
    name: 'e2e',
    args: ['e2e', ...(existsSync('e2e/walkthroughs') ? ['e2e/walkthroughs'] : [])],
    skip: !hasScript('e2e') && 'no e2e script',
  },
  {
    name: 'golden:check',
    args: ['golden:check'],
    skip: !hasScript('golden:check') ? 'no golden:check script' : !engineTouched && 'no engine or text-layer changes',
  },
];
const gates = plan.map(({ name, args, skip }) => {
  const reason = noGates ? '--no-gates' : skip;
  if (reason) return { name, status: 'SKIPPED', reason };
  console.log(`\n== gate ${name}: pnpm ${args.join(' ')}`);
  const r = runPnpm(...args);
  return { name, status: r.code ? 'FAIL' : 'PASS', exitCode: r.code, tail: tail(r.out) };
});

// 5. Summary on screen and in .superpowers/merge-wave-last.json.
console.log(`\n${'Branch'.padEnd(24)}Picked`);
for (const c of counts) console.log(`${c.branch.padEnd(24)}${c.picked}`);
console.log(`\n${'Gate'.padEnd(24)}Result`);
for (const g of gates) console.log(`${g.name.padEnd(24)}${g.status}${g.reason ? ` (${g.reason})` : ''}`);
console.log(`\nLockfile regenerated: ${lockRegenerated ? 'yes' : 'no'}`);
for (const g of gates.filter((x) => x.status === 'FAIL')) {
  console.log(`\n--- ${g.name} failed (exit ${g.exitCode}), last 40 lines ---\n${g.tail}`);
}
mkdirSync('.superpowers', { recursive: true });
const summary = { at: new Date().toISOString(), startHead, head: gitOrDie('rev-parse', 'HEAD'), branches: counts, lockfileRegenerated: lockRegenerated, gates };
writeFileSync(join('.superpowers', 'merge-wave-last.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.exit(gates.some((g) => g.status === 'FAIL') ? 1 : 0);
