// Proves that eslint.config.mjs does what it claims, through the same ESLint API `pnpm lint` uses:
//   - typed linting fires under TypeScript 6 (a deliberately floating promise gives no-floating-promises)
//   - sop/no-raw-design-values is wired to CSS and to JSX, and the token directory is exempt
// `pnpm lint` passing proves little by itself: a config that silently skipped these rules would pass too.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: repoRoot });

async function ruleIds(code: string, file: string): Promise<(string | null)[]> {
  const [result] = await eslint.lintText(code, { filePath: join(repoRoot, file) });
  const messages = result?.messages ?? [];
  expect(messages.filter((m) => m.fatal)).toEqual([]);
  return messages.map((m) => m.ruleId);
}

describe('typed lint', () => {
  // packages/core/src/index.ts exists and is in packages/core/tsconfig.json, so the project service can type the text
  const file = 'packages/core/src/index.ts';

  it('runs on TypeScript 6', () => {
    expect(ts.version).toMatch(/^6\./u);
  });

  it('reports a floating promise (needs type information)', { timeout: 120_000 }, async () => {
    const code = [
      'async function fetchThing(): Promise<void> {',
      '  await Promise.resolve();',
      '}',
      'fetchThing();',
      'export {};',
    ].join('\n');
    expect(await ruleIds(code, file)).toEqual(['@typescript-eslint/no-floating-promises']);
  });

  it('accepts the same code once the promise is awaited', { timeout: 120_000 }, async () => {
    const code = [
      'async function fetchThing(): Promise<void> {',
      '  await Promise.resolve();',
      '}',
      'export async function useThing(): Promise<void> {',
      '  await fetchThing();',
      '}',
    ].join('\n');
    expect(await ruleIds(code, file)).toEqual([]);
  });
});

describe('sop/no-raw-design-values wiring', () => {
  it('reports raw values in CSS', async () => {
    expect(await ruleIds('a { color: #0b57d0; }', 'packages/ui/src/components/Example.module.css')).toEqual([
      'sop/no-raw-design-values',
    ]);
  });

  it('reports raw values in an inline JSX style', async () => {
    expect(await ruleIds("export const a = <div style={{ padding: 12 }} />;", 'packages/ui/src/Example.jsx')).toEqual([
      'sop/no-raw-design-values',
    ]);
  });

  it('exempts the token directory', async () => {
    expect(await ruleIds(':root { --gm3-sys-color-primary: #0b57d0; --row-h: 48px; }', 'packages/ui/src/tokens/tokens.css')).toEqual([]);
  });
});
