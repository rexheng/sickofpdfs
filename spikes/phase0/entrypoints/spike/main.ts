// Check runner: spike.html?check=<name>&… loads src/checks/<name>.ts.
// - A check module that exports `run(params)` is run once; its resolved value becomes `window.__result`.
// - A module without `run` (for example backup-folder) only installs its page functions.
// - `window.__spikeReady` is set as soon as the module has loaded; `window.__spikeError` on any failure.

type CheckModule = { run?: (params: URLSearchParams) => Promise<unknown> };

declare global {
  interface Window {
    __result?: unknown;
    __spikeReady?: boolean;
    __spikeError?: string;
  }
}

const checks = import.meta.glob<CheckModule>('../../src/checks/*.ts');

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const name = params.get('check') ?? '';
  const load = checks[`../../src/checks/${name}.ts`];
  if (!load) throw new Error(`unknown check "${name}"`);
  const mod = await load();
  window.__spikeReady = true;
  if (!mod.run) return;
  const result = await mod.run(params);
  const out = document.createElement('pre');
  out.textContent = JSON.stringify(result, null, 2);
  document.body.append(out);
  window.__result = result;
}

main().catch((err: unknown) => {
  window.__spikeError = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(err);
});

export {};
