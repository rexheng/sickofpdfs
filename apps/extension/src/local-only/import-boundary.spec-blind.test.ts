// Spec-blind test for Task 29: the import boundary around the secrets store (ruling R14, spec "Privacy").
//
// Sources (interface file, Task 29):
//   "The store worker, the offscreen document, the service worker, backup, export and sync code and the test hooks never import
//     src/local-only/**. The static import graph is checked."; "eslint.config.mjs adds no-restricted-imports (patterns: ['**/local-only/**'])
//     for apps/extension/src/{store,background,entrypoints/offscreen,testing}/**"; the secrets store "lives in src/local-only/, outside
//     src/store/, and only viewer and settings code may import it"; "never goes into backups or the library database"; "The test hooks never
//     reach the secrets store (ruling R19)".
//   spec, Backups: "secrets live in a separate store that backups, export and sync cannot read".
// Written as a walk over the source files: from every file that must not reach the secrets store, follow every import that is not
// type-only (static, dynamic import(), and `new Worker(new URL(...))`) and report any path that ends in src/local-only/.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(SRC, '../../..');
const FORBIDDEN_AREAS = ['store', 'background', 'entrypoints/offscreen', 'testing'];
const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
const isTestFile = (name: string) => /\.(test|spec|spec-blind)\./.test(name) || /\.spec-blind\.[jt]sx?$/.test(name);

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/** The module names a file brings in at run time (type-only imports do not count). */
function runtimeImports(source: string): string[] {
  const text = stripComments(source);
  const found: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue; // import type / export type
    const clause = m[2].trim();
    const names = /^\{([^}]*)\}$/.exec(clause)?.[1];
    if (names !== undefined && names.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '))) continue; // { type A, type B }
    found.push(m[3]);
  }
  for (const m of text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(m[1]);
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) found.push(m[1]);
  for (const m of text.matchAll(/new\s+(?:Shared)?Worker\(\s*new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) found.push(m[1]);
  return found;
}

function resolveImport(specifier: string, from: string, srcRoot: string): string | null {
  const clean = specifier.replace(/\?.*$/, '');
  let base: string;
  if (clean.startsWith('./') || clean.startsWith('../')) base = resolve(dirname(from), clean);
  else if (clean.startsWith('@/') || clean.startsWith('~/')) base = join(srcRoot, clean.slice(2));
  else return null; // a package: workspace packages cannot reach apps/extension
  const bases = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')];
  for (const b of bases) for (const ext of EXTENSIONS) if (existsSync(b + ext) && !readdirSafe(b + ext)) return b + ext;
  return null;
}
function readdirSafe(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null; // a file, not a folder
  }
}

function sourceFilesIn(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSafe(dir) ?? []) {
    const full = join(dir, name);
    if (readdirSafe(full)) out.push(...sourceFilesIn(full));
    else if (/\.[jt]sx?$/.test(name) && !isTestFile(name)) out.push(full);
  }
  return out;
}

/** Every chain of files from a forbidden-area file to something under local-only/ (the shortest chain to each, per starting file). */
function reachLocalOnly(srcRoot: string, areas: string[], extraRoots: string[] = []): { roots: string[]; violations: string[][] } {
  const roots = [...areas.flatMap((a) => sourceFilesIn(join(srcRoot, a))), ...extraRoots.map((r) => join(srcRoot, r)).filter((r) => existsSync(r))];
  const rel = (f: string) => relative(srcRoot, f).split('\\').join('/');
  const violations: string[][] = [];
  for (const root of roots) {
    const seen = new Set<string>();
    const queue: string[][] = [[root]];
    while (queue.length > 0) {
      const chain = queue.shift()!;
      const file = chain.at(-1)!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (rel(file).startsWith('local-only/')) {
        violations.push(chain.map(rel));
        continue;
      }
      for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
        const target = resolveImport(spec, file, srcRoot);
        if (target && !seen.has(target)) queue.push([...chain, target]);
      }
    }
  }
  return { roots: roots.map(rel), violations };
}

describe('the secrets store is out of reach of the store, the service worker, the offscreen page and the test hooks', () => {
  it('the walker itself works: it finds a path through an intermediate file and through import(), and ignores type-only imports', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'sop-boundary-'));
    try {
      const put = (path: string, text: string) => {
        mkdirSync(dirname(join(tmp, path)), { recursive: true });
        writeFileSync(join(tmp, path), text);
      };
      put('store/a.ts', "import { b } from '../shared/b';\nexport const a = b;\n");
      put('shared/b.ts', "export const b = () => import('../local-only/secrets');\n");
      put('local-only/secrets.ts', 'export const s = 1;\n');
      put('background/ok.ts', "import type { s } from '../local-only/secrets';\nimport { type s as t } from '../local-only/secrets';\n// import '../local-only/secrets'\nexport const ok = 1;\n");
      put('testing/worker.ts', "export const w = new Worker(new URL('../local-only/secrets.ts', import.meta.url));\n");

      const { violations } = reachLocalOnly(tmp, ['store', 'background', 'testing']);

      expect(violations).toEqual([['store/a.ts', 'shared/b.ts', 'local-only/secrets.ts'], ['testing/worker.ts', 'local-only/secrets.ts']]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('no file of apps/extension/src/{store,background,entrypoints/offscreen,testing}, nor the service worker entry, reaches src/local-only/ through any import', () => {
    expect(existsSync(join(SRC, 'local-only/secrets-store.ts')), 'the secrets store lives in src/local-only/').toBe(true);

    const { roots, violations } = reachLocalOnly(SRC, FORBIDDEN_AREAS, ['entrypoints/background.ts', 'viewer/runtime.ts']);

    expect(roots, 'the walk starts from the real store worker').toContain('store/store-worker.ts');
    expect(roots).toContain('entrypoints/background.ts');
    expect(roots).toContain('entrypoints/offscreen/main.ts');
    expect(roots).toContain('testing/test-hooks.ts');
    expect(violations.map((chain) => chain.join('  ->  ')), 'a file that must not read the secrets store imports it').toEqual([]);
  });

  it('the secrets store uses IndexedDB only: no extension storage, no OPFS, no web storage, and nothing from the library store', () => {
    const source = stripComments(readFileSync(join(SRC, 'local-only/secrets-store.ts'), 'utf8'));
    expect(source).toMatch(/indexedDB\s*\.\s*open\(/);
    for (const forbidden of ['chrome.storage', 'browser.storage', 'localStorage', 'sessionStorage', 'getDirectory', 'sqlite', 'caches.']) {
      expect(source.includes(forbidden), `the secrets store mentions ${forbidden}`).toBe(false);
    }
    expect(runtimeImports(source).filter((s) => /(^|\/)store(\/|$)/.test(s) && !s.includes('local-only')), 'it must not depend on the library store').toEqual([]);
  });

  it('the lint rule is in place: no-restricted-imports on "**/local-only/**" for the four areas', () => {
    const config = readFileSync(join(REPO, 'eslint.config.mjs'), 'utf8');
    const at = config.indexOf('**/local-only/**');
    expect(at, 'eslint.config.mjs forbids "**/local-only/**"').toBeGreaterThan(-1);
    const around = config.slice(Math.max(0, at - 900), at + 300);
    expect(around).toContain('no-restricted-imports');
    for (const area of FORBIDDEN_AREAS) expect(around, `the rule covers ${area}`).toContain(area);
  });
});
