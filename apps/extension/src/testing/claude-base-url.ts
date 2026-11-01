// Test only (contract addition A7). `wxt build --mode test` adds this module to the viewer entry (see wxt.config.ts), and to
// nothing else, so no production module imports it and a production build does not contain it. It never touches the secrets store.
//
// It does one thing: while a base URL is set, a request the page makes to the Anthropic API goes to that address instead (the
// recorded-response double in e2e/support/claude-replay.ts). It does this by wrapping `fetch`, so the production client needs no
// switch of its own and carries no trace of this hook. Set the address with `__sopClaude.setBaseUrl(url)`; it is remembered
// across reloads, so a tab that was killed and reopened still talks to the double.
const API_ORIGIN = 'https://api.anthropic.com';
const STORAGE_KEY = 'sop.test.claudeBaseUrl';

export interface SopClaudeHook {
  /** The address requests are sent to now, or null for the real API. */
  readonly baseUrl: string | null;
  setBaseUrl(url: string | null): void;
}

declare global {
  var __sopClaude: SopClaudeHook | undefined;
}

function remembered(): string | null {
  try {
    return globalThis.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(url: string | null): void {
  try {
    if (url === null) globalThis.localStorage.removeItem(STORAGE_KEY);
    else globalThis.localStorage.setItem(STORAGE_KEY, url);
  } catch {
    // storage can be blocked; the address then lasts for this page load only
  }
}

let base: string | null = remembered();
const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (base !== null) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${API_ORIGIN}/`)) return realFetch(`${base}${url.slice(API_ORIGIN.length)}`, init);
  }
  return realFetch(input, init);
};

globalThis.__sopClaude = {
  get baseUrl() {
    return base;
  },
  setBaseUrl(url) {
    base = url === null ? null : url.replace(/\/+$/, '');
    remember(base);
  },
};
