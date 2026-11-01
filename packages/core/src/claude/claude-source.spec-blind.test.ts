/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- these tests read wire JSON from an API we do not own, and cast modules that did not exist when they were written */
// Spec-blind tests for slices A, H and E: what the source may and may not contain, and that nothing here touches the network.
//
// Sources:
//   OWNER DECISION: "Models are chosen by family from the Models API and stored as settings, never as code constants";
//   CLAUDE.md standing constraints: "Never put model ID strings ... in code, comments or docs"; contracts shared rules: "No model
//     id is ever written in code, comments or docs"; plan section 3: "No model id strings anywhere: ids exist only as data from
//     the Models API";
//   plan section 3: "Only apps/extension/src/viewer/claude/client.ts imports @anthropic-ai/sdk; an ESLint rule enforces this";
//     "The service worker, the offscreen page and the store worker never call Anthropic"; spec tech stack: SDK 1.3.0;
//   contracts section 6 and the dispatch: the key is read by client.ts only (`getSecret`); slices A and H never see it;
//   spec privacy table and done-when 4: "Nothing goes to api.anthropic.com unless you started an @Claude action" - so the pure
//     parts (request builder, mapper, pricing, cost, spend) must make no request of any kind, not even at import;
//   spec "Local traces": a PDF that isn't saved leaves no log line - so a clean run prints nothing.
/// <reference types="vite/client" />
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL, QUESTION, StreamBuilder, THINK_MODEL, assistantTurn, docCite, findModelId, makePack, userTurn, webCite,
  type CitableBlock, type CreateStreamMapper,
} from '../../test/spec-blind/claude-kit';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.output', '.wxt', 'dist', 'test-assets', 'test-results', '.git', '.superpowers', '.vitest']);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');
const isTestFile = (p: string): boolean => /\.(test|spec|browser\.test)\.[cm]?[jt]sx?$/.test(p) || /\.spec-blind\./.test(p) || /(^|\/)(test|__fixtures__|fixtures)\//.test(rel(p));
const isCode = (p: string): boolean => /\.(ts|tsx|js|jsx|mjs|cjs|css|json|yml|yaml)$/.test(p);

/** The source files a rule applies to: everything shipped or run by CI, never a test, a fixture or a recording. */
function shipped(...roots: string[]): { path: string; text: string }[] {
  return roots.flatMap((r) => walk(join(ROOT, r))).filter((p) => isCode(p) && !isTestFile(p)).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
}
/** Comments off, so a rule about code is not tripped by a sentence, and a rule about comments can use the raw text. */
const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

describe('no model id in the source (owner decision; CLAUDE.md standing constraints)', () => {
  it('the id scanner catches ids and leaves family names and our own names alone (positive and negative controls)', () => {
    const family = ['Haiku', 'haiku', 'Opus', 'Sonnet'].join(' ');
    const ours = ["kind: 'claude-reply'", 'claude-settings', 'claude-replay', 'claude-base-url', 'claude-live.yml'].join(' ');
    expect(findModelId(family)).toBeNull();
    expect(findModelId(ours)).toBeNull();
    for (const id of [['claude', 'haiku', '5', '5'].join('-'), ['claude', 'opus', '5', '5'].join('-'), ['claude', '3', '5', 'sonnet', '20241022'].join('-'), ['haiku', '5', '5'].join('-')]) {
      expect(findModelId(`model: "${id}",`), id).not.toBeNull();
    }
  });

  it('the Phase 4 source files exist, so the scan below saw them', () => {
    for (const f of ['request', 'stream-map', 'citations', 'prompts', 'pricing', 'cost']) expect(existsSync(join(ROOT, 'packages/core/src/claude', `${f}.ts`)), `packages/core/src/claude/${f}.ts`).toBe(true);
  });

  it('no shipped file, comment or workflow holds a model id', () => {
    const files = shipped('apps', 'packages', 'e2e/support', 'scripts', '.github');
    expect(files.length).toBeGreaterThan(50); // the walk really covered the repo
    const hits = files.flatMap((f) => { const m = findModelId(f.text); return m ? [`${f.path}: ${m}`] : []; });
    expect(hits).toEqual([]);
  });
});

describe('the SDK and the key stay where the plan puts them', () => {
  const CLIENT = 'apps/extension/src/viewer/claude/client.ts';

  it('only client.ts imports @anthropic-ai/sdk', () => {
    const importers = shipped('apps', 'packages', 'e2e/support', 'scripts')
      .filter((f) => /@anthropic-ai\/sdk/.test(code(f.text)) && !/package\.json$/.test(f.path))
      .map((f) => f.path);
    expect(importers.filter((p) => p !== CLIENT)).toEqual([]);
  });

  it('the SDK is a dependency of the extension alone, and pinned to the exact version the spec names', () => {
    const manifests = ['package.json', ...readdirSync(join(ROOT, 'apps')).map((a) => `apps/${a}/package.json`), ...readdirSync(join(ROOT, 'packages')).map((a) => `packages/${a}/package.json`)]
      .filter((p) => existsSync(join(ROOT, p)));
    for (const p of manifests) {
      const pkg = JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as Record<string, Record<string, string> | undefined>;
      const version = pkg['dependencies']?.['@anthropic-ai/sdk'] ?? pkg['devDependencies']?.['@anthropic-ai/sdk'];
      if (version === undefined) continue;
      expect(p, 'only the extension depends on the SDK').toBe('apps/extension/package.json');
      expect(version).toBe('1.3.0');
    }
  });

  it('slices A, H and E never touch the key, the network or the browser\'s storage APIs', () => {
    const files = shipped('packages/core/src/claude').concat(shipped('apps/extension/src/viewer/claude').filter((f) => f.path.endsWith('/spend.ts')), shipped('e2e/support').filter((f) => f.path.endsWith('claude-replay.ts')));
    expect(files.map((f) => f.path)).toContain('packages/core/src/claude/request.ts');
    const rules: [string, RegExp][] = [
      ['the SDK', /@anthropic-ai\/sdk/],
      ['getSecret or the key\'s name', /getSecret|anthropic_api_key|\bapiKey\b/],
      ['the key header', /x-api-key/i],
      ['the real API host', /api\.anthropic\.com/],
      ['fetch', /\bfetch\s*\(/],
      ['XMLHttpRequest', /XMLHttpRequest/],
      ['WebSocket', /WebSocket/],
      ['EventSource', /EventSource/],
      ['sendBeacon', /sendBeacon/],
      ['importScripts', /importScripts/],
      ['a dynamic import of a URL', /import\s*\(\s*['"`]https?:/],
    ];
    const hits: string[] = [];
    for (const f of files) {
      // the replay double is a server: it answers requests and may name the key header to refuse or ignore it, so it is checked for the key only
      const serverSide = f.path.endsWith('claude-replay.ts');
      for (const [what, re] of rules) {
        if (serverSide && what !== 'the SDK' && what !== 'getSecret or the key\'s name') continue;
        if (re.test(code(f.text))) hits.push(`${f.path}: ${what}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('the pure parts and the spend do not use localStorage, cookies or extension storage (the spend lives in sop-local, A6)', () => {
    const pure = shipped('packages/core/src/claude').concat(shipped('apps/extension/src/viewer/claude').filter((f) => f.path.endsWith('/spend.ts')));
    const hits = pure.filter((f) => /localStorage|sessionStorage|document\.cookie|chrome\.storage/.test(code(f.text))).map((f) => f.path);
    expect(hits).toEqual([]);
    const spend = pure.find((f) => f.path.endsWith('/spend.ts'));
    if (spend) expect(spend.text).toMatch(/claudeSpendMonth/);
  });
});

describe('the pure parts make no request and print nothing, ever (spec privacy table: only when you ask Claude)', () => {
  const fetchSpy = vi.fn(() => Promise.reject(new Error('the network was used')));
  const logged: string[] = [];
  const consoles: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    fetchSpy.mockClear();
    logged.length = 0;
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', function Forbidden() { throw new Error('the network was used'); });
    vi.stubGlobal('WebSocket', function Forbidden() { throw new Error('the network was used'); });
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) consoles.push(vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const s of consoles.splice(0)) s.mockRestore();
  });

  it('importing every Phase 4 core module starts nothing', async () => {
    vi.resetModules();
    const loaders = import.meta.glob(['./*.ts', '!./*.test.ts', '!./*.spec-blind.ts']);
    expect(Object.keys(loaders).length).toBeGreaterThanOrEqual(6); // request, stream-map, citations, prompts, pricing, cost, types
    for (const load of Object.values(loaders)) await load();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it('building a request, mapping a stream (with a failure) and pricing it use no network and log nothing', async () => {
    vi.resetModules();
    const { buildRequest } = await import('./request');
    const { createStreamMapper } = await import('./stream-map');
    const pricing = (await import('./pricing')) as Record<string, unknown>;
    const cost = (await import('./cost')) as Record<string, unknown>;
    const api = { ...pricing, ...cost } as Record<string, (...a: unknown[]) => unknown>;

    const pack = makePack({ figures: 1 });
    const built = await Promise.resolve((buildRequest as unknown as (...a: unknown[]) => unknown)(pack, [userTurn(QUESTION), assistantTurn('ZQ_PRIOR'), userTurn('and then?')], { role: 'think-harder', model: THINK_MODEL, webSearch: true })) as { blocks: CitableBlock[] };
    expect(built.blocks.length).toBeGreaterThan(0);

    const mapper = (createStreamMapper as unknown as CreateStreamMapper)(built.blocks, () => undefined);
    const events = new StreamBuilder()
      .text('Claim.', [docCite(1, 0, 'x')])
      .webSearch('q', [{ url: 'https://example.org/p', title: 'P' }])
      .text('Web claim.', [webCite('https://example.org/p', 'P', 'y')])
      .openText(['cut off'])
      .error('overloaded_error', 'Overloaded').events;
    for (const ev of events) mapper.push(ev);
    mapper.finish(undefined);

    const price = api['priceFor']!(DEFAULT_MODEL);
    api['usdFromUsage']!({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, webSearches: 1 }, price);
    api['estimate']!(pack, 'default', DEFAULT_MODEL);
    api['decide']!({ estimateUsd: 0.3, spentUsd: 0, capUsd: null, confirmOverUsd: 0.25, saved: false, scope: 'passages' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(logged, 'a clean run prints no log line (the PDF\'s words must never reach a log)').toEqual([]);
  });
});
