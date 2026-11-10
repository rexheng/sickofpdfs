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
// The lint rule is asked of ESLint itself: its computed configuration for a real file in each area, and a real import line linted.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const REPO = resolve(SRC, '../../..');
const FORBIDDEN_AREAS = ['store', 'background', 'entrypoints/offscreen', 'testing'];
/** CA7 (CL10): the cloud token broker in the service worker, and the only local-only files it may import. */
const CA7_BROKER = 'background/cloud-broker.ts';
const CA7_FILES = ['local-only/db.ts', 'local-only/cloud-auth.ts', 'local-only/cloud-forget.ts'];
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
    // CA7 (CL10): the one allowed edge from the service worker into local-only/ is the cloud token broker's, to these three files.
    const brokerEdge = (chain: string[]) => chain.length >= 2 && chain[chain.length - 2] === CA7_BROKER && CA7_FILES.includes(chain[chain.length - 1]);
    expect(violations.filter((chain) => !brokerEdge(chain)).map((chain) => chain.join('  ->  ')), 'a file that must not read the secrets store imports it').toEqual([]);
  });

  it('CA7: the cloud token broker reaches only db.ts, cloud-auth.ts and cloud-forget.ts, and those never reach the secrets store', () => {
    for (const file of CA7_FILES) {
      const source = readFileSync(join(SRC, file), 'utf8');
      const local = runtimeImports(source).map((spec) => resolveImport(spec, join(SRC, file), SRC)).filter((t): t is string => t !== null).map((t) => relative(SRC, t).split('\\').join('/'));
      expect(local.filter((t) => t.startsWith('local-only/') && t !== 'local-only/db.ts'), `${file} imports nothing in local-only/ but db.ts`).toEqual([]);
      expect(local.filter((t) => !t.startsWith('local-only/')), `${file} imports nothing else from the extension`).toEqual([]);
    }
  });

  it('the secrets store uses IndexedDB only: no extension storage, no OPFS, no web storage, and nothing from the library store', () => {
    // CL10 moved the open code, unchanged, into db.ts beside it (contracts CA7): the two files are read together.
    const source = stripComments(['local-only/secrets-store.ts', 'local-only/db.ts'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n'));
    expect(source).toMatch(/indexedDB\s*\.\s*open\(/);
    for (const forbidden of ['chrome.storage', 'browser.storage', 'localStorage', 'sessionStorage', 'getDirectory', 'sqlite', 'caches.']) {
      expect(source.includes(forbidden), `the secrets store mentions ${forbidden}`).toBe(false);
    }
    expect(runtimeImports(source).filter((s) => /(^|\/)store(\/|$)/.test(s) && !s.includes('local-only')), 'it must not depend on the library store').toEqual([]);
  });

  describe('the lint rule is in place (asked of ESLint itself)', () => {
    const AREA_FILES: Record<string, string> = {
      store: 'apps/extension/src/store/annotations.ts',
      background: 'apps/extension/src/background/takeover/register.ts',
      'entrypoints/offscreen': 'apps/extension/src/entrypoints/offscreen/main.ts',
      testing: 'apps/extension/src/testing/test-hooks.ts',
    };
    const IMPORT_LINE = "import { openLocalOnlyStore } from '../local-only/secrets-store';\nvoid openLocalOnlyStore;\n";
    const DYNAMIC_LINE = "export const load = () => import('../local-only/secrets-store');\n";
    const eslint = new ESLint({ cwd: REPO });
    const ruleIds = async (code: string, filePath: string): Promise<string[]> => {
      const [result] = await eslint.lintText(code, { filePath: join(REPO, filePath) });
      expect(result, `ESLint answered for ${filePath}`).toBeDefined();
      expect(result.messages.filter((m) => m.fatal), `ESLint could not parse the probe for ${filePath}`).toEqual([]);
      return result.messages.filter((m) => m.severity === 2 && m.message.length > 0 && m.ruleId !== null).map((m) => m.ruleId!);
    };

    it.each(Object.entries(AREA_FILES))('%s: the configuration forbids **/local-only/** as an error', async (_area, file) => {
      const config = (await eslint.calculateConfigForFile(join(REPO, file))) as { rules?: Record<string, unknown> } | undefined;
      const setting = config?.rules?.['no-restricted-imports'] as [unknown, { patterns?: (string | { group?: string[] })[] }?] | undefined;
      expect(setting, `no-restricted-imports is set for ${file}`).toBeDefined();
      expect([2, 'error']).toContain(setting![0]);
      const groups = (setting![1]?.patterns ?? []).flatMap((p) => (typeof p === 'string' ? [p] : (p.group ?? [])));
      expect(groups, 'a pattern group covers **/local-only/**').toContain('**/local-only/**');
    }, 60_000);

    it.each(Object.entries(AREA_FILES))('%s: a real import of the secrets store is reported as an error, static and dynamic', async (_area, file) => {
      expect(await ruleIds(IMPORT_LINE, file), 'import ... from the local-only folder').toContain('no-restricted-imports');
      expect(await ruleIds(DYNAMIC_LINE, file), "import('...') of the local-only folder").toContain('no-restricted-syntax');
    }, 180_000);

    it('the viewer is allowed to import it (the rule is aimed, not blanket)', async () => {
      const ids = await ruleIds(IMPORT_LINE, 'apps/extension/src/viewer/App.tsx');
      expect(ids).not.toContain('no-restricted-imports');
    }, 120_000);
  });
});
