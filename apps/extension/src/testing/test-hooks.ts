// Test only. The build adds this module to the viewer entry for `wxt build --mode test` (see wxt.config.ts), and
// to nothing else, so no production module imports it. It imports only the runtime registry, never a store.
import { readRuntime, type ViewerRuntime } from '../viewer/runtime';

/** What e2e specs read through `hooks(page).eval(...)`: the viewer's published runtime. */
export type SopTestHooks = ViewerRuntime;

declare global {
  var __sopTest: SopTestHooks | undefined;
}

const read = (key: string | symbol): unknown => (readRuntime() as Record<string | symbol, unknown>)[key];

// Each read goes to the registry, so a field published after this module loaded is seen.
Object.defineProperty(globalThis, '__sopTest', {
  configurable: true,
  value: new Proxy<SopTestHooks>({}, {
    get: (_target, key) => read(key),
    has: (_target, key) => key in readRuntime(),
    ownKeys: () => Reflect.ownKeys(readRuntime()),
    getOwnPropertyDescriptor: (_target, key) => (key in readRuntime() ? { configurable: true, enumerable: true, value: read(key) } : undefined),
  }),
});
