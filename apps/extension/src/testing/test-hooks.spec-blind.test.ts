// Spec-blind tests for the viewer runtime registry and the test hooks that read it.
// Interface: publishRuntime / readRuntime (production, module-local state, no global);
// test-hooks.ts (test-only, imports only ../viewer/runtime): importing it sets globalThis.__sopTest,
// whose reads return readRuntime()[key].
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Registry = Record<string, unknown>;
// ViewerRuntime has no fields yet ("later tasks add fields"), so these tests publish made-up keys.
const globals = globalThis as unknown as { __sopTest?: Registry };

beforeEach(() => {
  vi.resetModules();
  delete globals.__sopTest;
});

async function loadRuntime() {
  const runtime = await import('../viewer/runtime');
  return {
    // ViewerRuntime has no fields yet, so the registry is fed through a looser type.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- needed once later tasks add fields
    publish: runtime.publishRuntime as (p: Registry) => void,
    read: () => runtime.readRuntime() as Registry,
  };
}

describe('the viewer runtime registry (production code)', () => {
  it('merges what is published, later values win, and nothing is put on a global', async () => {
    const keysBefore = Object.getOwnPropertyNames(globalThis);
    const { publish, read } = await loadRuntime();
    expect(read()).toEqual({});
    publish({ zoom: 1 });
    publish({ page: 4 });
    expect(read()).toEqual({ zoom: 1, page: 4 });
    publish({ zoom: 2 });
    expect(read()).toEqual({ zoom: 2, page: 4 });
    expect(Object.getOwnPropertyNames(globalThis).filter((k) => !keysBefore.includes(k))).toEqual([]);
    expect(globals.__sopTest).toBeUndefined();
  });
});

describe('the test hooks', () => {
  it('appear on globalThis.__sopTest when the module is imported, and every read is live', async () => {
    const { publish } = await loadRuntime();
    publish({ zoom: 1 });
    expect(globals.__sopTest).toBeUndefined();

    await import('./test-hooks');
    const hooks = globals.__sopTest;
    expect(hooks).toBeDefined();
    expect(hooks?.zoom).toBe(1);
    expect(hooks?.neverPublished).toBeUndefined();

    publish({ zoom: 3, page: 9 }); // published after the hooks were installed
    expect(hooks?.zoom).toBe(3);
    expect(hooks?.page).toBe(9);
  });

  it('import nothing but the runtime registry, so a test build adds no other production code', () => {
    const source = readFileSync(fileURLToPath(new URL('./test-hooks.ts', import.meta.url)), 'utf8');
    const specifiers = [...source.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? m[2]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(['../viewer/runtime']));
  });
});
