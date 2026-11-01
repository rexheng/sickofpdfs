import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { record } from './record';

// The brief's P0-9, with its two assertions unchanged. ts7/ is a package of its own (own node_modules and lockfile,
// outside the spike's dependencies): TypeScript 7.0.2, typescript-eslint 8.72.1 and eslint 10.14.0, installed by
// `pnpm -C spikes/phase0/ts7 install`. The test writes what it observed with record() before asserting, so a failing
// run keeps the tsc status and output, the eslint messages, and any crash text. Either result is acceptable;
// what matters is the exact evidence. ts7/src/bad.ts line 3 is `fetchThing();` with no await, where fetchThing(): Promise<void>.
const TS7 = fileURLToPath(new URL('../ts7/', import.meta.url));
const exec = (...cmd: string[]) => spawnSync('pnpm', ['-C', TS7, 'exec', ...cmd], { encoding: 'utf8' });
// tsc colours its output; strip the escape codes so the recorded text reads plainly
const text = (r: { stdout: string; stderr: string }) => `${r.stdout}${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, '').trim();
// one line, without stack frames (they hold absolute paths), so a crash reads well in the report table
const oneLine = (s: string) => s.split('\n').filter((l) => !/^\s+at /.test(l)).join(' ').replace(/\s+/g, ' ').trim();
const manifest = (pkg: string): { version: string; peerDependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(`${TS7}node_modules/${pkg}/package.json`, 'utf8'));

test('P0-9: tsc 7 type-checks and typed lint rules work', async () => {
  const version = exec('tsc', '--version');
  const tsc = exec('tsc', '--noEmit', '-p', '.');
  const lint = exec('eslint', '--format', 'json', 'src');
  const msgs: string[] = [];
  let parseError: string | null = null;
  try {
    for (const f of JSON.parse(lint.stdout) as { filePath: string; messages: { line: number; ruleId: string | null; message: string }[] }[]) {
      for (const m of f.messages) msgs.push(`${basename(f.filePath)}:${m.line}:${m.ruleId}`);
    }
  } catch {
    parseError = `no JSON report: ${oneLine(text(lint)).slice(0, 1500) || '(no output)'}`;
  }
  const peer = manifest('typescript-eslint').peerDependencies?.typescript;
  const installed = manifest('typescript').version;
  // the peer range's upper bound is "<major.minor.patch": is the installed version at or past it?
  const [major = 0, minor = 0] = installed.split('.').map(Number);
  const upper = /<(\d+)\.(\d+)/.exec(peer ?? '');
  const outside = upper ? major > Number(upper[1]) || (major === Number(upper[1]) && minor >= Number(upper[2])) : false;
  const pass = tsc.status === 0 && parseError === null && JSON.stringify(msgs) === JSON.stringify(['bad.ts:3:@typescript-eslint/no-floating-promises']);
  await record('P0-9', {
    pass,
    measured:
      `${text(version)}; tsc --noEmit -p . exit ${tsc.status}${text(tsc) ? `, output: ${oneLine(text(tsc)).slice(0, 1500)}` : ', no output'}; ` +
      `eslint --format json src exit ${lint.status}, ${parseError ?? `messages ${JSON.stringify(msgs)}`}`,
    note: `typescript-eslint ${manifest('typescript-eslint').version} declares the peer typescript "${peer}"; installed typescript ${installed} is ${outside ? 'outside' : 'inside'} that range`,
  });
  expect(tsc.status).toBe(0);
  expect(parseError).toBeNull();
  expect(msgs).toEqual(['bad.ts:3:@typescript-eslint/no-floating-promises']);
});
