// Test support only: one "context" (a viewer tab, the settings page) with its own copy of the secrets store. The test sends it calls and
// reads back the answers. Several workers at once are several tabs; stopping a worker closes its database connection.
/// <reference lib="webworker" />
import { openLocalOnlyStore, type LocalOnlyStore } from './secrets-store';

let store: Promise<LocalOnlyStore> | undefined;

type Call = { id: number; fn: 'getSecret' | 'setSecret' | 'deleteSecret' | 'getMeta' | 'ensureMeta'; args: unknown[] };

self.onmessage = async (e: MessageEvent<Call>) => {
  const { id, fn, args } = e.data;
  try {
    store ??= openLocalOnlyStore();
    const s = (await store) as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const value = await s[fn](...args);
    (self as unknown as Worker).postMessage({ id, ok: true, value: value ?? null });
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(error) });
  }
};
