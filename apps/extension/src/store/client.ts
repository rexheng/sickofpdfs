// The page's handle on the store: every StoreApi method as a call over a store port, plus change events.
//
// Order: calls are posted in the order they are made, on one port, and the worker runs them in that order.
//
// When the store stops answering, the client opens a new port once and posts every unanswered call again, oldest first,
// before anything newer. Each call carries a unique key, so the worker runs a replayed call at most once. A call that still
// gets no answer after its one replay is rejected (`store-timeout: …`), never dropped silently. "Stops answering" is:
// - no answer for `timeoutMs` (3 s) on a port that has not answered yet;
// - on a port that has answered before: the store worker behind it is gone (each worker holds the Web Lock
//   `sop-store-owner` for as long as it lives; the client notes which one answered and checks every 400 ms while calls
//   wait), or no answer for 30 s even though it is still there;
// - the port closes (where Chrome reports that), or the service worker reports it could not hand the port on.
import { type StoreChange, subscribeChanges } from './change-bus';
import { errorFromPayload, isStoreResponse, STORE_METHODS, type StoreMethod } from './protocol';
import type { StoreApi } from './store-api';
import { isMessageOf, openStorePort, STORE_ERROR, STORE_OWNER_LOCK, type StoreBrokerError } from './transport';

export interface StoreClient extends StoreApi {
  /** Calls `cb` for every change any tab commits. Returns the function that stops it. */
  onChange(cb: (c: StoreChange) => void): () => void;
  /** Stops this client. Calls still waiting reject with `store-closed`. */
  close(): void;
}

/** How long a new port may stay silent while calls wait before the client reconnects (and, after that, gives up). */
export const STORE_TIMEOUT_MS = 3000;
/** On a port that has answered and whose store worker is still alive, a long job (a big forget, say) may take this long. */
const BUSY_TIMEOUT_MS = 30_000;
/** How often the client checks that the store worker is still alive while calls wait. */
const PROBE_MS = 400;

/** Which store worker holds the owner lock now (its client id), or null when none does. */
async function storeOwnerId(): Promise<string | null> {
  const state = await navigator.locks.query();
  return state.held?.find((l) => l.name === STORE_OWNER_LOCK)?.clientId ?? null;
}

/** Connects to the store and checks it answers (one round trip). Rejects if it cannot be reached. */
export async function connectStore(o: { timeoutMs?: number } = {}): Promise<StoreClient> {
  const ownerId = typeof navigator !== 'undefined' && typeof navigator.locks?.query === 'function' ? storeOwnerId : undefined;
  const client = createStoreClient(openStorePort, o.timeoutMs ?? STORE_TIMEOUT_MS, { ownerId });
  try {
    await client.schemaVersion();
  } catch (error) {
    client.close();
    throw error;
  }
  return client;
}

interface Call {
  id: number;
  method: StoreMethod;
  args: unknown[];
  /** 0 until it has been posted again on a new port; a call is replayed at most once. */
  replays: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(asError(e));
      },
    );
  });
}

export interface StoreClientOptions {
  /** Which store worker is alive now (null: none). Without it, every port gets the plain `timeoutMs` silence limit. */
  ownerId?: () => Promise<string | null>;
}

/** A client over ports from `openPort` (the service worker broker in the product; a test can pass its own). */
export function createStoreClient(openPort: () => Promise<MessagePort>, timeoutMs: number = STORE_TIMEOUT_MS, o: StoreClientOptions = {}): StoreClient {
  const clientKey = crypto.randomUUID();
  let nextId = 1;
  let port: MessagePort | null = null;
  /** The store worker behind the current port, once it has answered and the owner lock said which one it is. */
  let owner: string | null = null;
  let opening = false;
  let closed = false;
  /** Made but not yet posted on the current port, oldest first. */
  let unsent: Call[] = [];
  /** Posted on the current port, waiting for the answer. */
  const waiting = new Map<number, Call>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let probe: ReturnType<typeof setInterval> | null = null;
  let probing = false;
  const listeners = new Set<() => void>();

  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    if (probe !== null) clearInterval(probe);
    timer = null;
    probe = null;
  };

  /**
   * Starts watching while calls wait on an open port. Only an answer restarts the watch, so a stream of new calls cannot
   * hold it off. While a port is being opened, the opening has its own time limit instead.
   */
  const arm = (restart: boolean): void => {
    if (restart) disarm();
    if (port === null || waiting.size === 0) {
      disarm();
      return;
    }
    if (timer !== null) return;
    const watched = port;
    const known = owner;
    const ownerId = o.ownerId;
    timer = setTimeout(() => stall(new Error('the store did not answer')), known !== null ? BUSY_TIMEOUT_MS : timeoutMs);
    if (known !== null && ownerId) {
      probe = setInterval(() => {
        if (probing) return;
        probing = true;
        ownerId().then(
          (now) => {
            probing = false;
            if (now !== known && port === watched && waiting.size > 0) stall(new Error('the store went away'));
          },
          () => {
            probing = false; // cannot tell: the silence limit still applies
          },
        );
      }, PROBE_MS);
    }
  };

  const flush = (): void => {
    if (closed) return;
    if (port === null) {
      open();
      return;
    }
    const p = port;
    const batch = unsent;
    unsent = [];
    for (const call of batch) {
      waiting.set(call.id, call);
      try {
        p.postMessage({ id: call.id, key: `${clientKey}:${call.id}`, method: call.method, args: call.args });
      } catch (e) {
        // The arguments cannot be copied (a programming error): this call fails, the others go on.
        waiting.delete(call.id);
        call.reject(asError(e));
      }
    }
    arm(false);
  };

  const onMessage = (from: MessagePort, data: unknown): void => {
    if (from !== port) return;
    if (isMessageOf<StoreBrokerError>(data, STORE_ERROR)) {
      stall(new Error(data.message));
      return;
    }
    if (!isStoreResponse(data) || typeof data.id !== 'number') return;
    const call = waiting.get(data.id);
    if (!call) return;
    waiting.delete(data.id);
    if (owner === null && o.ownerId && !probing) learnOwner(from, o.ownerId);
    if (data.ok) call.resolve(data.value);
    else call.reject(errorFromPayload(data.error));
    arm(true);
  };

  /** After the first answer on a port: the worker that answered holds the owner lock, so note which one it is. */
  const learnOwner = (p: MessagePort, ownerId: () => Promise<string | null>): void => {
    probing = true;
    ownerId().then(
      (id) => {
        probing = false;
        if (port !== p || owner !== null) return;
        owner = id;
        if (id !== null) arm(true);
      },
      () => {
        probing = false;
      },
    );
  };

  const open = (): void => {
    if (opening || closed) return;
    opening = true;
    withTimeout(openPort(), timeoutMs, 'store-unavailable: the service worker did not hand out a store port').then(
      (p) => {
        opening = false;
        if (closed) {
          p.close();
          return;
        }
        port = p;
        owner = null;
        p.onmessage = (e: MessageEvent) => onMessage(p, e.data);
        // Where Chrome reports it, the other end going away (the offscreen document closed) is noticed at once.
        p.addEventListener('close', () => {
          if (port === p) stall(new Error('the store went away'));
        });
        flush();
      },
      (e: unknown) => {
        opening = false;
        stall(asError(e));
      },
    );
  };

  /** The store went quiet or away: reconnect once and replay every unanswered call in order; give up on calls already replayed. */
  function stall(reason: Error): void {
    disarm();
    const old = port;
    port = null;
    owner = null;
    old?.close();
    const all = [...waiting.values(), ...unsent].sort((a, b) => a.id - b.id);
    waiting.clear();
    unsent = [];
    for (const call of all) {
      if (call.replays >= 1) {
        call.reject(new Error(`store-timeout: ${reason.message}`));
      } else {
        call.replays += 1;
        unsent.push(call);
      }
    }
    if (unsent.length > 0) flush();
  }

  const call = (method: StoreMethod, args: unknown[]): Promise<unknown> => {
    if (closed) return Promise.reject(new Error('store-closed: this store connection was closed'));
    return new Promise<unknown>((resolve, reject) => {
      unsent.push({ id: nextId++, method, args, replays: 0, resolve, reject });
      flush();
    });
  };

  const client: Record<string, unknown> = {};
  for (const method of STORE_METHODS) client[method] = (...args: unknown[]) => call(method, args);
  client.onChange = (cb: (c: StoreChange) => void): (() => void) => {
    const stop = subscribeChanges(cb);
    let stopped = false;
    const off = () => {
      if (stopped) return;
      stopped = true;
      listeners.delete(off);
      stop();
    };
    listeners.add(off);
    return off;
  };
  client.close = (): void => {
    if (closed) return;
    closed = true;
    disarm();
    port?.close();
    port = null;
    const error = new Error('store-closed: this store connection was closed');
    for (const c of [...waiting.values(), ...unsent]) c.reject(error);
    waiting.clear();
    unsent = [];
    for (const off of [...listeners]) off();
  };
  return client as unknown as StoreClient;
}
