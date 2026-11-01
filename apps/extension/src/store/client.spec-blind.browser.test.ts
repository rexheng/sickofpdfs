// Spec-blind browser test for Task 28: connectStore / StoreClient, the viewer's side of the store.
//
// Sources (interface file, Task 28):
//   connectStore(o?: { timeoutMs?: number /* 3000 */ }): Promise<StoreClient>; StoreClient = StoreApi + onChange + close.
//   "openStorePort = a new MessageChannel, with port2 sent through (await navigator.serviceWorker.ready).active!.postMessage(
//     { type: 'store:connect' }, [port2])"; "on a 3000 ms timeout it reconnects once and replays the pending requests";
//   "onChange subscribes to CHANGES_CHANNEL" ('sop-changes'); the store serves requests { id, method, args } and answers
//     { id, ok, value | error } on every attached port.
//   spec, Storage: "a broadcast channel tells every open tab when something changes"; CLAUDE.md: "no lost notes".
// The other end is played by this test: a stand-in service worker that receives the 'store:connect' message and its port, and a stand-in
// store behind that port. The client code under test is the real one.
//
// GUESSES (the interface leaves them open): `method` is the StoreApi method name; `args` is the array of its arguments; an error answer
// carries a string in `error`; the pending timeout counts from when a request was sent.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectStore } from './client';

interface Request {
  id: unknown;
  method: string;
  args: unknown[];
}
type Reply = { ok: true; value: unknown } | { ok: false; error: string };
/** Decides what the stand-in store does with a request: answer it (the reply), or ignore it (undefined). */
type Behaviour = (req: Request, port: number) => Reply | undefined | Promise<Reply | undefined>;

const normalise = (data: { id: unknown; method: string; args?: unknown }): Request => ({
  id: data.id,
  method: String(data.method).split(/[.:/]/).pop()!,
  args: Array.isArray(data.args) ? (data.args as unknown[]) : data.args === undefined ? [] : [data.args],
});

const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
class FakeWorld {
  /** Every connection the client opened, in order. */
  connections: { port: MessagePort; requests: Request[] }[] = [];
  behaviour: Behaviour = () => ({ ok: true, value: null });

  install(): void {
    const active = {
      postMessage: (message: { type?: string }, transfer: MessagePort[]) => {
        if (message?.type !== 'store:connect') return;
        const port = transfer[0];
        const connection = { port, requests: [] as Request[] };
        const index = this.connections.push(connection) - 1;
        port.onmessage = (e: MessageEvent<{ id: unknown; method: string; args?: unknown }>) => {
          const req = normalise(e.data);
          connection.requests.push(req);
          void Promise.resolve(this.behaviour(req, index)).then((reply) => {
            if (reply) port.postMessage({ id: req.id, ...reply });
          });
        };
        port.start();
      },
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ active }), controller: active } });
  }
  uninstall(): void {
    delete (navigator as unknown as Record<string, unknown>)['serviceWorker'];
    if (originalDescriptor) Object.defineProperty(navigator, 'serviceWorker', originalDescriptor);
    for (const c of this.connections) c.port.close();
  }
  /** The requests of one kind, on one connection, in the order they arrived. */
  got(connection: number, method: string): unknown[][] {
    return (this.connections[connection]?.requests ?? []).filter((r) => r.method === method).map((r) => r.args);
  }
}

let world: FakeWorld;
beforeEach(() => {
  world = new FakeWorld();
  world.install();
});
afterEach(() => world.uninstall());

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const settles = (p: Promise<unknown>, ms: number): Promise<'resolved' | 'rejected' | 'hung'> =>
  Promise.race([p.then(() => 'resolved' as const, () => 'rejected' as const), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);

describe('talking to the store through a port', () => {
  it('sends each call as a request and gives every caller its own answer, even when the answers come back in another order; a failure rejects only its own call', async () => {
    const waiting: { req: Request; port: number }[] = [];
    world.behaviour = (req, port) => {
      if (req.method === 'getDocument' && req.args[0] === C) return { ok: false, error: 'disk full' };
      if (req.method !== 'getDocument') return { ok: true, value: req.method === 'schemaVersion' ? 2 : null };
      waiting.push({ req, port });
      if (waiting.length === 2) {
        // answer the second request first
        for (const w of [...waiting].reverse()) world.connections[w.port].port.postMessage({ id: w.req.id, ok: true, value: { id: w.req.args[0] } });
      }
      return undefined;
    };
    const store = await connectStore({ timeoutMs: 2000 });

    const [first, second] = await Promise.all([store.getDocument(A as never), store.getDocument(B as never)]);
    expect(first).toEqual({ id: A });
    expect(second).toEqual({ id: B });
    await expect(store.getDocument(C as never)).rejects.toBeDefined();
    expect(await store.schemaVersion(), 'the client carries on after a failed call').toBe(2);
    store.close();
  });

  it('on a timeout reconnects ONCE and sends the still-unanswered requests again, in the order they were made; answered ones are not repeated', async () => {
    world.behaviour = (req, port) => {
      if (req.method === 'stats') return { ok: true, value: { documents: 1 } }; // answered at once, on whichever connection
      if (!['getDocument', 'resolveFingerprint'].includes(req.method)) return { ok: true, value: 2 }; // anything else the client may ask on connecting
      if (port === 0) return undefined; // the first connection goes quiet for these calls: the hidden page was closed
      return { ok: true, value: `answer to ${req.method}(${String(req.args[0])})` };
    };
    const store = await connectStore({ timeoutMs: 300 });

    const answeredEarly = store.stats();
    const p1 = store.getDocument(A as never);
    const p2 = store.resolveFingerprint(B as never);
    const p3 = store.getDocument(C as never);
    await answeredEarly;

    await expect(Promise.all([p1, p2, p3])).resolves.toEqual([`answer to getDocument(${A})`, `answer to resolveFingerprint(${B})`, `answer to getDocument(${C})`]);

    expect(world.connections.length, 'one reconnect, not more').toBe(2);
    const replayed = world.connections[1].requests.filter((r) => ['getDocument', 'resolveFingerprint'].includes(r.method)).map((r) => `${r.method}:${String(r.args[0])}`);
    expect(replayed).toEqual([`getDocument:${A}`, `resolveFingerprint:${B}`, `getDocument:${C}`]);
    expect(world.got(1, 'stats'), 'a call that was answered is not asked again').toEqual([]);
    store.close();
  });

  it('does not wait for ever on a store that never answers: after its one reconnect the calls fail, and it does not keep reconnecting', async () => {
    world.behaviour = (req) => (req.method === 'getDocument' ? undefined : { ok: true, value: 2 });
    const store = await connectStore({ timeoutMs: 200 });

    const call = store.getDocument(A as never);
    expect(await settles(call, 4000), 'a hung call would freeze the "Saving..." chip for ever').toBe('rejected');
    await new Promise((r) => setTimeout(r, 600));
    expect(world.connections.length, 'reconnects once').toBe(2);
    store.close();
  });
});

describe('hearing about changes', () => {
  const CHANGE = { table: 'documents', ids: [A], op: 'upsert' } as const;
  const send = async (change: unknown) => {
    const channel = new BroadcastChannel('sop-changes'); // what the store worker posts on, as another tab or page
    channel.postMessage(change);
    await new Promise((r) => setTimeout(r, 100));
    channel.close();
  };

  it('onChange delivers what the store announced on the change channel to every listener, until it is unsubscribed or the client is closed', async () => {
    world.behaviour = () => ({ ok: true, value: null });
    const store = await connectStore({ timeoutMs: 2000 });
    const heard: unknown[] = [];
    const alsoHeard: unknown[] = [];
    const off = store.onChange((c) => heard.push(c));
    store.onChange((c) => alsoHeard.push(c));

    await send(CHANGE);
    expect(heard).toEqual([CHANGE]);
    expect(alsoHeard).toEqual([CHANGE]);

    off();
    await send({ table: 'history', ids: [A], op: 'upsert' });
    expect(heard, 'unsubscribed').toEqual([CHANGE]);
    expect(alsoHeard).toHaveLength(2);

    store.close();
    await send({ table: 'locations', ids: [B], op: 'delete' });
    expect(alsoHeard, 'closed').toHaveLength(2);
  });
});
